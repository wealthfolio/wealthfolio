import { revokeProfileSession, hasProfileSession } from "@/features/profiles/session";
import { isWeb } from "@/adapters";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { reloadApplication } from "@/lib/reload-application";
import { setUnauthorizedHandler, type AuthFailure } from "@/lib/auth-token";
import { useQueryClient } from "@tanstack/react-query";
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
  statusError: boolean;
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

/**
 * One-shot per-tab guard for the automatic SSO redirect. Armed before every
 * automatic redirect and on logout; cleared only once `/auth/me` confirms a
 * session. While armed, the login page suppresses further automatic redirects
 * (the manual SSO button is unaffected), so a callback that fails to establish
 * a session — no cookie, `/auth/me` rejecting — lands on the login page once
 * instead of looping through the IdP.
 */
export const SSO_REDIRECT_GUARD_STORAGE_KEY = "wf.sso-redirect-guard";

function clearSsoRedirectGuard() {
  try {
    window.sessionStorage.removeItem(SSO_REDIRECT_GUARD_STORAGE_KEY);
  } catch {
    // noop – sessionStorage may be unavailable
  }
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const invalidateSession = useCallback(() => {
    // AuthGate can unmount ProfileShell. Revoke and clear here even without its listener.
    // A first-time sign-in has no profile grant to revoke.
    if (hasProfileSession()) revokeProfileSession();
    void queries.cancelQueries();
    queries.clear();
  }, [queries]);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [statusLoading, setStatusLoading] = useState(isWeb);
  const [statusError, setStatusError] = useState(false);
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
        if (cancelled) return;
        if (response.status === 401) invalidateSession();
        if (!response.ok) throw new Error("Authentication status check failed");
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("requiresPassword" in data) ||
          typeof data.requiresPassword !== "boolean" ||
          !("oidcEnabled" in data) ||
          typeof data.oidcEnabled !== "boolean"
        ) {
          throw new Error("Invalid authentication status");
        }
        if (cancelled) return;
        setRequiresPassword(data.requiresPassword);
        setOidcEnabled(data.oidcEnabled);

        if (data.requiresPassword || data.oidcEnabled) {
          const meRes = await fetch("/api/v1/auth/me", {
            credentials: "same-origin",
          });
          if (cancelled) return;
          if (meRes.status === 401) {
            invalidateSession();
            setCookieSession(false);
            return;
          }
          if (!meRes.ok) throw new Error("Authentication session check failed");
          const session: unknown = await meRes.json();
          if (
            !session ||
            typeof session !== "object" ||
            !("authenticated" in session) ||
            session.authenticated !== true
          ) {
            throw new Error("Invalid authentication session");
          }
          if (!cancelled) {
            clearSsoRedirectGuard();
            setCookieSession(true);
          }
        }
      } catch {
        if (!cancelled) setStatusError(true);
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [invalidateSession]);

  useEffect(() => {
    const handler = (reason: AuthFailure) => {
      if (reason === "expired") invalidateSession();
      const hadSession = cookieSessionRef.current;
      setCookieSession(false);
      if (reason === "signIn" || (!requiresPassword && !oidcEnabled)) {
        setStatusError(true);
      }
      if (hadSession && reason === "expired") {
        setLoginError(t("auth:context.sessionExpired"));
      }
    };
    setUnauthorizedHandler(handler);
    return () => {
      setUnauthorizedHandler(null);
    };
  }, [requiresPassword, oidcEnabled, t, invalidateSession]);

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
    invalidateSession();
    if (isWeb) {
      try {
        window.sessionStorage.setItem(SSO_REDIRECT_GUARD_STORAGE_KEY, "1");
      } catch {
        // noop – sessionStorage may be unavailable
      }
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
  }, [oidcEnabled, invalidateSession]);

  const clearError = useCallback(() => setLoginError(null), []);

  const requiresAuth = requiresPassword || oidcEnabled;

  const value = useMemo<AuthContextValue>(
    () => ({
      requiresAuth,
      requiresPassword,
      oidcEnabled,
      isAuthenticated: !statusLoading && !statusError && (!requiresAuth || cookieSession),
      statusLoading,
      statusError,
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
      statusError,
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
  const { requiresAuth, isAuthenticated, statusLoading, statusError } = useAuth();

  if (statusLoading) {
    return (
      <div className="bg-background text-muted-foreground flex min-h-screen items-center justify-center">
        {t("auth:context.checkingAuthentication")}
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p role="alert" className="text-muted-foreground">
          {t("common:profiles.errors.generic")}
        </p>
        <Button onClick={() => reloadApplication()}>{t("common:retry")}</Button>
      </div>
    );
  }

  if (requiresAuth && !isAuthenticated) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
