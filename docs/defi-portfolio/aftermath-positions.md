# Querying Aftermath Perpetuals Positions via Sui GraphQL

Aftermath is a perpetuals protocol on Sui. Positions are stored in clearing house
objects, keyed by account ID.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Package | `0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068` | Aftermath perps package |

### Clearing Houses

| Address | Market |
|---------|--------|
| `0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920` | BTC/USD |
| `0xed358c545b4a6698f757d3840a6b7effd1b958dd31260931bef07691f255b1fa` | XAUT/USD |

## Types

```
AccountCap = 0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068::account::AccountCap
Position Key = 0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068::keys::Position
```

## Step-by-step Query Flow

### Step 1: Find AccountCaps

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068::account::AccountCap" }, first: 5) {
      nodes { contents { json } }
    }
  }
}
```

Each cap's `json.account_id` is a u64.

### Step 2: Fetch Positions from Clearing Houses

For each account × clearing house, query the position:

```graphql
{
  btc: object(address: "0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920") {
    dynamicField(name: {
      type: "0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068::keys::Position",
      bcs: "<u64Bcs(account_id)>"
    }) {
      value { ... on MoveValue { json } }
    }
  }
  xaut: object(address: "0xed358c545b4a6698f757d3840a6b7effd1b958dd31260931bef07691f255b1fa") {
    dynamicField(name: {
      type: "0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068::keys::Position",
      bcs: "<u64Bcs(account_id)>"
    }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

Batch with aliases: `a<account_id>_ch0`, `a<account_id>_ch1`, etc.

### Step 3: Parse Positions

Aftermath uses **IFixed** (256-bit signed integer, 1e18 scaled):

```javascript
function parseIFixed(val) {
  let raw = BigInt(val);
  // Two's complement for signed values
  if (raw >= 2n ** 255n) raw = raw - 2n ** 256n;
  return Number(raw) / 1e18;
}
```

**Position fields:**
```
base_amount  = parseIFixed(pos.base_asset_amount)    // positive = long, negative = short
notional     = parseIFixed(pos.quote_asset_notional_amount)
collateral   = parseIFixed(pos.collateral)           // in USDC units (1.0 = 1 USDC)

is_long     = base_amount > 0
size        = Math.abs(base_amount)
entry_price = Math.abs(notional) / size
```

### Step 4: Query Open Orders from Orderbook State

Position state alone is not enough to render robust open-order detail. For exact resting
orders (maker-side), read the orderbook maps:

1. On each clearing house object, read dynamic field `keys::Orderbook` to get orderbook object ID.
2. On the orderbook object, read dynamic fields `keys::AsksMap` and `keys::BidsMap`.
3. On each map object, paginate `dynamicFields(first: 50, after: ...)` and parse each
   `ordered_map::Leaf<orderbook::Order>` payload (`keys_vals[]`).
4. Filter rows by `account_id` and extract:
   - `key` as `order_id`
   - `val.size`
   - `val.reduce_only`
   - `val.expiration_timestamp_ms`

Interpretation:
- `AsksMap` rows are sell-side resting orders (`ASK` / short pressure).
- `BidsMap` rows are buy-side resting orders (`BID` / long pressure).
- Because these rows are in the live orderbook, they are maker/resting orders by definition.
- If orderbook scan is truncated, UI should mark data as partial and fall back to aggregate
  position-side order quantities (`asks_quantity` / `bids_quantity`) when possible.

## BCS Encoding

```javascript
// u64 → 8-byte little-endian, base64
function u64Bcs(n) {
  const buf = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return btoa(String.fromCharCode(...buf));
}
```

## Gotchas

1. **IFixed 256-bit signed.** Values >= 2^255 are negative (two's complement). Divide
   by 1e18 after sign correction.
2. **Account ID is u64.** The dynamic field key type is `keys::Position` but the BCS
   encoding is the account_id as a u64.
3. **Multiple clearing houses.** Each market (BTC/USD, XAUT/USD) is a separate clearing
   house object. Query each one per account.
4. **Positive = long.** `base_asset_amount > 0` means long, negative means short.
5. **Orderbook pagination matters.** Open-order detail is incomplete if asks/bids map
   pagination is capped; surface this explicitly.
6. **Open positions and open orders are distinct.** A user may have no filled position but
   still have resting orders/collateral in a market.
