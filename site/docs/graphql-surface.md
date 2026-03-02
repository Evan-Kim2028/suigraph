# GraphQL Surface

Generated: `2026-03-02T18:51:29.487Z`

| Metric | Value |
|---|---:|
| Total `gql(...)` call sites | 82 |
| Awaited `gql(...)` call sites | 80 |
| Static template-literal query call sites | 77 |
| Dynamic/non-literal query call sites | 5 |
| Unique static query signatures | 73 |

## Operations

| Signature | Static call sites | Preview |
|---|---:|---|
| `anonymous:8a3c1e6888` | 2 | `{ ${parts.join("\n")} }` |
| `anonymous:b365a39e1d` | 2 | `{ ${aliases.join("\n")} }` |
| `anonymous:bda79ad960` | 2 | `{ checkpoint { sequenceNumber timestamp } }` |
| `anonymous:e186e83057` | 2 | `query($cp: UInt53!){ checkpoint(sequenceNumber: $cp) { sequenceNumber timestamp } }` |
| `anonymous:01c04ae2ce` | 1 | `query($table: SuiAddress!, $bcs: Base64!) { address(address: $table) { dynamicField(name: { type` |
| `anonymous:0203244b68` | 1 | `query($ct: String!) { coinMetadata(coinType: $ct) { decimals symbol name iconUrl supply } }` |
| `anonymous:056d3c957d` | 1 | `{ address(address: "${NAVI_RESERVES_TABLE}") { ${reserveParts.join("\n")} } }` |
| `anonymous:0635c6a255` | 1 | `{ checkpoint { timestamp } epochs(last: 8) { nodes { epochId startTimestamp endTimestamp totalTr` |
| `anonymous:089f720188` | 1 | `query($before: String) { transactions(last: 25, before: $before) { pageInfo { hasPreviousPage st` |
| `anonymous:0c11c259bf` | 1 | `query($seq: UInt53!) { checkpoint(sequenceNumber: $seq) { sequenceNumber digest timestamp previo` |
| `anonymous:0e00ae4262` | 1 | `{ address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") { dynamicFields(first: 30) { nodes { name` |
| `anonymous:1225d1b9b8` | 1 | `{ ${tableQueries.join("\n")} }` |
| `anonymous:12c8eb9b2c` | 1 | `query($id: SuiAddress!, $before: String) { packageVersions(address: $id, last: 20, before: $befo` |
| `anonymous:15082280fe` | 1 | `query($id: SuiAddress!, $after: String) { object(address: $id) { dynamicFields(first: 20, after:` |
| `anonymous:15b781180e` | 1 | `query($id: UInt53!) { epoch(epochId: $id) { epochId startTimestamp endTimestamp referenceGasPric` |
| `anonymous:1ffa0e71ce` | 1 | `{ address(address: "${WORMHOLE_REGISTRY}") { dynamicField(name: { type: "${keyType}", bcs: "AA==` |
| `anonymous:22d7fb24ba` | 1 | `query($addr: SuiAddress!, $after: String) { address(address: $addr) { objects(first: 20, after: ` |
| `anonymous:2ed11ae35c` | 1 | `query($id: SuiAddress!) { firstTx: transactions(first: 1, filter: { affectedObject: $id }) { nod` |
| `anonymous:34832c19b8` | 1 | `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address asMoveObject { contents { t` |
| `anonymous:35b818c0ca` | 1 | `{ epoch(epochId: ${epochId - 1}) { totalStakeRewards totalStakeSubsidies totalGasFees fundSize f` |
| `anonymous:37d9d78533` | 1 | `query($digest: String!) { transactionEffects(digest: $digest) { status timestamp executionError ` |
| `anonymous:3baad530d8` | 1 | `{ address(address: "${ALPHA_POSITIONS_TABLE}") { ${posParts.join("\n")} } }` |
| `anonymous:4383cddd82` | 1 | `query($keys: [String!]!, $first: Int!) { multiGetTransactionEffects(keys: $keys) { digest status` |
| `anonymous:4741b50030` | 1 | `{ object(address: "${SUILEND_MAIN_POOL_OBJECT}") { asMoveObject { contents { json } } } }` |
| `anonymous:4b34039d98` | 1 | `{ borrowDynamics: address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") { dynamicFields(first: 50` |
| `anonymous:4bf1cdf245` | 1 | `query($keys: [String!]!) { multiGetTransactionEffects(keys: $keys) { digest status timestamp che` |
| `anonymous:4c5ddace6d` | 1 | `{ checkpoints(last: 10) { nodes { sequenceNumber timestamp networkTotalTransactions transactions` |
| `anonymous:4ce0dbb140` | 1 | `query($addr: SuiAddress!) { object(address: $addr) { asMovePackage { modules(first: 250) { nodes` |
| `anonymous:57c13f1965` | 1 | `query($keys:[UInt53!]!,$obj:SuiAddress!,$fmt:String!){ multiGetCheckpoints(keys:$keys){ sequence` |
| `anonymous:596e7ed6f8` | 1 | `query($addr: SuiAddress!, $before: String) { address(address: $addr) { transactions(last: 20, be` |
| `anonymous:62dca9ebf7` | 1 | `{ address(address: "${NAVI_RESERVES_TABLE}") { dynamicFields(first: 50) { nodes { value { ... on` |
| `anonymous:6da0786496` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${ALPHA_CAP_TYPE}" }, first: 10) { node` |
| `anonymous:71e590b537` | 1 | `{ serviceConfig { maxMultiGetSize queryTimeoutMs maxQueryDepth maxQueryNodes maxQueryPayloadSize` |
| `anonymous:73fad52f34` | 1 | `{ transactions(last: 50, filter: { kind: PROGRAMMABLE_TX }) { nodes { digest sender { address } ` |
| `anonymous:740ec7ae02` | 1 | `query($pkg: String!) { transactions(last: 50, filter: { function: $pkg }) { nodes { digest sende` |
| `anonymous:7bee0dfe38` | 1 | `{ address(address: "${ALPHA_MARKETS_TABLE}") { dynamicFields(first: 50) { nodes { name { json } ` |
| `anonymous:7eacfa097c` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${SUILEND_CAP_TYPE}" }, first: 10) { no` |
| `anonymous:7ee6aa1f0f` | 1 | `query($name: String!) { nameRecord(name: $name) { target { address } } }` |
| `anonymous:89eada1674` | 1 | `{ address(address: "${addr}") { balances(first: 50${afterClause}) { pageInfo { hasNextPage endCu` |
| `anonymous:8e3af7bf61` | 1 | `query($pkg: SuiAddress!, $mod: String!) { object(address: $pkg) { asMovePackage { module(name: $` |
| `anonymous:8e5f6a5c6d` | 1 | `{ address(address: "${POOL_REGISTRY_TABLE}") { dynamicFields(first: 10) { nodes { name { json } ` |
| `anonymous:91659f0281` | 1 | `{ object(address: "${q}") { asMovePackage { modules { nodes { name } } } asMoveObject { contents` |
| `anonymous:9b53003ec9` | 1 | `query($id: SuiAddress!) { objectVersions(address: $id, last: 20) { pageInfo { hasPreviousPage st` |
| `anonymous:9cb61b0466` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${SCALLOP_KEY_TYPE}" }, first: 10) { no` |
| `anonymous:a02961d84d` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${BLUEFIN_POSITION_TYPE}" }, first: 50)` |
| `anonymous:a159212d20` | 1 | `query($bag: SuiAddress!) { address(address: $bag) { dynamicFields(first: 10) { nodes { name { ty` |
| `anonymous:a3cb9c3603` | 1 | `query($id: SuiAddress!, $after: String) { object(address: $id) { asMovePackage { modules(first: ` |
| `anonymous:a91bdfa1eb` | 1 | `{ object(address: "${DEEPBOOK_SUI_USDC_POOL}") { objectVersionsBefore(last: ${DEEPBOOK_PRICE_LOO` |
| `anonymous:abac38445d` | 1 | `{ address(address: "${NAVI_USER_INFO_TABLE}") { dynamicField(name: { type: "address", bcs: "${ad` |
| `anonymous:ad3a98780d` | 1 | `{ checkpoint { sequenceNumber digest timestamp networkTotalTransactions rollingGasSummary { comp` |
| `anonymous:ae5d68c4f5` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${CETUS_POSITION_TYPE}" }, first: 50${a` |
| `anonymous:b49df69846` | 1 | `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address asMoveObject { contents { j` |
| `anonymous:bac8d84117` | 1 | `query($digest: String!) { transaction(digest: $digest) { digest sender { address } gasInput { ga` |
| `anonymous:bd357d462a` | 1 | `{ transactions(last: 40, filter: { kind: PROGRAMMABLE_TX }) { nodes { digest transactionBcs effe` |
| `anonymous:bd4cb9840a` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${AF_ACCOUNT_CAP_TYPE}" }, first: 5) { ` |
| `anonymous:c3fbfb3740` | 1 | `{ ${bagParts.join("\n")} }` |
| `anonymous:c59dbf78a6` | 1 | `{ checkpoint { sequenceNumber digest timestamp networkTotalTransactions } transactions(last: 10,` |
| `anonymous:c8a66679a9` | 1 | `query($pkg: SuiAddress!) { packageVersions(address: $pkg, last: 20) { nodes { address version pr` |
| `anonymous:c9259a7fdf` | 1 | `query($tx: JSON!) { simulateTransaction(transaction: $tx, checksEnabled: ${!simSkipChecks}) { ef` |
| `anonymous:caaea332b2` | 1 | `query($after: String) { checkpoints(last: 25, before: $after) { pageInfo { hasPreviousPage start` |
| `anonymous:d21d0280cb` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${TURBOS_POSITION_TYPE}" }, first: 50) ` |
| `anonymous:d9d8064ed2` | 1 | `query($pkg: SuiAddress!) { object(address: $pkg) { asMovePackage { linkage { originalId upgraded` |
| `anonymous:db2fcce76b` | 1 | `{ chainIdentifier serviceConfig { maxMultiGetSize queryTimeoutMs maxQueryDepth maxQueryNodes max` |
| `anonymous:e60dab97bc` | 1 | `query($id: SuiAddress!, $before: String) { objectVersions(address: $id, last: 20, before: $befor` |
| `anonymous:e97b834867` | 1 | `{ object(address: "${p.objAddr}") { asMoveObject { contents { json } } } }` |
| `anonymous:ea3607e47e` | 1 | `{ events(last: 50 ${filterArg}) { nodes { contents { type { repr } json } sender { address } tim` |
| `anonymous:eb1f358492` | 1 | `query($addr: SuiAddress!) { address(address: $addr) { address defaultNameRecord { domain } balan` |
| `anonymous:edc6600b90` | 1 | `query($id: SuiAddress!) { object(address: $id) { address version digest storageRebate owner { ..` |
| `anonymous:f1dbd91c19` | 1 | `{ ${balParts.join("\n")} }` |
| `anonymous:f2b1818c3d` | 1 | `query($id: SuiAddress!, $before: String) { objectVersions(address: $id, last: 20, before: $befor` |
| `anonymous:f8a5904526` | 1 | `{ address(address: "${BLUEFIN_PRO_ACCOUNTS_TABLE}") { dynamicField(name: { type: "address", bcs:` |
| `anonymous:fc8916eda7` | 1 | `{ ssui: object(address: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b") { ` |
| `anonymous:ff941e9100` | 1 | `query($keys:[UInt53!]!){ multiGetCheckpoints(keys:$keys){ sequenceNumber timestamp networkTotalT` |

Notes:
- This is a static source scan of `src/app.js`.
- Runtime call count/latency remains available in the in-app perf badge.
