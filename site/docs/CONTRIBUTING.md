# Contributing

## Scope
- Keep runtime browser dependencies at zero.
- Keep deployment output as a single static HTML file.

## Source of Truth
- Do not edit generated files directly.
- Edit:
- `src/index.template.html`
- `src/styles.css`
- `src/app/*.js`
- Regenerate outputs with `npm run build`.

## Quality Gates
- `npm run build:check` ensures generated outputs are in sync.
- `npm run validate` runs build parity, script syntax, and source quality guardrails.
- `npm run baseline` updates maintainability metrics.
- `npm run perf:budgets` regenerates per-route runtime query/render budgets.
- `npm run schema:coverage` regenerates static schema-root coverage from app queries.
- `npm run schema:refresh` refreshes live Sui GraphQL root-field snapshot.

## Review Expectations
- No functional regressions on key routes: overview, tx, object, address, checkpoint, DeFi pages.
- Avoid adding repeated inline styles when a reusable CSS class can be used.
- Keep GraphQL calls batched and cache-aware.
