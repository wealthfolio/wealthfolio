// Device Sync Types
// =================
// Types matching the new REST API for device sync

export type TrustState = "trusted" | "untrusted" | "revoked";
export type DevicePlatform =
  | "ios"
  | "android"
  | "mac"
  | "macos"
  | "windows"
  | "linux"
  | "web"
  | "server";
export type PairingRole = "issuer" | "claimer";
export type PairingStatus = "open" | "claimed" | "approved" | "completed" | "cancelled" | "expired";
export type EnrollmentMode = "BOOTSTRAP" | "PAIR" | "READY";
// ─────────────────────────────────────────────────────────────────────────────
// Device Sync State Machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device sync state machine constants.
 *
 * States:
 * - FRESH: No deviceNonce in keychain (never enrolled on this physical device)
 * - REGISTERED: Have deviceNonce + deviceId, but no E2EE credentials (rootKey/keyVersion)
 * - READY: Fully operational - have deviceNonce + deviceId + rootKey + keyVersion
 * - STALE: Have local E2EE credentials but server key version is higher (need re-pair)
 * - RECOVERY: Device ID not found on server (was revoked/deleted from another device)
 * - ORPHANED: Keys exist on server but no trusted devices to pair with (need reset)
 */
export const SyncStates = {
  FRESH: "FRESH",
  REGISTERED: "REGISTERED",
  READY: "READY",
  STALE: "STALE",
  RECOVERY: "RECOVERY",
  ORPHANED: "ORPHANED",
} as const;

export type DeviceSyncState = (typeof SyncStates)[keyof typeof SyncStates];

/**
 * Sync identity stored in keychain.
 * This is the source of truth for device identity and E2EE credentials.
 */
export interface SyncIdentity {
  /** Storage format version for migrations */
  version?: number;
  /** Device nonce - UUID generated locally, stored ONLY in keychain (not in DB).
   *  May be undefined when fetched from backend (not exposed for security). */
  deviceNonce?: string;
  /** Server-assigned device ID */
  deviceId?: string;
  /** E2EE root key (base64 encoded) */
  rootKey?: string;
  /** E2EE key version (epoch) */
  keyVersion?: number;
  /** Device X25519 secret key (base64 encoded) */
  deviceSecretKey?: string;
  /** Device X25519 public key (base64 encoded) */
  devicePublicKey?: string;
}

/**
 * Result of detecting the current sync state.
 */
