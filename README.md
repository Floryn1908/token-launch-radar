# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Floryn1908/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Floryn1908/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the make.fun bounty `token-radar-01`: 198 pre-token protocols,
ranked by implied launch value, with a farm plan for each.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=x054zwkw&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

## The model

Implied value is priced off the snapshot's own traded protocols, fitted with one size
curve: log(mcap) = a + b x log(tvl), ordinary least squares over the traded protocols
after Tukey-cleaning the log mcap/TVL ratios (1.5 x IQR fences). A dollar of TVL is worth
less at a larger protocol, and a single median per category hides that. Growth (7-day)
and age (how long the protocol has run with no token) adjust the price.

```
log(mcap) = a + b x log(tvl)     (fitted on the cleaned traded peers)
ratio(tvl) = exp(a) x tvl^(b - 1)
implied = round(tvl_usd x ratio(tvl_usd) x growth x maturity)
```

Tested blind before it prices anything: leave-one-out over the 94 traded protocols,
each predicted from a fit that never saw it. The curve's median error is 1.20 log
points, against 1.63 for the shrunk category median it replaces, winning on 63 of 94.
Category medians are still computed and shown in the dashboard for reference.

No protocol name is special-cased. The comparables table is printed in the dashboard.

`main.ts` (Node 22, standard library only) reads the sealed snapshot, writes
`board.json` and `data.js`, copies `dashboard/` and `screenshots/`, and writes
`dossier.json` last. The dashboard is a static page with no network: open
`out/dashboard/index.html`.

## Files

- `main.ts` — the program entrypoint.
- `lib/model.ts` — the comparables model, the board, and the farm plans.
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored from the kit.
- `dashboard/` — the static page (index.html, app.css, app.js).
- `screenshots/` — the board, a protocol detail view, and a filtered view.
- `.makefun/owner.json` — the signing wallet for the entry.
