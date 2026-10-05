import { invoke } from "./platform";
export interface CloudBackupPoint {
  backupId: string;
  publishedAt: string;
  sizeBytes: number;
  metadata?: { device_name?: string; profile_name?: string; app_version?: string } | null;
}
export interface CloudBackupCaptureStatus {
  state: "idle" | "running" | "failed";
  retryAt: string | null;
  /** Local completion counter catches uploads that finish between progress reads. */
  completed: number;
}
export interface CloudBackupStatus {
  /** In-memory health from this profile's scheduler; never a cloud policy field. */
  capture?: CloudBackupCaptureStatus;
  hasKey: boolean;
  keyReady: boolean;
  isSource: boolean;
  /** Whether this local profile has opted in for the current Connect account. */
  sourceConsented?: boolean;
  policy: {
    enabled: boolean;
    uploadEntitled: boolean;
    nextDueAt: string | null;
    lastBackupAt: string | null;
  };
  history: CloudBackupPoint[];
}
export type CloudBackupOperation =
  | { action: "status" | "runtimeStatus" | "access" | "setup" | "disable" | "reissue" }
  | { action: "enable"; confirmed: boolean }
  | { action: "recover"; code: string }
  | { action: "delete"; backupId: string | null };
export const cloudBackupAction = <T = unknown>(operation: CloudBackupOperation): Promise<T> =>
  invoke<T>("cloud_backup_action", { operation });
export const captureCloudBackup = (): Promise<CloudBackupPoint | null> =>
  invoke<CloudBackupPoint | null>("cloud_backup_capture");