export interface StateDetectionResult {
  /** Current state */
  state: DeviceSyncState;
  /** Identity from keychain (if any) */
  identity: SyncIdentity | null;
  /** Device info from server (if fetched) */
  device: Device | null;
  /** Server's E2EE key version (if known) */
  serverKeyVersion: number | null;
  /** Trusted devices for pairing (in REGISTERED state) */
  trustedDevices: TrustedDeviceSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Types
// ─────────────────────────────────────────────────────────────────────────────

// Device information from the API
export interface Device {
  id: string;
  userId: string;
  displayName: string;
  platform: DevicePlatform;
  devicePublicKey: string | null;
  trustState: TrustState;
  trustedKeyVersion: number | null;
  osVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  // Client-side flag
  isCurrent?: boolean;
}

// Summary of a trusted device (used in PAIR mode response)
export interface TrustedDeviceSummary {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
}

// Response from resetting team sync
export interface ResetTeamSyncResponse {
  success: boolean;
  keyVersion: number;
  resetAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Types
// ─────────────────────────────────────────────────────────────────────────────

// Request to create a new pairing session
export interface CreatePairingRequest {
  codeHash: string;
  ephemeralPublicKey: string;
}

// Response from creating a pairing session
export interface CreatePairingResponse {
  pairingId: string;
  expiresAt: string;
  keyVersion: number;
  requireSas: boolean;
}

// Response from getting a pairing session
export interface GetPairingResponse {
  pairingId: string;
  status: PairingStatus;
  claimerDeviceId: string | null;
  claimerEphemeralPub: string | null;
  expiresAt: string;
}

// Request to complete a pairing session
export interface CompletePairingRequest {
  encryptedKeyBundle: string;
  sasProof: string | Record<string, unknown>;
  signature: string;
}

// Generic success response
export interface SuccessResponse {
  success: boolean;
}

export interface CompletePairingResponse extends SuccessResponse {
  remoteSeedPresent?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claimer-Side Pairing Types
// ─────────────────────────────────────────────────────────────────────────────

// Request to claim a pairing session (claimer side)
export interface ClaimPairingRequest {
  code: string;
  ephemeralPublicKey: string;
}

// Response from claiming a pairing session
export interface ClaimPairingResponse {
  sessionId: string;
  issuerEphemeralPub: string;
  e2eeKeyVersion: number;
  requireSas: boolean;
  expiresAt: string;
}

// Message from the pairing mailbox
export interface PairingMessage {
  id: string;
  payloadType: string;
  payload: string;
  createdAt: string;
}

// Response from getting pairing messages
export interface PairingMessagesResponse {
  sessionStatus: PairingStatus;
  messages: PairingMessage[];
}

// Request to confirm pairing (claimer side)
export interface ConfirmPairingRequest {
  proof?: string;
}

// Response from confirming pairing
export interface ConfirmPairingResponse {
  success: boolean;
  keyVersion: number;
  remoteSeedPresent?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing Session State (Client-side)
// ─────────────────────────────────────────────────────────────────────────────

// Pairing session (issuer side)
export interface PairingSession {
  pairingId: string;
  code: string;
  ephemeralSecretKey: string; // base64
  ephemeralPublicKey: string; // base64
  claimerPublicKey?: string; // base64
  claimerDeviceId?: string;
  sessionKey?: string; // base64
  keyVersion: number;
  expiresAt: Date;
  status: PairingStatus;
  requireSas: boolean;
}

// Claimer session state (for new device being paired)
export interface ClaimerSession {
  pairingId: string;
  code: string;
  ephemeralSecretKey: string; // base64
  ephemeralPublicKey: string; // base64
  issuerPublicKey: string; // base64
  sessionKey: string; // base64
  e2eeKeyVersion: number;
  requireSas: boolean;
  expiresAt: Date;
  status: PairingStatus;
  /** Server timestamp when RK bundle was generated; used as snapshot freshness gate. */
  keyBundleCreatedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Handling
// ─────────────────────────────────────────────────────────────────────────────

// Known error codes
export const SyncErrorCodes = {
  // State-related errors
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  NO_DEVICE: "NO_DEVICE",
  NO_ACCESS_TOKEN: "NO_ACCESS_TOKEN",

  // Key-related errors
  KEYS_INIT_FAILED: "KEYS_INIT_FAILED",
  ROOT_KEY_NOT_FOUND: "ROOT_KEY_NOT_FOUND",
  KEYS_ALREADY_INITIALIZED: "KEYS_ALREADY_INITIALIZED",
  KEY_VERSION_MISMATCH: "KEY_VERSION_MISMATCH",
  LAST_TRUSTED_DEVICE: "LAST_TRUSTED_DEVICE",

  // Pairing errors
  REQUIRES_PAIRING: "REQUIRES_PAIRING",
  NO_SESSION: "NO_SESSION",
  NO_CLAIM: "NO_CLAIM",
  INVALID_SESSION: "INVALID_SESSION",
  PAIRING_ENDED: "PAIRING_ENDED",
  PAIRING_EXPIRED: "PAIRING_EXPIRED",
  CLAIMER_NOT_FOUND: "CLAIMER_NOT_FOUND",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED",
  SOURCE_RESTORE_REQUIRED: "SOURCE_RESTORE_REQUIRED",

  // General errors
  INIT_FAILED: "INIT_FAILED",
  NETWORK_ERROR: "NETWORK_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

// Custom error class for sync operations
export class SyncError extends Error {
  constructor(
    public code: string,
    message: string,
    public recoverable = true,
  ) {
    super(message);
    this.name = "SyncError";
  }

  /**
   * Create a SyncError from an unknown error.
   */
  static from(error: unknown, defaultCode: string = SyncErrorCodes.UNKNOWN_ERROR): SyncError {
    if (error instanceof SyncError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // Try to detect specific error types
    if (SyncError.isDeviceNotFound(error)) {
      return new SyncError(SyncErrorCodes.DEVICE_NOT_FOUND, message, true);
    }
    if (SyncError.isDeviceRevoked(error)) {
      return new SyncError(SyncErrorCodes.DEVICE_REVOKED, message, true);
    }
    if (SyncError.isNoAccessToken(error)) {
      return new SyncError(SyncErrorCodes.NO_ACCESS_TOKEN, message, true);
    }
    if (SyncError.isLastTrustedDevice(error)) {
      return new SyncError(SyncErrorCodes.LAST_TRUSTED_DEVICE, message, false);
    }
    if (SyncError.isKeysAlreadyInitialized(error)) {
      return new SyncError(SyncErrorCodes.KEYS_ALREADY_INITIALIZED, message, true);
    }
    if (SyncError.isSourceRestoreRequired(error)) {
      return new SyncError(SyncErrorCodes.SOURCE_RESTORE_REQUIRED, message, false);
    }

    return new SyncError(defaultCode, message, true);
  }

  static isDeviceNotFound(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.DEVICE_NOT_FOUND;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("device not found") ||
        msg.includes("device_not_found") ||
        msg.includes("device was unpaired") ||
        msg.includes('"code":"not_found"') ||
        msg.includes('"code":"device_not_found"') ||
        (msg.includes("404") && msg.includes("device"))
      );
    }
    return false;
  }

  static isDeviceRevoked(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.DEVICE_REVOKED;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("device revoked") ||
        msg.includes("device_revoked") ||
        msg.includes("trust revoked") ||
        msg.includes('"trustState":"revoked"')
      );
    }
    return false;
  }

  static isNoAccessToken(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.NO_ACCESS_TOKEN;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("no access token") ||
        msg.includes("please sign in") ||
        msg.includes("401") ||
        msg.includes("unauthorized")
      );
    }
    return false;
  }

  static isLastTrustedDevice(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.LAST_TRUSTED_DEVICE;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes("last_trusted_device") || msg.includes("last trusted device");
    }
    return false;
  }

  static isKeysAlreadyInitialized(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.KEYS_ALREADY_INITIALIZED;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("keys already initialized") || msg.includes("409") || msg.includes("conflict")
      );
    }
    return false;
  }

  static isSourceRestoreRequired(error: unknown): boolean {
    if (error instanceof SyncError) {
      return error.code === SyncErrorCodes.SOURCE_RESTORE_REQUIRED;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("sync_source_restore_required") ||
        (msg.includes("restore sync") && msg.includes("connect another device"))
      );
    }
    return false;
  }

  /**
   * Check if this error indicates the device needs recovery.
   * This happens when the device ID exists locally but not on the server.
   */
  static needsRecovery(error: unknown): boolean {
    return SyncError.isDeviceNotFound(error) || SyncError.isDeviceRevoked(error);
  }

  static needsSourceRestore(error: unknown): boolean {
    return SyncError.isSourceRestoreRequired(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Key Bundle Types (for E2EE key transfer during pairing)
// ─────────────────────────────────────────────────────────────────────────────

// Key bundle payload sent during pairing completion
export interface KeyBundlePayload {
  version: number;
  rootKey: string; // base64 encrypted root key
  keyVersion: number;
}
