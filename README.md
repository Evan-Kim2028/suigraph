# suigraph block explorer

A GraphQL based block explorer for Sui mainnet, built as a static frontend with no backend service.

This repo is designed to be deployable on [Walrus Sites](https://docs.wal.app/) and also easy to run with any static host.

## Quick Links

- Live Walrus site: [https://suigraph-explorer.wal.app](https://suigraph-explorer.wal.app)
- In-app GraphQL page: [https://suigraph-explorer.wal.app/#/graphql](https://suigraph-explorer.wal.app/#/graphql)
- Canonical Sui GraphQL endpoint used by the app: `https://graphql.mainnet.sui.io/graphql`
- Walrus site object ID: `0xa1248f83831fd952680649e461899a59647f6f1fefc6397a77d387dc01a7d732`
- Generated GraphQL inventory: `site/docs/graphql-surface.md`
- GraphQL/data flow notes: `docs/graphql-data-flow.md`
- Per-protocol query guides: `docs/defi-portfolio/*.md`

## What This Explorer Is Designed To Do

- Expose core Sui chain data through a fast, static UI backed by GraphQL queries.
- Keep deployment simple: a static Walrus-ready HTML + asset bundle, zero runtime dependencies in the browser.
- Support both regular users (search, chain views, DeFi views) and power users (query playground, simulator, package inspection).

## What It Supports

- Search and navigation for:
  - addresses
  - transaction digests
  - checkpoints
  - coin types (`0x...::module::Type`)
  - packages/objects
- Core chain pages:
  - overview dashboard
  - checkpoints + checkpoint detail
  - transactions + transaction detail
  - address detail
  - object/package detail
  - validators
  - protocol config
  - events, congestion, transfers
- DeFi-focused pages:
  - overview
  - lending markets (rates + USD supply/borrow depth per protocol)
  - DEX activity
  - stablecoins
  - flows
  - risk monitor
  - staking/LST
- Developer tools:
  - GraphQL playground
  - TX simulator
  - package activity registry
- In-app docs page explaining metrics, data sources, and interpretation.

## Repository Structure

- `site/src/index.template.html`: source HTML template
- `site/src/styles.css`: source styles
- `site/src/app/*.js`: ordered source application logic
- `site/scripts/build-single-file.mjs`: builds minified HTML + JS + CSS deploy outputs
- `site/ws-resources.json`: Walrus Sites routing/headers/metadata source config
- `site/index.html`: generated compatibility output
- `site/assets/`: generated local JS/CSS assets
- `site/dist/index.html`: generated deploy HTML
- `site/dist/assets/`: generated deploy JS/CSS assets
- `site/dist/ws-resources.json`: generated Walrus config copied at build time
- `site/docs/`: architecture/build/perf/schema docs and generated reports

## Architecture Design Rationale

- Static runtime bundle:
  - optimized for static hosting and Walrus Sites deployment
  - keeps initial bootstrap smaller by lazy-loading the secondary route bundle
- Source modularity with build inlining:
  - author in separated `src/` files for maintainability
  - emit one file for deployment portability
- Explicit quality gates:
  - syntax checks
  - build parity checks
  - route/perf budget coverage checks
  - schema coverage drift checks
- Walrus-aware configuration:
  - `ws-resources.json` controls headers, routes, metadata, and deployed site object tracking

## How Data Gets To The UI

- Core transport lives in `site/src/app/10-core.js`.
  - `GQL` points at `https://graphql.mainnet.sui.io/graphql`.
  - `gql(...)` handles retries, caching, dedupe, concurrency, and perf accounting.
- Most page-level GraphQL reads live in `site/src/app/30-pages.js`.
  - Core chain pages, dashboard pages, and DeFi page assembly are driven from there.
- Address DeFi protocol loading is normalized in `site/src/app/35-defi-adapters.js`.
  - Each protocol adapter declares a `key`, `label`, `kind`, loader, empty state, and validation hook.
- Protocol-specific query methodology lives under `docs/defi-portfolio/`.
  - Those docs explain how positions are discovered from Sui GraphQL for each protocol.
- The repo also carries a generated query inventory in `site/docs/graphql-surface.md`.
  - Regenerate it with `cd site && npm run gql:surface`.

If you want the shortest path to understanding the data surface, read in this order:

1. `docs/graphql-data-flow.md`
2. `site/src/app/10-core.js`
3. `site/src/app/30-pages.js`
4. `site/src/app/35-defi-adapters.js`
5. `docs/defi-portfolio/*.md`

## Coin Search Classification Notes

- Coin transfer `Action` and `Kind` now share one classifier pipeline in `site/src/app/*.js`:
  - `classifyTransactionAction(...)`
  - `classifyCoinTransferFlow(...)`
- This avoids drift where `Action` said one thing while `Kind` was computed by a different path.
- Non-supply actions (for example `order`/`deposit`/`withdraw`) are guarded from being mislabeled as `mint`/`burn`.
- `site/scripts/smoke-coin-search.mjs` mirrors the same logic and includes invariant checks to catch regressions.

## Local Development

Requirements:
- Node.js 20+ (Node 22 recommended)

From `site/`:

```bash
npm ci
npm run build
npm run validate
```

Primary commands:
- `npm run build`: regenerate `index.html`, `assets/`, `dist/index.html`, and `dist/assets/`
- `npm run build:check`: verify generated outputs match `src/*`
- `npm run validate`: run all quality checks
- `npm run baseline`: refresh baseline metrics doc

## Run Locally (Static Hosting)

After building:

```bash
cd site/dist
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Deploy To Walrus Sites

Official references (recommended reading):
- Walrus Sites docs index:
  - https://github.com/MystenLabs/walrus/blob/main/docs/content/sites/index.mdx
- Install site-builder:
  - https://github.com/MystenLabs/walrus/blob/main/docs/content/sites/getting-started/installing-the-site-builder.mdx
- Publish/deploy guide:
  - https://github.com/MystenLabs/walrus/blob/main/docs/content/sites/getting-started/publishing-your-first-site.mdx
- Site-builder command reference (`deploy`, `--epochs`, `--object-id` behavior):
  - https://github.com/MystenLabs/walrus/blob/main/docs/content/sites/getting-started/using-the-site-builder.mdx
- `ws-resources.json` routing/metadata reference:
  - https://github.com/MystenLabs/walrus/blob/main/docs/content/sites/configuration/setting-up-routing-rules.mdx

### Deployment steps for this repo

1. Install and configure `walrus` + `site-builder` (mainnet), then download `sites-config.yaml` as described in the links above.
2. Build the explorer:

```bash
cd site
npm ci
npm run build
```

3. Deploy from `site/` using the guarded wrapper. It refuses dirty deploy inputs under `site/src`, rebuilds, runs `npm run validate`, and only then calls `site-builder`:

```bash
npm run deploy:walrus
```

4. Re-run the same command for updates. Override context or epochs by passing args through npm:

```bash
npm run deploy:walrus -- --context mainnet --epochs 10
```

Notes:
- The `deploy` command creates a site on first run, then updates the same site on subsequent runs.
- The canonical site object ID is tracked in `site/ws-resources.json` (via `object_id`) when you pass `--ws-resources ./ws-resources.json`.
- `site/dist/ws-resources.json` is a generated copy from build/deploy output; do not treat it as the canonical source.
- `wal.app` serves mainnet-linked sites; testnet generally requires running your own portal.

## Current Walrus Deployment (as of 2026-03-04)

| Field | Value |
|-------|-------|
| Site Object ID | `0xa1248f83831fd952680649e461899a59647f6f1fefc6397a77d387dc01a7d732` |
| Source of Truth | `site/ws-resources.json` (`object_id`) |
| SuiNS Name | `suigraph-explorer` |
| Public URL | [https://suigraph-explorer.wal.app](https://suigraph-explorer.wal.app) |
| Network | Mainnet |
| site-builder Version | 2.6.0 |

Future `site-builder deploy` commands with the same `--ws-resources ./ws-resources.json` file update the same object ID in place.

## Additional Project Docs

- `site/README.md`: site-level commands and workflow
- `site/docs/ARCHITECTURE.md`: architectural notes
- `site/docs/BUILD.md`: build/validate details
- `site/docs/CONTRIBUTING.md`: contribution expectations
- `site/docs/graphql-surface.md`: generated inventory of static `gql(...)` call sites
- `docs/graphql-data-flow.md`: where the GraphQL endpoint, transport, query surfaces, and protocol guides live
- `docs/defi-portfolio/on-chain-pricing.md`: pool oracle pricing methodology
- `docs/defi-portfolio/`: per-protocol position querying guides
