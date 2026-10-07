// Capture includes export, encryption and the 15-minute transfer. Keep its
// outer budget aligned with device-sync::limits::BACKUP_CAPTURE_TIMEOUT_SECONDS.
const TIMEOUTS_MS: Record<string, number> = {
  cloud_backup_capture: 30 * 60_000,
  device_sync_generate_snapshot_now: 30 * 60_000,
  complete_pairing_with_transfer: 30 * 60_000,
  preview_import_assets: 600_000,
  check_activities_import: 600_000,
};
export const invokeTimeoutMs = (command: string): number => TIMEOUTS_MS[command] ?? 300_000;
