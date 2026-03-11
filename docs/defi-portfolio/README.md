# DeFi GraphQL Guide Index

This folder documents how suigraph discovers protocol and market data directly from Sui GraphQL.

## Coverage Index

| Surface | Doc | Adapter key | Code entrypoint | Fixture coverage |
|---|---|---|---|---|
| Suilend lending | [suilend-positions.md](./suilend-positions.md) | `suilend` | `fetchSuilendPositions`, `fetchSuilendLendingRates` | no live fixture yet; planned `team_lending_micro` |
| NAVI lending | [navi-positions.md](./navi-positions.md) | `navi` | `fetchNaviPositions`, `fetchNaviLendingRates` | no live fixture yet; planned `team_lending_micro` |
| AlphaFi lending | [alphafi-positions.md](./alphafi-positions.md) | `alpha` | `fetchAlphaPositions`, `fetchAlphaLendingRates` | no live fixture yet; planned `team_lending_micro` |
| Scallop lending | [scallop-positions.md](./scallop-positions.md) | `scallop` | `fetchScallopPositions` | no live fixture yet; planned `team_lending_micro` |
| Cetus CLMM | [cetus-positions.md](./cetus-positions.md) | `cetus` | `fetchCetusPositions` | no live fixture yet; planned `team_lp_micro` |
| Turbos CLMM | [turbos-positions.md](./turbos-positions.md) | `turbos` | `fetchTurbosPositions` | no live fixture yet; planned `team_lp_micro` |
| Bluefin Spot CLMM | [bluefin-positions.md](./bluefin-positions.md) | `bluefinSpot` | `fetchBluefinSpotPositions` | no live fixture yet; planned `team_lp_micro` |
| Bluefin Pro perps | [bluefin-positions.md](./bluefin-positions.md) | `bluefinPro` | `fetchBluefinProPositions` | live `broad_integration_smoke`; planned `team_perps_micro` |
| Aftermath perps | [aftermath-positions.md](./aftermath-positions.md) | `aftermathPerps` | `fetchAftermathPerpsPositions` | live `broad_integration_smoke`, `owner_aftermath_deepbook`; planned `team_perps_micro` |
| DeepBook margin | [deepbook-positions.md](./deepbook-positions.md) | `deepbook` | `fetchDeepBookPositions` | live `owner_aftermath_deepbook`; planned `team_margin_micro` |
| LST exchange rates | [lst-protocols.md](./lst-protocols.md) | `n/a` | `fetchDefiLstSnapshot`, shared pricing helpers | page-level only |
| Stablecoin supply | [stablecoins.md](./stablecoins.md) | `n/a` | `fetchStablecoinSupply`, `fetchDefiStablecoinSnapshot` | page-level only |
| Shared on-chain pricing | [on-chain-pricing.md](./on-chain-pricing.md) | `n/a` | `fetchSuiPriceFromDeepBook`, `fetchPoolOraclePrices`, `fetchDefiPrices` | shared layer |

## Source Of Truth

- Adapter keys come from `site/src/app/35-defi-adapters.js`.
- Query bodies mostly live in `site/src/app/30-pages.js`.
- Fixture coverage and planned team-owned replacement slots live in `site/fixtures/protocol-fixture-coverage.json`.
- Static GraphQL inventory lives in `site/docs/graphql-surface.md`.
