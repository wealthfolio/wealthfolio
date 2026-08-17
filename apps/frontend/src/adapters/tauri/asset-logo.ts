// Custom asset logo overrides - Tauri adapter.
// Bytes cross the IPC boundary as base64 (no local HTTP server involved);
// the result is turned into a data URL for <img src>.

import { invoke } from "./core";

interface AssetLogoPayload {
  contentBase64: string;
  contentType: string;
}

export const getAssetLogoDataUrl = async (assetId: string): Promise<string | null> => {
  const payload = await invoke<AssetLogoPayload | null>("get_asset_logo", { assetId });
  if (!payload) return null;
  return `data:${payload.contentType};base64,${payload.contentBase64}`;
};

export const getAssetLogoUrl = async (
  asset: { id: string; customLogoFilename?: string | null } | undefined,
): Promise<string | null> => {
  if (!asset?.customLogoFilename) return null;
  return getAssetLogoDataUrl(asset.id);
};

/** Opens a native file picker; `_file` is unused here (web-only parameter) but
 * kept so callers can share one signature across runtimes. */
export const uploadAssetLogo = async (assetId: string, _file?: File): Promise<boolean> => {
  return invoke<boolean>("pick_and_upload_asset_logo", { assetId });
};

export const removeAssetLogo = async (assetId: string): Promise<void> => {
  await invoke<void>("remove_asset_logo", { assetId });
};
