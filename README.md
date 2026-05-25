# aave-v4-omnigraph

A subgraph for Aave V4 that indexes everything [AaveKit's GraphQL API](https://api.aave.com/graphql) doesn't expose.

## What it captures

| Niche | What | AaveKit's gap |
|---|---|---|
| **Hub↔Spoke routing** | Every `Add`/`Remove`/`Draw`/`Restore`/`RefreshPremium`/`ReportDeficit`/`TransferShares` event between the three Hubs (Core, Plus, Prime) and their spokes | `IHubBase` events are completely absent from AaveKit's `ActivityType` enum. `hubSummaryHistory` is weekly-bucketed |
| **Risk-premium trajectory** | Per-user `UpdateUserRiskPremium` + `RefreshPremiumDebt` time series across spokes | AaveKit reports `riskPremium.latest` vs `riskPremium.current` only — no history |
| **Liquidation post-mortem** | Full `LiquidationCall` event with `premiumDelta`, share-level granularity, collateral-vs-debt breakdown, liquidator EOA | `LiquidatedActivity` drops 6 of 11 on-chain fields |
| **Config governance trail** | `UpdateSpokeConfig`, `UpdateReserveConfig`, `UpdateLiquidationConfig`, `AddDynamicReserveConfig` history | AaveKit returns current values only |
| **Treasury / fees / deficits** | `MintFeeShares`, `Sweep`, `Reclaim`, `EliminateDeficit`, spoke-side `ReportDeficit` | No coverage in AaveKit |
| **Position managers** | Per-spoke whitelist + per-user authorizations | Mutation-only in AaveKit, no history |

## Contracts indexed (Ethereum mainnet)

- **Hub Core** `0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9`
- **Hub Plus** `0x06002e9c4412CB7814a791eA3666D905871E536A`
- **Hub Prime** `0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931`
- **Spokes**: discovered dynamically via the `AddSpoke` event on each Hub (Main, Bluechip, Kelp, Lido, Ethena*, EtherFi, Forex, Gold, Lombard, Treasury, etc.).

## Best practices applied

- `Bytes` for entity IDs (perf)
- `@derivedFrom` for reverse relationships (no large arrays)
- `@entity(immutable: true)` for append-only event records
- `indexerHints.prune: auto` in the manifest
- No `eth_call`s — purely event-driven mappings

## Develop

```bash
yarn install
yarn codegen
yarn build
```

## Deploy

```bash
graph auth $STUDIO_KEY
yarn deploy:studio
```

Studio subgraph slug: `aave-v-4`.

## Querying

Once deployed, query at the Studio gateway:

```bash
curl https://api.studio.thegraph.com/query/<id>/aave-v-4/version/latest \
  -H "Content-Type: application/json" \
  -d '{"query": "{ hubSpokeFlows(first: 10, orderBy: block, orderDirection: desc) { type hub { name } spoke { id } amount block } }"}'
```

## Roadmap

- v0.1 (this): MVP — Hub Core + Plus + Prime, dynamic Spoke template, all flow + activity + liquidation + config events on Ethereum mainnet
- v0.2: cross-chain expansion as V4 deploys to other chains
- v0.3: derived analytics (per-Hub utilization rolling windows, liquidator efficiency rankings, premium-curve fitting)
- v1.0: x402 gateway in front for agent-pay-per-query

## License

MIT
