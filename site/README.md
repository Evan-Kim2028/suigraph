# suigraph block explorer (static Walrus site)

a graphql based block explorer, focused on GraphQL-powered chain introspection, with a static deployable asset bundle and zero runtime dependencies.

## Goals
- Keep runtime dependency-free in the browser.
- Keep deployment output static and Walrus-friendly.
- Preserve maintainability through source modularity (`src/`) and repeatable build checks.

## Repository Layout
- `src/index.template.html`: HTML shell (authoring source)
- `src/styles.css`: shared styles
- `src/app/*.js`: ordered client source parts split into a bootstrap bundle and an extra lazy bundle at build time
- `scripts/build-single-file.mjs`: minifies assets and writes HTML + JS + CSS deploy outputs
- `scripts/check-syntax.mjs`: validates embedded JS syntax in generated HTML
- `scripts/report-baseline.mjs`: updates static maintainability metrics
- `scripts/report-gql-surface.mjs`: static GraphQL call-surface report
- `scripts/report-perf-budgets.mjs`: per-route render/query budget report
- `scripts/refresh-schema-root-fields.mjs`: refresh live Sui GraphQL root-field snapshot
- `scripts/report-schema-coverage.mjs`: static schema-root usage coverage
- `docs/`: architecture, build, contribution notes, baseline metrics
- `index.html`: generated compatibility output
- `assets/`: generated local JS/CSS assets
- `dist/index.html`: generated deployment HTML
- `dist/assets/`: generated deployment JS/CSS assets

## Commands
- `npm run build`: generate `index.html`, `assets/`, `dist/index.html`, and `dist/assets/`
- `npm run build:check`: verify generated outputs match `src/*`
- `npm run validate`: run build parity + syntax + quality + schema drift checks
- `npm run baseline`: refresh `docs/baseline.md`
- `npm run gql:surface`: refresh `docs/graphql-surface.md`
- `npm run perf:budgets`: refresh `docs/perf-budgets.md`
- `npm run schema:refresh`: refresh `docs/schema-root-fields.json` from live schema
- `npm run schema:coverage`: refresh `docs/schema-coverage.md`

## Development Workflow
1. Edit only `src/index.template.html`, `src/styles.css`, and `src/app/*.js`.
2. Run `npm run build` to regenerate the minified HTML + asset bundle.
3. Run `npm run validate`.
4. Run `npm run baseline` when maintainability metrics should be updated.

## Deployment Artifact
- Preferred artifact: `dist/`

## Git Repository Setup
If this folder is not already a repo:
1. `git init -b main`
2. `git add .`
3. `git commit -m "Initial commit"`

This project is intentionally self-contained so it can be versioned independently from any parent workspace.
