import { profileFetch } from "@/features/profiles/session";
import type { BackupImportPreview } from "../types";
export const downloadCloudBackup = async (backupId: string): Promise<boolean> => {
  const response = await profileFetch(
    `/api/v1/cloud-backups/${encodeURIComponent(backupId)}/package`,
    { credentials: "same-origin" },
  );
  if (!response.ok) throw new Error("Cloud recovery package download failed");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `wealthfolio-${backupId}.wfrec`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
};
export const previewCloudBackupRestore = (_backupId: string): Promise<BackupImportPreview> =>
  Promise.reject(
    new Error(
      "Download the recovery package and restore with the stopped server's db restore command",
    ),
  );
