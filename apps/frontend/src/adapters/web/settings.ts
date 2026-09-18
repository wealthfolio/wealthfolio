// Web adapter - Settings, App Info, Updater Commands

import { API_PREFIX, invoke, logger } from "./core";
import { notifyUnauthorized } from "@/lib/auth-token";
import type { Settings, UpdateInfo } from "@/lib/types";
import type { AppInfo, PlatformInfo, BackupImportPreview } from "../types";
export type { BackupImportPreview } from "../types";

// ============================================================================
// Settings Commands
// ============================================================================

export const getSettings = async (): Promise<Settings> => {
  try {
    return await invoke<Settings>("get_settings");
  } catch (error) {
    logger.error("Error fetching settings.");
    throw error;
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
  protection: "encrypted" | "unencrypted" | "unavailable";
  reason: "manual" | "before-restore" | "before-maintenance" | "before-migration" | "legacy";
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

export const exportDatabaseBackup = async (
  filename: string,
  password: string | null,
  unencrypted: boolean,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (
    !unencrypted &&
    window.location.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
  ) {
    throw new Error("Use HTTPS to export a password-protected backup.");
  }
  const response = await fetch(
    `${API_PREFIX}/utilities/database/backups/${encodeURIComponent(filename)}/export`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Wealthfolio-Backup": "1" },
      body: JSON.stringify({ password, unencrypted }),
      signal,
    },
  );
  if (response.status === 401) {
    notifyUnauthorized();
  }
  const result = await response
    .json()
    .catch(() => ({ message: "Backup export timed out or failed" }));
  if (!response.ok) throw new Error(result.message || "Backup export failed");
  const link = document.createElement("a");
  link.href = `${API_PREFIX}/utilities/database/exports/${encodeURIComponent(result.id)}`;
  link.download = result.filename;
  document.body.append(link);
  link.click();
  link.remove();
  return true;
};

export interface DatabaseEncryptionStatus {
  enabled: boolean;
  supported: boolean;
}

export const getDatabaseEncryptionStatus = async (): Promise<DatabaseEncryptionStatus> => {
  try {
    return await invoke<DatabaseEncryptionStatus>("get_database_encryption_status");
  } catch (error) {
    logger.error("Error reading database encryption status.");
    throw error;
  }
};

export const setDatabaseEncryptionEnabled = (_enabled: boolean): Promise<void> =>
  Promise.reject(
    new Error(
      "Server database encryption is converted with `wealthfolio-server db encrypt` " +
        "and required with WF_DB_REQUIRE_ENCRYPTION",
    ),
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

// These exports preserve the shared native/web adapter interface. Server restore
// is an offline operator action; no browser request is sent.
export const discardDatabaseBackupImport = (_id: string): Promise<void> =>
  Promise.reject(new Error("Database restore is only available in the native app"));

export const inspectDatabaseBackup = (
  _file: string | File,
  _password: string | null,
  _signal?: AbortSignal,
): Promise<BackupImportPreview | null> =>
  Promise.reject(new Error("Database restore is only available in the native app"));

export const inspectSavedDatabaseBackup = (
  _filename: string,
  _signal?: AbortSignal,
): Promise<BackupImportPreview | null> =>
  Promise.reject(new Error("Database restore is only available in the native app"));

export const restoreDatabaseBackupImport = (_id: string): Promise<void> =>
  Promise.reject(new Error("Database restore is only available in the native app"));

export const openDatabaseBackupFolder = (): Promise<void> =>
  Promise.reject(new Error("Backup folders can only be opened on desktop"));
