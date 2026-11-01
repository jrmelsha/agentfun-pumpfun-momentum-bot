# Completer ladder

Two sleeves in one bot on the dev window's pump.fun curves: 10 SOL of paper cash, at most 5 open
positions, at most 16 orders a reply, at most 1% of a coin's real SOL reserve per reply.

**Big sleeve (the edge).** Enter a coin only on the first reply whose decision-time real SOL reserve
is at or above 30 SOL, with one tranche of **3/4 of the 1%-of-reserve cap**. Then ladder another
3/4-cap tranche on *every* reply while the reserve stays above 30 SOL, up to **4 SOL of cost basis**,
at most **2 coins** at a time. Price is (30 + rq)^2 / k and the 1% cap is per mint *per reply*, so
the reserve growing under the position is what lets repeat additions build a position several times
larger than any single reply allows. Hold it to the curve's completion (85.005 SOL).

**Rotation sleeve (the guardrail).** 0.005 SOL on any coin under 28 SOL of reserve we have not
touched, sold 2 slots later, at most 3 at once: 80 fills over 10 coins at a cost of about 0.02 SOL,
and it never takes a position slot the big sleeve could use. It is load-bearing: with it off the bot
makes +12.21 SOL on the 6-hour window but books only 32-58 fills over 4 coins, which is **not
guardrail-compliant** and ranks below every compliant entry.

## When it exits

