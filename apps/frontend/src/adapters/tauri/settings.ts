// Settings Commands
import { appDataDir, join } from "@tauri-apps/api/path";
import type { Settings, UpdateInfo } from "@/lib/types";
import type { AppInfo, PlatformInfo, BackupImportPreview } from "../types";
export type { BackupImportPreview } from "../types";

import { invoke, tauriInvoke, logger } from "./core";
import {
  removeAppDataPath,
  saveAppDataFileViaPicker,
  stagePickedDatabaseFileForRestore,
} from "./files";

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
  protection: "encrypted" | "unencrypted" | "unavailable";
  reason: "manual" | "before-restore" | "before-maintenance" | "before-migration" | "legacy";
}

export const listDatabaseBackups = (): Promise<DatabaseBackup[]> =>
  invoke<DatabaseBackup[]>("list_database_backups");

export const deleteDatabaseBackup = (filename: string): Promise<void> =>
  invoke<void>("delete_database_backup", { filename });

export const exportDatabaseBackup = async (
  filename: string,
  password: string | null,
  unencrypted: boolean,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (signal?.aborted) return false;
  const output = await tauriInvoke<PendingExport>("export_database_backup", {
    filename,
    password,
    unencrypted,
  });
  if (signal?.aborted) {
    await removeAppDataPath(output.relativePath.slice(0, output.relativePath.lastIndexOf("/")));
    return false;
  }
  return saveAppDataFileViaPicker(output.relativePath, output.filename);
};

export const getDatabaseBackupDownloadUrl = (_filename: string): string => {
  throw new Error("Server backup downloads are only supported in web mode");
};

export interface PendingExport {
  relativePath: string;
  filename: string;
}

export interface DatabaseEncryptionStatus {
  /** Whether the database file is encrypted right now. */
  enabled: boolean;
  /** Whether this platform can toggle encryption at all. */
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

/**
 * Converts the database between encrypted and plaintext.
 *
 * On desktop the app restarts as soon as the new database is verified, so this
 * promise never resolves on success — callers should show a restarting state
 * rather than waiting for it.
 */
export const setDatabaseEncryptionEnabled = async (enabled: boolean): Promise<void> => {
  try {
    await tauriInvoke<void>("set_database_encryption_enabled", { enabled });
  } catch (error) {
    logger.error("Error changing database encryption.");
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

export interface DatabaseStartupStatus {
  generation: string | null;
  ready: boolean;
  maintenance: boolean;
  error: string | null;
  canRecover: boolean;
  recoveryEncrypted: boolean | null;
}

export const getDatabaseStartupStatus = (): Promise<DatabaseStartupStatus> =>
  invoke("get_database_startup_status");

export const discardDatabaseBackupImport = (id: string): Promise<void> =>
  invoke("discard_database_backup_import", { id });

export const recoverDatabaseFromImport = (id: string): Promise<void> =>
  tauriInvoke("recover_database_from_import", { id });

export const inspectDatabaseBackup = async (
  backupFilePath: string | File,
  password: string | null,
  signal?: AbortSignal,
): Promise<BackupImportPreview | null> => {
  if (typeof backupFilePath !== "string") throw new Error("Choose a file using the device picker");
  let staged: { relativePath: string; pendingDir: string } | null = null;
  try {
    if (signal?.aborted) return null;
    const platform = await invoke<{ is_mobile?: boolean; os?: string }>("get_platform");
    let path = backupFilePath;
    if (platform.is_mobile || platform.os === "ios" || platform.os === "android") {
      staged = await stagePickedDatabaseFileForRestore(backupFilePath, signal);
      path = await join(await appDataDir(), staged.relativePath);
    }
    if (signal?.aborted) return null;
    const preview = await tauriInvoke<BackupImportPreview>("inspect_database_backup", {
      backupFilePath: path,
      password,
    });
    if (signal?.aborted) {
      await discardDatabaseBackupImport(preview.id);
      return null;
    }
    return preview;
  } finally {
    if (staged) await removeAppDataPath(staged.pendingDir);
  }
};

export const retryDatabaseStartup = (): Promise<void> => tauriInvoke("retry_database_startup");

export const restoreDatabaseBackupImport = (id: string): Promise<void> =>
  tauriInvoke("restore_database_backup_import", { id });

export const inspectSavedDatabaseBackup = async (
  filename: string,
  signal?: AbortSignal,
): Promise<BackupImportPreview | null> => {
  if (signal?.aborted) return null;
  const preview = await tauriInvoke<BackupImportPreview>("inspect_saved_database_backup", {
    filename,
  });
  if (signal?.aborted) {
    await discardDatabaseBackupImport(preview.id);
    return null;
  }
  return preview;
};

export const openDatabaseBackupFolder = (): Promise<void> => invoke("open_database_backup_folder");
