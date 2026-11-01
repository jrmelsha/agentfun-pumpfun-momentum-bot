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
//            a budget fixed when it opens, and holds while the coin keeps printing new highs. It
//            leaves on a stall (no new high for STALL_SLOTS), a disaster stop, a max hold, or the
//            curve's completion; a coin that stalls and then prints a new high is re-entered.
//
// Capital is the binding constraint, not signal: the 1% cap grows with the reserve, so the campaign
// is sized as a share of cash at the moment it opens and the earlier tranches (the cheapest ones)
// are what the return comes from.
import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/agentfun-bot.ts';

export interface Cfg {
  /** Probe: ticket size, price stop, time stop. */
  probeLamports: bigint;
  probeStopBps: number;
  probeHoldSlots: number;
  /** Ladder: the real SOL reserve that makes a coin a campaign candidate. */
  ladderMinRq: bigint;
  /** Position slots reserved for campaigns; probes may use the rest. */
  ladderSlots: number;
  /** A campaign's budget: a share of the cash at the moment it opens, clamped. */
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
  /** A campaign left on a stall may be re-entered this many times, on a new high. */
  maxRearms: number;
  /** Cash kept back, and the smallest order worth its transaction fee. */
  cashReserve: bigint;
  minOrderLamports: bigint;
}

export const DEFAULT_CFG: Cfg = {
  probeLamports: LAMPORTS_PER_SOL / 25n, // 0.04 SOL a probe
  probeStopBps: 800, // -8% from the probe's entry
  probeHoldSlots: 200, // about 80 s
  ladderMinRq: 20n * LAMPORTS_PER_SOL,
  ladderSlots: 3,
  budgetPctBps: 5_000,
  budgetLamports: 8n * LAMPORTS_PER_SOL,
  minBudget: LAMPORTS_PER_SOL / 2n,
  maxBudget: 8n * LAMPORTS_PER_SOL,
  bandLamports: 0n,
  bandBps: 50, // a new high of 0.5% of the real reserve
  stallSlots: 250, // about 100 s without a new high
  trailBps: 8_000, // -80% from the peak price: only a real collapse triggers this
  stopBps: 1_500,
  exitRq: 84n * LAMPORTS_PER_SOL, // the curve completes at about 85 SOL
  maxHoldSlots: 12_000,
  maxRearms: 2,
  cashReserve: LAMPORTS_PER_SOL / 50n,
  minOrderLamports: LAMPORTS_PER_SOL / 50n,
};

interface Meta {
  /** The position's entry price and high-water marks, for the exits. */
  entryPrice: number;
  peakPrice: number;
  peakRq: bigint;
  highSlot: number;
  firstSlot: number;
  /** The probe sleeve has spent its one ticket here. */
  probed: boolean;
  /** A ladder campaign has run (or is running) here. */
  ladder: boolean;
  /** The campaign holds one of the reserved campaign slots. */
  ladderOpen: boolean;
  spent: bigint;
  budget: bigint;
  lastAddRq: bigint;
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
      entryPrice: 0, peakPrice: 0, peakRq: 0n, highSlot: 0, firstSlot: 0,
      probed: false, ladder: false, ladderOpen: false,
      spent: 0n, budget: 0n, lastAddRq: 0n, rearmRq: 0n, rearms: 0,
    };
    meta.set(mint, m);
  }
  return m;
}

/** What a campaign opening now may spend: a share of the cash at hand, minus what the campaigns
 *  already open may still spend, clamped to [min,max]. */
