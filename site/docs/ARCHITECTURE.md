# Architecture

## Deployment Model
- Runtime target is a single static HTML artifact.
- Authoring source uses:
- `src/index.template.html`
- `src/styles.css`
- `src/app/*.js`
- Build outputs:
- `index.html` (compatibility for current local/tunnel serving flow)
- `dist/index.html` (explicit deployment artifact)

## Why This Shape
- Keeps Walrus-compatible single-file deployment.
- Allows structured authoring and quality gates without changing browser runtime dependencies.

## Current Phase
- Source split is active (`index.template.html`, `styles.css`, `app/*.js`) with single-file build output.
- Delegated UI actions replaced global `window.*` handlers and inline event attributes.
- Quality gates enforce:
- no inline event attributes
- no duplicate `class` attributes in generated snippets
- inline-style budget cap
- route-to-budget coverage (`PAGE_PERF_BUDGETS`)
- Runtime perf badge now includes per-page GraphQL/render budgets.

## Next Refactor Phases
- Continue carving `src/app/*.js` into clearer internal modules while preserving one-file output.
- Centralize GraphQL query definitions and fragments (reduce repeated anonymous query literals).
- Calibrate per-page perf budgets using observed p95 data and adjust defaults conservatively.

## Coin Activity Typing
- Coin search transfer rows are typed by a single source-of-truth path:
- `classifyTransactionAction(tx)` derives canonical action metadata from events and move calls.
- `classifyCoinTransferFlow(effects, targetKey, sentRaw, recvRaw, txAction)` maps action + balance context into transfer kind.
- The old split where action and kind were computed separately is deprecated.
- Non-supply actions (`order`, `deposit`, `withdraw`, etc.) are explicitly prevented from falling through to `mint`/`burn`.
- Swap-context recasts (`swap-in`/`swap-out`) only apply when the action is unknown or swap/fill.
- Coin activity scan cache keys include a version suffix; bump this when transfer row schema/classifier semantics change.
