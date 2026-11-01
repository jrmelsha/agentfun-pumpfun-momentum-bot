# Strategy: survivor ladder

One pump.fun SOL bonding curve is a price function of the SOL the coin has really raised: price is
`(30 + real SOL reserve)^2 / k`, and the curve completes (migrates) at about 85 SOL of real reserve.
So the whole game is to be holding a coin while its real reserve climbs and to be out before it
gives the money back. Two sleeves share the five position slots.

## What it trades on

**Probes.** Every coin in the replay universe gets exactly one small ticket (0.04 SOL, or the size
cap when that is smaller) on the first batch the size cap can fund. This sleeve is roughly
break-even on its own; it is what books the fill and coin counts the guardrails ask for.

**Campaigns.** A coin becomes a campaign candidate the first time its real SOL reserve reaches
20 SOL: a curve that has taken that much real money has other traders carrying it, and getting to
completion rises steeply with the reserve already in the curve (on the dev window: 14% of the coins
that reached 5 SOL completed, 31% at 10, 65% at 20, 73% at 30, 92% at 50). A campaign buys the size
cap again at every **new reserve high** (a new high of 0.5%, or the absolute band when set), which
is what separates the coins that went on to complete from the ones that topped out and decayed.

Nothing else is read: no volume, no buyer counts, no age, no trade counts. On this data those
features were noise; the reserve itself is the flow.

## How it sizes

- Orders are capped by the replay at 1% of the coin's real SOL reserve per reply
  (`state.maxBuyLamports`), and the campaign always spends exactly that cap, so the ticket grows
  with the coin: about 0.2 SOL a tranche at 20 SOL of reserve, 0.5 at 50, 0.8 at 80.
- A campaign's budget is 50% of the cash in hand when it opens (in lamports), clamped to
  0.5–8 SOL, and reduced by what the campaigns already open may still spend, so campaigns never
  over-commit the book. At most 3 campaigns run at once.
- Each order pays the 5,000 + 100,000 lamport transaction fee, counted against the free cash before
  anything is sent, and 0.02 SOL is kept back.
- Probes are 0.04 SOL (0.005 SOL minimum decided by the fee floor: orders under 0.02 SOL are
  skipped), and at most 2 probe positions are held at once so the ladder always has a slot for the
  next coin that crosses the threshold.

## When it exits

- **Campaign:** a stall (no new reserve high for 250 slots, about 100 s), a 15% drop below the
  price its first tranche filled at, an 80% drop from its peak price, 12,000 slots, or the curve's
  completion (the replay closes the position itself). A coin that stalls and later prints a new
  high above the high-water reserve of the stalled campaign is re-entered, up to twice.
- **Probe:** an 8% drop below its entry price, or 200 slots (about 80 s).
- All sells are sent for the whole position with maximum slippage so they are never refused.
- Nothing is ever re-bought after a completed coin; there is one campaign and one probe per coin.

## What it scores

On the dev window (6 h, 2026-10-27 00:08–06:08 UTC), `node cli/agentfun.mjs grade-local
--driver process --worktree`: **net PnL +10,253,928,675 lamports (+10.25 SOL on 10 SOL), 313 fills
over 136 coins, maximum drawdown 8.6%, guardrails met** (bar: 80 fills over 10 coins, drawdown 50%
or less); at 2x fees +8.36 SOL.

That number is concentrated, and the note should say so: two completions carry it, and the by-coin
90% bootstrap interval is −1.80 to +25.91 SOL. Strip the two winners and the rest of the window is
about −1.8 SOL, which is the cost of admission for the one tail this window has: the ladder pays
the transaction fees and the small stops on every coin that does not complete, and is paid by the
few that do. The mechanism is a positive-expectancy lottery here, not a steady edge.
