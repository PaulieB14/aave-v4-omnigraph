// v0.2.0 enrichment: oracle USD pricing, reserve totals, user positions,
// account health, daily rollups (OHLC price, volumes, cohorts) and time tagging.
// All contract reads are try_ calls, so a revert never fails indexing.
import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Spoke as SpokeContract } from "../generated/templates/Spoke/Spoke";
import { AaveOracle } from "../generated/templates/Spoke/AaveOracle";
import { ERC20 } from "../generated/templates/Spoke/ERC20";
import {
  Spoke,
  Reserve,
  User,
  UserReservePosition,
  ReserveDaily,
  ReserveDailyUser,
  SpokeDaily,
  SpokeDailyUser,
  HubAsset,
} from "../generated/schema";

export const ZERO_BD = BigDecimal.zero();
const WAD = BigDecimal.fromString("1000000000000000000");
const VALUE_UNIT = BigDecimal.fromString("100000000000000000000000000"); // 1e26 (8-dec price * WAD)
const RAY = BigDecimal.fromString("1000000000000000000000000000");
const PRICE_UNIT = BigDecimal.fromString("100000000"); // oracle returns 8 decimals (decimals()==8)
const BPS = BigDecimal.fromString("10000");

export function pow10(d: i32): BigDecimal {
  let s = "1";
  for (let i = 0; i < d; i++) s += "0";
  return BigDecimal.fromString(s);
}

function abytes(a: Address): Bytes {
  return Bytes.fromHexString(a.toHexString());
}

// ── time tagging ─────────────────────────────────────────
export function dayOf(ts: BigInt): i32 {
  return (ts.toI64() / 86400) as i32;
}
export function dayOfWeekUTC(ts: BigInt): i32 {
  // 1970-01-01 was a Thursday. 0=Sunday..6=Saturday
  return (((ts.toI64() / 86400 + 4) % 7) as i32);
}
export function hourOfWeekUTC(ts: BigInt): i32 {
  return dayOfWeekUTC(ts) * 24 + (((ts.toI64() % 86400) / 3600) as i32);
}
// Approximate NYSE regular session 9:30-16:00 New York time, Mon-Fri.
// DST approximated (2nd Sun Mar .. 1st Sun Nov ~ Mar 8-14 / Nov 1-7); market holidays ignored.
export function isUSMarketHours(ts: BigInt): boolean {
  let t = ts.toI64();
  let z = t / 86400 + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = mp < 10 ? mp + 3 : mp - 9;
  let dst = (m > 3 && m < 11) || (m == 3 && d >= 10) || (m == 11 && d < 4);
  let offset: i64 = dst ? 4 * 3600 : 5 * 3600;
  let local = t - offset;
  let dow = (local / 86400 + 4) % 7;
  if (dow == 0 || dow == 6) return false;
  let sec = local % 86400;
  return sec >= 34200 && sec < 57600;
}

// ── metadata + pricing ───────────────────────────────────
function ensureMetadata(r: Reserve, spokeAddr: Address): void {
  if (r.decimals != 0 && r.symbol !== null) return;
  let res = SpokeContract.bind(spokeAddr).try_getReserve(r.reserveId);
  if (res.reverted) return;
  r.underlying = abytes(res.value.underlying);
  r.decimals = res.value.decimals;
  let erc = ERC20.bind(res.value.underlying);
  let sym = erc.try_symbol();
  if (!sym.reverted) r.symbol = sym.value;
  let nm = erc.try_name();
  if (!nm.reverted) r.name = nm.value;
}

function decimalsOf(r: Reserve): i32 {
  let d = r.decimals;
  if (d == 0) return 18;
  return d;
}

export function toUSD(r: Reserve, amount: BigInt): BigDecimal {
  let p = r.lastPriceUSD;
  if (p === null) return ZERO_BD;
  return amount.toBigDecimal().div(pow10(decimalsOf(r))).times(p);
}

