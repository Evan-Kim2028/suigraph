# Querying Stablecoin Supply via Sui GraphQL

The explorer tracks total supply for stablecoins across three categories:
native, Wormhole-wrapped, and protocol-issued.

## Native Stablecoins (via coinMetadata)

| Symbol | Coin Type | Decimals |
|--------|-----------|----------|
| USDC | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` | 6 |
| USDT | `0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT` | 6 |
| FDUSD | `0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD` | 6 |
| AUSD | `0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD` | 6 |
| USDY | `0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY` | 6 |
| suiUSDe | `0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE` | 6 |

### Query

Batch 3 at a time via `coinMetadata`:

```graphql
{
  s0: coinMetadata(coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC") { supply }
  s1: coinMetadata(coinType: "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT") { supply }
  s2: coinMetadata(coinType: "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD") { supply }
}
```

`supply / 10^decimals` = human-readable amount.

## Wormhole-Wrapped Stablecoins

| Symbol | Coin Type | Decimals |
|--------|-----------|----------|
| wUSDC | `0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN` | 6 |
| wUSDT | `0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN` | 6 |

### Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| Wormhole Registry | `0x334881831bd89287554a6121087e498fa023ce52c037001b53a4563a00a281a5` | Token registry shared object |
| Wormhole Key Package | `0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d` | Key type for dynamic field lookups |

### Query

```graphql
{
  address(address: "0x334881831bd89287554a6121087e498fa023ce52c037001b53a4563a00a281a5") {
    dynamicField(name: {
      type: "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d::token_registry::Key<0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN>",
      bcs: "AA=="
    }) {
      value { ... on MoveValue { json } }
    }
  }
}
```

Supply from `json.treasury_cap.total_supply.value / 10^decimals`.

Note: The BCS value `"AA=="` is a single zero byte — the key has no meaningful data,
only the type parameter matters.

## Protocol-Issued (BUCK)

| Symbol | Coin Type | Decimals |
|--------|-----------|----------|
| BUCK | `0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK` | 9 |

### Key Objects

| Object | Address | Description |
|--------|---------|-------------|
| BUCK Protocol | `0x9e3dab13212b27f5434416939db5dec6a319d15b89a84fd074d03ece6350d3df` | Protocol shared object |

### Query

```graphql
{
  object(address: "0x9e3dab13212b27f5434416939db5dec6a319d15b89a84fd074d03ece6350d3df") {
    asMoveObject { contents { json } }
  }
}
```

Supply path: `json.buck_treasury_cap.total_supply.value / 10^9`.

## Gotchas

1. **Three different query patterns.** Native uses `coinMetadata.supply`, Wormhole uses
   dynamic field on the token registry, BUCK uses a protocol object.
2. **Wormhole key type.** The dynamic field key type includes the coin type as a generic
   parameter. The BCS is always `"AA=="` (zero byte).
3. **BUCK uses 9 decimals.** Unlike most stablecoins which use 6 decimals.
4. **Batching limits.** `coinMetadata` queries are batched 3 at a time to stay within
   GraphQL complexity limits.
