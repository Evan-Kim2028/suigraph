# Querying LST Exchange Rates via Sui GraphQL

Liquid Staking Tokens (LSTs) on Sui represent staked SUI with accruing rewards.
Each LST has an exchange rate that converts between the LST and its underlying SUI value.

## Doc Metadata

- Last verified: `2026-03-11`
- Adapter key: `n/a` (page-level pricing and snapshot helpers)
- Code entrypoint: `site/src/app/30-pages.js` via `fetchDefiLstSnapshot`, `fetchDefiPrices`, and the LST rate helpers used by wallet and DeFi views

## Supported LSTs

| Symbol | Protocol | Coin Type | Rate Object |
|--------|----------|-----------|-------------|
| sSUI | Suilend (SpringSui) | `0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI` | `0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b` |
| haSUI | Haedal | `0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI` | `0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca` |
| afSUI | Aftermath | `0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI` | *(uses sSUI rate as proxy)* |
| vSUI | Volo | `0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT` | *(uses haSUI rate as proxy)* |

## Fetching Exchange Rates

```graphql
{
  ssui: object(address: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b") {
    asMoveObject { contents { json } }
  }
  hasui: object(address: "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca") {
    asMoveObject { contents { json } }
  }
}
```

### Rate Computation

**sSUI (SpringSui / Suilend):**
```
sui_supply = json.storage.total_sui_supply
lst_supply = json.lst_treasury_cap.total_supply.value
rate       = sui_supply / lst_supply
```

**haSUI (Haedal):**
```
net_sui = json.total_staked - json.total_unstaked + json.total_rewards
supply  = json.stsui_supply
rate    = net_sui / supply
```

**afSUI (Aftermath):**
```
rate = sSUI_rate    # used as proxy (no direct rate object)
```

**vSUI (Volo):**
```
rate = haSUI_rate   # used as proxy (no direct rate object)
```

## Using Exchange Rates

### Wallet Balance Pricing

```
implied_price = sui_price_usd * lst_rate
usd_value     = lst_amount * implied_price
sui_equivalent = lst_amount * lst_rate
```

### Market Cap and Premium

```
total_supply = coinMetadata.supply / 10^decimals
market_cap   = total_supply * implied_price
premium_pct  = (rate - 1.0) * 100    # e.g., rate 1.05 = 5% premium over SUI
```

## Example

If SUI = $3.50 and sSUI rate = 1.104:
```
1000 sSUI = 1000 × 1.104 = 1,104 SUI equivalent
         = 1000 × 1.104 × $3.50 = $3,864 USD
Premium  = (1.104 - 1.0) × 100 = 10.4%
```

## Gotchas

1. **Proxy rates.** afSUI and vSUI don't have their own rate objects on-chain.
   The explorer uses sSUI and haSUI rates respectively as proxies.
2. **Rate > 1.0 always.** LST rates only go up over time as staking rewards accrue.
   A rate of 1.10 means each LST is backed by 1.10 SUI.
3. **Supply queries.** Total supply comes from `coinMetadata(coinType: ...)` queries,
   not from the rate objects.
