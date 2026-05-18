// Settings Commands
import type { Settings, UpdateInfo } from "@/lib/types";
import type { AppInfo, PlatformInfo } from "../types";

import { invoke, logger } from "./core";

export const getSettings = async (): Promise<Settings> => {
  try {
    return await invoke<Settings>("get_settings");
  } catch (err) {
    logger.error("Error fetching settings.");
    throw err;
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

export const backupDatabase = async (): Promise<{ filename: string }> => {
  try {
    const filename = await invoke<string>("backup_database");
    return { filename };
  } catch (error) {
    logger.error("Error backing up database.");
    throw error;
  }
};

export interface DatabaseBackup {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export const listDatabaseBackups = (): Promise<DatabaseBackup[]> =>
  Promise.reject(new Error("Server backup listing is only supported in web mode"));

export const deleteDatabaseBackup = (_filename: string): Promise<void> =>
  Promise.reject(new Error("Server backup deletion is only supported in web mode"));

export const getDatabaseBackupDownloadUrl = (_filename: string): string => {
  throw new Error("Server backup downloads are only supported in web mode");
};

export const backupDatabaseToPath = async (backupDir: string): Promise<string> => {
  try {
    return await invoke<string>("backup_database_to_path", { backupDir });
  } catch (error) {
    logger.error("Error backing up database to path.");
    throw error;
  }
};

export interface PendingExport {
  relativePath: string;
  filename: string;
}

export const backupDatabaseToPendingExport = async (): Promise<PendingExport> => {
  try {
    return await invoke<PendingExport>("backup_database_to_pending_export");
  } catch (error) {
    logger.error("Error backing up database to pending export.");
    throw error;
  }
};

export const restoreDatabase = async (backupFilePath: string): Promise<void> => {
  try {
    await invoke<void>("restore_database", { backupFilePath });
  } catch (error) {
    logger.error("Error restoring database.");
    throw error;
  }
};

// ============================================================================
// App Commands
// ============================================================================

export const getAppInfo = async (): Promise<AppInfo> => {
  try {
    return await invoke<AppInfo>("get_app_info");
  } catch (err) {
    logger.error("Error fetching app info");
    throw err;
  }
};

// ============================================================================
// Updater Commands
// ============================================================================

/**
 * Check for updates. Returns update info if available, null if up-to-date.
 * Desktop implementation uses Tauri invoke command.
 */
export const checkForUpdates = async (_options?: {
  force?: boolean;
}): Promise<UpdateInfo | null> => {
  return await invoke<UpdateInfo | null>("check_for_updates");
};

/**
 * Download and install an available update.
 * Only available on desktop.
 */
export const installUpdate = async (): Promise<void> => {
  await invoke("install_app_update");
};

// ============================================================================
// Platform Commands
// ============================================================================

export const getPlatform = async (): Promise<PlatformInfo> => {
  return invoke<PlatformInfo>("get_platform");
};
