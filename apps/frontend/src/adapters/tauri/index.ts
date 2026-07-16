// Tauri adapter - Desktop implementation
// This file re-exports all domain-specific modules

import type { RunEnv } from "../types";
import { RunEnvs } from "../types";

// Platform constants from core
export { isDesktop, isWeb, logger } from "./core";

/**
 * Runtime environment identifier - always "desktop" for Tauri builds
 */
export const RUN_ENV: RunEnv = RunEnvs.DESKTOP;

// Re-export types and constants from ../types
export type { EventCallback, UnlistenFn, RunEnv, Logger } from "../types";
export { RunEnvs } from "../types";
export type {
  AddonFile,
  AddonInstallResult,
  AddonManifest,
  AddonNetworkRequest,
  AddonNetworkResponse,
  AddonUpdateCheckResult,
  AddonUpdateInfo,
  AddonValidationResult,
  ExtractedAddon,
  FunctionPermission,
  InstalledAddon,
  Permission,
  MarketDataProviderSetting,
  ProviderCapabilities,
  ImportRunsRequest,
  UpdateThreadRequest,
  UpdateToolResultRequest,
  AppInfo,
  UpdateCheckResult,
  UpdateCheckPayload,
  PlatformCapabilities,
  PlatformInfo,
  BackendSyncStateResult,
  BackendEnableSyncResult,
  BackendSyncEngineStatusResult,
  BackendSyncBootstrapOverwriteCheckResult,
  BackendSyncReconcileReadyResult,
  BackendSyncBootstrapResult,
  BackendSyncCycleResult,
  BackendSyncBackgroundEngineResult,
  BackendSyncSnapshotUploadResult,
  EphemeralKeyPair,
  DataExportResult,
  McpServerStatus,
  AgentAccessStatus,
  AgentAccessToken,
  CreateAgentAccessTokenInput,
  CreatedAgentAccessToken,
  AgentAuditEntry,
  AgentAuditPage,
  AgentAuditQuery,
} from "../types";

// Re-export AI types from features/ai-assistant
export type {
  AiChatModelConfig,
  AiSendMessageRequest,
  AiStreamEvent,
  AiToolCall,
  AiToolResult,
  AiChatMessage,
  AiUsageStats,
  AiThread,
  ThreadPage,
  ListThreadsRequest,
} from "@/features/ai-assistant/types";

// ============================================================================
// Shared domain modules (identical logic for both platforms)
// ============================================================================

// Portfolio Commands
export {
  createPortfolio,
  deletePortfolio,
  getPortfolios,
  updatePortfolioEntry,
} from "../shared/portfolios";

// Account Commands
export * from "../shared/accounts";

// Activity Commands
export * from "../shared/activities";
export { parseCsv } from "./activities";

// Portfolio Commands
export * from "../shared/portfolio";

// Market Data Commands
export * from "../shared/market-data";

// Custom Provider Commands
export * from "../shared/custom-provider";

// Goal Commands
export * from "../shared/goals";

// Taxonomy Commands
export * from "../shared/taxonomies";

// Alternative Assets Commands
export * from "../shared/alternative-assets";

// Contribution Limits Commands
export * from "../shared/contribution-limits";

// Exchange Rates Commands
export * from "../shared/exchange-rates";

// Secrets Commands
export * from "../shared/secrets";

// Addon Network Commands
export * from "../shared/addon-network";

// Connect Commands (Broker + Device Sync + Auth)
export * from "../shared/connect";

// AI Providers Commands
export * from "../shared/ai-providers";

// AI Thread Commands
export * from "../shared/ai-threads";

// Health Center Commands
export * from "../shared/health";

// Allocation Target Commands
export * from "../shared/allocation-targets";

// Data Export Commands
export { exportDataFile } from "./exports";

// ============================================================================
// Platform-specific modules (different implementations)
// ============================================================================

// Settings Commands (contains platform-specific backupDatabase, etc.)
export {
  getSettings,
  updateSettings,
  isAutoUpdateCheckEnabled,
  backupDatabase,
  deleteDatabaseBackup,
  getDatabaseBackupDownloadUrl,
  listDatabaseBackups,
  backupDatabaseToPath,
  backupDatabaseToPendingExport,
  restoreDatabase,
  getAppInfo,
  checkForUpdates,
  installUpdate,
  getPlatform,
} from "./settings";
export type { DatabaseBackup } from "./settings";

// Addon Commands (platform-specific)
export {
  extractAddonZip,
  installAddonZip,
  installAddonFile,
  listInstalledAddons,
  toggleAddon,
  uninstallAddon,
  loadAddonForRuntime,
  getEnabledAddonsOnStartup,
  getInstalledAddons,
  loadAddon,
  extractAddon,
  installAddon,
  getEnabledAddons,
  checkAddonUpdate,
  checkAllAddonUpdates,
  updateAddon,
  downloadAddonForReview,
  installFromStaging,
  updateAddonNetworkApprovals,
  clearAddonStaging,
  getAddonRatings,
  submitAddonRating,
  fetchAddonStoreListings,
  getAddonStorageItem,
  setAddonStorageItem,
  deleteAddonStorageItem,
} from "./addons";

// Agent Access Commands (embedded MCP server; PATs are web-only stubs)
export {
  getMcpStatus,
  setMcpEnabled,
  setMcpAutoStart,
  startMcp,
  stopMcp,
  setMcpAuditEnabled,
  listAgentAuditLog,
  purgeAgentAuditLog,
  getAgentAccessStatus,
  listAgentAccessTokens,
  createAgentAccessToken,
  deleteAgentAccessToken,
} from "./agent-access";

// AI Streaming (Tauri Channel-based implementation)
export { streamAiChat } from "./ai-streaming";

// Event Listeners (Tauri listen() implementation)
export {
  listenFileDropHover,
  listenFileDrop,
  listenFileDropCancelled,
  listenPortfolioUpdateStart,
  listenPortfolioUpdateComplete,
  listenDatabaseRestored,
  listenPortfolioUpdateError,
  listenAssetClassificationsChanged,
  listenMarketSyncComplete,
  listenMarketSyncStart,
  listenMarketSyncError,
  listenBrokerSyncStart,
  listenBrokerSyncComplete,
  listenBrokerSyncError,
  listenNavigateToRoute,
  listenDeepLink,
  getCurrentDeepLinks,
} from "./events";

// File Dialogs (Tauri file dialogs)
export {
  openCsvFileDialog,
  openFolderDialog,
  openDatabaseFileDialog,
  openFileSaveDialog,
  saveAppDataFileViaPicker,
  openUrlInBrowser,
} from "./files";

// Crypto Commands (sync crypto operations)
export {
  syncGenerateRootKey,
  syncDeriveDek,
  syncGenerateKeypair,
  syncComputeSharedSecret,
  syncDeriveSessionKey,
  syncEncrypt,
  syncDecrypt,
  syncGeneratePairingCode,
  syncHashPairingCode,
  syncComputeSas,
  syncGenerateDeviceId,
  syncHmacSha256,
} from "./crypto";

// FIRE Planner (desktop-only feature)
export {
  calculateRetirementProjection,
  runRetirementDecisionSensitivityMap,
  runRetirementMonteCarlo,
  runRetirementScenarioAnalysis,
  runRetirementSorr,
  runRetirementStressTests,
} from "./fire-planner";
