import {
  getCurrentDeepLinks,
  isDesktop,
  listenDeepLink,
  logger,
  openUrlInBrowser,
} from "@/adapters";
import { useAuth } from "@/context/auth-context";
import { getPlatform } from "@/hooks/use-platform";
import { CONNECT_ENABLED } from "@/lib/connect-config";
import { createClient, Session, SupabaseClient, User } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { authenticate as authenticateWithNativeWebAuth } from "tauri-plugin-web-auth-api";
import {
  clearSyncSession,
  getSyncSessionStatus,
  restoreSyncSession,
  storeSyncSession,
} from "../services/auth-service";
import { getUserInfo } from "../services/broker-service";
import type { UserInfo } from "../types";
import { parseAuthCallbackUrl } from "../lib/auth-callback";
import { hasBrokerSync, isSubscriptionStatusActive } from "../lib/plan-capabilities";

// Auth configuration - these are public/publishable keys (safe for client-side)
// Can be overridden via environment variables: CONNECT_AUTH_URL and CONNECT_AUTH_PUBLISHABLE_KEY
const AUTH_URL = (import.meta.env.CONNECT_AUTH_URL as string) || "https://auth.wealthfolio.app";
const AUTH_PUBLISHABLE_KEY =
  (import.meta.env.CONNECT_AUTH_PUBLISHABLE_KEY as string) ||
  "sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd";

// Deep-link URL for desktop callbacks (custom URL scheme)
const DESKTOP_DEEP_LINK_URL = "wealthfolio://auth/callback";

// Web redirect URL for OAuth and magic link
const getWebRedirectUrl = () => {
  return `${window.location.origin}/auth/callback`;
};

// For OAuth on desktop, we use a hosted callback page that redirects to the deep link
// This is necessary because browsers block direct navigation to custom URL schemes
// Uses env variable in dev, falls back to production URL for bundled builds
const HOSTED_OAUTH_CALLBACK_URL =
  (import.meta.env.CONNECT_OAUTH_CALLBACK_URL as string) ||
  "https://connect.wealthfolio.app/deeplink";

const parseConfiguredAuthCallbackUrl = (url: string) =>
  parseAuthCallbackUrl(url, { hostedCallbackUrl: HOSTED_OAUTH_CALLBACK_URL });

const PROCESSED_AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PROCESSED_AUTH_CODES = 20;

type PostLoginSyncSource =
  | "auth-callback"
  | "email-sign-in"
  | "email-sign-up"
  | "otp"
  | "subscription-activated";

interface PostLoginSyncRequest {
  id: string;
  userId: string;
  createdAt: number;
  source: PostLoginSyncSource;
}

interface WealthfolioConnectContextValue {
  isEnabled: boolean;
  isConnected: boolean;
  isInitializing: boolean;
  isLoading: boolean;
  isLoadingUserInfo: boolean;
  user: User | null;
  session: Session | null;
  teamId: string | null;
  userInfo: UserInfo | null;
  postLoginSyncRequest: PostLoginSyncRequest | null;
  error: string | null;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithOAuth: (provider: "google" | "apple" | "github") => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
  refetchUserInfo: () => Promise<void>;
  consumePostLoginSyncRequest: (requestId: string) => void;
}

const WealthfolioConnectContext = createContext<WealthfolioConnectContextValue | undefined>(
  undefined,
);

// Disabled context value - used when CONNECT_ENABLED is false
// All methods are no-ops that return resolved promises
const disabledContextValue: WealthfolioConnectContextValue = {
  isEnabled: false,
  isConnected: false,
  isInitializing: false,
  isLoading: false,
  isLoadingUserInfo: false,
  user: null,
  session: null,
  teamId: null,
  userInfo: null,
  postLoginSyncRequest: null,
  error: null,
  signInWithEmail: async () => {},
  signUpWithEmail: async () => {},
  signInWithOAuth: async () => {},
  signInWithMagicLink: async () => {},
  verifyOtp: async () => {},
  signOut: async () => {},
  clearError: () => {},
  refetchUserInfo: async () => {},
  consumePostLoginSyncRequest: () => {},
};

