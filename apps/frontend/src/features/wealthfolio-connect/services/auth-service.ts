import {
  logger,
  getSyncSessionStatus as getSyncSessionStatusApi,
  storeSyncSession as storeSyncSessionApi,
  clearSyncSession as clearSyncSessionApi,
  postLoginBootstrap as postLoginBootstrapApi,
  restoreSyncSession as restoreSyncSessionApi,
  verifySyncSessionMfa as verifySyncSessionMfaApi,
} from "@/adapters";
import type { PostLoginBootstrapResult } from "@/adapters/types";

/**
 * Store Wealthfolio Connect tokens in the backend's encrypted secret store.
 * The backend uses the refresh token to mint fresh access tokens when needed.
 * Works in both desktop (Tauri) and web modes.
 */
export const storeSyncSession = async (
  refreshToken: string,
  confirmRebind = false,
): Promise<void> => {
  try {
    await storeSyncSessionApi(refreshToken, confirmRebind);
    logger.debug("Sync session stored in backend");
  } catch (error) {
    logger.error("Error storing sync session in backend");
    throw error;
  }
};

/**
 * Clear Wealthfolio Connect session from the backend's secret store.
 * Works in both desktop (Tauri) and web modes.
 */
/**
 * Restore Wealthfolio Connect session from the backend (web mode only).
 * The backend holds the canonical refresh token and can mint a fresh access token.
 */
export const restoreSyncSession = async (): Promise<{
  accessToken: string;
  refreshToken: string;
}> => {
  return restoreSyncSessionApi();
};

/**
 * Pass the code step for the saved login. The backend verifies the code with its
 * own token and keeps the rotated login, so the app never holds a newer token.
 */
export const verifySyncSessionMfa = async (code: string): Promise<void> => {
  return verifySyncSessionMfaApi(code);
};

export const postLoginBootstrap = async (): Promise<PostLoginBootstrapResult> => {
  return postLoginBootstrapApi();
};

export const clearSyncSession = async (): Promise<void> => {
  try {
    await clearSyncSessionApi();
    logger.debug("Sync session cleared from backend");
  } catch (error) {
    logger.error("Error clearing sync session from backend");
    throw error;
  }
};

export const getSyncSessionStatus = (): Promise<{ isConfigured: boolean }> => {
  return getSyncSessionStatusApi();
};
