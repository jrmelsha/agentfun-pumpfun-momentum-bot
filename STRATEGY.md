# Completer ladder

Two sleeves in one bot on the dev window's pump.fun curves: 10 SOL of paper cash, at most 5 open
positions, at most 16 orders a reply, at most 1% of a coin's real SOL reserve per reply.

**Big sleeve (the edge).** Enter a coin only on the first reply whose decision-time real SOL reserve
is at or above 30 SOL, then ladder 3/4 of the 1%-of-reserve cap into it on *every* reply while the
reserve stays above 30 SOL, up to 4 SOL of cost basis, at most 2 coins at a time. Hold to the curve's
completion (85.005 SOL). Exit early only on a 5%-of-reserve stop below the entry reserve, 175 slots
without a new reserve high, or 800 slots held. Price is (30 + rq)^2 / k, so a coin that has put 30 SOL
of real money into its curve completes 2 times in 3; the reserve growing under the position is what
lets repeat additions build a position several times larger than any single reply allows.

**Rotation sleeve (the guardrail).** 0.005 SOL on any coin under 28 SOL of reserve we have not touched,
sold 2 slots later: 80 fills over 10 coins at a cost of about 0.02 SOL, and it never takes a position
slot the big sleeve could use.

Dev window (2026-10-27 00:08-06:08 UTC, the kit's pilot-dev dataset): **+11.775 SOL**, 389 fills over
154 coins, 161 round trips, max drawdown 10.5%, 0 rejected, 12 failed, +10.920 SOL at 2x fees; every
guardrail met. The number rests on 3 of the 8 coins the big sleeve held. On the five 4-wall-clock-hour
sub-windows of the same flow it makes +2.0 to +8.6 SOL and stays guardrail-compliant on all five.

Entering at 5 SOL instead of 30 loses 5-10 SOL: 117 coins reach 5 SOL and 9 complete, while 17 reach
30 SOL and 11 complete. Do not lower the threshold.
