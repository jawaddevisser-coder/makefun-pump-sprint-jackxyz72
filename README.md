# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jawaddevisser-coder/makefun-pump-sprint-jackxyz72/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jawaddevisser-coder/makefun-pump-sprint-jackxyz72/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper-trading bot for the pump.fun bonding-curve replay
(harness `pumpfun-replay/v2`, protocol `agent-fun/replay/v2`).
Entry for the [make.fun bounty](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).

## Strategy

Do not buy the launch candle. Wait 1–6 slots after creation and buy only
coins that are still being bought: exactly 7 distinct non-creator buyers,
creator bought at most 1.5 SOL, real SOL 3–10, price holding ≥90% of its
high since creation, runup <3x, positive net inflow with a new buyer in
this batch. Flip fast: take profit +80%, stop-loss −12%, trailing stop 6%
after +5%, max hold 10 slots. Candidates are ranked by recent net inflow
so the free position slots go to the strongest demand. Deterministic: no
clock, no randomness.

`main.ts` is only the wire protocol and account/curve state; the decision
logic lives in `strategy.ts`. A self-check guardrail in `main.ts` refuses
orders the account cannot afford or sells larger than the position, and
`createStrategy` fails fast on an invalid parameter set.

## Verified result (kit grade-local, `--driver process`)

- **Net PnL: +0.0836 SOL** (beats hold-cash)
- 86 fills, 43 round trips, 43 distinct mints, win rate 41.9%
- Max drawdown 0.59%, 2 rejected orders, 1 failed
- Net PnL at 2x fees +0.0062 SOL

## Run

```sh
node main.ts   # reads agent-fun/replay/v2 NDJSON on stdin, replies per batch
```

Node 22+, standard library only.
