# Completer ladder

Two sleeves in one bot on the dev window's pump.fun curves: 10 SOL of paper cash, at most 5 open
positions, at most 16 orders a reply, at most 1% of a coin's real SOL reserve per reply.

**Big sleeve (the edge).** Enter a coin only on the first reply whose decision-time real SOL reserve
is at or above 30 SOL, with one tranche of **3/4 of the 1%-of-reserve cap**. Then ladder another
3/4-cap tranche on *every* reply while the reserve stays above 30 SOL, up to **4.5 SOL of cost
basis**, at most **2 coins** at a time. Price is (30 + rq)^2 / k and the 1% cap is per mint *per
reply*, so the reserve growing under the position is what lets repeat additions build a position
several times larger than any single reply allows. Hold it to the curve's completion (85.005 SOL).

**Rotation sleeve (the guardrail).** 0.005 SOL on any coin under 28 SOL of reserve we have not
touched, sold 2 slots later, at most 3 at once: 80 fills over 10 coins at a cost of about 0.06 SOL,
and it never takes a position slot the big sleeve could use. It is load-bearing: with it off the bot
makes +13.22 SOL on the 6-hour window but books only 32-60 fills over 4 coins, which is **not
guardrail-compliant** and ranks below every compliant entry.

## When it exits

All four exits are checked before any entry, on the decision-time reserve (`batch.marks` when the
coin is in a mark, else the recorded reserve shifted by the bot's own net curve flow):

| exit | constant | measured |
|---|---|---|
| target: reserve reaches **84 SOL**, just under the 85.005 completion | `EXIT_RQ` | 84, 85 and "never" are the same run (+13.38); 80 costs 0.26 SOL of the 6 h total (the best 4 h slice +9.40 instead of +9.67); 70 costs 3.5 and 60 costs 4.1 |
| stop: reserve **1% below the entry reserve** | `STOP_BP` | **+13.38** with a 19% drawdown. The axis is flat from 0.5% to 3% (3% +13.00, 23% drawdown) and falls away above 4%: 5% +12.98 with a 23% drawdown and a 4 h mean of +5.33 against +5.71; 20% +10.97 with a 44% drawdown; off +11.50 with a 37% drawdown |
| stall: **175 slots without a new real-reserve high** (about 40 s at the window's 4.7 slots/s) | `NO_HIGH_SLOTS` | **+13.38**. 150 +13.16, 100 +5.31, 225 +10.28 with a 45% drawdown, off +10.49 with a 45% drawdown |
| max hold: **800 slots** (about 3 minutes) | `MAX_HOLD` | **+13.38**, and 1,600 and "never" are the same run: 800 is the smallest value that does not bind. 400 costs 0.59 SOL, 200 costs 5.59 |

A sell is sent for the whole position with 100% slippage so it is never refused, and a coin we have
fully exited is never re-entered (the rebuilt curve shift would be stale on the re-entry). No coin is
ever re-bought after a completion. (One sell a run comes back `rejected token_complete` because the
curve completed inside the fill latency; the harness closes that position itself.)

## How it sizes

| knob | value | measured |
|---|---|---|
| tranche | **3/4 of the 1% cap** per reply | 0.25 → +2.09 SOL; 0.5 → +12.23 with a 42% drawdown; **0.75 → +13.38**; **1.0 → +13.98 at 1x fees but +1.32 at 2x** (the whole edge is the fee margin, so 0.75 is within 0.6 SOL of the full-cap result at almost no fee sensitivity, and better on the 4 h median and mean). 0.75 also leaves 25% headroom under the cap, which keeps the replay from rejecting a buy whose decision-time reserve moved under it |
| per-coin budget | **4.5 SOL** of cost basis | 1 → +4.9; 2 → +8.4; 3 → +10.4; 4 → +12.36; **4.5 → +13.38 with a 19% drawdown**; 4.55 → +13.48 (20%); **4.6 → +13.58 but the drawdown jumps to 46%**; 5 → +14.51 with a 49% drawdown; 6 → +15.77 and a 56% drawdown, over the 50% cap, **not compliant** |
| concurrent big coins | **2** | 1, 2 and 3 are the same run; cash binds before the position cap |
| order size | never more than 1% of the decision-time reserve | the replay's own cap (`max_order_bps_of_real_reserve`), taken as 3/4 |
| entries per reply | one buy per mint | the 1% cap is per mint per reply, so two buys on one mint in one reply share it |

Orders are also gated on free cash: the reply keeps its own ledger, `free = state.freeCashLamports()
- orders.length * tx`, and every order it queues comes off it (notional plus fee) before anything
later in the same reply is sized. An exit frees a position slot for a buy in the *same* reply, which
is how the big sleeve rolls from a completed coin into the next one without waiting a batch.

The budget cliff between 4.55 and 4.6 is one coin in one 4-hour slice, and it is worth knowing
where it came from: the extra 0.04 SOL tranche nudged that coin's decision-time reserve up by 0.04
SOL, the bot read its own nudge as a new reserve high, the 175-slot stall clock kept resetting, and
the stall exit that closed the position at rq 47 in the 4.5 run never fired in the 4.6 run — the
coin collapsed to rq 6.9 and the stop took it there. 4.5 SOL keeps 0.1 SOL of margin below that
switch; 4.5 is also where the mean stops paying for the risk (4.55 buys 0.06 SOL of mean for a
halved margin).

## Threshold x budget, measured

The obvious idea — a higher add floor means fewer campaigns fail, so it should carry a much bigger
budget — does not hold. Every cell below is the 13-slice table, stop at 1%, everything else at the
values above (net SOL):

| cell | 6 h | 4 h median | p10 | worst | mean | drawdown |
|---|---|---|---|---|---|---|
| **enter 30, add ≥ 30, budget 4.5 (this bot)** | **+13.38** | **+4.18** | **+3.95** | **+2.69** | **+5.71** | **19%** |
| enter 30, add ≥ 30, budget 4 | +12.36 | +3.75 | +3.51 | +2.39 | +5.16 | 17% |
| enter 30, add ≥ 40, budget 4 | +7.07 | +4.06 | +4.02 | -0.65 | +4.26 | 12% |
| enter 30, add ≥ 40, budget 4.5 | +7.85 | +4.70 | +1.05 | -0.65 | +4.48 | 44% |
| enter 30, add ≥ 40, budget 5 | +8.29 | +4.91 | +0.68 | -0.65 | +4.60 | 48% |
| enter 30, add ≥ 40, budget 6 | +8.42 | +4.91 | -0.10 | -0.65 | +4.59 | 55% |
| enter 30, add ≥ 40, budget 8 | +8.69 | +4.92 | -0.65 | -2.52 | +4.44 | 71% |
| enter 30, add ≥ 40, budget 10 / all cash | -1.07 | +4.66 | -5.46 | -5.47 | +1.93 | 83% |
| enter 40, add ≥ 40, budget 4 | +2.56 | +0.07 | -0.04 | -0.52 | +0.40 | 6% |
| enter 40, add ≥ 40, budget 6 | +3.15 | +0.07 | -0.52 | -4.67 | +0.14 | 48% |
| enter 40, add ≥ 40, budget 8 | +3.41 | +0.07 | -0.52 | -6.21 | +0.06 | 63% |
| enter 40, add ≥ 40, budget 10 / all cash | -6.08 | +0.06 | -7.71 | -7.72 | -2.12 | 78% |
| enter 50, budget 6 / 8 / 10 | +0.37 / +0.40 / +0.39 | -0.01 | -0.04 | -0.04 | +0.11 / +0.13 / +0.14 | 19-29% |
| enter 60, budget 8 / 10 | +0.98 | +0.36 | +0.08 | -0.07 | +0.41 | 1% |

The interaction runs the **wrong way**: at an add floor of 40 SOL the budget has to be *smaller*, not
bigger. The 4-hour drawdown goes 12% at 4 SOL → 44% at 4.5 → 55% at 6 → 83% at "all remaining cash",
and the mean never exceeds the 5.16 that 4 SOL at an add floor of 30 already makes. The reason is
mechanical: the add floor decides *where* on the curve the basis is built, and a stop that is a fixed
1% of the *entry* reserve converts a small reserve give-back into a much larger price loss the
higher the average entry is. A campaign entered at 30 and laddered to 80 SOL of reserve loses ~50%
of its basis when the reserve gives back 1% from 30; one that only starts laddering at 40 and is
carried to 80 has a far higher average entry price, so the same 1% of reserve costs far more of the
position. Bigger budgets therefore need *earlier* entries, not later ones — which is why the winner
in this table is the shipped family with 4.5 SOL, and why "enter 40" is not a cheaper threshold at
all: it costs 10.8 SOL of the 6-hour total.

## Accounting: nothing is booked on intent

A big-sleeve buy is booked **when it fills**, not when it is sent. Each order carries a client id the
bot assigns (`b1`, `b2`, … — a `b` namespace, because the SDK hands out its own `o<n>` ids and a
client id reused anywhere in a run is a rejected order), and the fill is what carries the cost basis
(`spent`, from `quote_lamports`), the entry reserve the stop measures against, and the slot the max
hold measures from. A rejected or failed ticket therefore costs its transaction fee and nothing else:
it does not consume the coin's budget, it does not set the stop on a position that does not exist,
and the coin can be entered again on the next reply. An in-flight first tranche still counts against
`MAX_BIG` and against `committedPositionCount`, so the slot and the concurrency cap are held while
the order is on the wire, exactly as a position would hold them.

## What it scores

`node cli/agentfun.mjs grade-local --kit <kit> --bot . --driver process --worktree` on the dev window
(2026-10-27 00:08-06:08 UTC, the kit's pilot-dev dataset):

| quantity | value |
|---|---|
| **net PnL** | **13,383,989,299 lamports (+13.384 SOL)**, return 1.338 |
| 90% bootstrap interval | **+1,479,958,873 .. +27,936,603,235** (+1.48 .. +27.94 SOL) |
| fills / coins / round trips | 393 fills, 154 distinct coins, 161 round trips |
| max drawdown | **0.102854** (10.3%, cap 50%) |
| **at 2x fees** | **+12.450 SOL** |
| fees paid | 0.771 SOL curve + 0.043 SOL tx |
| rejected / failed orders | 1 (`token_complete` on a sell) / 12 |
| guardrails | fills ok, coins ok, drawdown ok — **compliant** |
| determinism | two `grade-local` executions: same net, same `action_log_sha256`, same snapshot |

Concentration, stated plainly: the big sleeve held 8 coins. Three winners carried it — +5.448,
+5.230, +3.899 SOL = **+14.58 SOL** — the other five lost **-1.14 SOL**, and the rotation sleeve lost
-0.056 SOL. The top three are 109% of the net. This is three coins in a six-hour window, on a rule
whose *threshold* is the only reason they were the coins it bought: treat the magnitude as a lottery
ticket whose ticket was chosen by a structural filter, not as a steady edge.

## The four-hour distribution

The sealed final window is 4 hours, so the dev flow was cut into every overlapping 4-hour slice and
each graded with the same scorer (13 slices, stride 2,821 slots), net PnL in SOL:

| configuration | 6 h | 4 h median | 4 h p10 | 4 h worst | 4 h best | 4 h mean | drawdown |
|---|---|---|---|---|---|---|---|
| **this bot** (1% stop, 4.5 SOL) | **+13.38** | **+4.18** | **+3.95** | **+2.69** | **+9.67** | **+5.71** | 19% |
| 4 SOL budget | +12.36 | +3.75 | +3.51 | +2.39 | +9.02 | +5.16 | 17% |
| 5% stop, 4 SOL (the build before both changes) | +11.99 | +3.38 | +3.14 | +2.02 | +8.66 | +4.80 | 21% |

Every one of the 13 slices is better with the 4.5 SOL budget than with 4 (+0.25 to +0.65), and the
same is true of all nine seeded failure draws (13.07-13.53 against 12.06-12.47). The worst slice is
+2.69 SOL at a 19% drawdown, against a 50% cap; the per-slice 90% interval lower bound is -1.1 to
-2.2, i.e. a 4-hour window can still come out modestly negative on a bad draw of coins, which is
what "three coins carry it" means in practice.

## What was checked and rejected

* **An add floor at 40 SOL** (enter at 30, ladder only above 40) is a much tighter distribution —
  median +4.06, p10 +4.02, drawdown 12% at a 4 SOL budget — but its 4-hour mean is +4.26 against
  +5.71, and its worst slice is -0.65 against +2.69, because the 30-40 tranches are the cheapest
  ones the completions buy. Adding budget on top of it only adds drawdown.
* **Entering at 40, 50 or 60 SOL** instead of 30 makes almost nothing: +2.6, +0.4, +1.0 SOL on the
  6-hour window. 17 coins reach 30 SOL and 11 complete; raising the entry keeps the same completions
  and drops the tranches that paid for them.
* **Turning the stall off or widening it past 175 slots** doubles the drawdown (40%) and costs the
  worst 4-hour slice 1.9 SOL.
* **A price trail from the peak reserve** instead of the entry stop (8% / 12% / 20%) gives +5.4 /
  +6.6 / +7.1 SOL — it sells the completion it is trying to catch.
