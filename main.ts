// Starter: a rotation bot that meets this competition's guardrails (at least 80 fills over at least
// 10 coins, a maximum drawdown of 50% or less). It is a working starting point, not a strategy that
// wins: it meets the guardrails on the dev window and on the final window, and on the dev window it
// makes roughly 300 fills over about 150 coins with a maximum drawdown near 5% and loses about 0.4 SOL
// after fees, so it ranks but takes no prize (a prize needs a net PnL above 0).
//
// What it does: it buys a small stake (STAKE_LAMPORTS) in each new coin once the size cap lets it buy
// at least MIN_BUY_LAMPORTS, holds it HOLD_SLOTS slots, then sells everything, keeping at most
// hello.caps.max_open_positions coins at a time. Every coin it takes is one buy and one sell, so it
// makes many fills over many coins.
//
// Laid out as your repository: the grader runs `node /bot/main.ts` with this directory as /bot, and the
// SDK (the kit's sdk/ts/agentfun-bot.ts) is vendored at vendor/agentfun-bot.ts. Copy the directory into
// a new repository, have your agent change the strategy and rewrite STRATEGY.md to match, grade it on
// the dev window (node cli/agentfun.mjs grade-local), then check it before submitting (node
// cli/agentfun.mjs check): the transcript gate wants the code written in the agent sessions you upload.
import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/agentfun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL a coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: smaller buys are not worth the fees
const HOLD_SLOTS = 150; // about a minute
const MAX_SLIPPAGE_BPS = 2_000;

const candidates = new Set<string>();
const boughtAt = new Map<string, number>();

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    // Exits first: sell what has been held long enough.
    for (const [mint, h] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const at = boughtAt.get(mint) ?? batch.slot;
      if (!boughtAt.has(mint)) boughtAt.set(mint, at);
      if (pendingSell.has(mint) || batch.slot - at < HOLD_SLOTS || h.token_amount === 0n) continue;
      if (state.curves.get(mint)?.complete) continue;
      orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: 10_000 });
    }
    // Entries: new coins, in event order, while a position slot and the cash are free.
    let free = state.freeCashLamports() - BigInt(orders.length) * tx;
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') candidates.add(e.mint);
      if (!candidates.has(e.mint)) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(e.mint);
        continue;
      }
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      candidates.delete(e.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      boughtAt.set(e.mint, batch.slot);
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
