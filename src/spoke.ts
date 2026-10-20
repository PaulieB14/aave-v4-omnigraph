import { Address, BigDecimal, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import {
  ZERO_BD, toUSD, refreshReserve, refreshPosition, refreshAccount, trackDaily,
  hourOfWeekUTC, dayOfWeekUTC, isUSMarketHours,
} from "./v2";
import {
  SetSpokeImmutables as SetSpokeImmutablesEvent,
  UpdateLiquidationConfig as UpdateLiquidationConfigEvent,
  AddReserve as AddReserveEvent,
  UpdateReserveConfig as UpdateReserveConfigEvent,
  UpdateReservePriceSource as UpdateReservePriceSourceEvent,
  AddDynamicReserveConfig as AddDynamicReserveConfigEvent,
  UpdateDynamicReserveConfig as UpdateDynamicReserveConfigEvent,
  UpdatePositionManager as UpdatePositionManagerEvent,
  Supply as SupplyEvent,
  Withdraw as WithdrawEvent,
  Borrow as BorrowEvent,
  Repay as RepayEvent,
  LiquidationCall as LiquidationCallEvent,
  ReportDeficit as ReportDeficitEvent,
  SetUsingAsCollateral as SetUsingAsCollateralEvent,
  UpdateUserRiskPremium as UpdateUserRiskPremiumEvent,
  SetUserPositionManager as SetUserPositionManagerEvent,
  RefreshPremiumDebt as RefreshPremiumDebtEvent,
  RefreshAllUserDynamicConfig as RefreshAllUserDynamicConfigEvent,
  RefreshSingleUserDynamicConfig as RefreshSingleUserDynamicConfigEvent,
  Spoke as SpokeContract,
} from "../generated/templates/Spoke/Spoke";
import {
  Spoke,
  SpokeLiquidationConfig,
  SpokeLiquidationConfigSnapshot,
  Reserve,
  ReserveConfigSnapshot,
  ReservePriceSourceSnapshot,
  DynamicReserveConfig,
  User,
  UserRiskPremiumSnapshot,
  UserPositionManager,
  UserActivity,
  LiquidationCall,
  PremiumDebtRefresh,
  SpokeReportedDeficit,
  SpokePositionManagerWhitelist,
} from "../generated/schema";

// ── ID helpers ────────────────────────────────────────────
function reserveIdOf(spokeAddr: Address, reserveId: BigInt): Bytes {
  return Bytes.fromHexString(spokeAddr.toHexString()).concat(Bytes.fromByteArray(Bytes.fromBigInt(reserveId)));
}

function dynamicConfigIdOf(spokeAddr: Address, reserveId: BigInt, key: BigInt): Bytes {
  return reserveIdOf(spokeAddr, reserveId).concat(Bytes.fromByteArray(Bytes.fromBigInt(key)));
}

function eventIdOf(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concat(Bytes.fromByteArray(Bytes.fromBigInt(logIndex)));
}

function userPositionManagerIdOf(user: Address, spokeAddr: Address, pm: Address): Bytes {
  return Bytes.fromHexString(user.toHexString())
    .concat(Bytes.fromHexString(spokeAddr.toHexString()))
    .concat(Bytes.fromHexString(pm.toHexString()));
}

function spokePmWhitelistIdOf(spokeAddr: Address, pm: Address): Bytes {
  return Bytes.fromHexString(spokeAddr.toHexString()).concat(Bytes.fromHexString(pm.toHexString()));
}

function addrBytes(a: Address): Bytes {
  return Bytes.fromHexString(a.toHexString());
}

// ── Entity getters ────────────────────────────────────────
function getOrCreateUser(addr: Address): User {
  let id = addrBytes(addr);
  let u = User.load(id);
  if (u == null) {
    u = new User(id);
    u.latestRiskPremium = BigInt.zero();
    u.save();
  }
  return u as User;
}

function getOrCreateSpoke(spokeAddr: Address, block: BigInt, tx: Bytes): Spoke {
  let id = addrBytes(spokeAddr);
  let s = Spoke.load(id);
  if (s == null) {
    s = new Spoke(id);
    s.createdAtBlock = block;
    s.createdAtTx = tx;
    s.save();
  }
  // SetSpokeImmutables is emitted in the spoke constructor, before the hub's
  // AddSpoke creates this template, so it is never seen. Read ORACLE() instead.
  if (s.liquidationConfig === null) {
    let lc = SpokeContract.bind(spokeAddr).try_getLiquidationConfig();
    if (!lc.reverted) {
      let id = addrBytes(spokeAddr);
      let c = new SpokeLiquidationConfig(id);
      c.spoke = id;
      c.targetHealthFactor = lc.value.targetHealthFactor;
      c.healthFactorForMaxBonus = lc.value.healthFactorForMaxBonus;
      c.liquidationBonusFactor = lc.value.liquidationBonusFactor;
      c.updatedAtBlock = block;
      c.updatedAtTx = tx;
      c.save();
      s.liquidationConfig = id;
      s.save();
    }
  }
  if (s.oracle === null) {
    let o = SpokeContract.bind(spokeAddr).try_ORACLE();
    if (!o.reverted) {
      s.oracle = o.value;
      s.save();
    }
  }
  return s as Spoke;
}

// Fill assetId / hub / config from Spoke.getReserve() when the AddReserve
// event was missed (emitted before the template existed).
function backfillReserve(r: Reserve, spokeAddr: Address): void {
  let res = SpokeContract.bind(spokeAddr).try_getReserve(r.reserveId);
  if (res.reverted) return;
  let v = res.value;
  r.assetId = BigInt.fromI32(v.assetId);
  r.hub = addrBytes(v.hub);
  if (r.collateralRisk === null) r.collateralRisk = v.collateralRisk;
}

function getOrCreateReserve(spokeAddr: Address, reserveId: BigInt, assetId: BigInt, hubAddr: Address): Reserve {
  let id = reserveIdOf(spokeAddr, reserveId);
  let r = Reserve.load(id);
  if (r == null) {
    r = new Reserve(id);
    r.spoke = addrBytes(spokeAddr);
    r.reserveId = reserveId;
    r.assetId = assetId;
    r.hub = addrBytes(hubAddr);
    r.save();
  }
  return r as Reserve;
}

// Lazy Reserve loader — when activity events fire but AddReserve wasn't seen
// (graph-node started after AddReserve). Uses empty Hub pointer as sentinel.
function getOrCreateReserveLazy(spokeAddr: Address, reserveId: BigInt): Reserve {
  let id = reserveIdOf(spokeAddr, reserveId);
  let r = Reserve.load(id);
  if (r == null) {
    r = new Reserve(id);
    r.spoke = addrBytes(spokeAddr);
    r.reserveId = reserveId;
    r.assetId = BigInt.zero();
    r.hub = Bytes.empty();
    backfillReserve(r as Reserve, spokeAddr);
    r.save();
    getOrCreateSpoke(spokeAddr, BigInt.zero(), Bytes.empty());
  } else if (r.hub.length == 0) {
    backfillReserve(r as Reserve, spokeAddr);
    r.save();
  }
  return r as Reserve;
}

// ── v0.2.0 enrichment glue ────────────────────────────────
// Refreshes reserve price/totals, the user's position + account health,
// daily rollups, and USD/time fields on the activity record.
function enrich(
  spokeAddr: Address, r: Reserve, userAddr: Address, ts: BigInt, block: BigInt, tx: Bytes,
  act: UserActivity | null, amount: BigInt | null, kind: string, collFlag: i32
): BigDecimal {
  let s = getOrCreateSpoke(spokeAddr, block, tx);
  let u = getOrCreateUser(userAddr);
  refreshReserve(r, s, spokeAddr, ts);
  let pos = refreshPosition(u, userAddr, r, s, spokeAddr, ts, block, collFlag);
  r.save(); // persist fresh price before account-level liquidation-price pass
  refreshAccount(u, userAddr, spokeAddr, ts, pos, r);
  let usd = amount === null ? ZERO_BD : toUSD(r, amount as BigInt);
  trackDaily(s, r, u, userAddr, ts, usd, kind, kind == "BORROW");
  if (kind == "SUPPLY") r.cumulativeSuppliedUSD = (r.cumulativeSuppliedUSD === null ? ZERO_BD : r.cumulativeSuppliedUSD as BigDecimal).plus(usd);
  if (kind == "BORROW") r.cumulativeBorrowedUSD = (r.cumulativeBorrowedUSD === null ? ZERO_BD : r.cumulativeBorrowedUSD as BigDecimal).plus(usd);
  r.save();
  s.save();
  u.save();
  if (act !== null) {
    act.priceUSD = r.lastPriceUSD;
    if (amount !== null) act.amountUSD = usd;
    act.hourOfWeekUTC = hourOfWeekUTC(ts);
    act.dayOfWeekUTC = dayOfWeekUTC(ts);
    act.usMarketHours = isUSMarketHours(ts);
    act.save();
  }
  return usd;
}

// ── Spoke setup ───────────────────────────────────────────
export function handleSetSpokeImmutables(event: SetSpokeImmutablesEvent): void {
  let spokeAddr = dataSource.address();
  let s = getOrCreateSpoke(spokeAddr, event.block.number, event.transaction.hash);
  s.oracle = event.params.oracle;
  s.maxUserReservesLimit = event.params.maxUserReservesLimit;
  s.save();
}

export function handleUpdateLiquidationConfig(event: UpdateLiquidationConfigEvent): void {
  let spokeAddr = dataSource.address();
  let s = getOrCreateSpoke(spokeAddr, event.block.number, event.transaction.hash);
  let id = addrBytes(spokeAddr);
  let c = SpokeLiquidationConfig.load(id);
  if (c == null) {
    c = new SpokeLiquidationConfig(id);
    c.spoke = id;
  }
  c.targetHealthFactor = event.params.config.targetHealthFactor;
  c.healthFactorForMaxBonus = event.params.config.healthFactorForMaxBonus;
  c.liquidationBonusFactor = event.params.config.liquidationBonusFactor;
  c.updatedAtBlock = event.block.number;
  c.updatedAtTx = event.transaction.hash;
  c.save();
  s.liquidationConfig = c.id;
  s.save();
  let snap = new SpokeLiquidationConfigSnapshot(eventIdOf(event.transaction.hash, event.logIndex));
  snap.config = c.id;
  snap.targetHealthFactor = c.targetHealthFactor;
  snap.healthFactorForMaxBonus = c.healthFactorForMaxBonus;
  snap.liquidationBonusFactor = c.liquidationBonusFactor;
  snap.block = event.block.number;
  snap.timestamp = event.block.timestamp;
  snap.txHash = event.transaction.hash;
  snap.logIndex = event.logIndex;
  snap.save();
}

// ── Reserves ──────────────────────────────────────────────
export function handleAddReserve(event: AddReserveEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserve(spokeAddr, event.params.reserveId, event.params.assetId, event.params.hub);
  // Always trust the event over any lazily-created placeholder.
  r.assetId = event.params.assetId;
  r.hub = addrBytes(event.params.hub);
  r.save();
  getOrCreateSpoke(spokeAddr, event.block.number, event.transaction.hash);
}

export function handleUpdateReserveConfig(event: UpdateReserveConfigEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  r.collateralRisk = event.params.config.collateralRisk;
  r.paused = event.params.config.paused;
  r.frozen = event.params.config.frozen;
  r.borrowable = event.params.config.borrowable;
  r.receiveSharesEnabled = event.params.config.receiveSharesEnabled;
  r.save();
  let snap = new ReserveConfigSnapshot(eventIdOf(event.transaction.hash, event.logIndex));
  snap.reserve = r.id;
  snap.collateralRisk = event.params.config.collateralRisk;
  snap.paused = event.params.config.paused;
  snap.frozen = event.params.config.frozen;
  snap.borrowable = event.params.config.borrowable;
  snap.receiveSharesEnabled = event.params.config.receiveSharesEnabled;
  snap.block = event.block.number;
  snap.timestamp = event.block.timestamp;
  snap.txHash = event.transaction.hash;
  snap.save();
}

export function handleUpdateReservePriceSource(event: UpdateReservePriceSourceEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  r.priceSource = event.params.priceSource;
  r.save();
  let snap = new ReservePriceSourceSnapshot(eventIdOf(event.transaction.hash, event.logIndex));
  snap.reserve = r.id;
  snap.priceSource = event.params.priceSource;
  snap.block = event.block.number;
  snap.timestamp = event.block.timestamp;
  snap.txHash = event.transaction.hash;
  snap.save();
}

export function handleAddDynamicReserveConfig(event: AddDynamicReserveConfigEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let key = event.params.dynamicConfigKey;
  let cfg = new DynamicReserveConfig(dynamicConfigIdOf(spokeAddr, event.params.reserveId, key));
  cfg.reserve = r.id;
  cfg.key = key;
  cfg.collateralFactor = event.params.config.collateralFactor;
  cfg.maxLiquidationBonus = event.params.config.maxLiquidationBonus;
  cfg.liquidationFee = event.params.config.liquidationFee;
  cfg.createdAtBlock = event.block.number;
  cfg.createdAtTx = event.transaction.hash;
  cfg.save();
  r.latestDynamicConfigKey = key;
  r.save();
}

export function handleUpdateDynamicReserveConfig(event: UpdateDynamicReserveConfigEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let key = event.params.dynamicConfigKey;
  let id = dynamicConfigIdOf(spokeAddr, event.params.reserveId, key);
  if (DynamicReserveConfig.load(id) != null) return; // immutable; new key on each real change
  let cfg = new DynamicReserveConfig(id);
  cfg.reserve = r.id;
  cfg.key = key;
  cfg.collateralFactor = event.params.config.collateralFactor;
  cfg.maxLiquidationBonus = event.params.config.maxLiquidationBonus;
  cfg.liquidationFee = event.params.config.liquidationFee;
  cfg.createdAtBlock = event.block.number;
  cfg.createdAtTx = event.transaction.hash;
  cfg.save();
  r.latestDynamicConfigKey = key;
  r.save();
}

// ── Position managers ─────────────────────────────────────
export function handleUpdatePositionManager(event: UpdatePositionManagerEvent): void {
  let spokeAddr = dataSource.address();
  let id = spokePmWhitelistIdOf(spokeAddr, event.params.positionManager);
  let w = SpokePositionManagerWhitelist.load(id);
  if (w == null) {
    w = new SpokePositionManagerWhitelist(id);
    w.spoke = addrBytes(spokeAddr);
    w.positionManager = event.params.positionManager;
  }
  w.active = event.params.active;
  w.updatedAtBlock = event.block.number;
  w.updatedAtTx = event.transaction.hash;
  w.save();
}

export function handleSetUserPositionManager(event: SetUserPositionManagerEvent): void {
  let spokeAddr = dataSource.address();
  let user = getOrCreateUser(event.params.user);
  let id = userPositionManagerIdOf(event.params.user, spokeAddr, event.params.positionManager);
  let pm = UserPositionManager.load(id);
  if (pm == null) {
    pm = new UserPositionManager(id);
    pm.user = user.id;
    pm.spoke = addrBytes(spokeAddr);
    pm.positionManager = event.params.positionManager;
  }
  pm.approved = event.params.approve;
  pm.updatedAtBlock = event.block.number;
  pm.updatedAtTx = event.transaction.hash;
  pm.save();
}

// ── User activities (inlined per-event for AssemblyScript clarity) ──
export function handleSupply(event: SupplyEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "SUPPLY";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.caller = event.params.caller;
  act.shares = event.params.suppliedShares;
  act.amount = event.params.suppliedAmount;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
  enrich(spokeAddr, r, event.params.user, event.block.timestamp, event.block.number, event.transaction.hash, act, event.params.suppliedAmount, "SUPPLY", -1);
}

export function handleWithdraw(event: WithdrawEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "WITHDRAW";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.caller = event.params.caller;
  act.shares = event.params.withdrawnShares;
  act.amount = event.params.withdrawnAmount;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
  enrich(spokeAddr, r, event.params.user, event.block.timestamp, event.block.number, event.transaction.hash, act, event.params.withdrawnAmount, "WITHDRAW", -1);
}

export function handleBorrow(event: BorrowEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "BORROW";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.caller = event.params.caller;
  act.shares = event.params.drawnShares;
  act.amount = event.params.drawnAmount;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
  enrich(spokeAddr, r, event.params.user, event.block.timestamp, event.block.number, event.transaction.hash, act, event.params.drawnAmount, "BORROW", -1);
}

export function handleRepay(event: RepayEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "REPAY";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.caller = event.params.caller;
  act.shares = event.params.drawnShares;
  act.totalAmountRepaid = event.params.totalAmountRepaid;
  act.amount = event.params.totalAmountRepaid; // v0.2.0: was null for REPAY
  act.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  act.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  act.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
  enrich(spokeAddr, r, event.params.user, event.block.timestamp, event.block.number, event.transaction.hash, act, event.params.totalAmountRepaid, "REPAY", -1);
}

export function handleSetUsingAsCollateral(event: SetUsingAsCollateralEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "SET_COLLATERAL";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.caller = event.params.caller;
  act.usingAsCollateral = event.params.usingAsCollateral;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
  enrich(spokeAddr, r, event.params.user, event.block.timestamp, event.block.number, event.transaction.hash, act, null, "SET_COLLATERAL", event.params.usingAsCollateral ? 1 : 0);
}

// ── Liquidations ──────────────────────────────────────────
export function handleLiquidationCall(event: LiquidationCallEvent): void {
  let spokeAddr = dataSource.address();
  let collateralReserve = getOrCreateReserveLazy(spokeAddr, event.params.collateralReserveId);
  let debtReserve = getOrCreateReserveLazy(spokeAddr, event.params.debtReserveId);
  let user = getOrCreateUser(event.params.user);
  let liq = new LiquidationCall(eventIdOf(event.transaction.hash, event.logIndex));
  liq.spoke = addrBytes(spokeAddr);
  liq.collateralReserve = collateralReserve.id;
  liq.debtReserve = debtReserve.id;
  liq.user = user.id;
  liq.liquidator = event.params.liquidator;
  liq.receiveShares = event.params.receiveShares;
  liq.debtAmountRestored = event.params.debtAmountRestored;
  liq.drawnSharesLiquidated = event.params.drawnSharesLiquidated;
  liq.collateralAmountRemoved = event.params.collateralAmountRemoved;
  liq.collateralSharesLiquidated = event.params.collateralSharesLiquidated;
  liq.collateralSharesToLiquidator = event.params.collateralSharesToLiquidator;
  liq.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  liq.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  liq.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  liq.block = event.block.number;
  liq.timestamp = event.block.timestamp;
  liq.txHash = event.transaction.hash;
  liq.logIndex = event.logIndex;
  // v0.2.0 enrichment: refresh both legs, price them, tag time
  let ts = event.block.timestamp;
  let debtUSD = enrich(spokeAddr, debtReserve, event.params.user, ts, event.block.number, event.transaction.hash, null, event.params.debtAmountRestored, "LIQUIDATION", -1);
  let collUSD = enrich(spokeAddr, collateralReserve, event.params.user, ts, event.block.number, event.transaction.hash, null, event.params.collateralAmountRemoved, "LIQUIDATION_COLLATERAL", -1);
  liq.collateralPriceUSD = collateralReserve.lastPriceUSD;
  liq.debtPriceUSD = debtReserve.lastPriceUSD;
  liq.collateralRemovedUSD = collUSD;
  liq.debtRestoredUSD = debtUSD;
  liq.liquidatorProfitUSD = collUSD.minus(debtUSD);
  let u2 = User.load(user.id);
  if (u2 != null) {
    liq.healthFactorAfter = u2.healthFactor;
    let lc = u2.liquidationCount;
    u2.liquidationCount = (lc === null ? 0 : lc) + 1;
    u2.save();
  }
  liq.hourOfWeekUTC = hourOfWeekUTC(ts);
  liq.usMarketHours = isUSMarketHours(ts);
  liq.save();
  let sp = Spoke.load(addrBytes(spokeAddr));
  if (sp != null) {
    let c = sp.liquidationCount;
    sp.liquidationCount = (c === null ? 0 : c) + 1;
    sp.totalLiquidatedDebtUSD = (sp.totalLiquidatedDebtUSD === null ? ZERO_BD : sp.totalLiquidatedDebtUSD as BigDecimal).plus(debtUSD);
    sp.save();
  }
  let cr = Reserve.load(collateralReserve.id);
  if (cr != null) {
    cr.cumulativeLiquidatedUSD = (cr.cumulativeLiquidatedUSD === null ? ZERO_BD : cr.cumulativeLiquidatedUSD as BigDecimal).plus(collUSD);
    cr.save();
  }
}

// ── Spoke-side reported deficit ──────────────────────────
export function handleSpokeReportDeficit(event: ReportDeficitEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let rep = new SpokeReportedDeficit(eventIdOf(event.transaction.hash, event.logIndex));
  rep.spoke = addrBytes(spokeAddr);
  rep.reserve = r.id;
  rep.user = u.id;
  rep.drawnShares = event.params.drawnShares;
  rep.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  rep.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  rep.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  rep.block = event.block.number;
  rep.timestamp = event.block.timestamp;
  rep.txHash = event.transaction.hash;
  rep.save();
}

// ── Risk premium trajectory ──────────────────────────────
export function handleUpdateUserRiskPremium(event: UpdateUserRiskPremiumEvent): void {
  let spokeAddr = dataSource.address();
  let user = getOrCreateUser(event.params.user);
  user.latestRiskPremium = event.params.riskPremium;
  user.latestRiskPremiumSpoke = addrBytes(spokeAddr);
  user.save();
  let snap = new UserRiskPremiumSnapshot(eventIdOf(event.transaction.hash, event.logIndex));
  snap.user = user.id;
  snap.spoke = addrBytes(spokeAddr);
  snap.riskPremium = event.params.riskPremium;
  snap.block = event.block.number;
  snap.timestamp = event.block.timestamp;
  snap.txHash = event.transaction.hash;
  snap.save();
}

export function handleRefreshPremiumDebt(event: RefreshPremiumDebtEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let ref = new PremiumDebtRefresh(eventIdOf(event.transaction.hash, event.logIndex));
  ref.spoke = addrBytes(spokeAddr);
  ref.reserve = r.id;
  ref.user = u.id;
  ref.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  ref.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  ref.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  ref.block = event.block.number;
  ref.timestamp = event.block.timestamp;
  ref.txHash = event.transaction.hash;
  ref.save();
}

// ── v0.2.0: dynamic-config refreshes (previously unindexed) ──
export function handleRefreshSingleUserDynamicConfig(event: RefreshSingleUserDynamicConfigEvent): void {
  let spokeAddr = dataSource.address();
  let r = getOrCreateReserveLazy(spokeAddr, event.params.reserveId);
  let u = getOrCreateUser(event.params.user);
  let act = new UserActivity(eventIdOf(event.transaction.hash, event.logIndex));
  act.type = "REFRESH_DYNAMIC_CONFIG";
  act.spoke = addrBytes(spokeAddr);
  act.reserve = r.id;
  act.user = u.id;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
}

export function handleRefreshAllUserDynamicConfig(event: RefreshAllUserDynamicConfigEvent): void {
  // No reserve in the event; just refresh account health.
  let spokeAddr = dataSource.address();
  let u = getOrCreateUser(event.params.user);
  let res = SpokeContract.bind(spokeAddr).try_getUserAccountData(event.params.user);
  if (res.reverted) return;
  if (!res.value.totalDebtValueRay.isZero()) {
    u.healthFactor = res.value.healthFactor.toBigDecimal().div(BigDecimal.fromString("1000000000000000000"));
  }
  u.accountUpdatedAt = event.block.timestamp;
  u.save();
}
