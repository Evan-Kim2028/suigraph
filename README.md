# suigraph block explorer

A GraphQL based block explorer for Sui mainnet, built as a static frontend with no backend service.

This repo is designed to be deployable on [Walrus Sites](https://docs.wal.app/) and also easy to run with any static host.

## What This Explorer Is Designed To Do

- Expose core Sui chain data through a fast, static UI backed by GraphQL queries.
- Keep deployment simple: one generated HTML artifact, zero runtime dependencies in the browser.
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
- `site/src/app.js`: source application logic
- `site/scripts/build-single-file.mjs`: inlines source files into deploy outputs
- `site/ws-resources.json`: Walrus Sites routing/headers/metadata source config
- `site/index.html`: generated single-file output (root compatibility output)
- `site/dist/index.html`: generated deploy artifact
- `site/dist/ws-resources.json`: generated Walrus config copied at build time
- `site/docs/`: architecture/build/perf/schema docs and generated reports

## Architecture Design Rationale

- Single-file runtime output:
  - optimized for static hosting and Walrus Sites deployment
  - minimizes moving parts and operational overhead
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
- `npm run build`: regenerate `index.html` and `dist/index.html`
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

3. Deploy from `site/` using `dist/` as content and the repo-level Walrus config file:

```bash
site-builder --context=mainnet deploy ./dist --epochs 10 --ws-resources ./ws-resources.json
```

4. Re-run the same deploy command for updates:

```bash
site-builder --context=mainnet deploy ./dist --epochs 10 --ws-resources ./ws-resources.json
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
- `docs/defi-portfolio/on-chain-pricing.md`: pool oracle pricing methodology
- `docs/defi-portfolio/`: per-protocol position querying guides
