// Momentum/flow bot for pump.fun SOL bonding curves (agent-fun/replay/v2).
//
// The curve's price is (30 SOL + real SOL reserve)^2 / k, so the whole game is to be in a coin's
// curve while the real SOL reserve climbs and to leave before it gives the money back. Two sleeves
// share the five position slots:
//
//   probe  — one small ticket per new coin, behind a hard price stop and a short time stop. Coins
//            that go nowhere cost a few thousandths of a SOL; on its own this sleeve is roughly
//            break-even and it is what books the fill and coin counts the guardrails ask for.
//   ladder — a campaign in a coin whose real SOL reserve has crossed SURVIVOR_RQ. That reserve is
//            the coin's proven money: a curve that has taken that much real SOL has other traders
//            carrying it, and on the dev window a coin that reached 30 SOL of real reserve went on
//            to complete 73% of the time, against 14% at 5 SOL. The campaign adds the size cap
//            (1% of the coin's real reserve, state.maxBuyLamports) at every new reserve high, up to
//            a budget fixed when its first tranche actually fills, and holds while the coin keeps
//            printing new highs. It leaves on a stall (no new high for STALL_SLOTS), a stop below
//            its first tranche, a disaster stop, a max hold, or the curve's completion. A coin that
//            stalls and later prints a new high can be re-entered, but that is off by default: one
//            re-entry measured -0.3 SOL on the dev window.
//
// Capital is the binding constraint, not signal: the 1% cap grows with the reserve, so the campaign
// is sized as a share of cash when it opens and the earlier tranches (the cheapest ones) are what
// the return comes from.
//
// Nothing is booked on intent: a campaign exists only once its first tranche has filled, its spend
// is read back from the position the account reports, and a probe counts as spent only once its
// ticket has filled. A ticket that is rejected is retried a few times and then dropped, so it never
// holds a slot or a budget.
import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/agentfun-bot.ts';

export interface Cfg {
  /** Probe: ticket size, price stop, time stop. */
  probeLamports: bigint;
  probeStopBps: number;
  probeHoldSlots: number;
  /** Ladder: the real SOL reserve that makes a coin a campaign candidate. */
  ladderMinRq: bigint;
  /** Slots reserved for campaigns (running or armed); probes may use the rest. */
  ladderSlots: number;
  /** A campaign's budget: a share of the cash when its first tranche fills, clamped. */
  budgetPctBps: number;
  budgetLamports: bigint;
  minBudget: bigint;
  maxBudget: bigint;
  /** Add at every new reserve high of at least this much (either measure). */
  bandLamports: bigint;
  bandBps: number;
  /** Leave a campaign: no new high for this many slots, or this price drop from its peak. */
  stallSlots: number;
  trailBps: number;
  /** Leave a campaign this far below the price its first tranche filled at. */
  stopBps: number;
  exitRq: bigint;
  maxHoldSlots: number;
  /** A campaign that was left may be re-entered this many times, on a new high (0 = never). */
  maxRearms: number;
  /** How many times a rejected first ticket is retried before the ticket is dropped. */
  armTries: number;
  /** Cash kept back, and the smallest order worth its transaction fee. */
  cashReserve: bigint;
  minOrderLamports: bigint;
}

export const DEFAULT_CFG: Cfg = {
  probeLamports: LAMPORTS_PER_SOL / 25n, // 0.04 SOL a probe
  probeStopBps: 800, // -8% from the probe's fill
  probeHoldSlots: 200, // about 80 s
  ladderMinRq: 30n * LAMPORTS_PER_SOL,
  ladderSlots: 3,
  budgetPctBps: 6_000,
  budgetLamports: 8n * LAMPORTS_PER_SOL,
  minBudget: LAMPORTS_PER_SOL / 2n,
  maxBudget: 8n * LAMPORTS_PER_SOL,
  bandLamports: 0n,
  bandBps: 20, // a new high of 0.2% of the real reserve
  stallSlots: 150, // about 60 s without a new high
  trailBps: 5_000, // -50% from the peak price: a collapse, not a wobble
  stopBps: 1_000, // -10% from the campaign's first tranche
  exitRq: 84n * LAMPORTS_PER_SOL, // the curve completes at about 85 SOL
  maxHoldSlots: 12_000,
  maxRearms: 0, // one campaign per coin: a re-entry measured -0.3 SOL on the dev window
  armTries: 8,
  cashReserve: LAMPORTS_PER_SOL / 50n,
  minOrderLamports: LAMPORTS_PER_SOL / 50n,
};

