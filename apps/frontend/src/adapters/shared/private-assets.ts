import type {
  FundManager,
  NewFundManager,
  NewPrivateAsset,
  NewPrivateSnapshot,
  NewPrivateSubAsset,
  PrivateAsset,
  PrivateAssetCurrentTotals,
  PrivateAssetDetail,
  PrivateAssetHistoricalPoint,
  PrivateAssetListRow,
  PrivateSnapshot,
  PrivateSubAsset,
  UpdateFundManager,
  UpdatePrivateAsset,
  UpdatePrivateSnapshot,
  UpdatePrivateSubAsset,
} from "@/lib/types";

import { invoke } from "./platform";

export const listPrivateAssetRows = async (
  includeArchived = false,
): Promise<PrivateAssetListRow[]> => {
  return invoke<PrivateAssetListRow[]>("list_private_asset_rows", { includeArchived });
};

export const getPrivateAssetDetail = async (
  privateAssetId: string,
): Promise<PrivateAssetDetail | null> => {
  return invoke<PrivateAssetDetail | null>("get_private_asset_detail", { privateAssetId });
};

export const getPrivateAssetCurrentTotals = async (
  includeArchived = false,
): Promise<PrivateAssetCurrentTotals> => {
  return invoke<PrivateAssetCurrentTotals>("get_private_asset_current_totals", {
    includeArchived,
  });
};

export const getPrivateAssetHistoricalSeries = async (
  includeArchived = false,
): Promise<PrivateAssetHistoricalPoint[]> => {
  return invoke<PrivateAssetHistoricalPoint[]>("get_private_asset_historical_series", {
    includeArchived,
  });
};

export const listFundManagers = async (): Promise<FundManager[]> => {
  return invoke<FundManager[]>("list_fund_managers");
};

export const createFundManager = async (payload: NewFundManager): Promise<FundManager> => {
  return invoke<FundManager>("create_fund_manager", { payload });
};

export const updateFundManager = async (
  fundManagerId: string,
  payload: UpdateFundManager,
): Promise<FundManager> => {
  return invoke<FundManager>("update_fund_manager", { fundManagerId, payload });
};

export const createPrivateAsset = async (payload: NewPrivateAsset): Promise<PrivateAsset> => {
  return invoke<PrivateAsset>("create_private_asset", { payload });
};

export const updatePrivateAsset = async (
  privateAssetId: string,
  payload: UpdatePrivateAsset,
): Promise<PrivateAsset> => {
  return invoke<PrivateAsset>("update_private_asset", { privateAssetId, payload });
};

export const listPrivateSubAssets = async (privateAssetId: string): Promise<PrivateSubAsset[]> => {
  return invoke<PrivateSubAsset[]>("list_private_sub_assets", { privateAssetId });
};

export const createPrivateSubAsset = async (
  payload: NewPrivateSubAsset,
): Promise<PrivateSubAsset> => {
  return invoke<PrivateSubAsset>("create_private_sub_asset", { payload });
};

export const updatePrivateSubAsset = async (
  privateSubAssetId: string,
  payload: UpdatePrivateSubAsset,
): Promise<PrivateSubAsset> => {
  return invoke<PrivateSubAsset>("update_private_sub_asset", { privateSubAssetId, payload });
};

export const listPrivateSnapshots = async (privateAssetId: string): Promise<PrivateSnapshot[]> => {
  return invoke<PrivateSnapshot[]>("list_private_snapshots", { privateAssetId });
};

export const getLatestPrivateSnapshot = async (
  privateAssetId: string,
): Promise<PrivateSnapshot | null> => {
  return invoke<PrivateSnapshot | null>("get_latest_private_snapshot", { privateAssetId });
};

export const createPrivateSnapshot = async (
  payload: NewPrivateSnapshot,
): Promise<PrivateSnapshot> => {
  return invoke<PrivateSnapshot>("create_private_snapshot", { payload });
};

export const updatePrivateSnapshot = async (
  privateSnapshotId: string,
  payload: UpdatePrivateSnapshot,
): Promise<PrivateSnapshot> => {
  return invoke<PrivateSnapshot>("update_private_snapshot", { privateSnapshotId, payload });
};