function getReserveDaily(r: Reserve, ts: BigInt): ReserveDaily {
  let day = dayOf(ts);
  let id = r.id.concat(Bytes.fromI32(day));
  let d = ReserveDaily.load(id);
  if (d == null) {
    d = new ReserveDaily(id);
    d.reserve = r.id;
    d.day = day;
    d.date = BigInt.fromI32(day).times(BigInt.fromI32(86400));
    d.totalSuppliedUSD = ZERO_BD;
    d.totalDebtUSD = ZERO_BD;
    d.utilization = ZERO_BD;
    d.suppliedUSD = ZERO_BD;
    d.withdrawnUSD = ZERO_BD;
    d.borrowedUSD = ZERO_BD;
    d.repaidUSD = ZERO_BD;
    d.liquidatedUSD = ZERO_BD;
    d.activityCount = 0;
    d.uniqueUsers = 0;
  }
  return d as ReserveDaily;
}

function getSpokeDaily(s: Spoke, ts: BigInt): SpokeDaily {
  let day = dayOf(ts);
  let id = s.id.concat(Bytes.fromI32(day));
  let d = SpokeDaily.load(id);
  if (d == null) {
    d = new SpokeDaily(id);
    d.spoke = s.id;
    d.day = day;
    d.date = BigInt.fromI32(day).times(BigInt.fromI32(86400));
    d.totalSuppliedUSD = ZERO_BD;
    d.totalDebtUSD = ZERO_BD;
    d.volumeUSD = ZERO_BD;
    d.activityCount = 0;
    d.liquidationCount = 0;
    d.uniqueUsers = 0;
    d.newUsers = 0;
    d.newBorrowers = 0;
  }
  return d as SpokeDaily;
}

function bdOr(v: BigDecimal | null): BigDecimal {
  return v === null ? ZERO_BD : (v as BigDecimal);
}

// Refresh price + reserve totals; propagate to Spoke TVL, HubAsset price, ReserveDaily.
export function refreshReserve(r: Reserve, s: Spoke, spokeAddr: Address, ts: BigInt): void {
  ensureMetadata(r, spokeAddr);
  let sc = SpokeContract.bind(spokeAddr);
  if (s.oracle !== null) {
    let p = AaveOracle.bind(Address.fromBytes(s.oracle as Bytes)).try_getReservePrice(r.reserveId);
    if (!p.reverted) {
      r.lastPriceRaw = p.value;
      r.lastPriceUSD = p.value.toBigDecimal().div(PRICE_UNIT);
      r.lastPriceTimestamp = ts;
    }
  }
  let sup = sc.try_getReserveSuppliedAssets(r.reserveId);
  if (!sup.reverted) r.totalSupplied = sup.value;
  let debt = sc.try_getReserveTotalDebt(r.reserveId);
  if (!debt.reverted) r.totalDebt = debt.value;
  let dk = r.latestDynamicConfigKey;
  if (dk !== null) {
    let dc = sc.try_getDynamicReserveConfig(r.reserveId, dk as BigInt);
    if (!dc.reverted) {
      r.collateralFactor = dc.value.collateralFactor;
      r.maxLiquidationBonus = dc.value.maxLiquidationBonus;
      r.liquidationFee = dc.value.liquidationFee;
    }
  }
  let oldSup = bdOr(r.totalSuppliedUSD);
  let oldDebt = bdOr(r.totalDebtUSD);
  let ts_ = r.totalSupplied;
  let td_ = r.totalDebt;
  let newSup = ts_ === null ? ZERO_BD : toUSD(r, ts_ as BigInt);
  let newDebt = td_ === null ? ZERO_BD : toUSD(r, td_ as BigInt);
  r.totalSuppliedUSD = newSup;
  r.totalDebtUSD = newDebt;
  if (ts_ !== null && td_ !== null && !(ts_ as BigInt).isZero()) {
    r.utilization = (td_ as BigInt).toBigDecimal().div((ts_ as BigInt).toBigDecimal());
  }
  s.totalSuppliedUSD = bdOr(s.totalSuppliedUSD).minus(oldSup).plus(newSup);
  s.totalDebtUSD = bdOr(s.totalDebtUSD).minus(oldDebt).plus(newDebt);

  // mirror price/symbol onto the hub asset so hub-side events can be USD-valued
  if (r.hub.length > 0) {
    let haId = r.hub.concat(Bytes.fromByteArray(Bytes.fromBigInt(r.assetId)));
    let ha = HubAsset.load(haId);
    if (ha != null) {
      if (r.lastPriceUSD !== null) ha.lastPriceUSD = r.lastPriceUSD;
      if (r.symbol !== null) ha.symbol = r.symbol;
      ha.save();
    }
  }

  let d = getReserveDaily(r, ts);
  let p = r.lastPriceUSD;
  if (p !== null) {
    let pv = p as BigDecimal;
    if (d.openPriceUSD === null) d.openPriceUSD = pv;
    if (d.highPriceUSD === null || pv.gt(d.highPriceUSD as BigDecimal)) d.highPriceUSD = pv;
    if (d.lowPriceUSD === null || pv.lt(d.lowPriceUSD as BigDecimal)) d.lowPriceUSD = pv;
    d.closePriceUSD = pv;
  }
  d.totalSuppliedUSD = newSup;
  d.totalDebtUSD = newDebt;
  if (r.utilization !== null) d.utilization = r.utilization as BigDecimal;
  d.save();
}

