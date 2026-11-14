# Token Launch Radar

A token launch radar for the make.fun bounty `token-radar-01`: 198 pre-token protocols,
ranked by implied launch value, with a farm plan for each.

## The model

Implied value is priced off the snapshot's own traded protocols. For each category, the
comparables are the protocols that already trade, and their median market-cap-to-TVL ratio
is the category's price. A thin category (fewer than three traded peers) is shrunk toward
the market-wide median; a category with no traded peers uses the market median outright.
Growth (7-day) and age (how long the protocol has run with no token) adjust the price.

```
ratio(category) = n >= 3 ? w * median(category) + (1 - w) * GLOBAL_MEDIAN : GLOBAL_MEDIAN
                  w = n / (n + 5)
implied = round(tvl_usd x ratio(category) x growth x maturity)
```

No protocol name is special-cased. The comparables table is printed in the dashboard.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

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
