// Web adapter - Settings, App Info, Updater Commands

import { API_PREFIX, invoke, logger } from "./core";
import type { Settings, UpdateInfo } from "@/lib/types";
import type { AppInfo, PlatformInfo } from "../types";

// ============================================================================
// Settings Commands
// ============================================================================

export const getSettings = async (): Promise<Settings> => {
  try {
    return await invoke<Settings>("get_settings");
  } catch (_error) {
    logger.error("Error fetching settings.");
    return {} as Settings;
  }
};

export const updateSettings = async (settingsUpdate: Partial<Settings>): Promise<Settings> => {
  try {
    return await invoke<Settings>("update_settings", { settingsUpdate });
  } catch (error) {
    logger.error("Error updating settings.");
    throw error;
  }
};

export const isAutoUpdateCheckEnabled = async (): Promise<boolean> => {
  try {
    return await invoke<boolean>("is_auto_update_check_enabled");
  } catch (_error) {
    logger.error("Error checking auto-update setting.");
    return true; // Default to enabled
  }
};

export interface DatabaseBackup {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export const backupDatabase = async (): Promise<{ filename: string }> => {
  try {
    return await invoke<{ filename: string }>("backup_database");
  } catch (error) {
    logger.error("Error backing up database.");
    throw error;
  }
};

export const listDatabaseBackups = async (): Promise<DatabaseBackup[]> => {
  try {
    return await invoke<DatabaseBackup[]>("list_database_backups");
  } catch (error) {
    logger.error("Error listing database backups.");
    throw error;
  }
};

export const deleteDatabaseBackup = async (filename: string): Promise<void> => {
  try {
    await invoke<void>("delete_database_backup", { filename });
  } catch (error) {
    logger.error("Error deleting database backup.");
    throw error;
  }
};

export const getDatabaseBackupDownloadUrl = (filename: string): string =>
  `${API_PREFIX}/utilities/database/backups/${encodeURIComponent(filename)}/download`;

export const backupDatabaseToPath = (_backupDir: string): Promise<string> =>
  Promise.reject(new Error("Backing up to a local path is only supported in the Tauri app"));

export interface PendingExport {
  relativePath: string;
  filename: string;
}

export const backupDatabaseToPendingExport = (): Promise<PendingExport> =>
  Promise.reject(new Error("Pending backup exports are only supported in the Tauri app"));

export const restoreDatabase = (_backupFilePath: string): Promise<void> =>
  Promise.reject(
    new Error("Restore in web mode requires stopping Wealthfolio and replacing app.db"),
  );

// ============================================================================
// App Commands
// ============================================================================

export const getAppInfo = async (): Promise<AppInfo> => {
  try {
    return await invoke<AppInfo>("get_app_info");
  } catch (err) {
    logger.error("Error fetching app info");
    console.error(err);
    return {
      version: "",
      dbPath: "",
      logsDir: "",
    };
  }
};

// ============================================================================
// Updater Commands
// ============================================================================

/** Web API response shape */
interface WebUpdateCheckResponse {
  updateAvailable: boolean;
  latestVersion: string;
  notes?: string;
  pubDate?: string;
  downloadUrl?: string;
  changelogUrl?: string;
  screenshots?: string[];
}

/**
 * Check for updates. Returns update info if available, null if up-to-date.
 * Web implementation uses REST API.
 */
export const checkForUpdates = async (options?: {
  force?: boolean;
}): Promise<UpdateInfo | null> => {
  const response = await invoke<WebUpdateCheckResponse>("check_update", {
    ...(options?.force ? { force: true } : {}),
  });
  if (!response?.updateAvailable) {
    return null;
  }
  // Convert web response to UpdateInfo shape
  return {
    currentVersion: "",
    latestVersion: response.latestVersion,
    notes: response.notes,
    pubDate: response.pubDate,
    isAppStoreBuild: false,
    storeUrl: response.downloadUrl,
    changelogUrl: response.changelogUrl,
    screenshots: response.screenshots,
  };
};

/**
 * Download and install an available update.
 * Not supported in web - users update via Docker/manual download.
 */
export const installUpdate = (): Promise<void> => {
  return Promise.reject(new Error("Updates can only be installed on the desktop client"));
};

// ============================================================================
// Platform Commands
// ============================================================================

export const getPlatform = (): Promise<PlatformInfo> => {
  // Web environment - detect from user agent
  const userAgent = typeof window !== "undefined" ? window.navigator.userAgent.toLowerCase() : "";
  const platform =
    typeof window !== "undefined" ? window.navigator.platform?.toLowerCase() || "" : "";

  // Check for mobile devices
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
    userAgent,
  );
  const isTablet = /ipad|tablet|playbook|silk/i.test(userAgent);

  // Detect OS
  let os = "unknown";
  if (/iphone|ipad|ipod/.test(userAgent)) {
    os = "ios";
  } else if (userAgent.includes("android")) {
    os = "android";
  } else if (/mac|darwin/.test(platform) || userAgent.includes("macintosh")) {
    os = "macos";
  } else if (platform.includes("win") || userAgent.includes("windows")) {
    os = "windows";
  } else if (platform.includes("linux") || userAgent.includes("linux")) {
    os = "linux";
  }

  const is_mobile = isMobileUA || isTablet;

  return Promise.resolve({
    os,
    is_mobile,
    is_desktop: !is_mobile,
    is_tauri: false,
    capabilities: {
      connect_sync: true,
      device_sync: true,
      cloud_sync: true,
    },
  });
};
