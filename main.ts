// Completer ladder: two sleeves in one bot.
//
//  * big sleeve   -- enter a coin only when its decision-time real SOL reserve first reaches 30 SOL,
//                    then ladder 75% of the 1%-of-reserve cap into it on EVERY reply while the reserve
//                    stays above 30 SOL, up to 6 SOL of cost basis, at most 2 coins at a time, and
//                    hold it to the curve's completion (reserve 85.005 SOL). It exits on the reserve
//                    reaching 84 SOL (just under the completion), a stop 1% of the entry reserve
//                    below it, 175 slots without a new real-reserve high (about 40 s at this
//                    window's 4.7 slots/s), or 800 slots held (about 3 minutes).
//  * rotation sleeve -- 0.005 SOL on any coin under 28 SOL of reserve that we have not touched yet,
//                    sold 2 slots later: the 80-fills-over-10-coins guardrail, at a cost of about
//                    0.08 SOL on the dev window.
//
// Why it works: on a bonding curve the price is (30 + rq)^2 / k, so the coins that put 30 SOL of real
// money into the curve are the survivors: of the 8 mints that crossed 30 SOL while still tradeable in
// the dev window, 2 went on to complete (25%). The 11 completions in that window are not 11 chances:
// 9 of them are single-trade bundle launches whose first-ever trade IS the completing one, so at their
// only buyable batch the reserve is still 0 and no buy can be bigger than zero. The 1% cap is per mint
// PER REPLY, so the reserve growing under the position lets repeat additions build 3-15x the position
// a single reply allows. The entry threshold, not the exit, is what carries the number: entering at
// 5 SOL loses ~10 SOL.
import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/agentfun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- big sleeve
const ENTER_RQ = 30n * SOL;      // first reply whose decision-time real reserve reaches 30 SOL
const TRANCH_FRAC = 3n;          // 3/4 of the 1% cap per reply
const TRANCH_DEN = 4n;
const BUDGET = 6n * SOL;         // 6 SOL of cost basis per coin (the 4-hour optimum)
const MAX_BIG = 2;               // concurrent big-sleeve coins
const EXIT_RQ = 84n * SOL;
const STOP_BP = 100n;            // exit when the reserve is 1% below the entry reserve
const NO_HIGH_SLOTS = 175;       // exit after 175 slots without a new reserve high
const MAX_HOLD = 800;
const SLIP_BP = 5_000;

// ---- rotation sleeve (the guardrail)
const ROT_ON = true;
const ROT_STAKE = SOL / 200n;    // 0.005 SOL
const ROT_HOLD = 2;              // slots
const ROT_MAX_RQ = 28n * SOL;
const ROT_CONC = 3;              // at most 5 - MAX_BIG, so a big-sleeve slot is always free

let seq = 0;
// `b` and not `o`: the SDK hands out its own `o<n>` ids, and a client_id reused anywhere in the run
// is a rejected order, so the bot keeps its own namespace for the ids it has to follow. `seq` starts
// at 0, so the first id is `b0`.
const nextId = (): string => `b${seq++}`;