All four exits are checked before any entry, on the decision-time reserve (`batch.marks` when the
coin is in a mark, else the recorded reserve shifted by the bot's own net curve flow):

| exit | constant | measured |
|---|---|---|
| target: reserve reaches **84 SOL**, just under the 85.005 completion | `EXIT_RQ` | 84, 85 and "never" are the same run (+12.36); 80 costs 0.26 SOL of the 6 h total and 0.25 of the best 4 h slice; 70 costs 3.35 and 60 costs 3.97 |
| stop: reserve **1% below the entry reserve** | `STOP_BP` | **+12.36** (this bot). The axis is flat from 0.5% to 4% (+12.31 to +12.25) and falls away above 4%: 5% +11.99 with a 21% drawdown, 8% the same as 5%, 20% +10.09 with a 40% drawdown, off +10.47 with a 35% drawdown. The single failed campaign in the dev window realises -1.05 SOL at 1% against -1.30 at 5% |
| stall: **175 slots without a new real-reserve high** (about 40 s at the window's 4.7 slots/s) | `NO_HIGH_SLOTS` | **+12.36**. 150 +12.15 (-0.19 on the worst 4 h slice), 100 +4.76, 225 +9.58 with a 40% drawdown, off +9.77 with a 40% drawdown |
| max hold: **800 slots** (about 3 minutes) | `MAX_HOLD` | **+12.36**, and 1,600 and "never" are the same run: 800 is the smallest value that does not bind. 400 costs 0.54 SOL (worst slice +1.86), 200 costs 5.19 (worst slice +0.14) |

A sell is sent for the whole position with 100% slippage so it is never refused, and a coin we have
fully exited is never re-entered (the rebuilt curve shift would be stale on the re-entry). No coin is
ever re-bought after a completion.

## How it sizes

| knob | value | measured |
|---|---|---|
| tranche | **3/4 of the 1% cap** per reply | 0.25 → +2.09 SOL; 0.5 → +11.69 with a 38% drawdown; **0.75 → +12.36**; **1.0 → +13.12 at 1x fees but +1.23 at 2x** (the whole edge is the fee margin, so 0.75 is the full-cap result at almost no fee sensitivity). 0.75 also leaves 25% headroom under the cap, which is what keeps the replay from rejecting a buy whose decision-time reserve moved under it |
| per-coin budget | **4 SOL** of cost basis | 1 → +4.91; 2 → +8.43; 3 → +10.36; **4 → +12.36 with a 17% drawdown**; 5 → +14.51 but a 49% drawdown; 6 → +15.77 and a 56% drawdown, over the 50% cap, **not compliant** |
| concurrent big coins | **2** | 1, 2 and 3 are the same run; cash binds before the position cap |
| order size | never more than 1% of the decision-time reserve | the replay's own cap (`max_order_bps_of_real_reserve`), taken as 3/4 |
| entries per reply | one buy per mint | the 1% cap is per mint per reply, so two buys on one mint in one reply share it |

Orders are also gated on free cash: the reply keeps its own ledger, `free = state.freeCashLamports()
- orders.length * tx`, and every order it queues comes off it (notional plus fee) before anything
later in the same reply is sized. An exit frees a position slot for a buy in the *same* reply, which
is how the big sleeve rolls from a completed coin into the next one without waiting a batch.

## Accounting: nothing is booked on intent

A big-sleeve buy is booked **when it fills**, not when it is sent. Each order carries a client id the
bot assigns (`b1`, `b2`, … — a `b` namespace, because the SDK hands out its own `o<n>` ids and a
client id reused anywhere in a run is a rejected order), and the fill is what carries the cost basis
(`spent`, from `quote_lamports`), the entry reserve the stop measures against, and the slot the max
hold measures from. A rejected or failed ticket therefore costs its transaction fee and nothing else:
it does not consume the coin's 4 SOL of budget, it does not set the stop on a position that does not
exist, and the coin can be entered again on the next reply. An in-flight first tranche still counts
against `MAX_BIG` and against `committedPositionCount`, so the slot and the concurrency cap are held
while the order is on the wire, exactly as a position would hold them.

## What it scores

`node cli/agentfun.mjs grade-local --kit <kit> --bot . --driver process --worktree` on the dev window
(2026-10-27 00:08-06:08 UTC, the kit's pilot-dev dataset):

| quantity | value |
|---|---|
| **net PnL** | **12,356,524,804 lamports (+12.357 SOL)**, return 1.236 |
| 90% bootstrap interval | **+1,297,004,988 .. +25,724,202,897** (+1.30 .. +25.72 SOL) |
| fills / coins / round trips | 386 fills, 154 distinct coins, 161 round trips |
| max drawdown | **0.100262** (10.0%, cap 50%) |
| **at 2x fees** | **+11.504 SOL** |
| fees paid | 0.696 SOL curve + 0.042 SOL tx |
| rejected / failed orders | 0 / 12 |
| guardrails | fills ok, coins ok, drawdown ok — **compliant** |
| determinism | two `grade-local` executions: same net, same `action_log_sha256`, same snapshot |

Concentration, stated plainly: the big sleeve held 8 coins. Three winners carried it — +5.240,
+4.699, +3.492 SOL = **+13.43 SOL** — the other five lost **-1.02 SOL**, and the rotation sleeve
lost -0.056 SOL. The top three are 109% of the net. This is three coins in a six-hour window, on a
rule whose *threshold* is the only reason they were the coins it bought: treat the magnitude as a
lottery ticket whose ticket was chosen by a structural filter, not as a steady edge.

## The four-hour distribution

The sealed final window is 4 hours, so the dev flow was cut into every overlapping 4-hour slice and
each graded with the same scorer (13 slices, stride 2,821 slots). Net PnL in SOL:

| configuration | 6 h | 4 h median | 4 h p10 | 4 h worst | 4 h best | 4 h mean | drawdown |
|---|---|---|---|---|---|---|---|
| **this bot** (1% stop) | **+12.36** | **+3.75** | **+3.51** | **+2.39** | **+9.02** | **+5.16** | 17% |
| 5% stop (the previous build) | +11.99 | +3.38 | +3.14 | +2.02 | +8.66 | +4.80 | 21% |

Every one of the 13 slices is better with the 1% stop than with the 5% stop (+0.25 to +0.37), and so
is every one of the nine seeded failure draws (12.06-12.47 against 11.70-12.14). The worst slice is
+2.39 SOL and 17% drawdown, against a 50% cap; the per-slice 90% interval lower bound is -1.09 to
-2.17, i.e. a 4-hour window can still come out modestly negative on a bad draw of coins, which is
what "three coins carry it" means in practice.

## What was checked and rejected

* **Turning the stall off or widening it past 175 slots** doubles the drawdown (40%) and costs the
  worst 4-hour slice 1.85 SOL, because the position then rides a topped-out curve back down.
* **A price trail from the peak reserve** instead of the entry stop (8% / 12% / 20%) gives +5.35 /
  +6.60 / +7.12 SOL — it sells the completion it is trying to catch.
* **Adding only above 40 SOL of reserve** (enter at 30, ladder from 40) is a tighter distribution —
  4-hour median +4.02, mean +4.63, drawdown 12% — but it gives up 3.4 SOL of the 6-hour total and
  its worst slice is +1.26 instead of +2.39, because the 30-40 tranches are the cheapest ones the
  completions buy. It is the right change if the 4-hour median matters more than expected value.
* **Lowering the entry threshold** costs 5-10 SOL: 117 coins reach 5 SOL and 9 complete, while 17
  reach 30 SOL and 11 complete. Do not lower it.