function positionId(user: Address, spokeAddr: Address, reserveId: BigInt): Bytes {
  return abytes(user).concat(abytes(spokeAddr)).concat(Bytes.fromByteArray(Bytes.fromBigInt(reserveId)));
}

// Refresh one user's position in one reserve. Returns the position.
export function refreshPosition(
  u: User, userAddr: Address, r: Reserve, s: Spoke, spokeAddr: Address,
  ts: BigInt, block: BigInt, collateralFlag: i32 // -1 keep, 0 false, 1 true
): UserReservePosition {
  let id = positionId(userAddr, spokeAddr, r.reserveId);
  let p = UserReservePosition.load(id);
  if (p == null) {
    p = new UserReservePosition(id);
    p.user = u.id;
    p.spoke = s.id;
    p.reserve = r.id;
    p.supplied = BigInt.zero();
    p.debt = BigInt.zero();
    p.usingAsCollateral = false;
  }
  let sc = SpokeContract.bind(spokeAddr);
  let wasSupplier = !p.supplied.isZero();
  let wasBorrower = !p.debt.isZero();
  let sup = sc.try_getUserSuppliedAssets(r.reserveId, userAddr);
  if (!sup.reverted) p.supplied = sup.value;
  let debt = sc.try_getUserTotalDebt(r.reserveId, userAddr);
  if (!debt.reverted) p.debt = debt.value;
  if (collateralFlag == 1) p.usingAsCollateral = true;
  if (collateralFlag == 0) p.usingAsCollateral = false;
  p.suppliedUSD = toUSD(r, p.supplied);
  p.debtUSD = toUSD(r, p.debt);
  p.updatedAt = ts;
  p.updatedAtBlock = block;
  let isSupplier = !p.supplied.isZero();
  let isBorrower = !p.debt.isZero();
  let sc_ = r.supplierCount;
  let bc_ = r.borrowerCount;
  let sCount = sc_ === null ? 0 : sc_;
  let bCount = bc_ === null ? 0 : bc_;
  if (isSupplier && !wasSupplier) sCount += 1;
  if (!isSupplier && wasSupplier) sCount -= 1;
  if (isBorrower && !wasBorrower) bCount += 1;
  if (!isBorrower && wasBorrower) bCount -= 1;
  r.supplierCount = sCount;
  r.borrowerCount = bCount;
  p.save();
  return p as UserReservePosition;
}

