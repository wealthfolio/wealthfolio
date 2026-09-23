// Broker / Connect Commands
import type {
  ClaimPairingResponse,
  CompletePairingResponse,
  ConfirmPairingResponse,
  CreatePairingResponse,
  Device,
  GetPairingResponse,
  PairingMessagesResponse,
  ResetTeamSyncResponse,
  SuccessResponse,
} from "@/features/devices-sync/types";
import type {
  BrokerAccount,
  BrokerConnection,
  BrokerSyncState,
  ImportRun,
  PlansResponse,
  UserInfo,
} from "@/features/wealthfolio-connect/types";
import type { Account, Platform } from "@/lib/types";
import type {
  BackendEnableSyncResult,
  BackendRestoreOperation,
  BackendSyncBackgroundEngineResult,
  BackendSyncCycleResult,
  BackendSyncEngineStatusResult,
  BackendSyncPairingSourceStatusResult,
  BackendSyncSnapshotUploadResult,
  BackendSyncStateResult,
  ImportRunsRequest,
  PostLoginBootstrapResult,
} from "../types";

import { invoke } from "./platform";

// ============================================================================
// Broker / Connect Commands
// ============================================================================

export async function syncBrokerData(): Promise<void> {
  return invoke<void>("broker_ingest_run");
}

export async function postLoginBootstrap(): Promise<PostLoginBootstrapResult> {
  return invoke<PostLoginBootstrapResult>("post_login_bootstrap");
}

export async function getSyncedAccounts(): Promise<Account[]> {
  return invoke<Account[]>("get_synced_accounts");
}

export async function getPlatforms(): Promise<Platform[]> {
  return invoke<Platform[]>("get_platforms");
}

export async function listBrokerConnections(): Promise<BrokerConnection[]> {
  return invoke<BrokerConnection[]>("list_broker_connections");
}

export async function listBrokerAccounts(): Promise<BrokerAccount[]> {
  return invoke<BrokerAccount[]>("list_broker_accounts");
}

export async function getSubscriptionPlans(): Promise<PlansResponse> {
  return invoke<PlansResponse>("get_subscription_plans");
}

export async function getSubscriptionPlansPublic(): Promise<PlansResponse> {
  return invoke<PlansResponse>("get_subscription_plans_public");
}

export async function getUserInfo(): Promise<UserInfo> {
  return invoke<UserInfo>("get_user_info");
}

export async function getBrokerSyncStates(): Promise<BrokerSyncState[]> {
  return invoke<BrokerSyncState[]>("get_broker_ingest_states");
}

export async function getImportRuns(request?: ImportRunsRequest): Promise<ImportRun[]> {
  return invoke<ImportRun[]>("get_data_import_runs", {
    runType: request?.runType,
    limit: request?.limit,
    offset: request?.offset,
  });
}

// ============================================================================
// Device Sync Commands (DeviceEnrollService)
// ============================================================================

export const getDeviceSyncState = async (): Promise<BackendSyncStateResult> => {
  return invoke<BackendSyncStateResult>("get_device_sync_state");
};

export const enableDeviceSync = async (): Promise<BackendEnableSyncResult> => {
  return invoke<BackendEnableSyncResult>("enable_device_sync");
};

export const clearDeviceSyncData = async (): Promise<void> => {
  return invoke<void>("clear_device_sync_data");
};

export const reinitializeDeviceSync = async (): Promise<BackendEnableSyncResult> => {
  return invoke<BackendEnableSyncResult>("reinitialize_device_sync");
};

export const getSyncEngineStatus = async (): Promise<BackendSyncEngineStatusResult> => {
  return invoke<BackendSyncEngineStatusResult>("device_sync_engine_status");
};

export const getPairingSourceStatus = async (): Promise<BackendSyncPairingSourceStatusResult> => {
  return invoke<BackendSyncPairingSourceStatusResult>("device_sync_pairing_source_status");
};

export const syncTriggerCycle = async (): Promise<BackendSyncCycleResult> => {
  return invoke<BackendSyncCycleResult>("device_sync_trigger_cycle");
};

export const deviceSyncStartBackgroundEngine =
  async (): Promise<BackendSyncBackgroundEngineResult> => {
    return invoke<BackendSyncBackgroundEngineResult>("device_sync_start_background_engine");
  };

export const deviceSyncStopBackgroundEngine =
  async (): Promise<BackendSyncBackgroundEngineResult> => {
    return invoke<BackendSyncBackgroundEngineResult>("device_sync_stop_background_engine");
  };

export const deviceSyncGenerateSnapshotNow = async (): Promise<BackendSyncSnapshotUploadResult> => {
  return invoke<BackendSyncSnapshotUploadResult>("device_sync_generate_snapshot_now");
};

export const deviceSyncCancelSnapshotUpload =
  async (): Promise<BackendSyncBackgroundEngineResult> => {
    return invoke<BackendSyncBackgroundEngineResult>("device_sync_cancel_snapshot_upload");
  };

// Device Management Commands
export const getDevice = async (deviceId?: string): Promise<Device> => {
  return invoke<Device>("get_device", { deviceId });
};

export const listDevices = async (scope?: string): Promise<Device[]> => {
  return invoke<Device[]>("list_devices", { scope });
};

export const updateDevice = async (
  deviceId: string,
  displayName: string,
): Promise<SuccessResponse> => {
  return invoke<SuccessResponse>("update_device", { deviceId, displayName });
};

