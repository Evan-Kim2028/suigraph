# Querying NAVI Protocol Positions via Sui GraphQL

NAVI is an Aave-style lending protocol on Sui. All on-chain state is stored in shared
objects accessible via Sui's GraphQL `dynamicField` queries. No SDK or RPC required —
just GraphQL against `https://graphql.mainnet.sui.io/graphql`.

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| User Info Table | `0xabc6c3fbc89b96e3351fdbeb5730bcc5398648367260c6a4e201779e34694e04` | `Table<address, UserInfo>` — per-wallet collateral/loan asset IDs |
| Reserves Table | `0xe6d4c6610b86ce7735ea754596d71d72d10c7980b5052fc3c8cdf8d09fea9b4b` | `Table<u8, Reserve>` — per-asset reserve config and state |

## Architecture

```
User Info Table                  Reserves Table
┌──────────────────┐            ┌──────────────────────────────────────┐
│ key: address     │            │ key: u8 (asset ID)                   │
│ val: UserInfo    │            │ val: Reserve                         │
│   .collaterals   │──(ids)──►  │   .coin_type                         │
│   .loans         │            │   .current_supply_index  (RAY)       │
└──────────────────┘            │   .current_borrow_index  (RAY)       │
                                │   .supply_balance.user_state.id ──┐  │
                                │   .borrow_balance.user_state.id ──┤  │
                                │   .ltv  (RAY)                     │  │
                                │   .current_supply_rate  (RAY)     │  │
                                │   .current_borrow_rate  (RAY)     │  │
                                └───────────────────────────────────┘  │
                                                                       │
                                User Balance Tables                    │
                                ┌──────────────────────────┐           │
                                │ key: address (wallet)    │◄──────────┘
                                │ val: u64 (scaled balance)│
                                └──────────────────────────┘
```

## Step-by-step Query Flow

### Step 1: Get User Info

Look up the wallet's `UserInfo` from the dynamic field table. The key type is `address`
and the BCS encoding is the wallet address as 32 raw bytes, base64-encoded.

```graphql
{
  address(address: "<USER_INFO_TABLE>") {
    dynamicField(name: { type: "address", bcs: "<wallet_address_bcs>" }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

**Response:**
```json
{
  "collaterals": "FQcFDw0ZBCAYCwoA",
  "loans": ""
}
```

**Decoding `collaterals` and `loans`:** These are `VecSet<u8>` fields, serialized as
**base64 strings** of raw bytes (not JSON arrays). Each byte is one asset ID.

```javascript
// Decode base64 → byte array → asset IDs
const ids = Array.from(atob("FQcFDw0ZBCAYCwoA"), c => c.charCodeAt(0));
// → [21, 7, 5, 15, 13, 25, 4, 32, 24, 11, 10, 0]
```

### Step 2: Fetch Reserves

For each asset ID, look up the `Reserve` from the reserves table. The key type is `u8`
and the BCS encoding is a single byte, base64-encoded.

```graphql
{
  address(address: "<RESERVES_TABLE>") {
    r0: dynamicField(name: { type: "u8", bcs: "<asset_id_bcs>" }) {
      value { ... on MoveValue { json } }
    }
    # ... batch more with aliases r1, r2, etc.
  }
}
```

**Reserve fields used for position calculation:**

| Field | Type | Description |
|-------|------|-------------|
| `coin_type` | string | Move type without `0x` prefix (e.g. `dba3...::usdc::USDC`) |
| `current_supply_index` | string (u256) | RAY-scaled (÷ 1e27) supply accrual index |
| `current_borrow_index` | string (u256) | RAY-scaled (÷ 1e27) borrow accrual index |
| `supply_balance.user_state.id` | address | Object ID of the supply balance table |
| `borrow_balance.user_state.id` | address | Object ID of the borrow balance table |
| `ltv` | string (u256) | RAY-scaled loan-to-value ratio |
| `current_supply_rate` | string (u256) | RAY-scaled supply APR |
| `current_borrow_rate` | string (u256) | RAY-scaled borrow APR |

### Step 3: Fetch Scaled Balances

Each reserve has a supply and borrow balance table (`Table<address, u64>`). Look up the
wallet's scaled balance from the table ID found in step 2.

```graphql
{
  b0: address(address: "<supply_balance.user_state.id>") {
    dynamicField(name: { type: "address", bcs: "<wallet_address_bcs>" }) {
      value { ... on MoveValue { json } }
    }
  }
  # ... batch more with aliases b1, b2, etc.
}
```

The value is a raw `u64` scaled balance (e.g. `589355460342252`).

### Step 4: Compute Human-Readable Amounts

**Critical: NAVI uses 9-decimal internal precision for ALL coins.** This is independent of
the underlying coin's native decimals (USDC=6, ETH=8, SUI=9, etc.). All scaled balances
are stored in 9-decimal units.

```
human_amount = scaled_balance × (current_index / 1e27) / 1e9
```

Example for USDC (native 6 decimals, but NAVI stores with 9):
```
scaled_balance     = 589,355,460,342,252
current_supply_idx = 1,104,122,857,209,072,816,110,708,462  (÷ 1e27 = 1.10412...)
human_amount       = 589,355,460,342,252 × 1.10412 / 1e9 = 650,721 USDC  ✓
```

If you mistakenly use the coin's native 6 decimals: `/ 1e6 = 650,721,000` — **1000x too high.**

### Step 5: Health Factor

```
health_factor = Σ(deposit_usd × ltv) / total_borrow_usd
```

Where `ltv` is from each reserve, RAY-scaled (÷ 1e27).

## BCS Encoding Helpers

Dynamic field lookups require BCS-encoded keys. For the types used in NAVI:

```javascript
// address → 32 bytes, base64
function addrBcs(hexAddr) {
  const hex = hexAddr.replace(/^0x/, "").padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return btoa(String.fromCharCode(...bytes));
}

