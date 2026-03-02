# Querying AlphaFi Positions via Sui GraphQL

AlphaFi is a lending protocol on Sui with a kink-based interest rate model similar
to Suilend.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Package | `0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4` | AlphaFi Move package |
| Markets Table | `0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e` | `Table<u64, Market>` — per-market config and state |
| Positions Table | `0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba` | `Table<ID, Position>` — all user positions |

## Types

```
PositionCap = 0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4::position::PositionCap
```

## Known Market IDs

| ID | Symbol | ID | Symbol | ID | Symbol |
|----|--------|----|--------|----|--------|
| 1 | SUI | 11 | DEEP | 21 | ESUI |
| 2 | stSUI | 12 | ALPHA | 22 | EGUSDC |
| 3 | BTC | 13 | DMC | 23 | ETHIRD |
| 4 | LBTC | 14 | TBTC | 24 | EXBTC |
| 5 | USDT | 15 | IKA | 25 | SDEUSD |
| 6 | USDC | 16 | XBTC | 26 | EWAL |
| 7 | WAL | 17 | ALKIMI | 27 | RCUSDP |
| 8 | DEEP | 18 | XAUM | 28 | COIN |
| 9 | BLUE | 19 | UP | 29 | WBTC |
| 10 | ETH | 20 | EBTC | 30 | BTCVC |

## Step-by-step Query Flow

### Step 1: Find PositionCaps

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4::position::PositionCap" }, first: 10) {
      nodes { contents { json } }
    }
  }
}
```

Each cap's `json.position_id` (or similar) is an Object ID.

### Step 2: Fetch Positions from Positions Table

```graphql
{
  address(address: "0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba") {
    p0: dynamicField(name: { type: "0x2::object::ID", bcs: "<objectIdBcs(position_id)>" }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

**Position JSON structure:**
```json
{
  "total_collateral_usd": { "value": "..." },
  "total_loan_usd": { "value": "..." },
  "safe_collateral_usd": { "value": "..." },
  "deposits": { ... },
  "loans": { ... }
}
```

### Step 3: Parse Positions

```
deposited_usd  = total_collateral_usd.value / 1e18
borrowed_usd   = total_loan_usd.value / 1e18
safe_coll_usd  = safe_collateral_usd.value / 1e18
health_factor  = safe_coll_usd / borrowed_usd

# Deposits/loans keyed by market ID (integer)
# Map market ID → symbol using ALPHA_MARKETS table
# Amount = raw_amount / 10^decimals
```

## Fetching Lending Rates (No Wallet Required)

Query individual markets from the markets table:

```graphql
{
  address(address: "0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e") {
    sui: dynamicField(name: { type: "u64", bcs: "<u64Bcs(1)>" }) {
      value { ... on MoveValue { json } }
    }
    usdc: dynamicField(name: { type: "u64", bcs: "<u64Bcs(6)>" }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

### Rate Computation

```
utilization = borrowed_amount / (borrowed_amount + balance_holding)

kinks     = decodeB64U8Array(config.interest_rate_kinks)   # base64 → [u8]
rates     = config.interest_rates                           # bps at each kink
borrow_bps = interpolateRateBps(utilization * 100, kinks, rates)

spread_bps = config.spread_fee_bps
supply_bps = borrow_bps * utilization * (1 - spread_bps / 10000)
```

## BCS Encoding

```javascript
// u64 → 8-byte little-endian, base64
function u64Bcs(n) {
  const buf = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return btoa(String.fromCharCode(...buf));
}

// Object ID → 32-byte address, base64
function objectIdBcs(hexId) {
  return addrBcs(hexId);  // same as address encoding
}
```

## Gotchas

1. **Market ID keys.** Markets use `u64` integer keys, not coin type strings.
2. **Kink interpolation.** Same pattern as Suilend — base64-encoded utilization breakpoints
   with linear interpolation.
3. **Fixed-18 USD values.** All USD amounts use 1e18 precision.