export const deleteDevice = async (deviceId: string): Promise<SuccessResponse> => {
  return invoke<SuccessResponse>("delete_device", { deviceId });
};

export const revokeDevice = async (deviceId: string): Promise<SuccessResponse> => {
  return invoke<SuccessResponse>("revoke_device", { deviceId });
};

export const resetTeamSync = async (reason?: string): Promise<ResetTeamSyncResponse> => {
  return invoke<ResetTeamSyncResponse>("reset_team_sync", { reason });
};

// Pairing Commands (Issuer - Trusted Device)
export const createPairing = async (
  codeHash: string,
  ephemeralPublicKey: string,
): Promise<CreatePairingResponse> => {
  return invoke<CreatePairingResponse>("create_pairing", { codeHash, ephemeralPublicKey });
};

export const getPairing = async (pairingId: string): Promise<GetPairingResponse> => {
  return invoke<GetPairingResponse>("get_pairing", { pairingId });
};

export const approvePairing = async (pairingId: string): Promise<SuccessResponse> => {
  return invoke<SuccessResponse>("approve_pairing", { pairingId });
};

export const completePairing = async (
  pairingId: string,
  encryptedKeyBundle: string,
  sasProof: string | Record<string, unknown>,
  signature: string,
): Promise<CompletePairingResponse> => {
  return invoke<CompletePairingResponse>("complete_pairing", {
    pairingId,
    encryptedKeyBundle,
    sasProof,
    signature,
  });
};

export const cancelPairing = async (pairingId: string): Promise<SuccessResponse> => {
  return invoke<SuccessResponse>("cancel_pairing", { pairingId });
};

// Pairing Commands (Claimer - New Device)
export const claimPairing = async (
  code: string,
  ephemeralPublicKey: string,
): Promise<ClaimPairingResponse> => {
  return invoke<ClaimPairingResponse>("claim_pairing", { code, ephemeralPublicKey });
};

export const getPairingMessages = async (pairingId: string): Promise<PairingMessagesResponse> => {
  return invoke<PairingMessagesResponse>("get_pairing_messages", { pairingId });
};

export const confirmPairing = async (
  pairingId: string,
  proof?: string,
  minSnapshotCreatedAt?: string,
): Promise<ConfirmPairingResponse> => {
  return invoke<ConfirmPairingResponse>("confirm_pairing", {
    pairingId,
    proof,
    minSnapshotCreatedAt,
  });
};

// ============================================================================
// Restore Operation (receiving device)
// ============================================================================

/**
 * Returns the existing operation when one already owns restoration.
 * `newAttempt`: the user asked to finish setup; otherwise a recurring check.
 */
export const startDeviceSyncRestore = async (
  newAttempt: boolean,
): Promise<BackendRestoreOperation | null> => {
  return invoke<BackendRestoreOperation | null>("device_sync_start_restore", { newAttempt });
};

/** Read-only: never starts or advances restoration. */
export const getDeviceSyncRestore = async (): Promise<BackendRestoreOperation | null> => {
  return invoke<BackendRestoreOperation | null>("device_sync_get_restore");
};

export const approveDeviceSyncRestore = async (
  operationId: string,
  backup: boolean,
): Promise<BackendRestoreOperation> => {
  return invoke<BackendRestoreOperation>("device_sync_approve_restore", { operationId, backup });
};

export const retryDeviceSyncRestore = async (
  operationId: string,
): Promise<BackendRestoreOperation> => {
  return invoke<BackendRestoreOperation>("device_sync_retry_restore", { operationId });
};

export const cancelDeviceSyncRestore = async (
  operationId: string,
): Promise<BackendRestoreOperation> => {
  return invoke<BackendRestoreOperation>("device_sync_cancel_restore", { operationId });
};

/** Confirms pairing on the receiving device and hands restoration to the runtime. */
export const beginPairingRestore = async (
  pairingId: string,
  proof: string,
  minSnapshotCreatedAt?: string,
): Promise<BackendRestoreOperation> => {
  return invoke<BackendRestoreOperation>("device_sync_begin_pairing_restore", {
    pairingId,
    proof,
    minSnapshotCreatedAt,
  });
};

export const completePairingWithTransfer = async (
  pairingId: string,
  encryptedKeyBundle: string,
  sasProof: string | Record<string, unknown>,
  signature: string,
): Promise<{ success: boolean }> => {
  return invoke<{ success: boolean }>("complete_pairing_with_transfer", {
    pairingId,
    encryptedKeyBundle,
    sasProof,
    signature,
  });
};

// ============================================================================
// Wealthfolio Connect Auth Commands
// ============================================================================

export const restoreSyncSession = async (): Promise<{
  accessToken: string;
  refreshToken: string;
}> => {
  return invoke<{ accessToken: string; refreshToken: string }>("restore_sync_session");
};

export const storeSyncSession = async (
  refreshToken: string,
  confirmRebind = false,
): Promise<void> => {
  return invoke<void>("store_sync_session", { refreshToken, confirmRebind });
};

export const clearSyncSession = async (): Promise<void> => {
  return invoke<void>("clear_sync_session");
};

export const getSyncSessionStatus = (): Promise<{ isConfigured: boolean }> => {
  return invoke("get_sync_session_status");
};