// u8 → 1 byte, base64
function u8Bcs(n) {
  return btoa(String.fromCharCode(n & 0xff));
}
```

## Coin Type Normalization

NAVI stores `coin_type` in reserves **without** the `0x` prefix and sometimes with
shorter-than-64-char addresses. To match against standard Sui coin type strings:

1. Add `0x` prefix if missing
2. Pad the address portion to 64 hex characters (canonical Sui format)

```javascript
function normalizeCoinType(ct) {
  if (!ct.startsWith("0x")) ct = "0x" + ct;
  const sep = ct.indexOf("::");
  if (sep > 2) ct = "0x" + ct.slice(2, sep).padStart(64, "0") + ct.slice(sep);
  return ct;
}
```

## Known Asset IDs

A non-exhaustive mapping (asset IDs may be added over time):

| ID | Coin Type | Symbol |
|----|-----------|--------|
| 0 | `0x2::sui::SUI` | SUI |
| 4 | `0x06864a6f...::cetus::CETUS` | CETUS |
| 5 | `0x549e8b69...::cert::CERT` | vSUI |
| 7 | `0xa99b8952...::navx::NAVX` | NAVX |
| 10 | `0xdba34672...::usdc::USDC` | USDC |
| 11 | `0xd0e89b2a...::eth::ETH` | ETH |
| 13 | `0x5145494a...::ns::NS` | NS |
| 15 | `0xdeeb7a46...::deep::DEEP` | DEEP |
| 21 | `0xaafb102d...::btc::BTC` | BTC |
| 24 | `0x356a26eb...::wal::WAL` | WAL |
| 25 | `0x3a304c7f...::haedal::HAEDAL` | HAEDAL |
| 32 | `0x0041f9f9...::wbtc::WBTC` | WBTC |

You don't need to hardcode these — the `coin_type` field on each reserve tells you
which coin it represents. Use CoinMetadata queries for symbol/decimals of unknown types.

## Fetching Lending Rates (No Wallet Required)

To get protocol-wide supply/borrow rates without a specific wallet:

```graphql
{
  address(address: "<RESERVES_TABLE>") {
    dynamicFields(first: 50) {
      nodes { value { ... on MoveValue { json } } }
    }
  }
}
```

This returns all reserves. Compute rates from each reserve:
```
supply_apr = current_supply_rate / 1e27
borrow_apr = current_borrow_rate / 1e27
utilization = (borrow_shares × borrow_index) / (supply_shares × supply_index)
```

## Gotchas

1. **Base64 VecSet encoding.** `collaterals` and `loans` are base64 byte strings, not
   JSON arrays. You must decode them with `atob()` then read each byte as an asset ID.

2. **9-decimal precision.** All NAVI balances use 9 decimals internally. Using the coin's
   native decimals (6 for USDC, 8 for BTC/ETH) gives wildly wrong results (1000x, 10x off).

3. **Coin type normalization.** Reserve `coin_type` fields lack the `0x` prefix and may
   have shorter addresses than the canonical 64-hex-char Sui format.

4. **RAY scaling.** Indexes, rates, and LTV values are all stored as u256 with 1e27
   (RAY) precision. Divide by 1e27 to get the decimal value.
