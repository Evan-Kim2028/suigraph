# Issue #3 Feasibility: Transaction Summary, Date Range, CSV Export

Date assessed: 2026-03-02
Endpoint tested: `https://graphql.mainnet.sui.io/graphql`

## Scope

Issue: [#3](https://github.com/Evan-Kim2028/graphql-sui-block-explorer/issues/3)

Requested features:
1. Transaction overview summaries in list views
2. Date range filtering
3. CSV export of filtered rows

## Schema Findings (Live Introspection)

### Transaction roots and filters

- `Query.transactions(first, after, last, before, filter)` exists.
- `Address.transactions(first, after, last, before, relation, filter)` exists.
- `TransactionFilter` supports:
  - `afterCheckpoint: UInt53`
  - `atCheckpoint: UInt53`
  - `beforeCheckpoint: UInt53`
  - `function: String`
  - `kind: TransactionKindInput`
  - `affectedAddress: SuiAddress`
  - `affectedObject: SuiAddress`
  - `sentAddress: SuiAddress`

### Effects data needed for summaries

- `Transaction.effects` exists.
- `TransactionEffects` includes:
  - `status`
  - `timestamp`
  - `checkpoint`
  - `balanceChanges(first/after/last/before)`
  - `objectChanges(first/after/last/before)`
  - `events(first/after/last/before)`

### Checkpoint support for time mapping

- `Query.checkpoint(sequenceNumber: UInt53)` exists and includes timestamp.
- `Query.checkpoints(..., filter: CheckpointFilter)` exists.
- `CheckpointFilter` supports checkpoint and epoch bounds, but **not timestamp bounds**.

## Feasibility Assessment

### 1) Transaction overview summaries

Status: **Feasible now**

Implementation approach:
- Use current transaction list queries for basic rows.
- Batch fetch effects for visible rows via `multiGetTransactionEffects(keys: [...])` and include `balanceChanges`.
- Generate deterministic per-tx flow summaries like:
  - `-10.0 SUI, +9.4 USDC`
  - Optionally enriched with existing intent heuristic chip (`analyzeTxIntent`) already in code.

Constraints:
- Fully semantic labels (`Swap`, `Stake`, `Deposit`) are best-effort only unless protocol-specific decoders are added.
- Balance deltas are reliable; action naming is probabilistic.

### 2) Date range filtering

Status: **Feasible with checkpoint mapping**

Important limitation:
- GraphQL does not expose direct `timestampFrom/timestampTo` transaction filters.

Implementation approach:
- Convert UI time range into checkpoint bounds:
  - Find checkpoint for `from` timestamp (binary search over `checkpoint(sequenceNumber)` timestamps).
  - Find checkpoint for `to` timestamp similarly.
- Query transactions with `filter: { afterCheckpoint, beforeCheckpoint }`.
- Apply final client-side timestamp trim for precise display range.

Constraints:
- Checkpoint-level granularity means boundaries are approximate before final client trim.
- Requires extra checkpoint calls when range changes.

### 3) CSV export

Status: **Feasible now**

Implementation approach:
- Export currently filtered in-memory transaction rows.
- Browser-only download via `Blob` and temporary `a[download]` click.
- Suggested columns:
  - `timestamp`
  - `digest`
  - `checkpoint`
  - `sender`
  - `status`
  - `summary`
  - `net_flows`

USD valuation note:
- Accurate historical USD at tx time is **not currently reliable** without historical price snapshots per timestamp/checkpoint.
- Feasible fallback:
  - include `usd_value_current_snapshot`
  - include `pricing_timestamp` and label clearly as export-time valuation

## Existing Code Reuse

Current code already contains reusable pieces:
- `multiGetTransactionEffectsSummary(...)` helper
- deterministic intent heuristic: `analyzeTxIntent(...)`
- transaction list views on global transactions and address page

This reduces implementation risk and avoids architecture changes.

## Proposed Delivery (Phased)

Phase 1 (issue #3 core):
- Add list summary column using balance deltas
- Add date presets (`7d`, `30d`) + custom date range
- Add CSV export for filtered list
- Keep pricing column optional or marked as snapshot value

Phase 2 (optional quality upgrade):
- Protocol-specific semantic summaries (Swap/Stake/Deposit/Claim classification)
- Historical pricing model (checkpoint-indexed price snapshots) if required

## Overall Verdict

Issue #3 is implementable in the current GraphQL-first static architecture.

- Summaries: yes
- Date range: yes, via checkpoint mapping
- CSV export: yes
- Historical USD-at-time: partial, requires additional data model for full accuracy
