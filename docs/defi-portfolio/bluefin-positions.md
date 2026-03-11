# Querying Bluefin Positions via Sui GraphQL

Bluefin has two products: **Bluefin Spot** (CLMM DEX) and **Bluefin Pro** (perpetuals).

## Doc Metadata

- Last verified: `2026-03-11`
- Adapter key(s): `bluefinSpot`, `bluefinPro`
- Code entrypoint: `site/src/app/30-pages.js` via `fetchBluefinSpotPositions` and `fetchBluefinProPositions`; normalized through `site/src/app/35-defi-adapters.js`

## Bluefin Spot (CLMM DEX)

### Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Package | `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267` | Bluefin Spot package |

### Types

```
Position = 0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position
```

### Query Flow

**Step 1: Find Position NFTs**

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position" }, first: 50) {
      nodes { address contents { json } }
    }
  }
}
```

Position JSON fields:
- `pool_id` — pool object ID
- `coin_type_a` — coin A type (without `0x` prefix — add it)
- `coin_type_b` — coin B type (without `0x` prefix — add it)
- `lower_tick` — lower tick (u32 → i32)
- `upper_tick` — upper tick (u32 → i32)
- `liquidity` — position liquidity (u128)

**Step 2: Fetch Pool Objects**

Batch-fetch each unique `pool_id` so you can read the current tick and pool type:

```graphql
{
  p0: object(address: "<pool_id>") {
    asMoveObject {
      contents {
        type { repr }
        json
      }
    }
  }
}
```

Pool fields used by the current implementation:

- `current_tick_index` (or `tick_current_index` on some pools)
- pool Move type generics as a fallback source for coin types

**Step 3: Compute LP Amounts**

Bluefin Spot uses the same CLMM liquidity math as Cetus/Turbos, but the explorer computes it directly from Bluefin position JSON and pool state:

```text
cur_tick  = i32(pool.current_tick_index or pool.tick_current_index)
low_tick  = i32(position.lower_tick)
up_tick   = i32(position.upper_tick)

cur_sqrt  = tickToSqrtPriceX64(cur_tick)
low_sqrt  = tickToSqrtPriceX64(low_tick)
up_sqrt   = tickToSqrtPriceX64(up_tick)

{ coinA, coinB } = getCoinAmountsFromLiquidity(liquidity, cur_sqrt, low_sqrt, up_sqrt)

amount_a = coinA / 10^decimals_a
amount_b = coinB / 10^decimals_b
in_range = cur_tick >= low_tick && cur_tick < up_tick
```

`coin_type_a` / `coin_type_b` from the position JSON are preferred once the missing `0x` prefix is restored. If those fields are absent, fall back to the pool type generics.

### Bluefin-Specific Notes

- Coin types in position JSON lack the `0x` prefix. Prepend `"0x"` before use.
- Tick field names are `lower_tick` / `upper_tick` (not `tick_lower_index`).

---

## Bluefin Pro (Perpetuals)

### Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Accounts Table | `0x63f16b288f33fbe6d9374602cbbfa9948bf1cc175e9b0a91aa50085aa04980a0` | `Table<address, Account>` |

### Query Flow

**Single query — fetch account by wallet address:**

```graphql
{
  address(address: "0x63f16b288f33fbe6d9374602cbbfa9948bf1cc175e9b0a91aa50085aa04980a0") {
    dynamicField(name: { type: "address", bcs: "<addrBcs(wallet)>" }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

**Account JSON structure:**
```json
{
  "assets": [ { "quantity": "1000000000" } ],
  "cross_positions": [
    {
      "size": "500000000",
      "average_entry_price": "50000000000000",
      "margin": "100000000",
      "leverage": "5000000000",
      "is_long": true
    }
  ],
  "isolated_positions": [ ... ]
}
```

### Position Parsing

All values use **1e9 internal precision**:

```
collateral_usdc = sum(asset.quantity) / 1e9

# For each position (cross or isolated):
size        = position.size / 1e9
entry_price = position.average_entry_price / 1e9
margin      = position.margin / 1e9
leverage    = position.leverage / 1e9
is_long     = position.is_long
notional    = size * entry_price
```

## Gotchas

1. **Spot coin types lack `0x` prefix.** Always prepend when using Bluefin Spot positions.
2. **Pro uses 1e9 precision.** All perp values (size, price, margin, leverage) divide by 1e9.
3. **Pro has two position types.** Check both `cross_positions` and `isolated_positions`.
