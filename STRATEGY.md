# Strategy: survivor ladder

One pump.fun SOL bonding curve is a price function of the SOL the coin has really raised: price is
`(30 + real SOL reserve)^2 / k`, and the curve completes (migrates) at about 85 SOL of real reserve.
So the whole game is to be holding a coin while its real reserve climbs and to be out before it
gives the money back. Two sleeves share the five position slots.

## What it trades on

**Probes.** Every coin in the replay universe gets one small ticket (0.04 SOL, or the size cap when
that is smaller) on the first batch the size cap can fund. This sleeve is roughly break-even on its
own; it is what books the fill and coin counts the guardrails ask for.

**Campaigns.** A coin becomes a campaign candidate the first time its real SOL reserve reaches
30 SOL: a curve that has taken that much real money has other traders carrying it, and getting to
completion rises steeply with the reserve already in the curve (on the dev window: 14% of the coins
that reached 5 SOL completed, 31% at 10, 65% at 20, 73% at 30, 92% at 50). A campaign buys the size
cap again at every **new reserve high** of 0.2%, which is what separates the coins that went on to
complete from the ones that topped out and decayed.

Nothing else is read: no volume, no buyer counts, no age, no trade counts. On this data those
features were noise; the reserve itself is the flow.

The threshold is the whole sizing decision, and it is measured, not assumed: on the dev window the
same bot with the threshold at 5 SOL makes −7.47 SOL (drawdown 78.6%, guardrail missed), at 10 SOL
−4.31 SOL (drawdown 57.0%, guardrail missed), at 20 SOL +5.9 SOL, at 30 SOL +8.7 SOL (drawdown
5.9%). Early entries do pay a bigger multiple at completion (9.6x at 5 SOL), but only 14% of the
coins that reach 5 SOL ever complete, and a campaign puts 1–8 SOL behind that bet instead of a
0.04 SOL probe.

## How it sizes

- Orders are capped by the replay at 1% of the coin's decision-time real SOL reserve
  (`state.maxBuyLamports`, and the bot recomputes the replay's own-flow shift for re-entries), and a
  campaign always spends that cap, so the ticket grows with the coin: about 0.3 SOL a tranche at
  30 SOL of reserve, 0.5 at 50, 0.8 at 80.
- A campaign's budget is 60% of the cash in hand when its first tranche fills, clamped to 0.5–8 SOL
  and reduced by what the campaigns already running may still spend; when that leaves less than
  0.5 SOL no campaign is opened at all. At most 3 campaigns run (or are armed) at once.
- Each order pays the 5,000 + 100,000 lamport transaction fee, counted against the free cash before
  anything is sent, and 0.02 SOL is kept back.
- Probes are 0.04 SOL, and at most 2 probe positions are held at once so the ladder always has a
  slot for the next coin that crosses the threshold. Orders under 0.02 SOL are skipped.

## When it exits

- **Campaign:** a stall (no new reserve high for 150 slots, about 60 s), a 10% drop below the price
  the campaign opened at (the fill of its first tranche, or the point where a held probe crossed
  the threshold), a 50% drop from its peak price, 12,000 slots (about 80 minutes), or the curve's
  completion (the replay closes the position itself).
- **Probe:** an 8% drop below the price its ticket filled at, or 200 slots (about 80 s).
- All sells are sent for the whole position with maximum slippage so they are never refused.
- Nothing is ever re-bought after a completed coin; there is one probe and one campaign per coin.
  A coin that stalls and later prints a new high above the campaign's high-water reserve can be
  re-entered (`maxRearms`), but that is set to 0 because one re-entry measured −0.3 SOL on this
  window: it paid the round trip more often than it caught a second leg.

## Accounting

Nothing is booked on intent. A campaign exists only once its first tranche has **filled**: until
then it holds no slot and no budget, so a skipped or rejected ticket cannot strand either. Spend in
a campaign is read back from the position the account reports (cost of the tokens still held, fees
included), and a probe counts as spent only once its ticket has filled. A ticket that comes back
rejected or failed is retried, at most 8 times in all, and dropped. At most one order per coin per
reply is sent (a hot coin can trade more than once in a slot). A campaign whose position is gone —
sold, or closed by the replay on completion — releases its slot and budget the next batch.

## What it scores

On the dev window (6 h, 2026-10-27 00:08–06:08 UTC), `node cli/agentfun.mjs grade-local
--driver process --worktree`: **net PnL +8,730,529,628 lamports (+8.73 SOL on 10 SOL), 324 fills
over 139 coins, maximum drawdown 5.9%, guardrails met** (bar: 80 fills over 10 coins, drawdown 50%
or less); at 2x fees +6.92 SOL, by-coin 90% bootstrap interval +0.58 to +19.35 SOL.

The tail is concentrated and the note should say so: two completions carry most of it. But the rest
of the book is positive — strip the two winning coins and the other 137 coins are +0.87 SOL, which
is what the ladder is for: it pays the transaction fees and the small stops on every coin that does
not complete, and is paid by the few that do. It is a positive-expectancy lottery, not a steady
edge, and on a window with no completion-shaped move it would score around zero rather than a
profit.
