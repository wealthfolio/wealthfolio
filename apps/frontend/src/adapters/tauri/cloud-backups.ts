import { tauriInvoke } from "./core";
import { saveAppDataFileViaPicker } from "./files";
import type { BackupImportPreview } from "../types";
export const downloadCloudBackup = async (backupId: string): Promise<boolean> => {
  const output = await tauriInvoke<{ relativePath: string; filename: string }>(
    "cloud_backup_download",
    { backupId },
  );
  return saveAppDataFileViaPicker(output.relativePath, output.filename);
};
export const previewCloudBackupRestore = (backupId: string): Promise<BackupImportPreview> =>
  tauriInvoke<BackupImportPreview>("cloud_backup_restore_preview", { backupId, code: null });
