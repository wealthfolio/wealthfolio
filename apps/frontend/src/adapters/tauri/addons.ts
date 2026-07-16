// Addon Commands
import type { AddonUpdateCheckResult } from "@wealthfolio/addon-sdk";
import type { AddonStoreListing } from "@/lib/types";
import type { ExtractedAddon, InstalledAddon, AddonManifest } from "../types";

import { tauriInvoke } from "./core";

export const extractAddonZip = async (zipData: Uint8Array): Promise<ExtractedAddon> => {
  return await tauriInvoke<ExtractedAddon>("extract_addon_zip", { zipData: Array.from(zipData) });
};

export const installAddonZip = async (
  zipData: Uint8Array,
  enableAfterInstall?: boolean,
  approvedNetworkHosts?: string[],
): Promise<AddonManifest> => {
  return await tauriInvoke<AddonManifest>("install_addon_zip", {
    zipData: Array.from(zipData),
    enableAfterInstall,
    approvedNetworkHosts,
  });
};

export const installAddonFile = async (
  fileName: string,
  fileContent: string,
  enableAfterInstall?: boolean,
): Promise<AddonManifest> => {
  return await tauriInvoke<AddonManifest>("install_addon_file", {
    fileName,
    fileContent,
    enableAfterInstall,
  });
};

export const listInstalledAddons = async (): Promise<InstalledAddon[]> => {
  return await tauriInvoke<InstalledAddon[]>("list_installed_addons");
};

export const toggleAddon = async (addonId: string, enabled: boolean): Promise<void> => {
  return await tauriInvoke<void>("toggle_addon", { addonId, enabled });
};

export const uninstallAddon = async (addonId: string): Promise<void> => {
  return await tauriInvoke<void>("uninstall_addon", { addonId });
};

export const loadAddonForRuntime = async (addonId: string): Promise<ExtractedAddon> => {
  return await tauriInvoke<ExtractedAddon>("load_addon_for_runtime", { addonId });
};

export const getEnabledAddonsOnStartup = async (): Promise<ExtractedAddon[]> => {
  return await tauriInvoke<ExtractedAddon[]>("get_enabled_addons_on_startup");
};

// Addon functions with names matching commands/addon.ts for consumer compatibility
export const getInstalledAddons = async (): Promise<InstalledAddon[]> => {
  return listInstalledAddons();
};

export const loadAddon = async (addonId: string): Promise<ExtractedAddon> => {
  return loadAddonForRuntime(addonId);
};

export const extractAddon = async (zipData: Uint8Array): Promise<ExtractedAddon> => {
  return extractAddonZip(zipData);
};

export const installAddon = async (
  zipData: Uint8Array,
  enableAfterInstall?: boolean,
  approvedNetworkHosts?: string[],
): Promise<AddonManifest> => {
  return installAddonZip(zipData, enableAfterInstall, approvedNetworkHosts);
};

export const getEnabledAddons = async (): Promise<ExtractedAddon[]> => {
  return getEnabledAddonsOnStartup();
};

// Addon Store & Update Commands
export const checkAddonUpdate = async (addonId: string): Promise<AddonUpdateCheckResult> => {
  return tauriInvoke<AddonUpdateCheckResult>("check_addon_update", { addonId });
};

export const checkAllAddonUpdates = async (): Promise<AddonUpdateCheckResult[]> => {
  return tauriInvoke<AddonUpdateCheckResult[]>("check_all_addon_updates");
};

export const updateAddon = async (addonId: string): Promise<AddonManifest> => {
  return tauriInvoke<AddonManifest>("update_addon_from_store_by_id", { addonId });
};

export const downloadAddonForReview = async (addonId: string): Promise<ExtractedAddon> => {
  return tauriInvoke<ExtractedAddon>("download_addon_to_staging", { addonId });
};

export const installFromStaging = async (
  addonId: string,
  enableAfterInstall?: boolean,
  approvedNetworkHosts?: string[],
): Promise<AddonManifest> => {
  return tauriInvoke<AddonManifest>("install_addon_from_staging", {
    addonId,
    enableAfterInstall,
    approvedNetworkHosts,
  });
};

export const updateAddonNetworkApprovals = async (
  addonId: string,
  approvedNetworkHosts: string[],
): Promise<AddonManifest> => {
  return tauriInvoke<AddonManifest>("update_addon_network_approvals", {
    addonId,
    approvedNetworkHosts,
  });
};

export const clearAddonStaging = async (addonId?: string): Promise<void> => {
  return tauriInvoke<void>("clear_addon_staging", { addonId });
};

export const getAddonRatings = async (addonId: string): Promise<unknown[]> => {
  return tauriInvoke<unknown[]>("get_addon_ratings", { addonId });
};

export const submitAddonRating = async (
  addonId: string,
  rating: number,
  review?: string,
): Promise<unknown> => {
  if (rating < 1 || rating > 5) {
    throw new Error("Rating must be between 1 and 5");
  }
  return tauriInvoke<unknown>("submit_addon_rating", {
    addonId,
    rating,
    review,
  });
};

export const fetchAddonStoreListings = async (): Promise<AddonStoreListing[]> => {
  return tauriInvoke<AddonStoreListing[]>("fetch_addon_store_listings");
};

// ============================================================================
// Addon Key-Value Storage
// ============================================================================

export const getAddonStorageItem = async (addonId: string, key: string): Promise<string | null> => {
  return tauriInvoke<string | null>("get_addon_storage_item", { addonId, key });
};

export const setAddonStorageItem = async (
  addonId: string,
  key: string,
  value: string,
): Promise<void> => {
  return tauriInvoke<void>("set_addon_storage_item", { addonId, key, value });
};

export const deleteAddonStorageItem = async (addonId: string, key: string): Promise<void> => {
  return tauriInvoke<void>("delete_addon_storage_item", { addonId, key });
};
