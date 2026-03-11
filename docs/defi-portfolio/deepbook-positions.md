# Querying DeepBook Positions via Sui GraphQL

DeepBook v3 is the native orderbook on Sui. It supports both spot trading and margin
positions through balance managers.

## Doc Metadata

- Last verified: `2026-03-11`
- Adapter key: `deepbook`
- Code entrypoint: `site/src/app/30-pages.js` via `fetchDeepBookPositions` and `fetchSuiPriceFromDeepBook`; normalized through `site/src/app/35-defi-adapters.js`

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Spot Package | `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809` | DeepBook spot package |
| Margin Package | `0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b` | DeepBook margin package |
| SUI/USDC Pool | `0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407` | Main spot pool |
| Margin Managers Table | `0x092e684ffea68219f928b02b5888883a6214a5f689833cb78cd304a17477d195` | `Table<address, VecSet<ID>>` |
| Pool Registry Table | `0x09649d4bd62fcac10f6d4ff14716f0658456a7c33a74a04052e3e4027a646958` | Risk configs per pool |

## Known Pools

| Pool Address | Asset | Decimals |
|-------------|-------|----------|
| `0x53041c6f86c4782aabbfc1d4fe234a6d37160310c7ee740c915f0a01b7127344` | SUI | 9 |
| `0xba473d9ae278f10af75c50a8fa341e9c6a1c087dc91a3f23e8048baf67d0754f` | USDC | 6 |
| `0x38decd3dbb62bd4723144349bf57bc403b393aee86a51596846a824a1e0c2c01` | WAL | 9 |
| `0x1d723c5cd113296868b55208f2ab5a905184950dd59c48eb7345607d6b5e6af7` | DEEP | 6 |
| `0xbb990ca04a774326c3bf589e4bc67904ea076e3df7b85a7b81e2ca8a94b18253` | SUI_USDE | 6 |

## Fetching SUI Price from DeepBook

Walk recent pool versions and extract `OrderFilled` events:

```graphql
{
  object(address: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407") {
    objectVersionsBefore(last: 12) {
      nodes {
        previousTransaction {
          effects {
            status
            events(first: 30) {
              nodes { contents { type { repr } json } }
            }
          }
        }
      }
    }
  }
}
```

### Price Computation

```
# From OrderFilled events:
price = quote_quantity / base_quantity
base  = base_quantity / 10^9    # SUI decimals
quote = quote_quantity / 10^6   # USDC decimals
price = quote / base

# From Limit Order events (fallback):
price = json.price / 10^6

# Best effort: midpoint of best bid/ask
price = (best_bid + best_ask) / 2
```

The system checks the last 12 pool versions (configurable via
`DEEPBOOK_PRICE_LOOKBACK_VERSIONS`), looking at up to 30 events per transaction
(`DEEPBOOK_PRICE_EVENTS_PER_TX`). Filled trades are preferred over limit orders.

## Querying Margin Positions

### Step 1: Find Manager IDs

```graphql
{
  address(address: "0x092e684ffea68219f928b02b5888883a6214a5f689833cb78cd304a17477d195") {
    dynamicField(name: { type: "address", bcs: "<addrBcs(wallet)>" }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

Returns a `VecSet` of balance manager object IDs.

### Step 2: Fetch Manager Objects

Batch-fetch all manager objects:

```graphql
{
  m0: object(address: "<manager_id>") {
    asMoveObject { contents { type { repr } json } }
  }
}
```

Manager JSON fields:
- `balance_manager.balances.id` — bag of collateral coins
- `balance_manager.balances.size` — number of coin types
- `borrowed_base_shares` / `borrowed_quote_shares` — borrowed amounts
- `take_profit_stop_loss` — TP/SL config

### Step 3: Fetch Collateral Bags

```graphql
{
  bag: address(address: "<balances.id>") {
    dynamicFields(first: 10) {
      nodes {
        name { type { repr } json }
        value { ... on MoveValue { type { repr } json } }
      }
    }
  }
}
```

Coin type is extracted from the dynamic field key's type generic parameter:
`name.type.repr` matches `/<(.+)>/` to extract the coin type.

### Step 4: Fetch Risk Configs

```graphql
{
  address(address: "0x09649d4bd62fcac10f6d4ff14716f0658456a7c33a74a04052e3e4027a646958") {
    dynamicFields(first: 10) {
      nodes { name { json } value { ... on MoveValue { json } } }
    }
  }
}
```

## Scale Constants

```
SCALE = 1_000_000_000  (1e9)
```

All internal amounts are scaled by 1e9.

## Gotchas

1. **Version-walking for prices.** DeepBook doesn't expose a simple price field — you
   must walk recent pool object versions and extract events from their transactions.
2. **Bag dynamic fields.** Collateral is stored in a `Bag` where each entry's key type
   contains the coin type as a generic parameter.
3. **Multiple pools.** Each trading pair has its own pool. The `KNOWN_POOLS` mapping
   resolves pool addresses to asset names.
