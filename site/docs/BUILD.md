# Build and Validate

## Requirements
- Node.js 20+ (validated on Node 22).

## Commands
- `npm run build`
- `npm run build:check`
- `npm run baseline`
- `npm run smoke:coin`
- `npm run gql:surface`
- `npm run perf:budgets`
- `npm run schema:refresh`
- `npm run schema:coverage`
- `npm run validate`

## Workflow
1. Edit:
- `src/index.template.html`
- `src/styles.css`
- `src/app/*.js`
2. Run `npm run build` to generate minified `index.html`, `assets/`, `dist/index.html`, and `dist/assets/`.
3. Run `npm run validate` before commit.
4. Use `dist/` as the explicit deployment artifact target.
5. Run `npm run smoke:coin` (or pass custom `--coin`) when touching coin-search logic.

`npm run validate` includes:
- build-output parity check (`build:check`)
- script syntax parse check (`check-syntax`)
- source quality guardrails (`check-quality`) for:
  - no inline event handler attributes
  - no `window.*` handler assignments
  - no duplicate `class` attributes in app HTML snippets
  - inline-style budget cap on generated app HTML snippets
  - route pages must have explicit entries in `PAGE_PERF_BUDGETS`
- schema coverage drift check (`schema:check`) against `docs/schema-root-fields.json`

## Artifacts
- `dist/index.html`: deployable HTML entrypoint.
- `dist/assets/`: deployable minified JS/CSS assets.
- `dist/build-manifest.json`: build hash and metadata.
- `docs/baseline.md`: static maintainability baseline metrics.
- `docs/graphql-surface.md`: static GraphQL call-surface summary.
- `docs/perf-budgets.md`: per-route runtime query/render budgets.
- `docs/schema-root-fields.json`: introspected root-field snapshot from Sui GraphQL.
- `docs/schema-coverage.md`: static query-root coverage report from `src/app/*.js`.

## Coin Smoke Check
- Default run: `npm run smoke:coin`
- Custom coin run: `npm run smoke:coin -- --coin 0x...::module::Type`
- Tuning: `--max-object-pages`, `--max-digests`, `--tx-limit`

This command does a live mainnet sanity check for:
- supply availability via `coinMetadata` and RPC `suix_getTotalSupply`
- object-linked coin activity sampling
- transfer/event/object match counts
- action/transfer-kind distributions
- `swapAsMintSignals` (should be `0` in healthy classification windows)
