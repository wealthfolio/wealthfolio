import connectDefaults from "../../../../config/connect.defaults.json";

export const CONNECT_OAUTH_CALLBACK_URL =
  (import.meta.env.CONNECT_OAUTH_CALLBACK_URL as string) || connectDefaults.oauthCallbackUrl;

/**
 * Wealthfolio Connect feature flag.
 *
 * The Connect module (auth, broker sync, cloud API) is optional.
 * When these environment variables are not set, the app runs fully offline
 * with no Connect-related UI or initialization.
 */
export const CONNECT_ENABLED = Boolean(
  import.meta.env.CONNECT_AUTH_URL && import.meta.env.CONNECT_AUTH_PUBLISHABLE_KEY,
);