function campaignBudget(cfg: Cfg, state: any): bigint {
  let committed = 0n;
  for (const m of meta.values()) if (m.ladderOpen && m.budget > m.spent) committed += m.budget - m.spent;
  const available = state.cash - cfg.cashReserve - committed;
  let b = (state.cash * BigInt(cfg.budgetPctBps)) / BigInt(BPS);
  if (b > available) b = available;
  if (b > cfg.maxBudget) b = cfg.maxBudget;
  if (b > cfg.budgetLamports) b = cfg.budgetLamports;
  if (b < cfg.minBudget) b = cfg.minBudget;
  return b;
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

/** The orders to send on this batch. Pure in (state, batch, cfg): no clock, no randomness. */
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
  let ladderOpen = 0;
  for (const m of meta.values()) if (m.ladderOpen) ladderOpen++;
  let slots = caps.max_open_positions - state.committedPositionCount();

  // 1. A coin crossing the survivor threshold starts a campaign (promoting the probe we already
  //    hold in it). A coin whose earlier campaign stalled is re-entered on a new high.
  for (const e of batch.events) {
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (m.ladder) continue;
    if (m.rearms > cfg.maxRearms) continue;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const rq = curve.real_quote_reserves;
    if (rq < cfg.ladderMinRq) continue;
    if (m.rearmRq > 0n && rq <= m.rearmRq) continue;
    if (pendingBuy.has(e.mint)) continue;
    const held = state.positions.get(e.mint);
    if (held === undefined && slots <= 0) continue;
    if (ladderOpen >= cfg.ladderSlots) continue;
    if (m.rearmRq > 0n) m.rearms++;
    m.ladder = true;
    m.ladderOpen = true;
    m.budget = campaignBudget(cfg, state);
    m.spent = 0n;
    m.lastAddRq = rq;
    m.peakRq = rq;
    m.highSlot = batch.slot;
    ladderOpen++;
    if (held === undefined) slots -= 1;
  }

  // 2. Exits.
  for (const [mint, h] of state.positions) {
    if (orders.length >= maxOrders) break;
    const m = meta.get(mint);
    const curve = state.curves.get(mint);
    if (m === undefined || curve === undefined || h.token_amount === 0n || pendingSell.has(mint)) continue;
    if (curve.complete) { m.ladderOpen = false; continue; }
    const px = priceOf(curve);
    const rq = curve.real_quote_reserves;
    if (m.entryPrice === 0) {
      // The first batch a position is visible in is the one its buy filled in: this is the entry.
      m.entryPrice = px;
      m.peakPrice = px;
      m.peakRq = rq;
      m.highSlot = batch.slot;
      m.firstSlot = batch.slot;
      continue;
    }
    if (px > m.peakPrice) m.peakPrice = px;
    if (rq > m.peakRq) { m.peakRq = rq; m.highSlot = batch.slot; }
    const age = batch.slot - m.firstSlot;
    if (m.ladder) {
      const stalled = batch.slot - m.highSlot >= cfg.stallSlots;
      const dumped = px <= m.peakPrice * (1 - cfg.trailBps / BPS);
      const stopped = cfg.stopBps > 0 && px <= m.entryPrice * (1 - cfg.stopBps / BPS);
      if (stalled || dumped || stopped || age >= cfg.maxHoldSlots || rq >= cfg.exitRq) {
        sell(mint, h.token_amount, orders);
        m.ladderOpen = false; // the reserved slot is free for the next coin
        m.ladder = false;
        m.spent = 0n;
        m.rearmRq = m.peakRq;
        m.entryPrice = 0;
      }
    } else if (px <= m.entryPrice * (1 - cfg.probeStopBps / BPS) || age >= cfg.probeHoldSlots) {
      sell(mint, h.token_amount, orders);
    }
  }

  // 3. Add to a running campaign at each new reserve high, up to its budget.
  for (const [mint, h] of state.positions) {
    if (orders.length >= maxOrders) break;
    const m = meta.get(mint);
    const curve = state.curves.get(mint);
    if (m === undefined || !m.ladder || h.token_amount === 0n || curve === undefined || curve.complete) continue;
    if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
    if (m.spent >= m.budget) continue;
    const rq = curve.real_quote_reserves;
    const byAbs = cfg.bandLamports > 0n && rq >= m.lastAddRq + cfg.bandLamports;
    const byPct = cfg.bandBps > 0 && rq * BigInt(BPS) >= m.lastAddRq * BigInt(BPS + cfg.bandBps);
    if (!byAbs && !byPct) continue;
    const cap = state.maxBuyLamports(mint);
    const room = m.budget - m.spent;
    const amount = cap < room ? cap : room;
    if (amount < cfg.minOrderLamports) continue;
    const free = state.freeCashLamports() - BigInt(orders.length) * tx - cfg.cashReserve;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    m.spent += amount;
    m.lastAddRq = rq;
  }

  // 4. First tickets. Campaigns claim their slot first; probes take what is left, and never all of
  //    it, so the ladder always has a slot for the next coin that crosses the threshold.
  let free = state.freeCashLamports() - BigInt(orders.length) * tx - cfg.cashReserve;
  for (const e of batch.events) {
    if (orders.length >= maxOrders) break;
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (!m.ladder || m.spent > 0n) continue;
    if (state.positions.has(e.mint) || pendingBuy.has(e.mint)) continue;
    if (slots <= 0) break;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const cap = state.maxBuyLamports(e.mint);
    if (cap < cfg.minOrderLamports) continue;
    const amount = cap < m.budget ? cap : m.budget;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    m.spent += amount;
    free -= amount + tx;
    slots -= 1;
  }
  const probeSlots = caps.max_open_positions - cfg.ladderSlots;
  let probesOpen = 0;
  for (const [mint] of state.positions) {
    const m = meta.get(mint);
    if (m !== undefined && !m.ladder) probesOpen++;
  }
  for (const e of batch.events) {
    if (orders.length >= maxOrders) break;
    if (e.event === 'CompleteEvent') continue;
    const m = note(e.mint);
    if (m.probed || m.ladder) continue;
    if (probesOpen >= probeSlots) break;
    if (state.positions.has(e.mint) || pendingBuy.has(e.mint)) continue;
    if (slots <= 0) break;
    const curve = state.curves.get(e.mint);
    if (curve === undefined || curve.complete) continue;
    const cap = state.maxBuyLamports(e.mint);
    if (cap < cfg.minOrderLamports) continue;
    const amount = cap < cfg.probeLamports ? cap : cfg.probeLamports;
    if (free < amount + tx) continue;
    orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
    m.probed = true;
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
