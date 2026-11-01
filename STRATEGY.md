# Completer ladder

Two sleeves in one bot on the dev window's pump.fun curves: 10 SOL of paper cash, at most 5 open
positions, at most 16 orders a reply, at most 1% of a coin's real SOL reserve per reply.

**Big sleeve (the edge).** Enter a coin on the first reply whose decision-time real SOL reserve is at
or above 30 SOL, with one tranche of **3/4 of the 1%-of-reserve cap**. Then ladder another 3/4-cap
tranche on *every* reply while the reserve stays above 30 SOL, up to **6 SOL of cost basis**, at most
**2 coins** at a time. Price is (30 + rq)^2 / k and the 1% cap is per mint *per reply*, so the reserve
growing under the position is what lets repeat additions build a position several times larger than
any single reply allows. Hold it to the curve's completion (85.005 SOL).

**What the 30-SOL entry buys.** Of the 11 completions in the dev window only **2 are buyable**: 9 are
single-trade bundle launches whose first-ever TradeEvent *is* the completing trade, so at their only
buyable batch the decision-time reserve is still 0 and the engine rejects any spend of 1 lamport or
more (`engine.ts:899`: `total * BPS > decision.rq * 100`, with `decision.rq = 0`). The honest success
rate is therefore **P(complete | crossed 30 SOL while still tradeable) =
2/8 = 25%**, not the 11/17 = 65% that the raw completion count suggests. The threshold is still the
structural line: on the reachable cohort E[return per SOL] rises from 1.19x at rq 10 to 1.69x at rq 30
and is flat-to-falling beyond (1.84x at 45 rests on three coins), and backward induction on the
measured kernel — sell / do not enter below ~28 SOL, hold to completion from 30 up, V(enter) 1.012 at
30, 1.054 at 35, 1.161 at 45-47.5 — puts the exercise boundary at 28-30 and is smooth across 30-50.
That is a reason for the threshold rather than a fit to it, and it is why the 25 -> 30 -> 35 wobble of a
one-axis scan is noise. What falls above 30 is the *total*: a higher entry drops campaigns and their
cheap tranches (enter 40 makes +2.6 SOL of the 6-hour window, enter 50 nothing, enter 60 +1.0).

**Rotation sleeve (the guardrail).** 0.005 SOL on any coin under 28 SOL of reserve we have not touched,
sold 2 slots later, at most 3 at once. The guardrail is **80 fills over 10 distinct coins**; with this
sleeve off the 6-hour run books only **111 fills over 8 coins** (+15.48 SOL) and is not
compliance-eligible. It is not a profit centre: it **lost 0.082 SOL** on the dev window under this
budget (0.056 SOL at 4.5). The shipped
run books **423 fills over 158 coins** in total; 5 of those coins are the big sleeve's campaigns.

Utilisation is not the constraint and is not a lever: time-averaged exposure is **0.046 SOL of 10**
(peak 4.00), and the binding limit is the campaign count — only 8 mints cross 30 SOL while still
tradeable in six hours, and 5 of them became campaigns. No sizing, concurrency or cash-reserve knob
creates campaigns that do not exist.

## When it exits