function getAuthStorageKey(supabaseUrl: string): string {
  try {
    const hostname = new URL(supabaseUrl).hostname;
    const projectRef = hostname.split(".")[0];
    return `sb-${projectRef}-auth-token`;
  } catch {
    return "sb-auth-token";
  }
}

function createHybridPkceStorage(storageKey: string) {
  const inMemory = new Map<string, string>();
  const pkceKey = `${storageKey}-code-verifier`;

  const safeLocalStorageGet = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const safeLocalStorageSet = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore - PKCE exchange will fail after a full redirect without persistence
    }
  };

  const safeLocalStorageRemove = (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  };

  return {
    getItem: (key: string) => {
      if (key === pkceKey) return safeLocalStorageGet(key);
      return inMemory.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (key === pkceKey) {
        safeLocalStorageSet(key, value);
        return;
      }
      inMemory.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === pkceKey) {
        safeLocalStorageRemove(key);
        return;
      }
      inMemory.delete(key);
    },
  };
}

// Create a Supabase client with custom storage for persistent auth
const createSupabaseClient = () => {
  const storageKey = getAuthStorageKey(AUTH_URL);
  return createClient(AUTH_URL, AUTH_PUBLISHABLE_KEY, {
    auth: {
      storageKey,
      storage: createHybridPkceStorage(storageKey),
      flowType: "pkce",
      autoRefreshToken: false,
      // Must be true for auth-js to use the provided `storage` (PKCE code_verifier lives there).
      // Our custom storage keeps sessions in-memory (non-persistent) while allowing PKCE to work
      // across full-page redirects.
      persistSession: true,
      detectSessionInUrl: false, // We handle URL parsing manually
    },
  });
};

