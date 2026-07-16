import { isWeb } from "@/adapters";
import { setUnauthorizedHandler } from "@/lib/auth-token";
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
import type { TFunction } from "i18next";

interface AuthContextValue {
  requiresAuth: boolean;
  requiresPassword: boolean;
  oidcEnabled: boolean;
  isAuthenticated: boolean;
  statusLoading: boolean;
  loginLoading: boolean;
  loginError: string | null;
  login: (password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

/** Translation keys for `?oidc_error=` codes set by the server callback. */
const OIDC_ERROR_KEYS: Record<string, string> = {
  oidc_forbidden: "auth:context.oidcErrors.forbidden",
  oidc_provider_error: "auth:context.oidcErrors.providerError",
  oidc_expired: "auth:context.oidcErrors.expired",
  oidc_state_mismatch: "auth:context.oidcErrors.stateMismatch",
  oidc_exchange_failed: "auth:context.oidcErrors.exchangeFailed",
  oidc_invalid_token: "auth:context.oidcErrors.invalidToken",
  oidc_no_id_token: "auth:context.oidcErrors.noIdToken",
  oidc_missing_params: "auth:context.oidcErrors.missingParams",
  oidc_not_configured: "auth:context.oidcErrors.notConfigured",
  oidc_internal: "auth:context.oidcErrors.internal",
};

/** Resolve a server OIDC error code to a localized message. */
function resolveOidcError(t: TFunction, code: string): string {
  const key = OIDC_ERROR_KEYS[code];
  return key ? t(key) : t("auth:context.oidcErrors.generic");
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [statusLoading, setStatusLoading] = useState(isWeb);
  const [cookieSession, setCookieSession] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const cookieSessionRef = useRef(false);

  useEffect(() => {
    cookieSessionRef.current = cookieSession;
  }, [cookieSession]);

  useEffect(() => {
    if (!isWeb) {
      setStatusLoading(false);
      return;
    }
    let cancelled = false;
    const loadStatus = async () => {
      try {
        const response = await fetch("/api/v1/auth/status", {
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`Failed to check authentication status: ${response.status}`);
        }
        const data = (await response.json()) as {
          requiresPassword: boolean;
          oidcEnabled: boolean;
        };
        if (cancelled) return;
        const needsPassword = Boolean(data?.requiresPassword);
        const needsOidc = Boolean(data?.oidcEnabled);
        setRequiresPassword(needsPassword);
        setOidcEnabled(needsOidc);
        const needsAuth = needsPassword || needsOidc;

        // If auth is required, check if we have a valid cookie session
        if (needsAuth) {
          try {
            const meRes = await fetch("/api/v1/auth/me", {
              credentials: "same-origin",
            });
            if (meRes.ok && !cancelled) {
              setCookieSession(true);
            }
          } catch {
            // No valid session, user will need to log in
          }
        }
      } catch (error) {
        console.error("Failed to load authentication status", error);
        if (!cancelled) {
          setRequiresPassword(false);
          setOidcEnabled(false);
        }
      } finally {
        if (!cancelled) {
          setStatusLoading(false);
        }
      }
    };

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      const hadSession = cookieSessionRef.current;
      setCookieSession(false);
      if (hadSession) {
        setLoginError(t("auth:context.sessionExpired"));
      }
    };
    setUnauthorizedHandler(handler);
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [t]);

  // Surface OIDC callback errors passed back as `?oidc_error=<code>`.
  useEffect(() => {
    if (!isWeb) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("oidc_error");
    if (!code) return;
    setLoginError(resolveOidcError(t, code));
    params.delete("oidc_error");
    const query = params.toString();
    const newUrl = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }, [t]);

  const login = useCallback(
    async (password: string) => {
      setLoginLoading(true);
      setLoginError(null);
      try {
        const response = await fetch("/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          credentials: "same-origin",
        });
        if (!response.ok) {
          if (response.status === 404) {
            setRequiresPassword(false);
          }
          let message = t("auth:context.invalidPassword");
          try {
            const body = await response.json();
            message = body?.message ?? message;
          } catch (parseError) {
            console.error("Failed to parse login error", parseError);
          }
          throw new Error(message);
        }
        // Cookie is set by the server via Set-Cookie header
        setCookieSession(true);
        setLoginError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("auth:context.loginFailed");
        setCookieSession(false);
        setLoginError(message);
        throw error;
      } finally {
        setLoginLoading(false);
      }
    },
    [t],
  );

  const logout = useCallback(() => {
    if (isWeb) {
      if (oidcEnabled) {
        // Full-page navigation: the server clears the session (and OIDC id-token
        // cookie) and may redirect to the IdP for single logout.
        window.location.href = "/api/v1/auth/oidc/logout";
        return;
      }
      // Clear server-side cookie session
      fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
    }
    setCookieSession(false);
    setLoginError(null);
  }, [oidcEnabled]);

  const clearError = useCallback(() => setLoginError(null), []);

  const requiresAuth = requiresPassword || oidcEnabled;

  const value = useMemo<AuthContextValue>(
    () => ({
      requiresAuth,
      requiresPassword,
      oidcEnabled,
      isAuthenticated: !requiresAuth || cookieSession,
      statusLoading,
      loginLoading,
      loginError,
      login,
      logout,
      clearError,
    }),
    [
      requiresAuth,
      requiresPassword,
      oidcEnabled,
      cookieSession,
      statusLoading,
      loginLoading,
      loginError,
      login,
      logout,
      clearError,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
};

export function AuthGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const { t } = useTranslation();
  const { requiresAuth, isAuthenticated, statusLoading } = useAuth();

  if (statusLoading) {
    return (
      <div className="bg-background text-muted-foreground flex min-h-screen items-center justify-center">
        {t("auth:context.checkingAuthentication")}
      </div>
    );
  }

  if (requiresAuth && !isAuthenticated) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
