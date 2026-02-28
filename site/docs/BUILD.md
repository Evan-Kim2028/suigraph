# Build and Validate

## Requirements
- Node.js 20+ (validated on Node 22).

## Commands
- `npm run build`
- `npm run build:check`
- `npm run baseline`
- `npm run gql:surface`
- `npm run perf:budgets`
- `npm run schema:refresh`
- `npm run schema:coverage`
- `npm run validate`

## Workflow
1. Edit:
- `src/index.template.html`
- `src/styles.css`
- `src/app.js`
2. Run `npm run build` to generate `index.html` and `dist/index.html`.
3. Run `npm run validate` before commit.
4. Use `dist/index.html` as the explicit deployment artifact target.

`npm run validate` includes:
- build-output parity check (`build:check`)
- script syntax parse check (`check-syntax`)
- source quality guardrails (`check-quality`) for:
  - no inline event handler attributes
  - no `window.*` handler assignments
  - no duplicate `class` attributes in app HTML snippets
  - inline-style budget cap on generated single-file output
  - route pages must have explicit entries in `PAGE_PERF_BUDGETS`
- schema coverage drift check (`schema:check`) against `docs/schema-root-fields.json`

## Artifacts
- `dist/index.html`: deployable single-file output.
- `dist/build-manifest.json`: build hash and metadata.
- `docs/baseline.md`: static maintainability baseline metrics.
- `docs/graphql-surface.md`: static GraphQL call-surface summary.
- `docs/perf-budgets.md`: per-route runtime query/render budgets.
- `docs/schema-root-fields.json`: introspected root-field snapshot from Sui GraphQL.
- `docs/schema-coverage.md`: static query-root coverage report from `src/app.js`.