// Internal provider used when Connect is enabled
function EnabledWealthfolioConnectProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUserInfo, setIsLoadingUserInfo] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSessionState] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const sessionGenerationRef = useRef(0);
  const syncAccessRef = useRef<string | null>(null);
  const userInfoRequestRef = useRef(0);
  const authTransitionRef = useRef<Promise<unknown>>(Promise.resolve());

  const setSession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    syncAccessRef.current = null;
    sessionGenerationRef.current += 1;
    userInfoRequestRef.current += 1;
    setSessionState(next);
  }, []);

  // Serialize credential-changing operations, including mobile OAuth callbacks.
  const runAuthTransition = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const next = authTransitionRef.current.then(operation, operation);
    authTransitionRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [postLoginSyncRequest, setPostLoginSyncRequest] = useState<PostLoginSyncRequest | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const supabaseRef = useRef<SupabaseClient | null>(null);
  const processedAuthCodesRef = useRef<Map<string, number>>(new Map());
  const postLoginSyncRequestSequenceRef = useRef(0);

  // Initialize Supabase client
  supabaseRef.current ??= createSupabaseClient();

  const supabase = supabaseRef.current;

  const clearProcessedAuthCodes = useCallback(() => {
    processedAuthCodesRef.current.clear();
  }, []);

  const rememberAuthCodeIfNew = useCallback((code: string) => {
    const now = Date.now();
    const processedAuthCodes = processedAuthCodesRef.current;

    for (const [processedCode, processedAt] of processedAuthCodes) {
      if (now - processedAt > PROCESSED_AUTH_CODE_TTL_MS) {
        processedAuthCodes.delete(processedCode);
      }
    }

    if (processedAuthCodes.has(code)) {
      return false;
    }

    processedAuthCodes.set(code, now);
    while (processedAuthCodes.size > MAX_PROCESSED_AUTH_CODES) {
      const oldestCode = processedAuthCodes.keys().next().value;
      if (!oldestCode) break;
      processedAuthCodes.delete(oldestCode);
    }

    return true;
  }, []);

  const requestPostLoginSync = useCallback((source: PostLoginSyncSource, session: Session) => {
    const now = Date.now();
    const sequence = postLoginSyncRequestSequenceRef.current + 1;
    postLoginSyncRequestSequenceRef.current = sequence;

    setPostLoginSyncRequest((current) => {
      // Keep pending login work and its result handler when subscription info arrives.
      if (source === "subscription-activated" && current?.userId === session.user.id) {
        return current;
      }
      return {
        id: `${session.user.id}:${now}:${sequence}`,
        userId: session.user.id,
        createdAt: now,
        source,
      };
    });
  }, []);

  const consumePostLoginSyncRequest = useCallback((requestId: string) => {
    setPostLoginSyncRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  // The backend is the sole owner of persistent credentials and token rotation.
  const storeTokens = useCallback(async (next: Session | null) => {
    if (next?.refresh_token) {
      await storeSyncSession(next.refresh_token);
    } else {
      await clearSyncSession();
    }
  }, []);

  // Handle auth callback from URL (deep link or web redirect)
  const handleAuthCallback = useCallback(
    async (url: string) => {
      const payload = parseConfiguredAuthCallbackUrl(url);

      if (!payload) {
        logger.error("Failed to parse auth callback URL - no payload");
        return;
      }

      if (payload.type === "error") {
        logger.error(`Auth callback error: ${payload.message}`);
        setError(payload.message);
        return;
      }

      if (!rememberAuthCodeIfNew(payload.code)) {
        logger.debug("Skipping duplicate auth callback code");
        return;
      }

      let didExchangeSession = false;

      try {
        await runAuthTransition(async () => {
          const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(
            payload.code,
          );

          if (exchangeError) {
            processedAuthCodesRef.current.delete(payload.code);
            logger.error(`Failed to exchange auth code: ${exchangeError.message}`);
            setError(exchangeError.message);
            return;
          }

          if (!data.session) {
            processedAuthCodesRef.current.delete(payload.code);
            logger.error("No session returned after code exchange");
            setError(t("connect:authErrors.noSessionReturned"));
            return;
          }

          didExchangeSession = true;
          // Store tokens BEFORE setting session to avoid race condition
          await storeTokens(data.session);
          setSession(data.session);
          setUser(data.session.user);
          requestPostLoginSync("auth-callback", data.session);
          logger.info("Auth callback completed successfully");
        });
      } catch (err) {
        if (!didExchangeSession) {
          processedAuthCodesRef.current.delete(payload.code);
        }
        logger.error(`Error in handleAuthCallback: ${err instanceof Error ? err.message : err}`);
        setError(err instanceof Error ? err.message : t("connect:authErrors.completeSignInFailed"));
      }
    },
    [
      runAuthTransition,
      setSession,
      supabase,
      storeTokens,
      rememberAuthCodeIfNew,
      requestPostLoginSync,
      t,
    ],
  );

  // Restore session from stored tokens on mount
  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      try {
        await runAuthTransition(async () => {
          if (cancelled) return;
          // Ask the backend for fresh tokens. The backend is the single owner of
          // the refresh token and will rotate it via Supabase when needed, avoiding
          // the race condition where both the JS client and backend independently
          // rotate the same refresh token.
          try {
            const { accessToken, refreshToken } = await restoreSyncSession();
            const { data, error: setErr } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (setErr) {
              logger.debug("Failed to set session from backend tokens.");
            } else if (data.session && !cancelled) {
              setSession(data.session);
              setUser(data.session.user);
            }
          } catch (_err) {
            // No backend session (not logged in or backend unreachable) — that's fine
            logger.debug("No backend session to restore.");
          }
        });
      } catch (_err) {
        logger.error("Error restoring session.");
      } finally {
        if (!cancelled) {
          setIsInitializing(false);
        }
      }
    };

    void restoreSession();

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled) return;
      // Explicit auth operations install sessions after backend persistence. A
      // local SDK sign-out must never delete a newer backend session.
      if (event === "SIGNED_OUT") {
        setSession(null);
        setUser(null);
        setUserInfo(null);
        setIsLoadingUserInfo(false);
        setPostLoginSyncRequest(null);
        clearProcessedAuthCodes();
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [supabase, runAuthTransition, setSession, clearProcessedAuthCodes, isAuthenticated]);

  // Listen for deep link events on desktop
  useEffect(() => {
    if (!isDesktop) return;

    let unlistenFn: (() => Promise<void>) | undefined;
    let cancelled = false;

    const setupDeepLinkListener = async () => {
      try {
        unlistenFn = await listenDeepLink<string>((event) => {
          if (cancelled) return;
          const url = event.payload;

          const authPayload = parseConfiguredAuthCallbackUrl(url);
          if (authPayload) {
            void handleAuthCallback(url);
          }
        });
      } catch (_err) {
        logger.error("Failed to set up deep link listener.");
      }

      try {
        const currentUrls = await getCurrentDeepLinks();
        if (cancelled) return;

        for (const url of currentUrls) {
          if (parseConfiguredAuthCallbackUrl(url)) {
            void handleAuthCallback(url);
          }
        }
      } catch (_err) {
        logger.error("Failed to read startup deep links.");
      }
    };

    void setupDeepLinkListener();

    return () => {
      cancelled = true;
      void unlistenFn?.();
    };
  }, [handleAuthCallback]);

  // Handle auth callback on mount (webview redirect callback)
  // This works for both web and desktop (when OAuth happens in webview)
  useEffect(() => {
    const currentUrl = window.location.href;
    if (parseConfiguredAuthCallbackUrl(currentUrl)) {
      void handleAuthCallback(currentUrl);
      // Clean up URL after handling
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [handleAuthCallback]);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      setIsLoading(true);
      setError(null);

      try {
        await runAuthTransition(async () => {
          const { data, error: signInError } = await supabase.auth.signInWithPassword({
            email,
            password,
          });

          if (signInError) {
            throw signInError;
          }

          if (data.session) {
            // Store tokens BEFORE setting session to avoid race condition
            await storeTokens(data.session);
            setSession(data.session);
            setUser(data.session.user);
            requestPostLoginSync("email-sign-in", data.session);
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : t("connect:authErrors.signInFailed");
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [runAuthTransition, setSession, supabase, storeTokens, requestPostLoginSync, t],
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string) => {
      setIsLoading(true);
      setError(null);

      try {
        await runAuthTransition(async () => {
          const { data, error: signUpError } = await supabase.auth.signUp({
            email,
            password,
          });

          if (signUpError) {
            throw signUpError;
          }

          // If email confirmation is not required, user will be signed in
          if (data.session) {
            // Store tokens BEFORE setting session to avoid race condition
            await storeTokens(data.session);
            setSession(data.session);
            setUser(data.session.user);
            requestPostLoginSync("email-sign-up", data.session);
          } else if (data.user && !data.session) {
            // Email confirmation required
            setError(t("connect:authErrors.confirmEmail"));
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : t("connect:authErrors.signUpFailed");
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [runAuthTransition, setSession, supabase, storeTokens, requestPostLoginSync, t],
  );

  const signInWithOAuth = useCallback(
    async (provider: "google" | "apple" | "github") => {
      setIsLoading(true);
      setError(null);

      try {
        const isTauri = isDesktop;
        const platform = isTauri ? await getPlatform() : null;
        const isMobile = platform?.is_mobile ?? false;

        // Mobile: use native web auth with a deep link callback because Google blocks OAuth
        // from embedded webviews.
        const useNativeMobileWebAuth = isTauri && isMobile;

        // Determine redirect URL based on platform
        // Native mobile web auth always needs a deep link URL (works in dev and prod)
        // Desktop prod uses hosted callback → deep link (can't use in dev - URL scheme not registered)
        // Dev mode uses webview redirect (simpler, no deep link registration needed)
        const redirectUrl = useNativeMobileWebAuth
          ? DESKTOP_DEEP_LINK_URL // Mobile: direct custom scheme, captured by native web auth
          : isTauri && import.meta.env.PROD
            ? HOSTED_OAUTH_CALLBACK_URL // Desktop: bounce page → wealthfolio://
            : getWebRedirectUrl(); // Web or dev mode

        const useSystemBrowser = isTauri && import.meta.env.PROD && !useNativeMobileWebAuth;
        const queryParams =
          provider === "google"
            ? {
                // Forces the account chooser instead of silently reusing the last Google session.
                prompt: "select_account",
              }
            : undefined;

        const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            skipBrowserRedirect: useSystemBrowser || useNativeMobileWebAuth,
            redirectTo: redirectUrl,
            queryParams,
          },
        });

        if (oauthError) {
          throw oauthError;
        }

        // Mobile: use the native web-auth plugin instead of the embedded webview.
        if (useNativeMobileWebAuth && data.url) {
          try {
            const result = await authenticateWithNativeWebAuth({
              url: data.url,
              callbackScheme: "wealthfolio",
            });

            // The plugin returns the full callback URL with the auth code
            if (result?.callbackUrl) {
              await handleAuthCallback(result.callbackUrl);
            } else {
              logger.error("No callbackUrl in native web auth result");
            }
          } catch (authErr) {
            // User cancelled or auth failed
            const message =
              authErr instanceof Error ? authErr.message : "Authentication was cancelled";
            logger.error(`Native web auth error: ${message}`);
            // Don't throw if user just cancelled
            if (!message.toLowerCase().includes("cancel")) {
              throw authErr;
            }
            logger.info("OAuth authentication was cancelled by user");
          }
          return;
        }

        // Desktop: Open the OAuth URL in the system browser
        if (useSystemBrowser && data.url) {
          await openUrlInBrowser(data.url);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t("connect:authErrors.oauthFailed");
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [supabase, handleAuthCallback, t],
  );

  const signInWithMagicLink = useCallback(
    async (email: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const isTauri = isDesktop;
        const platform = isTauri ? await getPlatform() : null;
        const isMobile = platform?.is_mobile ?? false;

        const redirectUrl =
          isTauri && import.meta.env.PROD
            ? isMobile
              ? HOSTED_OAUTH_CALLBACK_URL // Mobile: bounce page → wealthfolio://
              : DESKTOP_DEEP_LINK_URL // Desktop: direct wealthfolio:// from email client
            : getWebRedirectUrl();

        const { error: otpError } = await supabase.auth.signInWithOtp({
          email,
          options: {
            // Redirect URL for when user clicks the magic link
            emailRedirectTo: redirectUrl,
          },
        });

        if (otpError) {
          throw otpError;
        }

        // Don't throw error - magic link sent successfully
        // The UI will handle showing success message
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("connect:authErrors.magicLinkFailed");
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [supabase, t],
  );

  const verifyOtp = useCallback(
    async (email: string, token: string) => {
      setIsLoading(true);
      setError(null);

      try {
        await runAuthTransition(async () => {
          const { data, error: verifyError } = await supabase.auth.verifyOtp({
            email,
            token,
            type: "email",
          });

          if (verifyError) {
            throw verifyError;
          }

          if (data.session) {
            // Store tokens BEFORE setting session to avoid race condition
            await storeTokens(data.session);
            setSession(data.session);
            setUser(data.session.user);
            requestPostLoginSync("otp", data.session);
          }
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("connect:authErrors.invalidVerificationCode");
        setError(message);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [runAuthTransition, setSession, supabase, storeTokens, requestPostLoginSync, t],
  );

  const clearLocalSession = useCallback(() => {
    setSession(null);
    setUser(null);
    setUserInfo(null);
    setPostLoginSyncRequest(null);
    setIsLoadingUserInfo(false);
    clearProcessedAuthCodes();
  }, [setSession, clearProcessedAuthCodes]);

  const signOut = useCallback(async () => {
    await runAuthTransition(async () => {
      setIsLoading(true);
      setError(null);
      clearLocalSession();
      try {
        // Cleanup is local and independent of the remote auth service's availability.
        await clearSyncSession();
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) logger.warn(`Server-side sign out failed: ${signOutError.message}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("connect:authErrors.signOutFailed"));
        throw err;
      } finally {
        setIsLoading(false);
      }
    });
  }, [runAuthTransition, clearLocalSession, supabase, t]);

  // Only a missing backend auth session signs the user out; subscription access is separate.
  const reconcileSession = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    if (!sessionRef.current) return;
    await runAuthTransition(async () => {
      if (generation !== sessionGenerationRef.current) return;
      const status = await getSyncSessionStatus();
      if (generation !== sessionGenerationRef.current || status.isConfigured) return;
      clearLocalSession();
      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) logger.warn(`Local session sign out failed: ${signOutError.message}`);
    });
  }, [runAuthTransition, clearLocalSession, supabase]);

  const clearError = useCallback(() => setError(null), []);

  // Fetch user info from the cloud API
  const refetchUserInfo = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const request = ++userInfoRequestRef.current;
    const isCurrent = () =>
      generation === sessionGenerationRef.current && request === userInfoRequestRef.current;
    if (!sessionRef.current) return;
    setIsLoadingUserInfo(true);
    setError(null);
    try {
      await reconcileSession();
      if (!isCurrent()) return;
      const info = await getUserInfo();
      if (!isCurrent()) return;
      const access = hasBrokerSync(info)
        ? "broker"
        : isSubscriptionStatusActive(info.team?.subscription_status)
          ? "device"
          : "none";
      if (syncAccessRef.current !== access && access !== "none" && sessionRef.current) {
        requestPostLoginSync("subscription-activated", sessionRef.current);
      }
      syncAccessRef.current = access;
      setUserInfo(info);
    } catch (err) {
      if (!isCurrent()) return;
      logger.error("Failed to fetch user info from API.");
      setUserInfo(null);
      setError(err instanceof Error ? err.message : t("connect:authErrors.fetchUserInfoFailed"));
    } finally {
      if (isCurrent()) setIsLoadingUserInfo(false);
    }
  }, [reconcileSession, requestPostLoginSync, t]);

  useEffect(() => {
    if (session) void refetchUserInfo();
    else setUserInfo(null);
    return () => {
      userInfoRequestRef.current += 1;
    };
  }, [session, refetchUserInfo]);

  useEffect(() => {
    if (!session) return;
    const handleFocus = () => void refetchUserInfo();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refetchUserInfo();
    };
    const interval = window.setInterval(handleFocus, 60_000);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [session, refetchUserInfo]);

  // Extract team_id from user's app_metadata
  const teamId = useMemo(() => {
    return (user?.app_metadata?.team_id as string | undefined) ?? null;
  }, [user]);

  const value = useMemo<WealthfolioConnectContextValue>(
    () => ({
      isEnabled: true,
      isConnected: !!session,
      isInitializing,
      isLoading,
      isLoadingUserInfo,
      user,
      session,
      teamId,
      userInfo,
      postLoginSyncRequest,
      error,
      signInWithEmail,
      signUpWithEmail,
      signInWithOAuth,
      signInWithMagicLink,
      verifyOtp,
      signOut,
      clearError,
      refetchUserInfo,
      consumePostLoginSyncRequest,
    }),
    [
      session,
      isInitializing,
      isLoading,
      isLoadingUserInfo,
      user,
      teamId,
      userInfo,
      postLoginSyncRequest,
      error,
      signInWithEmail,
      signUpWithEmail,
      signInWithOAuth,
      signInWithMagicLink,
      verifyOtp,
      signOut,
      clearError,
      refetchUserInfo,
      consumePostLoginSyncRequest,
    ],
  );

  return (
    <WealthfolioConnectContext.Provider value={value}>
      {children}
    </WealthfolioConnectContext.Provider>
  );
}

// Main provider that chooses enabled/disabled path based on configuration
export function WealthfolioConnectProvider({ children }: { children: ReactNode }) {
  const [isCapabilityCheckComplete, setIsCapabilityCheckComplete] = useState(!CONNECT_ENABLED);
  const [isCloudSyncAvailable, setIsCloudSyncAvailable] = useState(false);

  useEffect(() => {
    if (!CONNECT_ENABLED) return;

    let cancelled = false;

    void getPlatform()
      .then((platform) => {
        if (cancelled) return;
        setIsCloudSyncAvailable(
          platform.capabilities?.cloud_sync ?? platform.capabilities?.connect_sync ?? true,
        );
      })
      .catch(() => {
        // Fall back to enabled on detection errors to preserve current behavior.
        if (cancelled) return;
        setIsCloudSyncAvailable(true);
      })
      .finally(() => {
        if (cancelled) return;
        setIsCapabilityCheckComplete(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!isCapabilityCheckComplete) {
    return (
      <WealthfolioConnectContext.Provider
        value={{
          ...disabledContextValue,
          isEnabled: true,
          isInitializing: true,
        }}
      >
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  if (!CONNECT_ENABLED || !isCloudSyncAvailable) {
    return (
      <WealthfolioConnectContext.Provider value={disabledContextValue}>
        {children}
      </WealthfolioConnectContext.Provider>
    );
  }

  return <EnabledWealthfolioConnectProvider>{children}</EnabledWealthfolioConnectProvider>;
}

export const useWealthfolioConnect = () => {
  const ctx = useContext(WealthfolioConnectContext);
  if (!ctx) {
    throw new Error("useWealthfolioConnect must be used within a WealthfolioConnectProvider");
  }
  return ctx;
};
