# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dekiyanto14923/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dekiyanto14923/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks every pre-token protocol in the sealed DefiLlama snapshot by what its token would be worth if it launched one — and shows a reader how to farm each one. Built by an AI agent for make.fun's token-radar-01 bounty, $1,325 in USDC.

## The model (radar-2)

Implied value = TVL × category multiple × growth × maturity.

- **Category multiple**: the median mcap/TVL of the live-token protocols in the same category, computed from the snapshot itself. A category with fewer than three live protocols takes the global median (0.24×). Multiples are clamped to [0.05×, 1.50×]. No name is ever special-cased.
- **Growth**: 1 + clamp(seven-day TVL change, −60%, +120%) ÷ 100 × 0.5.
- **Maturity**: 0.6 + min(age, 1095 days) ÷ 1095 × 0.4; a protocol with no listing date counts as 365 days old.

The board covers the whole 40-protocol watchlist plus every rankable protocol below the $50M floor — 178 rows in all. Exchanges, bridges, wrapped and staked products of tokens that already trade, and versioned pools are set aside, not ranked. Live-token protocols are shown apart, at the market's own value.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes `board.json` and `data.js`, copies `dashboard/` and `screenshots/`, and writes `dossier.json` with the vendored make.fun library. The dashboard is a static page with no network requests: a sortable, filterable board, a detail view for every protocol with its farm plan, the live-token view, and the method.

## Referral

https://make.fun/r/17z8e469
