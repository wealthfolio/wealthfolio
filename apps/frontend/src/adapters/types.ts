// Shared types for adapters

/**
 * Runtime environment constants
 */
export const RunEnvs = {
  DESKTOP: "desktop",
  WEB: "web",
} as const;

/**
 * Runtime environment type - either desktop (Tauri) or web
 */
export type RunEnv = (typeof RunEnvs)[keyof typeof RunEnvs];

/**
 * Callback function for event handling
 */
export type EventCallback<T> = (event: { event: string; payload: T; id: number }) => void;

/**
 * Function to unsubscribe from an event
 */
export type UnlistenFn = () => Promise<void>;

/**
 * Logger interface with standard logging methods
 */
export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
}

export interface DataExportResult {
  status: "saved" | "empty" | "canceled";
  filename?: string;
}

export type PostLoginBootstrapStatus = "started" | "skipped";

export type PostLoginBootstrapReason =
  | "feature_disabled"
  | "not_entitled"
  | "no_connections"
  | "already_running"
  | "error"
  | "not_enrolled"
  | "not_ready";

export interface PostLoginBootstrapSyncResult {
  status: PostLoginBootstrapStatus;
  reason?: PostLoginBootstrapReason;
}

export interface PostLoginBootstrapResult {
  brokerSync: PostLoginBootstrapSyncResult;
  deviceSync: PostLoginBootstrapSyncResult;
}

// Addon types from SDK, re-exported with Tauri serialization adjustments
import type {
  AddonInstallResult,
  AddonManifest,
  AddonUpdateCheckResult,
  AddonUpdateInfo,
  AddonValidationResult,
  AddonFile as BaseAddonFile,
  FunctionPermission,
  Permission,
} from "@wealthfolio/addon-sdk";

// Tauri-specific types with camelCase serialization to match Rust
export interface AddonFile extends Omit<BaseAddonFile, "is_main"> {
  isMain: boolean;
}

// Re-export SDK types directly
export type {
  AddonInstallResult,
  AddonManifest,
  AddonUpdateCheckResult,
  AddonUpdateInfo,
  AddonValidationResult,
  FunctionPermission,
  Permission,
};

export interface ExtractedAddon {
  metadata: AddonManifest;
  files: AddonFile[];
}

export interface InstalledAddon {
  metadata: AddonManifest;
  /** File path where the addon is stored (Tauri-specific) */
  filePath: string;
  /** Whether this is a ZIP-based addon (Tauri-specific) */
  isZipAddon: boolean;
}

export interface AddonNetworkRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  auth?: AddonNetworkAuth;
}

export interface AddonNetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AddonNetworkAuth {
  type: "bearer" | "basic";
  secretKey: string;
}

// Provider capabilities from backend
export interface ProviderCapabilities {
  instruments: string;
  coverage: string;
  features: string[];
}

// Interface matching the backend struct
export interface MarketDataProviderSetting {
  id: string;
  name: string;
  description: string | null;
  url: string | null;
  priority: number;
  enabled: boolean;
  logoFilename: string | null;
  capabilities: ProviderCapabilities | null;
  providerType?: string;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  assetCount: number;
  errorCount: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  uniqueErrors: string[];
}

// ============================================================================
// Shared Request/Response Types
// ============================================================================

/**
 * Request for fetching import runs with pagination and filtering.
 */
export interface ImportRunsRequest {
  runType?: string;
  limit?: number;
  offset?: number;
}

/**
 * Request for updating thread title or pinned status.
 */
export interface UpdateThreadRequest {
  id: string;
  title?: string;
  isPinned?: boolean;
}

/**
 * Request to update a tool result with additional data.
 */
export interface UpdateToolResultRequest {
  threadId: string;
  toolCallId: string;
  resultPatch: Record<string, unknown>;
}

/**
 * Application info including version and paths.
 */
export interface AppInfo {
  version: string;
  dbPath: string;
  logsDir: string;
}

/**
 * Result from checking for application updates.
 */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  latestVersion: string;
  notes?: string;
  pubDate?: string;
  downloadUrl?: string;
}

/**
 * Payload for update check requests.
 */
export interface UpdateCheckPayload {
  currentVersion: string;
}

/**
 * Platform information for the current runtime environment.
 */
export interface PlatformCapabilities {
  connect_sync: boolean;
  device_sync: boolean;
  cloud_sync: boolean;
}

export interface PlatformInfo {
  os: string;
  arch?: string;
  is_mobile: boolean;
  is_desktop: boolean;
  is_tauri?: boolean;
  capabilities?: PlatformCapabilities;
}

// ============================================================================
// Device Sync Types
// ============================================================================

import type { DeviceSyncState, TrustedDeviceSummary } from "@/features/devices-sync/types";

/**
 * Result from get_device_sync_state command.
 */
export interface BackendSyncStateResult {
  state: DeviceSyncState;
  deviceId: string | null;
  deviceName: string | null;
  keyVersion: number | null;
  serverKeyVersion: number | null;
  isTrusted: boolean;
  trustedDevices: TrustedDeviceSummary[];
}

/**
 * Result from enable_device_sync command.
 */
