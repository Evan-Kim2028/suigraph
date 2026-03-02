# suigraph block explorer (single-file site)

a graphql based block explorer, focused on GraphQL-powered chain introspection, with a single deployable HTML artifact and zero runtime dependencies.

## Goals
- Keep runtime dependency-free in the browser.
- Keep deployment output as one static HTML file.
- Preserve maintainability through source modularity (`src/`) and repeatable build checks.

## Repository Layout
- `src/index.template.html`: HTML shell (authoring source)
- `src/styles.css`: shared styles
- `src/app.js`: all client logic
- `scripts/build-single-file.mjs`: inlines `src/*` into deploy outputs
- `scripts/check-syntax.mjs`: validates embedded JS syntax in generated HTML
- `scripts/report-baseline.mjs`: updates static maintainability metrics
- `scripts/report-gql-surface.mjs`: static GraphQL call-surface report
- `scripts/report-perf-budgets.mjs`: per-route render/query budget report
- `scripts/refresh-schema-root-fields.mjs`: refresh live Sui GraphQL root-field snapshot
- `scripts/report-schema-coverage.mjs`: static schema-root usage coverage
- `docs/`: architecture, build, contribution notes, baseline metrics
- `index.html`: generated compatibility output
- `dist/index.html`: generated deployment artifact

## Commands
- `npm run build`: generate `index.html` and `dist/index.html`
- `npm run build:check`: verify generated outputs match `src/*`
- `npm run validate`: run build parity + syntax + quality + schema drift checks
- `npm run baseline`: refresh `docs/baseline.md`
- `npm run gql:surface`: refresh `docs/graphql-surface.md`
- `npm run perf:budgets`: refresh `docs/perf-budgets.md`
- `npm run schema:refresh`: refresh `docs/schema-root-fields.json` from live schema
- `npm run schema:coverage`: refresh `docs/schema-coverage.md`

## Development Workflow
1. Edit only `src/index.template.html`, `src/styles.css`, and `src/app.js`.
2. Run `npm run build`.
3. Run `npm run validate`.
4. Run `npm run baseline` when maintainability metrics should be updated.

## Deployment Artifact
- Preferred artifact: `dist/index.html`

## Git Repository Setup
If this folder is not already a repo:
1. `git init -b main`
2. `git add .`
3. `git commit -m "Initial commit"`

This project is intentionally self-contained so it can be versioned independently from any parent workspace.