All four exits are checked before any entry, on the decision-time reserve (`batch.marks` when the coin
is in a mark, else the recorded reserve shifted by the bot's own net curve flow):

| exit | constant | measured |
|---|---|---|
| target: reserve reaches **84 SOL**, just under the 85.005 completion | `EXIT_RQ` | **+15.62 SOL**. 84 and 85 are the same run (the completion closes it first); 80 costs 0.29 of the 6 h total, 70 costs 3.6 |
| stop: reserve **1% below the entry reserve** | `STOP_BP` | **+15.62**. The axis is flat from 0.5% to 3% (median +4.83 / +5.00 / +4.90) and falls away above 4%: 5% +14.51 with a 39% worst-slice drawdown, 10% +14.47, off +12.81 with 54% |
| stall: **175 slots without a new real-reserve high** (about 40 s at the window's 4.7 slots/s) | `NO_HIGH_SLOTS` | **+15.62**. Flat across 150-225 (150: +15.67 median +5.34; 225: +16.24 median +4.99, worst slice +3.96); 100 still makes the best median (+6.12) but loses 7.8 SOL of 6 h and drops the worst slice to +1.36; 300 or off is +11.72 with a 57% drawdown |
| max hold: **800 slots** (about 3 minutes) | `MAX_HOLD` | **+15.62**, and 1,600 and "never" are the same run: 800 is the smallest value that does not bind. 400 costs 0.78 SOL and 0.78 of the worst slice, 200 costs 6.7 |

**The stall clock runs on the coin's recorded reserve, not on the marked one.** `batch.marks` already
carries the bot's own curve flow, so a peak fed from marks counts our own tranches as new highs: the
175-slot clock reset itself on every add, the stall exit never fired, and a coin that fell from rq 47
to rq 6.9 was left to the 1% stop. The recorded reserve is on the wire directly — every `TradeEvent`
carries `real_quote_reserves` — so the peak now advances only on the coin's own trades, on the
pre-our-impact number. That one line is what un-sticks the budget axis: at 4.6 SOL the old clock left
DM2JikiT at **-3.62 SOL** (from +0.05 at 4.5), a slice at a 46% drawdown and a +0.63 SOL minimum;
with the recorded clock the same 4.6 SOL budget holds a 19.7% worst-slice drawdown and a +2.75 SOL
minimum, and the whole 4-10 SOL axis is smooth.

A sell is sent for the whole position with 100% slippage so it is never refused, and a coin we have
fully exited is never re-entered (the rebuilt curve shift would be stale on the re-entry). No coin is
ever re-bought after a completion. (Two sells a run come back `rejected token_complete` because the
curve completed inside the fill latency; the harness closes that position itself.)

**The completion close is priced on the pristine curve.** At a completion the recorded real token
reserve is 0, so `offsetReserves` clips the bot's whole net curve flow to zero and the harness closes
the position at the pristine completion price. That is a structural cost of about **-2.24 SOL** on the
11.775 build (the two reachable completions), and it is **not avoidable by selling earlier**: the coin
jumps from below 84 SOL straight to complete in a single trade. It is a penalty, not a lever.

## How it sizes

| knob | value | measured |
|---|---|---|
| tranche | **3/4 of the 1% cap** per reply | 0.25 → +5.16 SOL; 0.5 → +13.13 with a 4h median +3.55; **0.75 → +15.62**; 1.0 → +16.30 at 1x but **+1.41 at 2x** (the whole edge is the fee margin, so 0.75 is the fee-robust choice: it gives up 0.68 of 6 h and 0.38 of 4h median to keep 14.46 at 2x) |
| per-coin budget | **6 SOL** of cost basis | 4 → med +3.76, mean +5.16; 4.5 → +4.19 / +5.72; 5 → +4.63 / +6.27; 6 → **+5.00 / +6.78**; 6.5 → +4.98 / +6.83; 7 → +3.68 / +5.67. The 4-hour distribution peaks at 6 (see the axis table below) |
| concurrent big coins | **2** | 1, 2 and 3 are the same run to the lamport: cash and campaign count bind, not the position cap |
| order size | never more than 1% of the decision-time reserve | the replay's own cap (`max_order_bps_of_real_reserve`), taken as 3/4 |
| entries per reply | one buy per mint | the 1% cap is per mint per reply, so two buys on one mint in one reply share it |

The drawdown column in the tables below is the **worst 4-hour slice's**, not the 6-hour run's: the
graded 6-hour drawdown is 10.3% at 4.5 SOL and 13.5% at the shipped 6 SOL.

Orders are also gated on free cash: the reply keeps its own ledger, `free = state.freeCashLamports()
- orders.length * tx`, and every order it queues comes off it (notional plus fee) before anything
later in the same reply is sized. An exit frees a position slot for a buy in the *same* reply, which
is how the big sleeve rolls from a completed coin into the next one without waiting a batch.

## The budget axis, before and after the stall-clock fix

13 overlapping 4-hour slices (stride 2,821 slots, span 67,700), a fresh 10 SOL per slice, the same
scorer; net SOL. `before` is the shipped 4.5 SOL build with the mark-fed clock, `after` is this build
with the recorded-reserve clock:

| budget | before med | before p10 | before min | before mean | before DD | after med | after p10 | after min | after mean | after DD |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 SOL | +3.75 | +3.51 | +2.39 | +5.16 | 17% | +3.76 | +3.51 | +2.39 | +5.16 | 17% |
| 4.5 SOL | +4.18 | +3.95 | +2.69 | +5.72 | 19% | +4.19 | +3.95 | +2.69 | +5.72 | 19% |
| **4.6 SOL** | **+4.18** | **+2.75** | **+0.63** | **+5.54** | **46%** | **+4.29** | **+4.04** | **+2.75** | **+5.83** | **20%** |
| 5 SOL | +4.63 | +3.00 | +0.66 | +5.99 | 49% | +4.63 | +4.42 | +3.00 | +6.27 | 21% |
| 5.5 SOL | +4.69 | +2.98 | +0.39 | +6.15 | 53% ✗ | +4.69 | +4.51 | +2.98 | +6.45 | 27% |
| **6 SOL (shipped)** | **+5.00** | **+3.33** | **-0.57** | **+6.40** | **56% ✗** | **+5.00** | **+4.54** | **+3.33** | **+6.78** | **29%** |
| 6.5 SOL | +4.98 | +3.64 | -1.28 | +6.41 | 60% ✗ | +4.98 | +4.49 | +3.64 | +6.83 | 31% |
| 7 SOL | +3.70 | +2.55 | -3.30 | +5.19 | 64% ✗ | +3.68 | +3.24 | +2.55 | +5.67 | 44% |
| 8 SOL | +3.38 | +2.03 | -5.35 | +4.93 | 70% ✗ | +3.35 | +2.94 | +2.03 | +5.55 | 48% |
| 10 SOL | +1.66 | -6.10 | -6.11 | +1.91 | 81% ✗ | +2.59 | +2.17 | +0.93 | +5.12 | 55% ✗ |

Read three things off it:

1. **The cliff was the stall clock.** Before the fix, 4.55 -> 4.6 SOL cost the worst slice 2.07 SOL
   and took its drawdown from 19.5% to 46%: the extra 0.04 SOL tranche on one coin (DM2JikiT, the
   slice that starts 3.0 h into the flow: **+0.05 -> -3.62 SOL**) nudged the *marked* reserve, reset
   the stall clock, and the exit that would have closed it never fired. After the fix 4.6 SOL is a
   smooth step (median +4.29 at 4.6 against +4.19 at 4.5, min +2.75 against +2.69).
2. **The axis now stays compliant to 8 SOL.** Every slice at 4-8 SOL is under the 50% drawdown cap;
   at 10 SOL one slice is 55%. Before the fix 6 SOL was already over the cap (56%).
3. **The 4-hour optimum is 6 SOL.** Median (+5.00) and p10 (+4.54) both peak at 6 SOL; min and mean
   are flat across 6-6.5 (+3.33/+3.64 and +6.78/+6.83) and fall at 7; the
   worst slice at 6 SOL is +3.33 with a 29% drawdown. The 6-hour window keeps liking a bigger budget
   (8 SOL +15.64, 10 SOL +16.45), but the sealed window is 4 hours and 6 SOL is where the 4-hour
   distribution peaks. 6 SOL is worth **+2.24 SOL of 6-hour net and +0.81 of 4-hour median** over the
   shipped 4.5 SOL, at 29% worst-slice drawdown against 19%.

## Threshold x budget, measured

Every cell below is the 13-slice table on the fixed stall clock, stop at 1%, everything else at the
values above (net SOL; "DD" is the worst slice's drawdown):

| cell | 6 h | 4 h median | p10 | min | mean | DD |
|---|---|---|---|---|---|---|
| **enter 30, add >= 30, budget 6 (this bot)** | **+15.62** | **+5.00** | **+4.54** | **+3.33** | **+6.78** | **29%** |
| enter 30, add >= 30, budget 5 | +14.39 | +4.63 | +4.42 | +3.00 | +6.27 | 21% |
| enter 30, add >= 30, budget 4.5 | +13.39 | +4.19 | +3.95 | +2.69 | +5.72 | 19% |
| enter 30, add >= 30, budget 4 | +12.36 | +3.76 | +3.51 | +2.39 | +5.16 | 17% |
| enter 30, add >= 40, budget 4 | +7.08 | +4.06 | +4.02 | -0.65 | +4.26 | 12% |
| enter 30, add >= 40, budget 6 | +8.27 | +4.91 | +4.55 | -0.65 | +4.91 | 12% |
| enter 30, add >= 40, budget 10 | +8.38 | +4.91 | +4.55 | -0.65 | +4.93 | 12% |
| enter 40, budget 4 | +2.57 | +0.07 | -0.04 | -0.52 | +0.40 | 6% |
| enter 40, budget 6 | +3.00 | +0.07 | -0.09 | -0.52 | +0.46 | 6% |
| enter 50, budget 6 | +0.03 | -0.01 | -0.04 | -0.04 | -0.01 | 5% |
| enter 60, budget 8 | +0.98 | +0.36 | +0.08 | -0.07 | +0.41 | 1% |

An add floor at 40 SOL (enter at 30, ladder only above 40) is a much tighter distribution — worst
slice -0.65 against +3.33, drawdown 12% against 29% — but its 4-hour mean is 4.91 against 6.78 and
its 6-hour net is 8.27 against 15.62: a quarter of the mean and half the 6-hour total, because the
30-40 tranches are the cheapest ones the completions buy.
Adding budget on top of it does nothing (4 -> 10 SOL moves the mean by 0.07). Entering at 40, 50 or
60 SOL instead of 30 makes almost nothing at any budget, because the entry drops the tranches that
paid for the completions.

## Accounting: nothing is booked on intent

Both sleeves are booked **when the order fills**, not when it is sent. Every buy carries a client id
the bot assigns (`b0`, `b1`, ... — a `b` namespace, because the SDK hands out its own `o<n>` ids and a
client id reused anywhere in a run is a rejected order); sells are sent without one. The fill is what carries the big
sleeve's cost basis (`spent`, from `quote_lamports`), the entry reserve the stop measures against, and
the slot the max hold measures from. A rotation probe becomes a touch only when it fills too: a
rejected or failed probe costs its transaction fee and nothing else, so it cannot burn a coin the
sleeve still wants (it used to: a failed probe marked the coin `touched` and it was never probed
again). An in-flight first tranche still counts against `MAX_BIG` and against
`committedPositionCount`, and an in-flight probe against `ROT_CONC`, so the slot and the concurrency
cap are held while the order is on the wire, exactly as a position would hold them.

## What it scores

`grade-local --driver process --worktree` on the dev window (2026-10-27 00:08-06:08 UTC):

| quantity | value |
|---|---|
| **net PnL** | **15,620,365,136 lamports (+15.620 SOL)**, return 1.562 |
| 90% bootstrap interval | **+418,312,849 .. +33,695,533,047** (+0.42 .. +33.70 SOL) |
| fills / coins / round trips | 423 fills, 158 distinct coins, 165 round trips |
| max drawdown | **0.135418837** (13.5%, cap 50%) |
| **at 2x fees** | **+14.460 SOL** |
| fees paid | 0.987 SOL curve + 0.046 SOL tx |
| rejected / failed orders | 2 (`token_complete` on a sell) / 13 |
| guardrails | fills ok, coins ok, drawdown ok — **compliant** |
| determinism | two `grade-local` executions: same net, same `action_log_sha256`, same snapshot (L1 regrade: reproduced byte for byte) |
| 9 seeded failure draws | 15.535 .. 15.976 SOL, mean 15.788, worst 13.7% drawdown |

The same bot before the stall fix and at 4.5 SOL (the build this one replaces): +13.384 SOL, 393
fills over 154 coins, 10.3% drawdown.

## Concentration, stated plainly

The big sleeve held **5 coins** in this build (8 in the 4.5 SOL build, whose tranches were smaller).
Two completions — C5DXREKp **+6.56** and 4jM56iiu **+5.76** — plus GZwCGPmd's **+5.13 time-rule exit**
are **+17.45 of the +15.62 net**, and HdvTjDFj is **-1.76**. A sealed window without those three is a
loss. That is three coins in a six-hour window, on a rule whose *threshold* is the only reason they
were the coins it bought: treat the magnitude as a lottery ticket whose ticket was chosen by a
structural filter, not as a steady edge.

## The four-hour distribution

The sealed final window is 4 hours, so the dev flow was cut into every overlapping 4-hour slice and
each graded with the same scorer (13 slices, stride 2,821 slots; net SOL):

| configuration | 6 h | 4 h median | 4 h p10 | 4 h worst | 4 h best | 4 h mean | DD |
|---|---|---|---|---|---|---|---|
| **this bot** (6 SOL, 1% stop, recorded stall clock) | **+15.62** | **+5.00** | **+4.54** | **+3.33** | **+10.60** | **+6.78** | **29%** |
| the same bot at 4.5 SOL (the shipped budget) | +13.39 | +4.19 | +3.95 | +2.69 | +9.68 | +5.72 | 19% |
| 4.5 SOL, mark-fed stall clock (the build this replaces) | +13.38 | +4.18 | +3.95 | +2.69 | +9.67 | +5.71 | 19% |
| 4 SOL, mark-fed stall clock | +12.36 | +3.75 | +3.51 | +2.39 | +9.02 | +5.16 | 17% |

Every one of the 13 slices is better at 6 SOL than at 4.5 (+0.3 to +2.2 SOL), and the same is true of
all nine seeded failure draws (15.53-15.98 against 13.08-13.54). The worst slice is +3.33 SOL at a
29% drawdown, against a 50% cap; the per-slice 90% interval lower bound is -1.8 to -3.6, i.e. a
4-hour window can still come out modestly negative on a bad draw of coins, which is what "two coins
carry it" means in practice.

## What was checked and rejected

* **An add ceiling above 40/45/50/55 SOL** (stop laddering there, still hold to completion) — measured
  on this build and **not shipped**. Every cell is the full 13-slice row plus the 6-hour net and the
  2x-fee net (the scorer's cost sensitivity on the same run); `DD` is the worst slice's drawdown:

  | ceiling | budget | 6 h | 2x | 4h med | p10 | min | mean | DD |
  |---|---|---|---|---|---|---|---|---|
  | 40 SOL | 4 SOL | +10.31 | +9.67 | +3.23 | +2.64 | +2.55 | +4.44 | 18% |
  | 40 SOL | 4.5 SOL | +10.69 | +10.02 | +3.20 | +2.94 | +2.62 | +4.54 | 20% |
  | 40 SOL | 5 SOL | +11.08 | +10.38 | +3.19 | +3.04 | +2.62 | +4.66 | 22% |
  | 40 SOL | 6 SOL | +11.47 | +10.71 | +2.75 | +2.59 | +2.16 | +4.47 | 29% |
  | 40 SOL | 8 SOL | +11.27 | +10.42 | +0.96 | +0.79 | +0.32 | +3.08 | 48% |
  | 45 SOL | 4 SOL | +11.87 | +11.13 | +4.67 | +4.22 | +2.41 | +5.73 | 17% |
  | 45 SOL | 4.5 SOL | +12.18 | +11.40 | +4.63 | +4.12 | +2.71 | +5.79 | 19% |
  | 45 SOL | 5 SOL | +12.48 | +11.67 | +4.54 | +4.05 | +3.02 | +5.84 | 21% |
  | 45 SOL | 6 SOL | +12.86 | +11.99 | +4.08 | +3.59 | +3.41 | +5.64 | 29% |
  | 45 SOL | 8 SOL | +12.84 | +11.87 | +2.46 | +1.98 | +1.93 | +4.40 | 48% |
  | 50 SOL | 4 SOL | +12.00 | +11.18 | +3.99 | +3.84 | +2.39 | +5.34 | 17% |
  | 50 SOL | 4.5 SOL | +12.86 | +11.98 | +4.44 | +4.33 | +2.69 | +5.89 | 19% |
  | 50 SOL | 5 SOL | +13.67 | +12.72 | +4.86 | +4.78 | +3.00 | +6.41 | 21% |
  | 50 SOL | 6 SOL | +14.32 | +13.27 | +5.00 | +4.50 | +3.33 | +6.56 | 29% |
  | 50 SOL | 8 SOL | +14.28 | +13.09 | +3.39 | +2.90 | +2.03 | +5.35 | 48% |
  | 55 SOL | 4 SOL | +12.31 | +11.46 | +3.76 | +3.51 | +2.39 | +5.15 | 17% |
  | 55 SOL | 4.5 SOL | +13.13 | +12.22 | +4.19 | +3.95 | +2.69 | +5.68 | 19% |
  | 55 SOL | 5 SOL | +13.98 | +12.99 | +4.63 | +4.42 | +3.00 | +6.21 | 21% |
  | 55 SOL | 6 SOL | +15.08 | +13.98 | +5.00 | +4.56 | +3.33 | +6.71 | 29% |
  | 55 SOL | 8 SOL | +15.04 | +13.80 | +3.46 | +2.95 | +2.03 | +5.52 | 48% |
  | **none (shipped)** | 4 SOL | +12.36 | +11.51 | +3.76 | +3.51 | +2.39 | +5.16 | 17% |
  | **none (shipped)** | 4.5 SOL | +13.39 | +12.45 | +4.19 | +3.95 | +2.69 | +5.72 | 19% |
  | **none (shipped)** | 5 SOL | +14.39 | +13.37 | +4.63 | +4.42 | +3.00 | +6.27 | 21% |
  | **none (shipped)** | **6 SOL** | **+15.62** | **+14.46** | **+5.00** | **+4.54** | **+3.33** | **+6.78** | **29%** |
  | **none (shipped)** | 8 SOL | +15.64 | +14.29 | +3.35 | +2.94 | +2.03 | +5.55 | 48% |

  It is measured and **not shipped** because it was compensating for the broken stall clock: with the
  mark-fed clock the tranches above the ceiling were the ones a collapsing coin dragged down, so
  cutting them bought a tighter tail. With the recorded clock they have a real exit and the budget
  does that job better — at the shipped 6 SOL a ceiling costs 0.54-4.15 SOL of 6-hour net (0.48-3.75
  at 2x) and 0-2.25 of 4-hour median. Only at 4 SOL does it buy median (+4.67 against +3.76, and
  0.57 of mean), by giving up 0.49 of 6 h and 0.38 at 2x. There is no cell where a ceiling improves
  both the 6-hour net and the 4-hour median.
* **An add floor at 40 SOL** (enter at 30, ladder only above 40) is a much tighter distribution but
  gives up half the mean and half the 6-hour net (above).
* **Entering at 40, 50 or 60 SOL** instead of 30 makes almost nothing: +2.6, 0.0, +1.0 SOL on the
  6-hour window. 8 coins cross 30 SOL while tradeable and 2 complete; a higher entry mostly just
  drops the tranches that paid for them.
* **Turning the stall off or widening it past 225 slots**: 300 or off is +11.72 SOL with a 57%
  worst-slice drawdown (the max-hold exit is the only thing left). Widening to 225 is +16.24 with a
  +3.96 worst slice — marginally better than 175, but the 150-225 band is flat within a six-hour
  sample and 175 is kept.
* **A price trail from the peak reserve** instead of the entry stop (8% / 12% / 20%) gave +5.4 /
  +6.6 / +7.1 SOL on the earlier build — it sells the completion it is trying to catch.
* **A full-cap tranche (tranche = 1.0)**: +16.30 at 1x but **+1.41 at 2x**, against +15.62 / +14.46 for
  0.75. The whole edge is the fee margin. Not shipped.
* **Turning the rotation sleeve off**: +15.48 SOL with 111 fills over 8 coins on the 6-hour window
  (the guardrail wants 80 fills over 10 coins), and the 13 slices book 45-82 fills over 4-6 coins with
  all 13 non-compliant. It is load-bearing for compliance, not for PnL.
* **Widening the position count or reserving cash for the rotation sleeve**: max concurrent big 1/2/3
  are the same run to the lamport, and cash is never the constraint (minimum free cash 5.99 SOL).