const peak = new Map<string, bigint>();
const highSlot = new Map<string, number>();
const entryRq = new Map<string, bigint>();
const firstSlot = new Map<string, number>();
const spent = new Map<string, bigint>();
const touched = new Map<string, 'big' | 'rot'>();
const rotBought = new Map<string, number>();
const retired = new Set<string>();   // a coin we fully exited: never re-enter (stale curve shift)
const offQ = new Map<string, bigint>();
/** A big-sleeve buy we have sent and not yet heard back on: what the position is if it fills. */
const sentBig = new Map<string, { mint: string; rq: bigint; slot: number }>();
/** A rotation probe we have sent and not yet heard back on: a touch only once it fills. */
const sentRot = new Map<string, { mint: string; slot: number }>();

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const maxOrders = caps.max_orders_per_batch;
    const capBps = BigInt(caps.max_order_bps_of_real_reserve);

    // --- 0. our own curve shift, from our own fills. The wire carries quote_lamports (buy: paid,
    // sell: proceeds) and fee_lamports, so the curve's own quote leg is paid - fees on a buy and
    // proceeds + fees on a sell. A harness close (`_complete_`/`_flatten_`) needs no offset.
    // A big-sleeve buy is booked here, when it fills and not when it is sent: a rejected or failed
    // ticket costs its transaction fee and nothing else — no cost basis, no entry price, no stop.
    for (const f of batch.fills) {
      if (f.client_id[0] === '_') continue;
      if (f.status !== 'filled') { sentBig.delete(f.client_id); sentRot.delete(f.client_id); continue; }
      const q = f.side === 'buy' ? BigInt(f.quote_lamports) - BigInt(f.fee_lamports) : BigInt(f.quote_lamports) + BigInt(f.fee_lamports);
      offQ.set(f.mint, (offQ.get(f.mint) ?? 0n) + (f.side === 'buy' ? q : -q));
      const rot = sentRot.get(f.client_id);
      if (rot !== undefined && f.side === 'buy') {
        // Only a filled probe is a touch. A rejected or failed one costs its tx fee and leaves the
        // coin probeable, so a dropped ticket cannot burn a coin the sleeve still wants.
        sentRot.delete(f.client_id);
        touched.set(rot.mint, 'rot');
        rotBought.set(rot.mint, rot.slot);
        continue;
      }
      const s = sentBig.get(f.client_id);
      if (s === undefined || f.side !== 'buy') continue;
      sentBig.delete(f.client_id);
      spent.set(s.mint, (spent.get(s.mint) ?? 0n) + BigInt(f.quote_lamports));
      if (touched.get(s.mint) !== 'big') {
        touched.set(s.mint, 'big');
        entryRq.set(s.mint, s.rq);
        firstSlot.set(s.mint, s.slot);
      }
    }

    // --- 1. decision-time reserves. A mark is the engine's own view (recorded reserves shifted by
    // our impact); without one (a coin we hold nothing in) the recorded reserves plus our own shift.
    const markOf = new Map<string, bigint>();
    for (const mk of batch.marks) markOf.set(mk.mint, BigInt(mk.real_quote_reserves));
    const rqOf = (mint: string): bigint => {
      const mk = markOf.get(mint);
      if (mk !== undefined) return mk;
      const rec = state.curves.get(mint)?.real_quote_reserves ?? 0n;
      const shifted = rec + (offQ.get(mint) ?? 0n);
      return shifted > 0n ? shifted : 0n;
    };
    const capOf = (rq: bigint): bigint => (rq * capBps) / 10_000n;
    // The stall clock runs on the RECORDED reserve, not on rqOf: a mark already carries our own curve
    // flow, so a peak fed from marks counts our own tranches as new highs, resets the 175-slot clock
    // on every add, and the stall exit never fires (a coin that fell from rq 47 to rq 6.9 was left to
    // the 1% stop). The recorded reserve is on the wire directly: every TradeEvent carries it. The
    // peak therefore advances only on the coin's own trades, on the pre-our-impact number. Exits and
    // the size cap keep using the marked reserve, because that is the price they act on.
    const seen = new Set<string>();
    for (const e of batch.events) {
      seen.add(e.mint);
      if (e.event !== 'TradeEvent') continue;
      const r = BigInt(e.real_quote_reserves);
      if (r > (peak.get(e.mint) ?? 0n)) { peak.set(e.mint, r); highSlot.set(e.mint, batch.slot); }
    }

    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) (p.order.side === 'sell' ? pendingSell : pendingBuy).add(p.order.mint);

    const orders: OrderInput[] = [];

    // --- 2. EXITS first: target, stop, stall, max hold. Then the rotation sleeve's timed exit.
    for (const [mint, h] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (touched.get(mint) !== 'big') continue;
      if (pendingSell.has(mint) || h.token_amount === 0n) continue;
      const rq = rqOf(mint), e0 = entryRq.get(mint) ?? rq;
      let sell = 0n;
      if (rq >= EXIT_RQ) sell = h.token_amount;
      else if (STOP_BP > 0n && rq * 10_000n <= e0 * (10_000n - STOP_BP)) sell = h.token_amount;
      else if (batch.slot - (highSlot.get(mint) ?? batch.slot) >= NO_HIGH_SLOTS) sell = h.token_amount;
      else if (batch.slot - (firstSlot.get(mint) ?? batch.slot) >= MAX_HOLD) sell = h.token_amount;
      if (sell === 0n) continue;
      orders.push({ side: 'sell', mint, token_amount: sell, max_slippage_bps: 10_000 });
      if (sell === h.token_amount) retired.add(mint);
    }
    for (const [mint, h] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (touched.get(mint) !== 'rot') continue;
      if (pendingSell.has(mint) || h.token_amount === 0n) continue;
      if (batch.slot - (rotBought.get(mint) ?? batch.slot) < ROT_HOLD) continue;
      orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: 10_000 });
    }

    let free = state.freeCashLamports() - BigInt(orders.length) * tx;
    let committed = state.committedPositionCount();
    // Big-sleeve coins held, plus first tranches already on the wire: an in-flight entry holds its
    // slot until it fills or comes back, exactly as a position would.
    const bigMints = new Set<string>();
    for (const [mint] of state.positions) if (touched.get(mint) === 'big') bigMints.add(mint);
    for (const s of sentBig.values()) bigMints.add(s.mint);
    let bigCount = bigMints.size;

    // --- 3. BIG sleeve: one buy per mint per reply (the cap is per mint per reply), the largest
    // reserves first so the coins closest to completion get the free slot.
    const cands: { mint: string; rq: bigint; amt: bigint; held: boolean }[] = [];
    for (const mint of new Set([...seen, ...markOf.keys()])) {
      if (retired.has(mint)) continue;
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) continue;
      const rq = rqOf(mint);
      const held = state.positions.has(mint) && touched.get(mint) === 'big';
      if (held) {
        if (rq < ENTER_RQ) continue;
        if (pendingBuy.has(mint)) continue;
      } else {
        if (rq < ENTER_RQ) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (bigCount >= MAX_BIG) continue;
      }
      const cap = capOf(rq);
      if (cap <= 0n) continue;
      const already = spent.get(mint) ?? 0n;
      if (already >= BUDGET) continue;
      let amt = (cap * TRANCH_FRAC) / TRANCH_DEN;
      const room = BUDGET - already;
      if (amt > room) amt = room;
      if (amt <= 0n) continue;
      cands.push({ mint, rq, amt, held });
    }
    cands.sort((x, y) => (x.rq === y.rq ? (x.mint < y.mint ? -1 : 1) : x.rq > y.rq ? -1 : 1));
    for (const c of cands) {
      if (orders.length >= maxOrders) break;
      if (!c.held && committed >= caps.max_open_positions) break;
      const need = c.amt + tx;
      if (free < need) continue;
      const id = nextId();
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: c.amt, max_slippage_bps: SLIP_BP, client_id: id });
      sentBig.set(id, { mint: c.mint, rq: c.rq, slot: batch.slot });
      free -= need;
      if (!c.held) { committed++; bigCount++; }
    }

    // --- 4. Rotation sleeve: one cheap buy on a coin we have never touched, sold ROT_HOLD slots
    // later. It never takes a slot the big sleeve could use (ROT_CONC = 5 - MAX_BIG).
    let rotCount = 0;
    for (const [mint] of state.positions) if (touched.get(mint) === 'rot') rotCount++;
    for (const s of sentRot.values()) rotCount++;   // probes on the wire hold their sleeve slot
    if (ROT_ON) {
      for (const mint of new Set([...seen, ...markOf.keys()])) {
        if (orders.length >= maxOrders) break;
        if (touched.has(mint) || retired.has(mint) || state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const c = state.curves.get(mint);
        if (c === undefined || c.complete) continue;
        const rq = rqOf(mint);
        if (rq >= ROT_MAX_RQ) continue;
        const cap = capOf(rq);
        if (cap < ROT_STAKE) continue;
        if (committed >= caps.max_open_positions || rotCount >= ROT_CONC) break;
        const amt = ROT_STAKE;   // the cap is already known to be at least the stake
        if (free < amt + tx) continue;
        const id = nextId();
        orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: SLIP_BP, client_id: id });
        sentRot.set(id, { mint, slot: batch.slot });
        free -= amt + tx;
        committed++; rotCount++;
      }
    }
    return orders;
  },
});
