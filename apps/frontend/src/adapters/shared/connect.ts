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
  BackendSyncBackgroundEngineResult,
  BackendSyncBootstrapOverwriteCheckResult,
  BackendSyncBootstrapResult,
  BackendSyncCycleResult,
  BackendSyncEngineStatusResult,
  BackendSyncPairingSourceStatusResult,
  BackendSyncReconcileReadyResult,
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

export const deviceSyncBootstrapOverwriteCheck =
  async (): Promise<BackendSyncBootstrapOverwriteCheckResult> => {
    return invoke<BackendSyncBootstrapOverwriteCheckResult>(
      "device_sync_bootstrap_overwrite_check",
    );
  };

export const deviceSyncReconcileReadyState = async (
  allowOverwrite = false,
): Promise<BackendSyncReconcileReadyResult> => {
  return invoke<BackendSyncReconcileReadyResult>("device_sync_reconcile_ready_state", {
    allowOverwrite,
  });
};

export const syncBootstrapSnapshotIfNeeded = async (): Promise<BackendSyncBootstrapResult> => {
  return invoke<BackendSyncBootstrapResult>("device_sync_bootstrap_snapshot_if_needed");
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
// Pairing Flow Coordinator Commands
// ============================================================================

export type PairingFlowPhase =
  | {
      phase: "overwrite_required";
      info: { localRows: number; nonEmptyTables: { table: string; rows: number }[] };
    }
  | { phase: "syncing"; detail: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

export interface PairingFlowResponse {
  flowId: string;
  phase: PairingFlowPhase;
}

export const beginPairingConfirm = async (
  pairingId: string,
  proof: string,
  minSnapshotCreatedAt?: string,
): Promise<PairingFlowResponse> => {
  return invoke<PairingFlowResponse>("begin_pairing_confirm", {
    pairingId,
    proof,
    minSnapshotCreatedAt,
  });
};

export const getPairingFlowState = async (flowId: string): Promise<PairingFlowResponse> => {
  return invoke<PairingFlowResponse>("get_pairing_flow_state", { flowId });
};

export const approvePairingOverwrite = async (flowId: string): Promise<PairingFlowResponse> => {
  return invoke<PairingFlowResponse>("approve_pairing_overwrite", { flowId });
};

export const cancelPairingFlow = async (flowId: string): Promise<PairingFlowResponse> => {
  return invoke<PairingFlowResponse>("cancel_pairing_flow", { flowId });
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

export interface ConfirmPairingWithBootstrapResult {
  status: "applied" | "overwrite_required" | "already_complete" | "waiting_snapshot";
  message: string;
  localRows: number | null;
  nonEmptyTables: { table: string; rows: number }[] | null;
}

export const confirmPairingWithBootstrap = async (
  pairingId: string,
  proof?: string,
  minSnapshotCreatedAt?: string,
  allowOverwrite?: boolean,
): Promise<ConfirmPairingWithBootstrapResult> => {
  return invoke<ConfirmPairingWithBootstrapResult>("confirm_pairing_with_bootstrap", {
    pairingId,
    proof,
    minSnapshotCreatedAt,
    allowOverwrite: allowOverwrite ?? false,
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

export const storeSyncSession = async (refreshToken: string): Promise<void> => {
  return invoke<void>("store_sync_session", { refreshToken });
};

export const clearSyncSession = async (): Promise<void> => {
  return invoke<void>("clear_sync_session");
};
