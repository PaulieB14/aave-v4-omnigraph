import { Address, BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import {
  Add as AddEvent,
  Remove as RemoveEvent,
  Draw as DrawEvent,
  Restore as RestoreEvent,
  RefreshPremium as RefreshPremiumEvent,
  ReportDeficit as ReportDeficitEvent,
  TransferShares as TransferSharesEvent,
  AddAsset as AddAssetEvent,
  UpdateAsset as UpdateAssetEvent,
  UpdateAssetConfig as UpdateAssetConfigEvent,
  AddSpoke as AddSpokeEvent,
  UpdateSpokeConfig as UpdateSpokeConfigEvent,
  MintFeeShares as MintFeeSharesEvent,
  Sweep as SweepEvent,
  Reclaim as ReclaimEvent,
  EliminateDeficit as EliminateDeficitEvent,
} from "../generated/HubCore/Hub";
import {
  Hub,
  HubAsset,
  HubSpokeConfig,
  HubSpokeConfigSnapshot,
  HubSpokeFlow,
  HubAssetDaily,
  Spoke,
  FeeMint,
  Sweep,
  Reclaim,
  DeficitEliminated,
} from "../generated/schema";
import { Spoke as SpokeTemplate } from "../generated/templates";

// ── Hub name registry ─────────────────────────────────────
const CORE = "0xcca852bc40e560adc3b1cc58ca5b55638ce826c9";
const PLUS = "0x06002e9c4412cb7814a791ea3666d905871e536a";
const PRIME = "0x943827dca022d0f354a8a8c332da1e5eb9f9f931";

function hubName(addr: Address): string {
  let a = addr.toHexString().toLowerCase();
  if (a == CORE) return "Core";
  if (a == PLUS) return "Plus";
  if (a == PRIME) return "Prime";
  return "Unknown";
}

// ── ID helpers (Bytes-based for performance) ─────────────
function hubAssetIdOf(hubAddr: Address, assetId: BigInt): Bytes {
  return Bytes.fromHexString(hubAddr.toHexString()).concat(Bytes.fromByteArray(Bytes.fromBigInt(assetId)));
}

function configIdOf(hubAddr: Address, assetId: BigInt, spokeAddr: Address): Bytes {
  return hubAssetIdOf(hubAddr, assetId).concat(Bytes.fromHexString(spokeAddr.toHexString()));
}

function eventIdOf(txHash: Bytes, logIndex: BigInt): Bytes {
  return txHash.concat(Bytes.fromByteArray(Bytes.fromBigInt(logIndex)));
}

function dailyIdOf(hubAssetId: Bytes, day: i32): Bytes {
  return hubAssetId.concat(Bytes.fromI32(day));
}

// ── Entity getters ────────────────────────────────────────
function getOrCreateHub(addr: Address, block: BigInt, tx: Bytes): Hub {
  let id = Bytes.fromHexString(addr.toHexString());
  let hub = Hub.load(id);
  if (hub == null) {
    hub = new Hub(id);
    hub.name = hubName(addr);
    hub.chainId = 1;
    hub.createdAtBlock = block;
    hub.createdAtTx = tx;
    hub.save();
  }
  return hub as Hub;
}

function getOrCreateHubAsset(hubAddr: Address, assetId: BigInt, block: BigInt, tx: Bytes): HubAsset {
  let id = hubAssetIdOf(hubAddr, assetId);
  let a = HubAsset.load(id);
  if (a == null) {
    a = new HubAsset(id);
    a.hub = getOrCreateHub(hubAddr, block, tx).id;
    a.assetId = assetId;
    a.underlying = Bytes.empty();
    a.decimals = 0;
    a.save();
  }
  return a as HubAsset;
}

function getOrCreateSpoke(addr: Address, block: BigInt, tx: Bytes): Spoke {
  let id = Bytes.fromHexString(addr.toHexString());
  let s = Spoke.load(id);
  if (s == null) {
    s = new Spoke(id);
    s.createdAtBlock = block;
    s.createdAtTx = tx;
    s.save();
    // Spin up a Spoke data source so we start indexing this spoke's events.
    SpokeTemplate.create(addr);
  }
  return s as Spoke;
}

function dayBucket(timestamp: BigInt): i32 {
  return timestamp.toI32() / 86400;
}

function getOrCreateHubAssetDaily(hubAsset: HubAsset, timestamp: BigInt): HubAssetDaily {
  let day = dayBucket(timestamp);
  let id = dailyIdOf(hubAsset.id, day);
  let d = HubAssetDaily.load(id);
  if (d == null) {
    d = new HubAssetDaily(id);
    d.hubAsset = hubAsset.id;
    d.day = day;
    d.date = BigInt.fromI32(day).times(BigInt.fromI32(86400));
    d.totalAddedAmount = BigInt.zero();
    d.totalRemovedAmount = BigInt.zero();
    d.totalDrawnAmount = BigInt.zero();
    d.totalRestoredAmount = BigInt.zero();
    d.totalDeficitRay = BigInt.zero();
    d.flowCount = 0;
  }
  return d as HubAssetDaily;
}

// ── Flow handlers (IHubBase) ─────────────────────────────
export function handleAdd(event: AddEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "ADD";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.shares = event.params.shares;
  f.amount = event.params.amount;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
  let d = getOrCreateHubAssetDaily(asset, event.block.timestamp);
  d.totalAddedAmount = d.totalAddedAmount.plus(event.params.amount);
  d.flowCount = d.flowCount + 1;
  d.save();
}

export function handleRemove(event: RemoveEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "REMOVE";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.shares = event.params.shares;
  f.amount = event.params.amount;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
  let d = getOrCreateHubAssetDaily(asset, event.block.timestamp);
  d.totalRemovedAmount = d.totalRemovedAmount.plus(event.params.amount);
  d.flowCount = d.flowCount + 1;
  d.save();
}

export function handleDraw(event: DrawEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "DRAW";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.drawnShares = event.params.drawnShares;
  f.drawnAmount = event.params.drawnAmount;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
  let d = getOrCreateHubAssetDaily(asset, event.block.timestamp);
  d.totalDrawnAmount = d.totalDrawnAmount.plus(event.params.drawnAmount);
  d.flowCount = d.flowCount + 1;
  d.save();
}

export function handleRestore(event: RestoreEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "RESTORE";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.drawnShares = event.params.drawnShares;
  f.drawnAmount = event.params.drawnAmount;
  f.premiumAmount = event.params.premiumAmount;
  f.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  f.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  f.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
  let d = getOrCreateHubAssetDaily(asset, event.block.timestamp);
  d.totalRestoredAmount = d.totalRestoredAmount.plus(event.params.drawnAmount);
  d.flowCount = d.flowCount + 1;
  d.save();
}

export function handleRefreshPremium(event: RefreshPremiumEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "REFRESH_PREMIUM";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  f.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  f.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
}

export function handleReportDeficit(event: ReportDeficitEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "REPORT_DEFICIT";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = spoke.id;
  f.drawnShares = event.params.drawnShares;
  f.deficitAmountRay = event.params.deficitAmountRay;
  f.premiumSharesDelta = event.params.premiumDelta.sharesDelta;
  f.premiumOffsetRayDelta = event.params.premiumDelta.offsetRayDelta;
  f.restoredPremiumRay = event.params.premiumDelta.restoredPremiumRay;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
  let d = getOrCreateHubAssetDaily(asset, event.block.timestamp);
  d.totalDeficitRay = d.totalDeficitRay.plus(event.params.deficitAmountRay);
  d.flowCount = d.flowCount + 1;
  d.save();
}

export function handleTransferShares(event: TransferSharesEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let sender = getOrCreateSpoke(event.params.sender, event.block.number, event.transaction.hash);
  let receiver = getOrCreateSpoke(event.params.receiver, event.block.number, event.transaction.hash);
  let f = new HubSpokeFlow(eventIdOf(event.transaction.hash, event.logIndex));
  f.type = "TRANSFER_SHARES";
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.spoke = sender.id;
  f.counterpartySpoke = receiver.id;
  f.shares = event.params.shares;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.logIndex = event.logIndex;
  f.save();
}

// ── Hub config handlers (IHub) ───────────────────────────
export function handleAddAsset(event: AddAssetEvent): void {
  let hubAddr = dataSource.address();
  let a = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  a.underlying = event.params.underlying;
  a.decimals = event.params.decimals;
  a.save();
}

export function handleUpdateAsset(event: UpdateAssetEvent): void {
  let hubAddr = dataSource.address();
  let a = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  a.drawnIndex = event.params.drawnIndex;
  a.drawnRate = event.params.drawnRate;
  a.accruedFees = event.params.accruedFees;
  a.lastUpdatedBlock = event.block.number;
  a.save();
}

export function handleUpdateAssetConfig(event: UpdateAssetConfigEvent): void {
  let hubAddr = dataSource.address();
  let a = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  a.feeReceiver = event.params.config.feeReceiver;
  a.liquidityFee = event.params.config.liquidityFee;
  a.irStrategy = event.params.config.irStrategy;
  a.reinvestmentController = event.params.config.reinvestmentController;
  a.save();
}

export function handleAddSpoke(event: AddSpokeEvent): void {
  getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
}

export function handleUpdateSpokeConfig(event: UpdateSpokeConfigEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let spoke = getOrCreateSpoke(event.params.spoke, event.block.number, event.transaction.hash);
  let id = configIdOf(hubAddr, event.params.assetId, event.params.spoke);
  let c = HubSpokeConfig.load(id);
  if (c == null) {
    c = new HubSpokeConfig(id);
    c.hub = asset.hub;
    c.hubAsset = asset.id;
    c.spoke = spoke.id;
  }
  c.addCap = event.params.config.addCap;
  c.drawCap = event.params.config.drawCap;
  c.riskPremiumThreshold = event.params.config.riskPremiumThreshold;
  c.active = event.params.config.active;
  c.halted = event.params.config.halted;
  c.updatedAtBlock = event.block.number;
  c.updatedAtTx = event.transaction.hash;
  c.save();
  let snap = new HubSpokeConfigSnapshot(eventIdOf(event.transaction.hash, event.logIndex));
  snap.config = c.id;
  snap.addCap = c.addCap;
  snap.drawCap = c.drawCap;
  snap.riskPremiumThreshold = c.riskPremiumThreshold;
  snap.active = c.active;
  snap.halted = c.halted;
  snap.block = event.block.number;
  snap.timestamp = event.block.timestamp;
  snap.txHash = event.transaction.hash;
  snap.logIndex = event.logIndex;
  snap.save();
}

export function handleMintFeeShares(event: MintFeeSharesEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let f = new FeeMint(eventIdOf(event.transaction.hash, event.logIndex));
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.feeReceiver = event.params.feeReceiver;
  f.shares = event.params.shares;
  f.assets = event.params.assets;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.save();
}

export function handleSweep(event: SweepEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let f = new Sweep(eventIdOf(event.transaction.hash, event.logIndex));
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.reinvestmentController = event.params.reinvestmentController;
  f.amount = event.params.amount;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.save();
}

export function handleReclaim(event: ReclaimEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let f = new Reclaim(eventIdOf(event.transaction.hash, event.logIndex));
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.reinvestmentController = event.params.reinvestmentController;
  f.amount = event.params.amount;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.save();
}

export function handleEliminateDeficit(event: EliminateDeficitEvent): void {
  let hubAddr = dataSource.address();
  let asset = getOrCreateHubAsset(hubAddr, event.params.assetId, event.block.number, event.transaction.hash);
  let caller = getOrCreateSpoke(event.params.callerSpoke, event.block.number, event.transaction.hash);
  let covered = getOrCreateSpoke(event.params.coveredSpoke, event.block.number, event.transaction.hash);
  let f = new DeficitEliminated(eventIdOf(event.transaction.hash, event.logIndex));
  f.hub = asset.hub;
  f.hubAsset = asset.id;
  f.callerSpoke = caller.id;
  f.coveredSpoke = covered.id;
  f.shares = event.params.shares;
  f.deficitAmountRay = event.params.deficitAmountRay;
  f.block = event.block.number;
  f.timestamp = event.block.timestamp;
  f.txHash = event.transaction.hash;
  f.save();
}
