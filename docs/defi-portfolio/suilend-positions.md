# Querying Suilend Positions via Sui GraphQL

Suilend is a lending protocol on Sui. Positions are stored as `Obligation` objects
owned by `ObligationOwnerCap` NFTs in the user's wallet.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Main Pool | `0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1` | Lending market shared object with all reserves |
| Package | `0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf` | Suilend Move package |

## Types

```
ObligationOwnerCap = 0xf95b06141...::lending_market::ObligationOwnerCap<0xf95b06141...::suilend::MAIN_POOL>
```

## Step-by-step Query Flow

### Step 1: Find ObligationOwnerCaps

Query the user's wallet for Suilend cap NFTs:

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::lending_market::ObligationOwnerCap<0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf::suilend::MAIN_POOL>" }, first: 10) {
      nodes { contents { json } }
    }
  }
}
```

Each cap's `json.obligation_id` points to the obligation object.

### Step 2: Fetch Obligations

Batch-fetch each obligation object:

```graphql
{
  ob0: object(address: "<obligation_id>") {
    asMoveObject { contents { json } }
  }
  ob1: object(address: "<obligation_id_2>") {
    asMoveObject { contents { json } }
  }
}
```

**Obligation JSON structure:**
```json
{
  "deposits": [
    {
      "coin_type": { "name": "0x2::sui::SUI" },
      "market_value": { "value": "12345678901234567890" },
      "deposited_ctoken_amount": "1000000000"
    }
  ],
  "borrows": [
    {
      "coin_type": { "name": "0xdba...::usdc::USDC" },
      "market_value": { "value": "5000000000000000000" },
      "borrowed_amount": { "value": "500000000" }
    }
  ],
  "deposited_value_usd": { "value": "..." },
  "unweighted_borrowed_value_usd": { "value": "..." },
  "weighted_borrowed_value_usd": { "value": "..." },
  "unhealthy_borrow_value_usd": { "value": "..." }
}
```

### Step 3: Parse Positions

```
deposit_usd  = deposit.market_value.value / 1e18
deposit_amt  = deposit.deposited_ctoken_amount / 10^decimals

borrow_usd   = borrow.market_value.value / 1e18
borrow_amt   = borrow.borrowed_amount.value / 10^decimals

total_deposit_usd = deposited_value_usd.value / 1e18
total_borrow_usd  = unweighted_borrowed_value_usd.value / 1e18

health_factor = unhealthy_borrow_value_usd.value / weighted_borrowed_value_usd.value
```

Note: `market_value` fields use **fixed-18 precision** (divide by 1e18).

## Fetching Lending Rates (No Wallet Required)

Query the main pool object for all reserve data:

```graphql
{
  object(address: "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1") {
    asMoveObject { contents { json } }
  }
}
```

`json.reserves[]` contains each asset's config and state.

### Rate Computation

```
borrowed     = borrowed_amount.value / 1e18
available    = available_amount
utilization  = borrowed / (available + borrowed)

# Kink-based interpolation
kinks = decodeB64U8Array(config.element.interest_rate_utils)  # base64 → [u8]
aprs  = config.element.interest_rate_aprs                     # array of bps values
borrow_bps = interpolateRateBps(utilization * 100, kinks, aprs)

spread_bps = config.element.spread_fee_bps
supply_bps = borrow_bps * utilization * (1 - spread_bps / 10000)
```

The `interest_rate_utils` field is a base64-encoded array of u8 utilization percentage
breakpoints. The `interest_rate_aprs` are the corresponding rate values in bps at each
breakpoint. Linear interpolation between kink points gives the current rate.

## Gotchas

1. **Fixed-18 precision.** All USD market values use 1e18 scaling, not 1e6 or 1e9.
2. **Kink interpolation.** Rates are piecewise-linear between utilization breakpoints.
   The kink array is base64-encoded bytes, not a JSON array.
3. **Coin type names.** The `coin_type.name` field includes the full type path
   (e.g., `0x2::sui::SUI`).