// Account-level health from Spoke.getUserAccountData (uses the user's current dynamic config).
export function refreshAccount(u: User, userAddr: Address, spokeAddr: Address, ts: BigInt, pos: UserReservePosition, r: Reserve): void {
  let res = SpokeContract.bind(spokeAddr).try_getUserAccountData(userAddr);
  if (res.reverted) return;
  let v = res.value;
  let hadDebt = u.totalDebtUSD !== null && (u.totalDebtUSD as BigDecimal).gt(ZERO_BD);
  u.totalCollateralUSD = v.totalCollateralValue.toBigDecimal().div(VALUE_UNIT);
  u.totalDebtUSD = v.totalDebtValueRay.toBigDecimal().div(VALUE_UNIT).div(RAY);
  u.avgCollateralFactor = v.avgCollateralFactor.toBigDecimal().div(WAD);
  u.activeCollateralCount = v.activeCollateralCount.toI32();
  u.borrowCount = v.borrowCount.toI32();
  u.accountUpdatedAt = ts;
  let hasDebt = !v.totalDebtValueRay.isZero();
  // HF is uint256.max when there is no debt; store null in that case.
  if (hasDebt) {
    u.healthFactor = v.healthFactor.toBigDecimal().div(WAD);
  } else {
    u.healthFactor = null;
  }
  // Single-collateral users: HF scales linearly with that collateral's price,
  // so liquidation price = price / HF.
  if (hasDebt && v.activeCollateralCount.equals(BigInt.fromI32(1)) && pos.usingAsCollateral && !pos.supplied.isZero() && r.lastPriceUSD !== null && !v.healthFactor.isZero()) {
    pos.liquidationPriceUSD = (r.lastPriceUSD as BigDecimal).div(u.healthFactor as BigDecimal);
  } else {
    pos.liquidationPriceUSD = null;
  }
  pos.save();
  if (hasDebt && !hadDebt) {
    // borrower count on spoke handled by caller via return flag on User
  }
}

// Mark daily uniques + cohorts. Returns true if the user is new to the spoke.
export function trackDaily(
  s: Spoke, r: Reserve, u: User, userAddr: Address, ts: BigInt,
  volumeUSD: BigDecimal, kind: string, isBorrow: boolean
): void {
  let rd = getReserveDaily(r, ts);
  rd.activityCount += 1;
  if (kind == "SUPPLY") rd.suppliedUSD = rd.suppliedUSD.plus(volumeUSD);
  if (kind == "WITHDRAW") rd.withdrawnUSD = rd.withdrawnUSD.plus(volumeUSD);
  if (kind == "BORROW") rd.borrowedUSD = rd.borrowedUSD.plus(volumeUSD);
  if (kind == "REPAY") rd.repaidUSD = rd.repaidUSD.plus(volumeUSD);
  if (kind == "LIQUIDATION_COLLATERAL") rd.liquidatedUSD = rd.liquidatedUSD.plus(volumeUSD);
  let rdu = rd.id.concat(abytes(userAddr));
  if (ReserveDailyUser.load(rdu) == null) {
    new ReserveDailyUser(rdu).save();
    rd.uniqueUsers += 1;
  }
  rd.save();

  if (kind == "LIQUIDATION_COLLATERAL") return; // second leg of a liquidation; counted once via debt leg
  let sd = getSpokeDaily(s, ts);
  sd.activityCount += 1;
  sd.volumeUSD = sd.volumeUSD.plus(volumeUSD);
  if (kind == "LIQUIDATION") sd.liquidationCount += 1;
  let sdu = sd.id.concat(abytes(userAddr));
  if (SpokeDailyUser.load(sdu) == null) {
    new SpokeDailyUser(sdu).save();
    sd.uniqueUsers += 1;
  }
  if (u.firstSeenTimestamp === null) {
    u.firstSeenTimestamp = ts;
    sd.newUsers += 1;
    let c = s.userCount;
    s.userCount = (c === null ? 0 : c) + 1;
  }
  if (isBorrow && u.firstBorrowTimestamp === null) {
    u.firstBorrowTimestamp = ts;
    u.secondsToFirstBorrow = ts.minus(u.firstSeenTimestamp as BigInt);
    sd.newBorrowers += 1;
    let b = s.borrowerCount;
    s.borrowerCount = (b === null ? 0 : b) + 1;
  }
  sd.totalSuppliedUSD = bdOr(s.totalSuppliedUSD);
  sd.totalDebtUSD = bdOr(s.totalDebtUSD);
  sd.save();
  let ac = u.activityCount;
  u.activityCount = (ac === null ? 0 : ac) + 1;
}
