# Fixture Governance

The fixture system has two jobs:

1. Keep live address-route regressions visible.
2. Prevent protocol growth from landing without declared coverage.

## Live Fixture Types

- `required` + `active`: live fixtures that must keep passing.
- `candidate` + `historical`: research artifacts kept for comparison, not gating.
- `ownership: legacy_personal`: temporary live fixtures that must have a team-owned replacement plan.
- `ownership: public_external`: public fixtures we do not control but still use for broad integration coverage.

## Team-Owned Slot Plan

Team-owned micro-wallets are tracked in `protocol-fixture-coverage.json` under `teamSlots`.
Those slots are the migration path away from legacy personal fixtures.

Current planned slots:

- `team_wallet_micro`
- `team_vault_micro`
- `team_lending_micro`
- `team_lp_micro`
- `team_margin_micro`
- `team_perps_micro`

## Adding Or Growing A Protocol

Every new adapter must do all of the following before it is considered complete:

1. Add the adapter in `src/app/35-defi-adapters.js`.
2. Add the protocol to `fixtures/protocol-fixture-coverage.json`.
3. Point that protocol to at least one live fixture or one planned team slot.
4. Add or update `fixtures/address-fixtures.json` so the referenced live fixtures declare that protocol in `protocols`.
5. Run `npm run validate` and `npm run fixtures:scan`.

The automated coverage check fails if an adapter is missing a protocol coverage entry, if a live fixture is referenced incorrectly, or if a legacy personal fixture has no team-owned replacement slot.
