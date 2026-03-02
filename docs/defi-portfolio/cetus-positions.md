# Querying Cetus CLMM Positions via Sui GraphQL

Cetus is a concentrated liquidity market maker (CLMM) DEX on Sui, using
Uniswap v3-style tick-based liquidity positions.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Package | `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb` | Cetus CLMM package |

## Types

```
Position = 0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position
```

## Step-by-step Query Flow

### Step 1: Find Position NFTs

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position" }, first: 50, after: "<cursor>") {
      pageInfo { hasNextPage endCursor }
      nodes { address contents { json } }
    }
  }
}
```

Position JSON fields:
- `pool` — pool object ID
- `tick_lower_index` — lower tick bound (u32, interpret as i32)
- `tick_upper_index` — upper tick bound (u32, interpret as i32)
- `liquidity` — position liquidity (u128)

### Step 2: Fetch Pool Objects

Batch-fetch pools to get current tick and coin types:

```graphql
{
  p0: object(address: "<pool_id>") {
    asMoveObject {
      contents { type { repr } json }
    }
  }
}
```

Pool type repr: `0x1eabed72c...::pool::Pool<CoinTypeA, CoinTypeB>`
Pool JSON: `current_tick_index` (u32, interpret as i32), `sqrt_price` (u128)

Extract coin types A and B from the pool's generic type parameters.

### Step 3: Compute LP Amounts

Uses Uniswap v3 concentrated liquidity math:

```javascript
const Q64 = 2n ** 64n;

// Convert u32 bits to signed i32
function i32FromBits(val) {
  return val >= 0x80000000 ? val - 0x100000000 : val;
}

// Tick → sqrt price (Q64 fixed point)
function tickToSqrtPriceX64(tick) {
  return BigInt(Math.round(Math.pow(1.0001, tick / 2) * Number(Q64)));
}

// Compute amounts from liquidity and price range
function getCoinAmountsFromLiquidity(liq, curSqrt, lowSqrt, upSqrt) {
  let coinA = 0n, coinB = 0n;
  if (curSqrt < lowSqrt) {
    // All in coin A (above range)
    coinA = liq * (upSqrt - lowSqrt) * Q64 / (lowSqrt * upSqrt);
  } else if (curSqrt >= upSqrt) {
    // All in coin B (below range)
    coinB = liq * (upSqrt - lowSqrt) / Q64;
  } else {
    // In range — split between A and B
    coinA = liq * (upSqrt - curSqrt) * Q64 / (curSqrt * upSqrt);
    coinB = liq * (curSqrt - lowSqrt) / Q64;
  }
  return { coinA, coinB };
}

// Convert to human amounts
amountA = Number(coinA) / 10 ** decimalsA;
amountB = Number(coinB) / 10 ** decimalsB;

// Check if in range
inRange = currentTick >= lowerTick && currentTick < upperTick;
```

## Gotchas

1. **Signed tick indices.** Ticks are stored as `u32` on-chain but represent signed `i32`
   values. Apply two's complement: `val >= 0x80000000 ? val - 0x100000000 : val`.
2. **Q64 fixed-point math.** `sqrt_price` is a Q64.64 fixed-point number. All CLMM math
   must use BigInt to avoid precision loss.
3. **Zero liquidity.** Positions with `liquidity === 0` (fully withdrawn) should be skipped.
4. **Pool type generics.** Coin types A and B are extracted from the pool's Move type
   repr string, not from the position itself.