/** A ticket that has been decided but not yet filled: 'probe' or 'campaign' (the first tranche). */
type Arm = 'probe' | 'campaign' | null;

interface Meta {
  /** The probe sleeve has filled its ticket here. */
  probed: boolean;
  probeEntry: number;
  /** A decided ticket waiting for its fill, and how many times it has been sent. */
  arm: Arm;
  tries: number;
  /** The ladder sleeve: a campaign exists once its first tranche filled. */
  ladder: boolean;
  ladderOpen: boolean;
  campaignEntry: number;
  budget: bigint;
  lastAddRq: bigint;
  peakRq: bigint;
  highSlot: number;
  /** The position's high-water price and the slot it was entered at. */
  peakPrice: number;
  firstSlot: number;
  /** High-water reserve when the last campaign here ended: a new high re-arms it. */
  rearmRq: bigint;
  rearms: number;
}

const BPS = 10_000;
const meta = new Map<string, Meta>();

function note(mint: string): Meta {
  let m = meta.get(mint);
  if (m === undefined) {
    m = {
      probed: false, probeEntry: 0, arm: null, tries: 0,
      ladder: false, ladderOpen: false, campaignEntry: 0, budget: 0n, lastAddRq: 0n, peakRq: 0n, highSlot: 0,
      peakPrice: 0, firstSlot: 0, rearmRq: 0n, rearms: 0,
    };
    meta.set(mint, m);
  }
  return m;
}

/** Lamports this mint's campaign has actually spent: the cost of the tokens it still holds. */
function booked(state: any, mint: string): bigint {
  const pos = state.positions.get(mint);
  return pos === undefined ? 0n : pos.cost_lamports;
}

/** What a campaign opening now may spend: a share of the cash at hand, minus what the campaigns
 *  already running may still spend. 0n when there is no room for the smallest campaign, in which
 *  case no campaign is opened. */
function campaignBudget(cfg: Cfg, state: any): bigint {
  let committed = 0n;
  for (const [mint, m] of meta) if (m.ladderOpen && m.budget > booked(state, mint)) committed += m.budget - booked(state, mint);
  const available = state.cash - cfg.cashReserve - committed;
  let b = (state.cash * BigInt(cfg.budgetPctBps)) / BigInt(BPS);
  if (b > cfg.budgetLamports) b = cfg.budgetLamports;
  if (b > cfg.maxBudget) b = cfg.maxBudget;
  if (b > available) b = available;
  return b < cfg.minBudget ? 0n : b;
}

/** Our own net flow into each curve, the way the replay tracks it: the SOL quote our buys put in
 *  minus what our sells took out, and the tokens we bought minus what we sold back. The replay
 *  sizes every order against the recorded reserves shifted by this flow (sim/engine.ts,
 *  offsetReserves), so a re-entry into a curve we have already traded needs the same shift here or
 *  the size cap is wrong. A harness close (`_complete_`, `_flatten_`, `_writeoff_`) reports no
 *  curve quote, and no completed curve is ever traded again, so it cannot skew an entry. */
const flowQuote = new Map<string, bigint>();
const flowTokens = new Map<string, bigint>();

