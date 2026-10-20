# Changelog

## v0.2.0 — USD pricing, positions, health, daily rollups

### Added
- **Oracle USD pricing**: `Spoke.ORACLE().getReservePrice(reserveId)` (8 decimals, verified `decimals()==8` on Base). Price is read on every spoke user event, so prices follow the same oracle Aave uses for liquidations.
- **Reserve**: `underlying/symbol/name/decimals` (ERC20 calls), `lastPriceUSD`, `totalSupplied/totalDebt` (+USD), `utilization`, current `collateralFactor/maxLiquidationBonus/liquidationFee`, `supplierCount/borrowerCount`, cumulative supplied/borrowed/liquidated USD.
- **UserReservePosition** (new): per user × reserve supplied/debt (+USD), collateral flag, and `liquidationPriceUSD` for single-collateral borrowers (price / HF).
- **User**: `healthFactor`, `totalCollateralUSD`, `totalDebtUSD`, `avgCollateralFactor`, counts (from `getUserAccountData` at the user's last event), `firstSeenTimestamp`, `firstBorrowTimestamp`, `secondsToFirstBorrow`, `activityCount`, `liquidationCount`.
- **UserActivity**: `priceUSD`, `amountUSD`, `hourOfWeekUTC`, `dayOfWeekUTC`, `usMarketHours`. REPAY now also fills `amount` (= totalAmountRepaid).
- **LiquidationCall**: collateral/debt prices, `collateralRemovedUSD`, `debtRestoredUSD`, `liquidatorProfitUSD` (collateral seized − debt repaid, incl. bonus), `healthFactorAfter`, time tags.
- **ReserveDaily** (new): daily open/high/low/close oracle price (as observed at events), TVL/debt/utilization close, supplied/withdrawn/borrowed/repaid/liquidated USD, activity count, unique users.
- **SpokeDaily** (new): TVL/debt close, volume USD, activity, liquidations, unique users, new users, new borrowers (cohorts).
- **Spoke**: `totalSuppliedUSD`, `totalDebtUSD`, `userCount`, `borrowerCount`, `liquidationCount`, `totalLiquidatedDebtUSD`.
- **HubAsset / HubAssetDaily / HubSpokeFlow / FeeMint**: `drawnRateAPR`, daily `drawnRate/drawnIndex/accruedFees` close, USD on flows, fee mints USD + running totals, cumulative deficit.
- New handlers for previously unindexed `RefreshAllUserDynamicConfig` and `RefreshSingleUserDynamicConfig` (new enum value `REFRESH_DYNAMIC_CONFIG`).
- Fixed `deploy:studio` slug (`aave-v-4` → `aave-v4`).

All changes are additive (no renames/removals). All contract reads use `try_`.

### Deliberately skipped
- **Block handlers / live HF for every user**: per-block calls would make sync slow. Position/HF values are "as of the user's last event", noted in field docs.
- **Exact intraday OHLC**: price is sampled at events, not every oracle update (stock oracles update off-chain feeds; polling them per block is too expensive).
- **Supply-side APY / IR strategy curves**: needs Hub view calls (not in the Hub ABI here) and IR-strategy contracts; `drawnRate` from `UpdateAsset` already gives the borrow-rate history.
- **Market-holiday calendar**: `usMarketHours` uses NYSE 9:30–16:00 ET Mon–Fri with approximate DST; holidays ignored.
- **Hub-side USD on the same tx**: hub events fire before the spoke event in a tx, so hub USD uses the previous observed price (seconds old).

## v0.2.1
- Fix: `liquidationPriceUSD` was only computed when the triggering event was on the collateral reserve (usually it is the USDC borrow/repay), so most single-collateral borrowers had null. Now evaluated across all of the user's positions, using the freshly saved price.
