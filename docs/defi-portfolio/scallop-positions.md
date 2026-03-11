# Querying Scallop Positions via Sui GraphQL

Scallop is a lending protocol on Sui. State is spread across multiple shared tables
for borrow dynamics, interest models, and balance sheets.

## Doc Metadata

- Last verified: `2026-03-11`
- Adapter key: `scallop`
- Code entrypoint: `site/src/app/30-pages.js` via `fetchScallopPositions`, `fetchScallopBorrowIndices`, and `fetchScallopUnderlyingCoinTypes`; normalized through `site/src/app/35-defi-adapters.js`

## Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Protocol | `0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf` | Scallop package |
| Market | `0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9` | Market shared object |
| Borrow Dynamics Table | `0x2d878e129dec2d83f3e240fa403cd588bc5101dd9b60040c27007e24ef242d8d` | Current borrow indices per asset |
| Interest Models Table | `0x1e8419e665b8b796723c97747c504f4a37a527d4f944f27ae9467ae68e8b50f9` | Rate model config per asset |
| Balance Sheets Table | `0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368` | Cash/debt/revenue per asset |

## Types

```
ObligationKey = 0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf::obligation::ObligationKey
```

## Step-by-step Query Flow

### Step 1: Find ObligationKeys

```graphql
{
  address(address: "<wallet>") {
    objects(filter: { type: "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf::obligation::ObligationKey" }, first: 10) {
      nodes { contents { json } }
    }
  }
}
```

Each key's `json.ownership.of` is the obligation object ID.

### Step 2: Fetch Obligations

```graphql
{
  ob0: object(address: "<obligation_id>") {
    asMoveObject { contents { json } }
  }
}
```

Obligation JSON has:
- `collaterals.table.id` — table of collateral entries
- `debts.table.id` — table of debt entries

### Step 3: Fetch Borrow Indices

Query current market-wide borrow indices for interest accrual:

```graphql
{
  address(address: "0x2d878e129dec2d83f3e240fa403cd588bc5101dd9b60040c27007e24ef242d8d") {
    dynamicFields(first: 30) {
      nodes {
        name { json }
        value { ... on MoveValue { json } }
      }
    }
  }
}
```

Keys are coin type strings. Values contain `interest_rate`, `interest_rate_scale`,
`borrow_index`.

### Step 4: Fetch Collateral and Debt Entries

```graphql
{
  coll: address(address: "<collaterals.table.id>") {
    dynamicFields(first: 20) {
      nodes {
        name { json }
        value { ... on MoveValue { json } }
      }
    }
  }
  debt: address(address: "<debts.table.id>") {
    dynamicFields(first: 20) {
      nodes {
        name { json }
        value { ... on MoveValue { json } }
      }
    }
  }
}
```

### Step 5: Parse Positions

**Collateral:**
```
coin_type = "0x" + name.json.name
amount    = value.json.amount / 10^decimals
```

**Debt (interest-adjusted):**
```
raw_amount    = value.json.amount
user_index    = value.json.borrow_index
market_index  = borrow_dynamics[coin_type].borrow_index   # from Step 3
actual_amount = raw_amount * market_index / user_index
human_amount  = actual_amount / 10^decimals
```

**Health Factor:**
```
health_factor = total_deposit_usd / total_borrow_usd
```

## Fetching Lending Rates (No Wallet Required)

Batch query all three tables:

```graphql
{
  borrowDynamics: address(address: "0x2d878e129dec2d83f3e240fa403cd588bc5101dd9b60040c27007e24ef242d8d") {
    dynamicFields(first: 50) {
      nodes { name { json } value { ... on MoveValue { json } } }
    }
  }
  balanceSheets: address(address: "0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368") {
    dynamicFields(first: 50) {
      nodes { name { json } value { ... on MoveValue { json } } }
    }
  }
  interestModels: address(address: "0x1e8419e665b8b796723c97747c504f4a37a527d4f944f27ae9467ae68e8b50f9") {
    dynamicFields(first: 50) {
      nodes { name { json } value { ... on MoveValue { json } } }
    }
  }
}
```

### Rate Computation

Scallop uses **Fixed32 precision** (2^32 = 4,294,967,296):

```
FIXED32_SCALE = 4294967296

borrow_bps     = (interest_rate.value / FIXED32_SCALE) * 10000
cash           = balance_sheet.cash
debt           = balance_sheet.debt
revenue        = balance_sheet.revenue
utilization    = debt / (debt + cash - revenue)
revenue_factor = interest_model.revenue_factor / FIXED32_SCALE
supply_bps     = borrow_bps * utilization * (1 - revenue_factor)
```

## Gotchas

1. **Fixed32 scaling.** Interest rates and revenue factors use 2^32 precision, not 1e18
   or 1e27. Divide by 4,294,967,296.
2. **Debt interest accrual.** Raw debt amounts must be multiplied by
   `market_borrow_index / user_borrow_index` to get current actual debt.
3. **Coin type keys.** Dynamic field keys in Scallop tables are coin type strings
   (e.g., the `name.json` field). Prefix with `0x` for standard format.
4. **Three separate tables.** Unlike NAVI (one reserves table) or Suilend (one pool object),
   Scallop splits data across borrow dynamics, balance sheets, and interest models.