function trackFlow(batch: any): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    const quote = BigInt(f.quote_lamports);
    const fee = BigInt(f.fee_lamports);
    const tokens = BigInt(f.token_amount);
    const curveQuote = f.side === 'buy' ? quote - fee : quote + fee;
    const sign = f.side === 'buy' ? 1n : -1n;
    flowQuote.set(f.mint, (flowQuote.get(f.mint) ?? 0n) + sign * curveQuote);
    flowTokens.set(f.mint, (flowTokens.get(f.mint) ?? 0n) + sign * tokens);
  }
}

/** The recorded real SOL reserve shifted by our flow, exactly as the replay does it: the shift is
 *  scaled down when it would take the real reserve below zero. */
function shiftedRq(rawRq: bigint, rawTokens: bigint, mint: string): bigint {
  const quote = flowQuote.get(mint) ?? 0n;
  const tokens = flowTokens.get(mint) ?? 0n;
  let num = 1n;
  let den = 1n;
  if (tokens > rawTokens) { num = rawTokens; den = tokens; }
  if (quote < 0n && rawRq * den < num * -quote) { num = rawRq; den = -quote; }
  if (num === den) return rawRq + quote;
  return rawRq + (quote >= 0n ? (quote * num) / den : -((-quote * num) / den));
}

/** The most this reply may spend on the mint: the replay's 1% of its decision-time reserve, never
 *  more than what the shim's own view allows. `viewIsRaw` is true when this batch carried an event
 *  for the mint (the shim applies events after marks, and an event's reserves are unshifted). */
function sizeCap(state: any, mint: string, viewIsRaw: boolean): bigint {
  const sdk = state.maxBuyLamports(mint);
  if (sdk === 0n) return 0n;
  const curve = state.curves.get(mint);
  if (!viewIsRaw || curve === undefined) return sdk;
  const bps = BigInt(state.hello.caps.max_order_bps_of_real_reserve);
  const shifted = (shiftedRq(curve.real_quote_reserves, curve.real_token_reserves, mint) * bps) / BigInt(BPS);
  return shifted < sdk ? shifted : sdk;
}

/** The curve's price in lamports per token. */
function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function sell(mint: string, tokens: bigint, orders: OrderInput[]): void {
  if (tokens <= 0n) return;
  orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
}

/** A campaign becomes real here: its first tranche has filled (or a held probe was promoted). */
function adopt(mint: string, m: Meta, state: any, cfg: Cfg, px: number, rq: bigint, slot: number): void {
  if (m.rearmRq > 0n) m.rearms++;
  m.ladder = true;
  m.ladderOpen = true;
  m.arm = null;
  m.tries = 0;
  m.budget = campaignBudget(cfg, state);
  m.campaignEntry = px;
  m.peakPrice = px;
  m.lastAddRq = rq;
  m.peakRq = rq;
  m.highSlot = slot;
  m.firstSlot = slot;
}

/** The campaign is over: its reserved slot and budget are free again. */
function endCampaign(m: Meta): void {
  m.ladderOpen = false;
  m.budget = 0n;
  m.rearmRq = m.peakRq;
  m.campaignEntry = 0;
}

/** The orders to send on this batch. Deterministic in (state, batch, cfg) and the per-process
 *  notes above: no clock, no randomness, no environment. */
