# GraphQL Surface

Generated: `2026-03-10T10:52:23.900Z`

| Metric | Value |
|---|---:|
| Total `gql(...)` call sites | 98 |
| Awaited `gql(...)` call sites | 96 |
| Static template-literal query call sites | 90 |
| Dynamic/non-literal query call sites | 8 |
| Unique static query signatures | 85 |

## Operations

| Signature | Static call sites | Preview |
|---|---:|---|
| `anonymous:b365a39e1d` | 4 | `{ ${aliases.join("\n")} }` |
| `anonymous:b1bb773cd5` | 2 | `{ epoch { epochId startTimestamp referenceGasPrice validatorSet { activeValidators(first: 50) { ` |
| `anonymous:e186e83057` | 2 | `query($cp: UInt53!){ checkpoint(sequenceNumber: $cp) { sequenceNumber timestamp } }` |
| `anonymous:01c04ae2ce` | 1 | `query($table: SuiAddress!, $bcs: Base64!) { address(address: $table) { dynamicField(name: { type` |
| `anonymous:0203244b68` | 1 | `query($ct: String!) { coinMetadata(coinType: $ct) { decimals symbol name iconUrl supply } }` |
| `anonymous:0399123075` | 1 | `query($seq: UInt53) { checkpoint(sequenceNumber: $seq) { sequenceNumber timestamp } }` |
| `anonymous:056d3c957d` | 1 | `{ address(address: "${NAVI_RESERVES_TABLE}") { ${reserveParts.join("\n")} } }` |
| `anonymous:0635c6a255` | 1 | `{ checkpoint { timestamp } epochs(last: 8) { nodes { epochId startTimestamp endTimestamp totalTr` |
| `anonymous:0684d0b1f7` | 1 | `{ checkpoint { sequenceNumber digest timestamp networkTotalTransactions } }` |
| `anonymous:09c1d2a71d` | 1 | `{ transactions(last: 50, filter: { kind: PROGRAMMABLE_TX }) { nodes { digest sender { address } ` |
| `anonymous:0c11c259bf` | 1 | `query($seq: UInt53!) { checkpoint(sequenceNumber: $seq) { sequenceNumber digest timestamp previo` |
| `anonymous:0e00ae4262` | 1 | `{ address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") { dynamicFields(first: 30) { nodes { name` |
| `anonymous:1225d1b9b8` | 1 | `{ ${tableQueries.join("\n")} }` |
| `anonymous:12c8eb9b2c` | 1 | `query($id: SuiAddress!, $before: String) { packageVersions(address: $id, last: 20, before: $befo` |
| `anonymous:14313088e2` | 1 | `{ ${fields} }` |
| `anonymous:15b781180e` | 1 | `query($id: UInt53!) { epoch(epochId: $id) { epochId startTimestamp endTimestamp referenceGasPric` |
| `anonymous:1ffa0e71ce` | 1 | `{ address(address: "${WORMHOLE_REGISTRY}") { dynamicField(name: { type: "${keyType}", bcs: "AA==` |
| `anonymous:2321391609` | 1 | `query($type: String!, $after: String, $first: Int!) { objects(filter: { type: $type }, first: $f` |
| `anonymous:2d1ddb4550` | 1 | `query($digest: String!) { transactionEffects(digest: $digest) { status timestamp executionError ` |
| `anonymous:2ed11ae35c` | 1 | `query($id: SuiAddress!) { firstTx: transactions(first: 1, filter: { affectedObject: $id }) { nod` |
| `anonymous:35b818c0ca` | 1 | `{ epoch(epochId: ${epochId - 1}) { totalStakeRewards totalStakeSubsidies totalGasFees fundSize f` |
| `anonymous:3baad530d8` | 1 | `{ address(address: "${ALPHA_POSITIONS_TABLE}") { ${posParts.join("\n")} } }` |
| `anonymous:3ef10e64e7` | 1 | `query($pkg: String!) { transactions(last: 50, filter: { function: $pkg }) { nodes { digest sende` |
| `anonymous:41abdd3dc0` | 1 | `query($addr: SuiAddress!, $before: String, $filter: TransactionFilter) { address(address: $addr)` |
| `anonymous:462e16f9c8` | 1 | `{ events(last: 50 ${filterArg}) { nodes { contents { type { repr } } sender { address } timestam` |
| `anonymous:4b34039d98` | 1 | `{ borrowDynamics: address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") { dynamicFields(first: 50` |
| `anonymous:4b47270ed5` | 1 | `query($id: SuiAddress!) { object(address: $id) { address version digest storageRebate owner { ${` |
| `anonymous:4bf1cdf245` | 1 | `query($keys: [String!]!) { multiGetTransactionEffects(keys: $keys) { digest status timestamp che` |
| `anonymous:4c5ddace6d` | 1 | `{ checkpoints(last: 10) { nodes { sequenceNumber timestamp networkTotalTransactions transactions` |
| `anonymous:4ce0dbb140` | 1 | `query($addr: SuiAddress!) { object(address: $addr) { asMovePackage { modules(first: 250) { nodes` |
| `anonymous:4ce30bcfa3` | 1 | `{ object(address: "${SUILEND_MAIN_POOL_OBJECT}") { ${GQL_F_MOVE_JSON} } }` |
| `anonymous:4fa205930a` | 1 | `{ checkpoint { sequenceNumber digest timestamp networkTotalTransactions } epoch { epochId refere` |
| `anonymous:53b61e40a6` | 1 | `query($addr: SuiAddress!, $type: String!, $after: String, $first: Int!) { address(address: $addr` |
| `anonymous:57c13f1965` | 1 | `query($keys:[UInt53!]!,$obj:SuiAddress!,$fmt:String!){ multiGetCheckpoints(keys:$keys){ sequence` |
| `anonymous:58f29d673a` | 1 | `query($digest: String!) { transaction(digest: $digest) { effects { events(first: 100) { nodes { ` |
| `anonymous:5df3ed1225` | 1 | `query($addr: SuiAddress!) { address(address: $addr) { address defaultNameRecord { domain } objec` |
| `anonymous:5f545b116d` | 1 | `query($id: SuiAddress!, $after: String) { object(address: $id) { dynamicFields(first: 20, after:` |
| `anonymous:62dca9ebf7` | 1 | `{ address(address: "${NAVI_RESERVES_TABLE}") { dynamicFields(first: 50) { nodes { value { ... on` |
| `anonymous:6b62c8038b` | 1 | `query($before: String, $filter: TransactionFilter) { transactions(last: 25, before: $before, fil` |
| `anonymous:6da0786496` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${ALPHA_CAP_TYPE}" }, first: 10) { node` |
| `anonymous:71e590b537` | 1 | `{ serviceConfig { maxMultiGetSize queryTimeoutMs maxQueryDepth maxQueryNodes maxQueryPayloadSize` |
| `anonymous:7bee0dfe38` | 1 | `{ address(address: "${ALPHA_MARKETS_TABLE}") { dynamicFields(first: 50) { nodes { name { json } ` |
| `anonymous:7e2ac8fa45` | 1 | `query($addr: SuiAddress!) { address(address: $addr) { transactions(last: ${AF_ORDER_EVENT_TX_SCA` |
| `anonymous:7eacfa097c` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${SUILEND_CAP_TYPE}" }, first: 10) { no` |
| `anonymous:7ee6aa1f0f` | 1 | `query($name: String!) { nameRecord(name: $name) { target { address } } }` |
| `anonymous:89eada1674` | 1 | `{ address(address: "${addr}") { balances(first: 50${afterClause}) { pageInfo { hasNextPage endCu` |
| `anonymous:8a3c1e6888` | 1 | `{ ${parts.join("\n")} }` |
| `anonymous:8e3af7bf61` | 1 | `query($pkg: SuiAddress!, $mod: String!) { object(address: $pkg) { asMovePackage { module(name: $` |
| `anonymous:8e5f6a5c6d` | 1 | `{ address(address: "${POOL_REGISTRY_TABLE}") { dynamicFields(first: 10) { nodes { name { json } ` |
| `anonymous:90742de58b` | 1 | `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address ${GQL_F_MOVE_JSON} } }` |
| `anonymous:935d2e165a` | 1 | `query($type: String!, $after: String) { objects(filter: { type: $type }, first: 50, after: $afte` |
| `anonymous:96fb77e0de` | 1 | `query($id: SuiAddress!, $before: String) { objectVersions(address: $id, last: 20, before: $befor` |
| `anonymous:9817231a82` | 1 | `{ transactions(last: 10, filter: {}) { nodes { digest sender { address } kind { __typename ... o` |
| `anonymous:99767258de` | 1 | `{ ssui: object(address: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b") { ` |
| `anonymous:9bc8df3d99` | 1 | `{ ${chAliases.join("\n")} }` |
| `anonymous:9cb61b0466` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${SCALLOP_KEY_TYPE}" }, first: 10) { no` |
| `anonymous:a02961d84d` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${BLUEFIN_POSITION_TYPE}" }, first: 50)` |
| `anonymous:a0d77f3566` | 1 | `{ object(address: "${DEEPBOOK_SUI_USDC_POOL}") { objectVersionsBefore(last: ${DEEPBOOK_PRICE_LOO` |
| `anonymous:a159212d20` | 1 | `query($bag: SuiAddress!) { address(address: $bag) { dynamicFields(first: 10) { nodes { name { ty` |
| `anonymous:a3cb9c3603` | 1 | `query($id: SuiAddress!, $after: String) { object(address: $id) { asMovePackage { modules(first: ` |
| `anonymous:a96eea1f93` | 1 | `query($id: SuiAddress!) { objectVersions(address: $id, last: 20) { pageInfo { hasPreviousPage st` |
| `anonymous:abac38445d` | 1 | `{ address(address: "${NAVI_USER_INFO_TABLE}") { dynamicField(name: { type: "address", bcs: "${ad` |
| `anonymous:abd3c39919` | 1 | `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address ${GQL_F_MOVE_TYPE_JSON} } }` |
| `anonymous:ae5d68c4f5` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${CETUS_POSITION_TYPE}" }, first: 50${a` |
| `anonymous:b514b3f838` | 1 | `query($id: SuiAddress!, $after: String, $first: Int!) { object(address: $id) { dynamicFields(fir` |
| `anonymous:b7959559e3` | 1 | `query($digest: String!) { transaction(digest: $digest) { digest sender { address } gasInput { ga` |
| `anonymous:bbf9babe13` | 1 | `query($before: String) { transactions(last: ${PAGE_SIZE}, before: $before, filter: { kind: PROGR` |
| `anonymous:bd357d462a` | 1 | `{ transactions(last: 40, filter: { kind: PROGRAMMABLE_TX }) { nodes { digest transactionBcs effe` |
| `anonymous:c3fbfb3740` | 1 | `{ ${bagParts.join("\n")} }` |
| `anonymous:c8a66679a9` | 1 | `query($pkg: SuiAddress!) { packageVersions(address: $pkg, last: 20) { nodes { address version pr` |
| `anonymous:ca5b111be2` | 1 | `query($id: SuiAddress!, $before: String) { objectVersions(address: $id, last: 20, before: $befor` |
| `anonymous:caaea332b2` | 1 | `query($after: String) { checkpoints(last: 25, before: $after) { pageInfo { hasPreviousPage start` |
| `anonymous:d21d0280cb` | 1 | `{ address(address: "${addr}") { objects(filter: { type: "${TURBOS_POSITION_TYPE}" }, first: 50) ` |
| `anonymous:d77d3c25a5` | 1 | `query($tx: JSON!) { simulateTransaction(transaction: $tx, checksEnabled: ${!simSkipChecks}) { ef` |
| `anonymous:d9d8064ed2` | 1 | `query($pkg: SuiAddress!) { object(address: $pkg) { asMovePackage { linkage { originalId upgraded` |
| `anonymous:da8f6c349d` | 1 | `query($type: String!, $after: String) { objects(filter: { type: $type }, first: 50, after: $afte` |
| `anonymous:db2fcce76b` | 1 | `{ chainIdentifier serviceConfig { maxMultiGetSize queryTimeoutMs maxQueryDepth maxQueryNodes max` |
| `anonymous:df83f0a4d6` | 1 | `{ ${obAliases.join("\n")} }` |
| `anonymous:dfa606a041` | 1 | `{ object(address: "${p.objAddr}") { ${GQL_F_MOVE_JSON} } }` |
| `anonymous:e641192baa` | 1 | `query($keys: [String!]!, $first: Int!) { multiGetTransactionEffects(keys: $keys) { digest status` |
| `anonymous:eb71e0a6bc` | 1 | `query($addr: SuiAddress!, $after: String) { address(address: $addr) { objects(first: 20, after: ` |
| `anonymous:f1dbd91c19` | 1 | `{ ${balParts.join("\n")} }` |
| `anonymous:f71b2f934e` | 1 | `{ object(address: "${q}") { asMovePackage { modules { nodes { name } } } ${GQL_F_MOVE_TYPE} } }` |
| `anonymous:f8a5904526` | 1 | `{ address(address: "${BLUEFIN_PRO_ACCOUNTS_TABLE}") { dynamicField(name: { type: "address", bcs:` |
| `anonymous:ff941e9100` | 1 | `query($keys:[UInt53!]!){ multiGetCheckpoints(keys:$keys){ sequenceNumber timestamp networkTotalT` |

Notes:
- This is a static source scan of `src/app.js`.
- Runtime call count/latency remains available in the in-app perf badge.
