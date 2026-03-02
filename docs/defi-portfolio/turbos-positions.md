# Querying Turbos CLMM Positions via Sui GraphQL

Turbos is a concentrated liquidity DEX on Sui using the same Uniswap v3 tick math
as Cetus. The key difference is that position data is stored in a shared container
object rather than directly in the NFT.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Package | `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1` | Turbos package |
| Positions Container | `0xf5762ae5ae19a2016bb233c72d9a4b2cba5a302237a82724af66292ae43ae52d` | Shared object holding all position data |

## Types

```
TurbosPositionNFT = 0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::position_nft::TurbosPositionNFT
```

## Step-by-step Query Flow

### Step 1: Find Position NFTs

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::position_nft::TurbosPositionNFT" }, first: 50) {
      nodes { address contents { json } }
    }
  }
}
```

NFT JSON fields:
- `pool_id` — pool object ID
- `coin_type_a` — coin A type string
- `coin_type_b` — coin B type string

Note: Unlike Cetus, Turbos stores coin types on the NFT directly.

### Step 2: Fetch Position Data from Container

The actual tick/liquidity data is in the shared positions container, keyed by
the NFT's object address using `dynamicObjectField`:

```graphql
{
  container: object(address: "0xf5762ae5ae19a2016bb233c72d9a4b2cba5a302237a82724af66292ae43ae52d") {
    pos0: dynamicObjectField(name: { type: "address", bcs: "<addrBcs(nft.address)>" }) {
      value { ... on MoveObject { contents { json } } }
    }
    pos1: dynamicObjectField(name: { type: "address", bcs: "<addrBcs(nft.address)>" }) {
      value { ... on MoveObject { contents { json } } }
    }
  }
}
```

Position JSON fields:
- `tick_lower_index` — lower tick (u32, interpret as i32)
- `tick_upper_index` — upper tick (u32, interpret as i32)
- `liquidity` — position liquidity (u128)

### Step 3: Fetch Pool Objects

```graphql
{
  p0: object(address: "<pool_id>") {
    asMoveObject { contents { type { repr } json } }
  }
}
```

Pool JSON: `tick_current_index` or `current_tick_index` (u32, interpret as i32)

### Step 4: Compute LP Amounts

Identical to Cetus — uses the same `getCoinAmountsFromLiquidity`, `tickToSqrtPriceX64`,
and `i32FromBits` functions. See [cetus-positions.md](./cetus-positions.md) for the math.

## Key Difference from Cetus

| | Cetus | Turbos |
|--|-------|--------|
| Position data location | Stored in the position NFT itself | Stored in shared container, keyed by NFT address |
| Coin types source | Extracted from pool type generics | Stored on the NFT JSON (`coin_type_a`, `coin_type_b`) |
| Dynamic field type | N/A | `dynamicObjectField` (not `dynamicField`) |
| LP math | Uni v3 CLMM | Uni v3 CLMM (identical) |

## Gotchas

1. **`dynamicObjectField` vs `dynamicField`.** Turbos uses `dynamicObjectField` for
   position lookups. This is a different GraphQL field than `dynamicField`.
2. **Container pattern.** Position data is NOT on the NFT. You must query the shared
   container object with the NFT address as the key.
3. **Zero liquidity.** Skip positions where `liquidity === 0`.
