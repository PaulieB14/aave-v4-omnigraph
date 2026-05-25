import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
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
  return s as Spoke;
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
    r.save();
  }
  return r as Reserve;
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
  getOrCreateReserve(spokeAddr, event.params.reserveId, event.params.assetId, event.params.hub);
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
  act.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  act.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  act.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  act.block = event.block.number;
  act.timestamp = event.block.timestamp;
  act.txHash = event.transaction.hash;
  act.logIndex = event.logIndex;
  act.save();
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
  liq.save();
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