export interface BackendEnableSyncResult {
  deviceId: string;
  state: DeviceSyncState;
  keyVersion: number | null;
  serverKeyVersion: number | null;
  needsPairing: boolean;
  trustedDevices: TrustedDeviceSummary[];
}

/**
 * Result from sync_engine_status command.
 */
export interface BackendSyncEngineStatusResult {
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
}

export interface BackendSyncPairingSourceStatusResult {
  status: "ready" | "restore_required";
  message: string;
  localCursor: number;
  serverCursor: number;
}

export interface BackendSyncBootstrapOverwriteCheckTableResult {
  table: string;
  rows: number;
}

/**
 * Result from device_sync_bootstrap_overwrite_check command.
 */
export interface BackendSyncBootstrapOverwriteCheckResult {
  bootstrapRequired: boolean;
  hasLocalData: boolean;
  localRows: number;
  nonEmptyTables: BackendSyncBootstrapOverwriteCheckTableResult[];
}

export interface BackendSyncReconcileReadyResult {
  action?: "PULL_TAIL" | "BOOTSTRAP_SNAPSHOT" | "WAIT_SNAPSHOT" | "NOOP";
  bootstrapAction:
    | "PULL_REMOTE_OVERWRITE"
    | "NO_REMOTE_PULL"
    | "WAIT_REMOTE_SNAPSHOT"
    | "NO_BOOTSTRAP";
  reason?: string;
  reconcileReason?: string;
  cursor?: number;
  deviceCursor?: number;
  gcWatermark?: number;
  staleCursor?: boolean;
  diagnostics?: {
    remoteSnapshotExists?: boolean;
    trustedDeviceCount?: number;
    teamKeyVersion?: number;
    latestSnapshot?: {
      snapshotId: string;
      schemaVersion: number;
      oplogSeq: number;
    } | null;
  };
  status: "ok" | "skipped_not_ready" | "error";
  message: string;
  bootstrapStatus: "applied" | "skipped" | "skipped_not_ready" | "requested" | "not_attempted";
  bootstrapMessage: string | null;
  bootstrapSnapshotId: string | null;
  cycleStatus: string | null;
  cycleNeedsBootstrap: boolean;
  retryAttempted: boolean;
  retryCycleStatus: string | null;
  backgroundStatus: "started" | "skipped" | "failed";
}

/**
 * Result from sync_bootstrap_snapshot_if_needed command.
 */
export interface BackendSyncBootstrapResult {
  status: string;
  message: string;
  snapshotId: string | null;
  cursor: number | null;
}

/**
 * Result from sync_trigger_cycle command.
 */
export interface BackendSyncCycleResult {
  status: string;
  lockVersion: number;
  pushedCount: number;
  pulledCount: number;
  cursor: number;
  needsBootstrap: boolean;
  bootstrapSnapshotId: string | null;
  bootstrapSnapshotSeq: number | null;
  deadLetterCount: number;
}

export interface BackendSyncBackgroundEngineResult {
  status: string;
  message: string;
}

export interface BackendSyncSnapshotUploadResult {
  status: string;
  snapshotId: string | null;
  oplogSeq: number | null;
  message: string;
}

/**
 * Ephemeral key pair for secure pairing operations.
 */
export interface EphemeralKeyPair {
  publicKey: string; // Base64
  secretKey: string; // Base64
}

// ============================================================================
// Agent Access (MCP server + personal access tokens)
// ============================================================================

/** Embedded MCP server status (desktop only). */
export interface McpServerStatus {
  enabled: boolean;
  autoStart: boolean;
  auditEnabled: boolean;
  running: boolean;
  port: number | null;
  startedAt: string | null;
}

/** Agent access status for the web server's `/mcp` endpoint. */
export interface AgentAccessStatus {
  mcpEnabled: boolean;
  auditEnabled: boolean;
  endpoint: string;
}

/** Personal access token metadata (web only; the secret is never returned). */
export interface AgentAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  /** `sha256:<prefix>` matching audit `actorFingerprint`, for name attribution. */
  fingerprint: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Input for creating a personal access token. */
export interface CreateAgentAccessTokenInput {
  name: string;
  expiresAt?: string;
  scopes: string[];
}

/** Created personal access token. `token` is shown exactly once. */
export interface CreatedAgentAccessToken {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
}

/** One MCP tool-call audit entry. */
export interface AgentAuditEntry {
  id: string;
  sessionId: string;
  actorKind: string;
  actorFingerprint: string;
  tool: string;
  scopes: string[];
  argsSummary: string | null;
  outcome: string;
  errorMessage: string | null;
  createdAt: string;
}

/** One page of audit entries. */
export interface AgentAuditPage {
  items: AgentAuditEntry[];
  totalCount: number;
  /** Distinct tool names across the whole log (for the Tool filter). */
  availableTools: string[];
}

/** Request to list a page of the agent audit log. All filters are server-side. */
export interface AgentAuditQuery {
  page: number;
  pageSize: number;
  /** Case-insensitive substring search on the tool name. */
  q?: string;
  /** Exact tool names to include. */
  tools?: string[];
  /** Outcomes to include (success | denied | error). */
  outcomes?: string[];
  /** Actor kinds to include (pat | local_token | desktop_bridge). */
  actorKinds?: string[];
}