export function decide(state: any, batch: any, cfg: Cfg = DEFAULT_CFG): OrderInput[] {
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();
  const maxOrders = caps.max_orders_per_batch;
  const orders: OrderInput[] = [];
  const pendingSell = new Set<string>();
  const pendingBuy = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    else pendingBuy.add(p.order.mint);
  }
  let slots = caps.max_open_positions - state.committedPositionCount();
  const sent = new Set<string>(); // one order per mint per reply: a hot coin can trade twice in a slot
  trackFlow(batch);
  const rawView = new Set<string>();
  for (const e of batch.events) rawView.add(e.mint);

  // 0. Book what actually happened. A position that exists is a filled ticket: a probe ticket, or a
  //    campaign's first tranche, which is what makes a campaign real. A decided ticket that came
  //    back without a position was rejected or failed, so its arm is cleared and the attempt
  //    counted; a campaign whose position is gone (it was sold, or the replay closed it on the
  //    curve's completion) gives its slot and its budget back.
  const resolvedBuys = new Set<string>();
  for (const f of batch.fills) if (f.side === 'buy') resolvedBuys.add(f.mint);
  for (const [mint, h] of state.positions) {
    if (h.token_amount === 0n) continue;
    const m = meta.get(mint);
    const curve = state.curves.get(mint);
    if (m === undefined || curve === undefined) continue;
    const px = priceOf(curve);
    if (m.arm === 'campaign' || (m.ladder && m.campaignEntry === 0)) {
      adopt(mint, m, state, cfg, px, curve.real_quote_reserves, batch.slot);
    } else if (m.arm === 'probe') {
      m.probed = true;
      m.arm = null;
      m.tries = 0;
      m.probeEntry = px;
      m.peakPrice = px;
      m.firstSlot = batch.slot;
    }
  }
  for (const [mint, m] of meta) {
    if (m.arm !== null && !state.positions.has(mint) && resolvedBuys.has(mint)) {
      m.arm = null; // the ticket did not fill: stand it down so a later batch can decide again
      m.tries += 1;
    }
    if (!m.ladderOpen) continue;
    if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
    endCampaign(m); // the position closed: the campaign is over
  }

  let ladderOpen = 0;
  let armedCampaigns = 0;
  for (const m of meta.values()) {
    if (m.ladderOpen) ladderOpen++;
    else if (m.arm === 'campaign') armedCampaigns++;
  }

  // 1. Arm a campaign for a coin at or above the survivor threshold, or promote the probe we hold
  //    in it. Nothing is reserved here: a campaign claims its slot and budget only when its first
  //    tranche fills (step 0).
  let planned = 0;
  for (const e of batch.events) {
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (m.ladderOpen) continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const rq = curve.real_quote_reserves;
    if (m.arm === 'campaign') {
      // The coin fell back below the threshold before the tranche filled: stand the ticket down.
      if (rq < cfg.ladderMinRq) { m.arm = null; m.rearmRq = m.peakRq; }
      continue;
    }
    if (rq < cfg.ladderMinRq) continue;
    if (m.rearmRq > 0n) {
      // This coin has already run a campaign: a re-entry needs a new high, and there are only so
      // many of them. maxRearms 0 means one campaign per coin.
      if (m.rearms >= cfg.maxRearms) continue;
      if (rq <= m.rearmRq) continue;
    }
    if (m.tries >= cfg.armTries) continue;
    if (pendingBuy.has(e.mint)) continue;
    if (state.positions.has(e.mint)) {
      adopt(e.mint, m, state, cfg, priceOf(curve), rq, batch.slot); // promote the held probe
      ladderOpen++;
      continue;
    }
    if (ladderOpen + armedCampaigns + planned >= cfg.ladderSlots) continue;
    if (slots - planned <= 0) continue;
    if (campaignBudget(cfg, state) === 0n) continue;
    m.arm = 'campaign';
    planned += 1;
  }

  // 2. Exits.
  for (const [mint, h] of state.positions) {
    if (orders.length >= maxOrders) break;
    const m = meta.get(mint);
    const curve = state.curves.get(mint);
    if (m === undefined || curve === undefined || h.token_amount === 0n || pendingSell.has(mint)) continue;
    if (curve.complete) { endCampaign(m); continue; }
    const px = priceOf(curve);
    const rq = curve.real_quote_reserves;
    if (px > m.peakPrice) m.peakPrice = px;
    if (rq > m.peakRq) { m.peakRq = rq; m.highSlot = batch.slot; }
    const age = batch.slot - m.firstSlot;
    if (m.ladderOpen) {
      const stalled = batch.slot - m.highSlot >= cfg.stallSlots;
      const dumped = px <= m.peakPrice * (1 - cfg.trailBps / BPS);
      const stopped = px <= m.campaignEntry * (1 - cfg.stopBps / BPS);
      if (stalled || dumped || stopped || age >= cfg.maxHoldSlots || rq >= cfg.exitRq) {
        sell(mint, h.token_amount, orders);
        endCampaign(m);
      }
    } else if (px <= m.probeEntry * (1 - cfg.probeStopBps / BPS) || age >= cfg.probeHoldSlots) {
      sell(mint, h.token_amount, orders);
    }
  }

  // 3. Add to a running campaign at each new reserve high, up to its budget.
  for (const [mint, h] of state.positions) {
    if (orders.length >= maxOrders) break;
    const m = meta.get(mint);
    const curve = state.curves.get(mint);
    if (m === undefined || !m.ladderOpen || h.token_amount === 0n || curve === undefined || curve.complete) continue;
    if (pendingBuy.has(mint) || pendingSell.has(mint) || sent.has(mint)) continue;
    const spent = booked(state, mint);
    if (spent >= m.budget) continue;
    const rq = curve.real_quote_reserves;
    const byAbs = cfg.bandLamports > 0n && rq >= m.lastAddRq + cfg.bandLamports;
    const byPct = cfg.bandBps > 0 && rq * BigInt(BPS) >= m.lastAddRq * BigInt(BPS + cfg.bandBps);
    if (!byAbs && !byPct) continue;
    const cap = sizeCap(state, mint, rawView.has(mint));
    const room = m.budget - spent;
    const amount = cap < room ? cap : room;
    if (amount < cfg.minOrderLamports) continue;
    const free = state.freeCashLamports() - BigInt(orders.length) * tx - cfg.cashReserve;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    sent.add(mint);
    m.lastAddRq = rq;
  }

  // 4. First tickets. Campaigns claim their slot first; probes take what is left, and never all of
  //    it, so the ladder always has a slot for the next coin that crosses the threshold. An arm is
  //    set only when its order is actually sent, so nothing is ever held for a ticket that never
  //    reached the market.
  let free = state.freeCashLamports() - BigInt(orders.length) * tx - cfg.cashReserve;
  for (const e of batch.events) {
    if (orders.length >= maxOrders) break;
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (m.arm !== 'campaign') continue;
    if (state.positions.has(e.mint) || pendingBuy.has(e.mint) || sent.has(e.mint)) continue;
    if (slots <= 0) break;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const cap = sizeCap(state, e.mint, true);
    if (cap < cfg.minOrderLamports) continue;
    const budget = campaignBudget(cfg, state);
    if (budget === 0n) continue;
    const amount = cap < budget ? cap : budget;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    sent.add(e.mint);
    free -= amount + tx;
    slots -= 1;
  }
  const probeSlots = caps.max_open_positions - cfg.ladderSlots;
  let probesOpen = 0;
  for (const [mint, m] of meta) {
    if (m.ladder || m.probed) continue;
    if (state.positions.has(mint)) probesOpen++;
    else if (m.arm === 'probe' && pendingBuy.has(mint)) probesOpen++;
  }
  for (const e of batch.events) {
    if (orders.length >= maxOrders) break;
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (m.probed || m.ladder || m.arm !== null) continue;
    if (m.tries >= cfg.armTries) continue;
    if (pendingBuy.has(e.mint) || sent.has(e.mint)) continue;
    if (probesOpen >= probeSlots) continue;
    if (state.positions.has(e.mint)) continue;
    if (slots <= 0) break;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const cap = sizeCap(state, e.mint, true);
    if (cap < cfg.minOrderLamports) continue;
    const amount = cap < cfg.probeLamports ? cap : cfg.probeLamports;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    m.arm = 'probe';
    sent.add(e.mint);
    free -= amount + tx;
    slots -= 1;
    probesOpen++;
  }

  return orders;
}

await runBot({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
