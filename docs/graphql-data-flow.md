# GraphQL Data Flow

This repo is a static frontend. There is no backend service translating or proxying Sui data.
All live chain and protocol state shown in the UI is sourced from Sui GraphQL reads in the browser.

## Public Entry Points

- Live site: `https://suigraph-explorer.wal.app`
- In-app GraphQL page: `https://suigraph-explorer.wal.app/#/graphql`
- Sui GraphQL endpoint: `https://graphql.mainnet.sui.io/graphql`
- Walrus site object ID: `0xa1248f83831fd952680649e461899a59647f6f1fefc6397a77d387dc01a7d732`

## Where The GraphQL Client Lives

The main GraphQL client logic is in `site/src/app/10-core.js`.

Important pieces there:

- `const GQL = "https://graphql.mainnet.sui.io/graphql"`
- `async function gql(query, variables = {}, opts = {})`
- request dedupe and in-flight coalescing
- concurrency limiting
- cache/perf tracking for the in-app perf badge
- reusable object and transaction batch helpers such as `multiGetObjects`

If you want to understand how every page actually talks to Sui GraphQL, start there.

## Where Page Queries Live

Most page-level query assembly lives in `site/src/app/30-pages.js`.

That file contains:

- overview/dashboard queries
- checkpoint, transaction, object, address, and package route queries
- DeFi page assembly
- stablecoin, events, congestion, transfers, validators, and docs page data loads

In practice, `10-core.js` owns the transport and `30-pages.js` owns the page-specific query shapes.

## Where Protocol-Specific DeFi Reads Live

Address DeFi protocol loading is normalized in `site/src/app/35-defi-adapters.js`.

Each adapter defines:

- `key`: stable protocol identifier used by fixtures and coverage checks
- `label`: UI label
- `kind`: lending / dex_lp / wallet / vault / margin / perps
- `load`: the function that fetches that protocol's data
- `empty`: canonical empty fallback shape
- `validate`: protocol-specific accounting invariant check

The actual GraphQL query bodies for those protocol loaders still live in `site/src/app/30-pages.js`, but the adapter file is the contract layer that keeps protocol loading consistent.

## Where To Find All Query Surfaces

There are three practical ways to inspect the GraphQL surface:

1. Read `site/docs/graphql-surface.md`.
   It is a generated inventory of static `gql(...)` call sites and query previews.

2. Regenerate the inventory locally.

```bash
cd site
npm ci
npm run gql:surface
```

3. Read the protocol notes in `docs/defi-portfolio/`.
   Those docs explain the object layouts, tables, dynamic fields, and GraphQL query patterns used for each protocol.

## Recommended Reading Order

1. `site/src/app/10-core.js`
2. `site/src/app/30-pages.js`
3. `site/src/app/35-defi-adapters.js`
4. `site/docs/graphql-surface.md`
5. `docs/defi-portfolio/*.md`

## Why This Matters

When new data surfaces are added, this repo should stay legible in three ways:

- the transport remains centralized in `10-core.js`
- protocol loading stays normalized through the adapter contract
- protocol docs explain the GraphQL/object model behind each new integration

That is the intended path for growing the explorer without losing trust or debuggability.
