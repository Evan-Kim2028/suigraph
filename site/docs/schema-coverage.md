# Schema Coverage

Generated from snapshot: `2026-02-28T20:58:08.939Z`

## Snapshot

- Endpoint: `https://graphql.mainnet.sui.io/graphql`
- Snapshot generated: `2026-02-28T20:58:08.939Z`

| Metric | Value |
|---|---:|
| Total gql call sites | 98 |
| Static template query call sites | 90 |
| Dynamic/non-literal call sites | 8 |
| Query root fields in schema snapshot | 32 |
| Query root fields used (static scan) | 22 |
| Query root coverage | 68.8% |
| Mutation root fields used | 0 |
| Subscription root fields used | 0 |
| Unknown root tokens in static scan | 0 |

## Used Query Roots

| Root field | Static call sites |
|---|---:|
| `address` | 26 |
| `object` | 13 |
| `transactions` | 8 |
| `checkpoint` | 7 |
| `epoch` | 5 |
| `checkpoints` | 3 |
| `objects` | 3 |
| `objectVersions` | 3 |
| `multiGetCheckpoints` | 2 |
| `multiGetObjects` | 2 |
| `multiGetTransactionEffects` | 2 |
| `packageVersions` | 2 |
| `serviceConfig` | 2 |
| `transaction` | 2 |
| `chainIdentifier` | 1 |
| `coinMetadata` | 1 |
| `epochs` | 1 |
| `events` | 1 |
| `nameRecord` | 1 |
| `protocolConfigs` | 1 |
| `simulateTransaction` | 1 |
| `transactionEffects` | 1 |

## Unused Query Roots

- `multiGetAddresses`
- `multiGetEpochs`
- `multiGetPackages`
- `multiGetTransactions`
- `multiGetTypes`
- `node`
- `package`
- `packages`
- `type`
- `verifyZkLoginSignature`

## Notes

- Coverage is based on static template-literal query scans in `src/app.js`.
- Dynamic query construction can undercount true runtime root-field usage.
- Refresh schema snapshot with `npm run schema:refresh` when upstream schema changes.
