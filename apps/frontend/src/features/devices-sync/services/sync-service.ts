// Sync Service
// Core service for device sync, E2EE, and pairing operations
// Uses state machine model: FRESH → REGISTERED → READY (+ STALE, RECOVERY)
//
// NOTE: State detection and enable sync are now handled by the Rust backend
// (DeviceEnrollService). This service wraps those commands and handles
// pairing operations which require real-time UI interaction.
// ===========================================================================

import {
  cancelPairing as cancelPairingApi,
  claimPairing as claimPairingApi,
  clearDeviceSyncData as clearDeviceSyncDataApi,
  completePairingWithTransfer as completePairingWithTransferApi,
  createPairing as createPairingApi,
  deleteDevice as deleteDeviceApi,
  deviceSyncGenerateSnapshotNow as deviceSyncGenerateSnapshotNowApi,
  deviceSyncStartBackgroundEngine as deviceSyncStartBackgroundEngineApi,
  deviceSyncStopBackgroundEngine as deviceSyncStopBackgroundEngineApi,
  enableDeviceSync as enableDeviceSyncApi,
  getDevice as getDeviceApi,
  getDeviceSyncState as getDeviceSyncStateApi,
  getPairingSourceStatus as getPairingSourceStatusApi,
  getPairing as getPairingApi,
  getPairingMessages as getPairingMessagesApi,
  getSyncEngineStatus as getSyncEngineStatusApi,
  listDevices as listDevicesApi,
  logger,
  reinitializeDeviceSync as reinitializeDeviceSyncApi,
  resetTeamSync as resetTeamSyncApi,
  revokeDevice as revokeDeviceApi,
  syncTriggerCycle as syncTriggerCycleApi,
  updateDevice as updateDeviceApi,
} from "@/adapters";
import * as crypto from "../crypto";
import { syncStorage } from "../storage/keyring";
import type {
  ClaimerSession,
  Device,
  DeviceSyncState,
  KeyBundlePayload,
  PairingStatus,
  PairingSession,
  StateDetectionResult,
  SyncIdentity,
  TrustedDeviceSummary,
} from "../types";
import { SyncError, SyncErrorCodes, SyncStates } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Exported Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result from enabling device sync. */
export interface EnableSyncResult {
  deviceId: string;
  state: DeviceSyncState;
  keyVersion: number | null;
  serverKeyVersion: number | null;
  needsPairing: boolean;
  trustedDevices: TrustedDeviceSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Service Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync Service
 * Manages device registration, E2EE key initialization, and pairing operations.
 * Uses state machine model for clear state transitions.
 *
 * NOTE: Core state detection and enable sync are now handled by Rust backend
 * (DeviceEnrollService). This service wraps those commands and handles
 * pairing operations which require real-time UI interaction.
 */
class SyncService {
  // ═══════════════════════════════════════════════════════════════════════════
  // STATE DETECTION (delegates to backend)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect the current sync state.
   * Delegates to Rust backend which handles keyring access and server verification.
   *
   * State Machine:
   * - FRESH: No deviceNonce in keychain (never enrolled on this physical device)
   * - REGISTERED: Have deviceNonce + deviceId, but no E2EE credentials
   * - READY: Fully operational - have all credentials and device is trusted
   * - STALE: Have local E2EE credentials but server key version is higher
   * - RECOVERY: Device ID exists locally but not found/revoked on server
   */
  async detectState(): Promise<StateDetectionResult> {
    logger.info("[SyncService] Detecting sync state...");

    try {
      const result = await getDeviceSyncStateApi();

      // Build device object if we have device info
      const device: Device | null =
        result.deviceId && result.deviceName
          ? {
              id: result.deviceId,
              userId: "",
              displayName: result.deviceName,
              platform: "macos",
              devicePublicKey: null,
              trustState: result.isTrusted ? "trusted" : "untrusted",
              trustedKeyVersion: result.serverKeyVersion ?? null,
              osVersion: null,
              appVersion: null,
              lastSeenAt: null,
              createdAt: new Date().toISOString(),
              isCurrent: true,
            }
          : null;

      // Build identity from backend result
      const identity: SyncIdentity | null = result.deviceId
        ? {
            deviceNonce: undefined, // Not exposed by backend
            deviceId: result.deviceId,
            rootKey: result.state === SyncStates.READY ? "present" : undefined,
            keyVersion: result.keyVersion ?? undefined,
          }
        : null;

      logger.info(`[SyncService] State: ${result.state}`);
      return {
        state: result.state,
        identity,
        device,
        serverKeyVersion: result.serverKeyVersion,
        trustedDevices: result.trustedDevices,
      };
    } catch (err) {
      logger.error(`[SyncService] Failed to detect state: ${err}`);
      throw SyncError.from(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENABLE SYNC (FRESH → REGISTERED or READY)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enable device sync by enrolling this device.
   * Delegates to Rust backend which handles:
   * - Device nonce generation
   * - Server enrollment
   * - E2EE key initialization (for BOOTSTRAP mode)
   * - Keyring storage
   *
   * Returns the result indicating if pairing is needed.
   */
  async enableSync(): Promise<EnableSyncResult> {
    logger.info("[SyncService] Enabling sync...");

    try {
      const result = await enableDeviceSyncApi();
      logger.info(
        `[SyncService] Sync enabled: deviceId=${result.deviceId}, state=${result.state}, needsPairing=${result.needsPairing}`,
      );
      return result;
    } catch (err) {
      logger.error(`[SyncService] Enable sync failed: ${err}`);
      throw SyncError.from(err, SyncErrorCodes.INIT_FAILED);
    }
  }

  async getEngineStatus(): Promise<{
    cursor: number;
    lastPushAt: string | null;
    lastPullAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    nextRetryAt: string | null;
    lastCycleStatus: string | null;
    lastCycleDurationMs: number | null;
    backgroundRunning: boolean;
    bootstrapRequired: boolean;
  }> {
    return getSyncEngineStatusApi();
  }

  async getPairingSourceStatus(): Promise<{
    status: "ready" | "restore_required";
    message: string;
    localCursor: number;
    serverCursor: number;
  }> {
    return getPairingSourceStatusApi();
  }

  async triggerSyncCycle(): Promise<{
    status: string;
    lockVersion: number;
    pushedCount: number;
    pulledCount: number;
    cursor: number;
    needsBootstrap: boolean;
    deadLetterCount: number;
  }> {
    const result = await syncTriggerCycleApi();
    if (result.deadLetterCount > 0) {
      logger.warn(
        `[SyncService] ${result.deadLetterCount} outbox event(s) dead-lettered (key version mismatch)`,
      );
    }
    return result;
  }

  async startBackgroundEngine(): Promise<{ status: string; message: string }> {
    return deviceSyncStartBackgroundEngineApi();
  }

  async stopBackgroundEngine(): Promise<{ status: string; message: string }> {
    return deviceSyncStopBackgroundEngineApi();
  }

  async generateSnapshotNow(): Promise<{
    status: string;
    snapshotId: string | null;
    oplogSeq: number | null;
    message: string;
  }> {
    return deviceSyncGenerateSnapshotNowApi();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAIRING: ISSUER (Trusted Device)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new pairing session (trusted device side).
   */
  async createPairingSession(): Promise<PairingSession> {
    try {
      // Generate pairing code
      const code = await crypto.generatePairingCode();
      // hashPairingCode is intentionally used here (not hmacSha256) — this is a
      // lookup hash for the server to match the pairing code, not an auth proof.
      const codeHash = await crypto.hashPairingCode(code);

      // Generate ephemeral keypair for key exchange
      const keypair = await crypto.generateEphemeralKeypair();

      // Create session on server
      const result = await createPairingApi(codeHash, keypair.publicKey);

      return {
        pairingId: result.pairingId,
        code,
        ephemeralSecretKey: keypair.secretKey,
        ephemeralPublicKey: keypair.publicKey,
        keyVersion: result.keyVersion,
        expiresAt: new Date(result.expiresAt),
        status: "open",
        requireSas: result.requireSas,
      };
    } catch (err) {
      logger.error(`[SyncService] Failed to create pairing session: ${err}`);
      throw SyncError.from(err);
    }
  }

  /**
   * Poll for claimer connection (issuer side).
   */
  async pollForClaimerConnection(session: PairingSession): Promise<{
    claimed: boolean;
    claimerPublicKey?: string;
    claimerDeviceId?: string;
    sessionKey?: string;
  }> {
    const result = await getPairingApi(session.pairingId);

    if (result.status === "cancelled" || result.status === "expired") {
      throw new SyncError(SyncErrorCodes.PAIRING_ENDED, "Pairing session ended");
    }

    if (result.claimerEphemeralPub && result.claimerDeviceId) {
      // Compute session key using ECDH
      const sharedSecretB64 = await crypto.computeSharedSecret(
        session.ephemeralSecretKey,
        result.claimerEphemeralPub,
      );
      const sessionKeyB64 = await crypto.deriveSessionKey(sharedSecretB64, "pairing");

      return {
        claimed: true,
        claimerPublicKey: result.claimerEphemeralPub,
        claimerDeviceId: result.claimerDeviceId,
        sessionKey: sessionKeyB64,
      };
    }

    return { claimed: false };
  }

  async getPairingStatus(pairingId: string): Promise<PairingStatus> {
    const result = await getPairingApi(pairingId);
    return result.status;
  }

  /**
   * Complete pairing with transfer — issuer side, single backend call.
   * Frontend computes crypto (SAS, encrypt key bundle) then calls this.
   */
  async completePairingWithTransfer(
    session: PairingSession,
  ): Promise<{ remoteSeedPresent: boolean | null }> {
    if (new Date() > session.expiresAt) {
      throw new SyncError(SyncErrorCodes.PAIRING_EXPIRED, "Pairing session expired");
    }
    if (!session.claimerPublicKey || !session.sessionKey) {
      throw new SyncError(SyncErrorCodes.INVALID_SESSION, "Session not ready for key transfer");
    }

    const rootKeyB64 = await syncStorage.getRootKey();
    if (!rootKeyB64) {
      throw new SyncError(SyncErrorCodes.ROOT_KEY_NOT_FOUND, "Root key not found");
    }
    const keyVersion = await syncStorage.getKeyVersion();
    const keyBundle: KeyBundlePayload = {
      version: 1,
      rootKey: rootKeyB64,
      keyVersion: keyVersion ?? 1,
    };
    const encryptedKeyBundle = await crypto.encrypt(session.sessionKey, JSON.stringify(keyBundle));
    const sas = await crypto.computeSAS(session.sessionKey);
    const signatureData = `complete:${session.pairingId}:${encryptedKeyBundle}`;
    const signature = await crypto.hmacSha256(session.sessionKey, signatureData);

    try {
      await completePairingWithTransferApi(session.pairingId, encryptedKeyBundle, sas, signature);
      return { remoteSeedPresent: null };
    } catch (err) {
      throw SyncError.from(err, SyncErrorCodes.SNAPSHOT_FAILED);
    }
  }

  /**
   * Cancel a pairing session.
   */
  async cancelPairing(pairingId: string): Promise<void> {
    await cancelPairingApi(pairingId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAIRING: CLAIMER (New Device)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Claim a pairing session using a code (claimer side).
   */
  async claimPairingSession(code: string): Promise<ClaimerSession> {
    try {
      const deviceId = await syncStorage.getDeviceId();
      if (!deviceId)
        throw new SyncError(SyncErrorCodes.NO_DEVICE, "Enroll this device before pairing");
      // Generate ephemeral keypair for key exchange
      const keypair = await crypto.generateEphemeralKeypair();

      // Claim the session
      const result = await claimPairingApi(code, keypair.publicKey);

      // Compute session key using ECDH
      const sharedSecretB64 = await crypto.computeSharedSecret(
        keypair.secretKey,
        result.issuerEphemeralPub,
      );
      const sessionKeyB64 = await crypto.deriveSessionKey(sharedSecretB64, "pairing");

      return {
        deviceId,
        pairingId: result.sessionId,
        code,
        ephemeralSecretKey: keypair.secretKey,
        ephemeralPublicKey: keypair.publicKey,
        issuerPublicKey: result.issuerEphemeralPub,
        sessionKey: sessionKeyB64,
        e2eeKeyVersion: result.e2eeKeyVersion,
        requireSas: result.requireSas,
        expiresAt: new Date(result.expiresAt),
        status: "claimed",
      };
    } catch (err) {
      logger.error(`[SyncService] Failed to claim pairing session: ${err}`);
      throw SyncError.from(err);
    }
  }

  /**
   * Poll for key bundle from issuer (claimer side).
   */
  async pollForKeyBundle(session: ClaimerSession): Promise<{
    received: boolean;
    keyBundle?: KeyBundlePayload;
    keyBundleCreatedAt?: string;
    status: string;
  }> {
    const result = await getPairingMessagesApi(session.pairingId);

    if (result.sessionStatus === "cancelled" || result.sessionStatus === "expired") {
      throw new SyncError(SyncErrorCodes.PAIRING_ENDED, "Pairing session ended");
    }

    // Look for key bundle message (payload type is "rk_transfer_v1")
    const keyBundleMsg = result.messages.find((m) => m.payloadType === "rk_transfer_v1");

    if (keyBundleMsg) {
      try {
        // Decrypt the key bundle
        const decrypted = await crypto.decrypt(session.sessionKey, keyBundleMsg.payload);
        const parsed = JSON.parse(decrypted);

        // Validate key bundle structure
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof parsed.rootKey !== "string" ||
          typeof parsed.keyVersion !== "number" ||
          !parsed.rootKey
        ) {
          throw new Error("Invalid key bundle structure");
        }

        const keyBundle: KeyBundlePayload = {
          version: typeof parsed.version === "number" ? parsed.version : 1,
          rootKey: parsed.rootKey,
          keyVersion: parsed.keyVersion,
        };

        return {
          received: true,
          keyBundle,
          keyBundleCreatedAt: keyBundleMsg.createdAt,
          status: result.sessionStatus,
        };
      } catch (err) {
        logger.error(`[SyncService] Failed to decrypt key bundle: ${err}`);
        throw new SyncError(SyncErrorCodes.INVALID_SESSION, "Failed to decrypt key bundle");
      }
    }

    return { received: false, status: result.sessionStatus };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEVICE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current device info from the server.
   */
  async getCurrentDevice(): Promise<Device | null> {
    const deviceId = await syncStorage.getDeviceId();
    if (!deviceId) return null;

    try {
      const device = await getDeviceApi(deviceId);
      return { ...device, isCurrent: true };
    } catch (err) {
      if (SyncError.needsRecovery(err)) {
        return null;
      }
      throw SyncError.from(err);
    }
  }

  /**
   * Get all devices for the user.
   */
  async listDevices(scope?: "my" | "team"): Promise<Device[]> {
    const currentDeviceId = await syncStorage.getDeviceId();
    const devices = await listDevicesApi(scope);
    return devices.map((d) => ({
      ...d,
      isCurrent: d.id === currentDeviceId,
    }));
  }

  /**
   * Rename a device.
   */
  async renameDevice(deviceId: string, name: string): Promise<void> {
    await updateDeviceApi(deviceId, name);
  }

  /**
   * Revoke a device's trust.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    await revokeDeviceApi(deviceId);
  }

  /**
   * Delete a device.
   */
  async deleteDevice(deviceId: string): Promise<void> {
    await deleteDeviceApi(deviceId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY (RECOVERY → FRESH)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle recovery by clearing local state and returning to FRESH.
   * Called when user acknowledges that their device was removed.
   */
  async handleRecovery(): Promise<void> {
    logger.info("[SyncService] Handling recovery - clearing local state");
    await clearDeviceSyncDataApi();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYNC RESET (Owner only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reset team sync - revokes all devices and requires new key initialization.
   */
  async resetSync(reason?: string): Promise<{ keyVersion: number }> {
    const deviceId = await syncStorage.getDeviceId();
    const result = await resetTeamSyncApi(reason);

    // Clear local keys but keep device nonce and ID
    await syncStorage.clearRootKey(deviceId);

    return { keyVersion: result.keyVersion };
  }

  /**
   * Clear all sync data (sign out).
   * Delegates to backend to clear keyring.
   */
  async clearSyncData(): Promise<void> {
    await clearDeviceSyncDataApi();
  }

  /**
   * Reinitialize sync - resets server data and enables sync in one operation.
   * Used when sync is in orphaned state (keys exist but no devices).
   */
  async reinitializeSync(): Promise<EnableSyncResult> {
    logger.info("[SyncService] Reinitializing sync...");
    const result = await reinitializeDeviceSyncApi();
    logger.info(`[SyncService] Sync reinitialized: state=${result.state}`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
}

// Export singleton instance with explicit device-sync naming.
export const deviceSyncService = new SyncService();
// Backward-compatible alias.
export const syncService = deviceSyncService;
