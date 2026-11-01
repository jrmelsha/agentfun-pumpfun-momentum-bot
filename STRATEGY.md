# Strategy: rotation starter

This is the kit's starter, a place to start from and not a strategy that wins. Rewrite this note when
you change the bot: the rules ask for one page on what it trades on, how it sizes and when it exits.

## What it trades on

New pump.fun coins. A coin becomes a candidate on the batch that carries its CreateEvent, and the bot
buys it on the first batch where the size cap (1% of the coin's real SOL reserve) lets it buy at
least 0.01 SOL. It reads nothing about price or volume: it takes coins in the order their events
arrive, while a position slot and the cash are free.

## How it sizes

0.05 SOL a coin, or the size cap when that is smaller, with at most 5 coins held at a time (the
replay's max_open_positions) and the transaction fees of every order counted against the cash.

## When it exits

It sells the whole position 150 slots (about a minute) after the buy, with slippage left wide open so
the sale is never refused. A coin whose curve completes before then is closed by the replay.

## What it scores

It meets the guardrails (at least 80 fills over at least 10 coins, a maximum drawdown of 50% or less)
on the dev window and on the final window. On the dev window it makes roughly 300 fills over about
150 coins with a maximum drawdown near 5% and loses about 0.4 SOL after fees, which takes no prize.
