# On-Chain Pool Oracle Pricing

suigraph prices all tokens using on-chain DEX pool state — no external APIs or oracles.
Prices are derived from CLMM (concentrated liquidity) pools on Cetus and Bluefin,
using live `current_sqrt_price` and `liquidity` values read via Sui GraphQL.

## Doc Metadata

- Last verified: `2026-03-11`
- Adapter key: `n/a` (shared pricing layer)
- Code entrypoint: `site/src/app/30-pages.js` via `fetchSuiPriceFromDeepBook`, `fetchPoolOraclePrices`, and `fetchDefiPrices`

## Architecture

```
DeepBook SUI/USDC Pool
┌─────────────────────────┐
│ mid_price → SUI/USD     │─────┐
└─────────────────────────┘     │
                                ▼
CLMM Pools (Cetus, Bluefin)   SUI price
┌─────────────────────────┐     │
│ TOKEN/SUI pools         │     │
│ current_sqrt_price (Q64)│──►  │ token_price_in_SUI × SUI/USD
│ liquidity (weight)      │     │ = token_price_in_USD
└─────────────────────────┘     │
                                ▼
                          defiPrices[TOKEN]
```

## Pricing Flow

### Step 1: SUI Base Price

SUI/USD is fetched from the DeepBook v3 SUI/USDC pool by reading the pool's
`pool_book` → `best_bid_price` and `best_ask_price`, then computing the mid-price:

```
SUI/USD = (best_bid + best_ask) / 2
```

This is the anchor price for all other conversions. TTL: 30 seconds.

### Step 2: Pool Discovery

For each token to price, the oracle searches for CLMM pools containing `TOKEN/SUI`
or `SUI/TOKEN` pairs across Cetus and Bluefin. Pool addresses are discovered via
GraphQL `objects` queries filtered by pool type and verified against coin type pairs.

Discovery results are cached with a TTL to avoid repeated lookups.

### Step 3: Price Extraction

For each discovered pool, the oracle reads:

- **`current_sqrt_price`** — Q64.64 fixed-point square root of the price ratio
- **`liquidity`** — current active liquidity (used as weight)

Conversion from sqrt price to human price:

```javascript
ratio = current_sqrt_price / 2^64
price = ratio² × 10^(decimalsA − decimalsB)
```

### Step 4: Liquidity-Weighted Averaging

When multiple pools exist for a token, the final price is a weighted average:

```
price = Σ(pool_price × pool_liquidity) / Σ(pool_liquidity)
```

This ensures deeper pools have more influence on the final price.

### Step 5: USD Conversion

If the pool quotes against SUI (most common case):

```
token_price_USD = token_price_in_SUI × defiPrices.SUI
```

## Pegged Asset Groups

Certain asset classes share the same underlying price and are hardcoded rather
than individually queried, eliminating unnecessary pool lookups.

### Stablecoins (= $1.00)

```
USDC, USDT, wUSDC, BUCK, AUSD, FDUSD, USDY, SUI_USDE, suiUSDe
```

### SUI LSTs (= SUI price)

Liquid staking tokens are pegged to SUI since they represent staked SUI:

```
haSUI, afSUI, vSUI, sSUI, HASUI, SPRING_SUI, MSUI, KSUI, CERT, stSUI, mSUI, kSUI
```

### BTC Variants (= xBTC DeepBook spot price)

All BTC-wrapped tokens share the xBTC price from its DeepBook CLMM pool.
xBTC (Exponent BTC) has the deepest SUI-quoted liquidity on Sui:

```
WBTC, BTC, LBTC, stBTC, enzoBTC, MBTC, YBTC, XBTC, EXBTC
```

Source symbol: `xBTC` — discovered via pool oracle like any other token,
then propagated to all BTC variants.

## Where Prices Are Used

| Feature | Usage |
|---------|-------|
| DeFi Portfolio | USD valuations for deposits, borrows, LP positions |
| Lending Markets | Total Supply / Total Borrow USD columns and stat boxes |
| Risk Monitor | Collateral and debt USD calculations |
| DEX Pools | TVL and LP value computations |
| Stablecoin Supply | Market-cap-weighted breakdowns |

## Performance

- **SUI price**: Single GraphQL read, 30s TTL
- **Pool discovery**: Batched (6 aliases/chunk, 10 chunks in parallel), cached
- **Pool reads**: Batched via `multiGetObjects`, single GraphQL call
- **Total latency**: ~200-400ms for full price refresh (all tokens)

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEEPBOOK_SUI_PRICE_TTL_MS` | 30,000 | SUI price cache TTL |
| `POOL_ORACLE_PRICE_TTL_MS` | 60,000 | Full oracle refresh TTL |
| `POOL_ORACLE_DISCOVERY_TTL_MS` | 300,000 | Pool address cache TTL |

## Key Functions

| Function | Description |
|----------|-------------|
| `fetchSuiPriceFromDeepBook()` | Reads SUI/USDC mid-price from DeepBook v3 |
| `discoverPoolAddresses(coinTypes)` | Finds CLMM pool addresses for token/SUI pairs |
| `readPoolPrices(coinTypesBySymbol)` | Reads sqrt prices, computes weighted USD prices |
| `fetchPoolOraclePrices(coinTypes)` | End-to-end: discover → read → write to defiPrices |
| `fetchDefiPrices(force)` | Top-level: SUI price + oracle + pegged groups |
| `ensurePrices(coinTypes)` | On-demand pricing for newly discovered coin types |
| `sqrtPriceToHumanPrice(sqrt, decA, decB)` | Q64.64 → human price conversion |
