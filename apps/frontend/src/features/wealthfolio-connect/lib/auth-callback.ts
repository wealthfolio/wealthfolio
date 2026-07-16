export type AuthCallbackPayload =
  | { type: "code"; code: string }
  | { type: "error"; message: string };

interface AuthCallbackParseOptions {
  appOrigin?: string | null;
  hostedCallbackUrl?: string | null;
}

function currentOrigin(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.origin;
}

function isConfiguredHostedCallbackUrl(url: URL, hostedCallbackUrl: string | null): boolean {
  if (!hostedCallbackUrl) return false;

  try {
    const callbackUrl = new URL(hostedCallbackUrl);
    return url.origin === callbackUrl.origin && url.pathname === callbackUrl.pathname;
  } catch {
    return false;
  }
}

function isAllowedAuthCallbackUrl(
  url: URL,
  appOrigin: string | null,
  hostedCallbackUrl: string | null,
): boolean {
  if (url.protocol === "wealthfolio:" && url.hostname === "auth" && url.pathname === "/callback") {
    return true;
  }

  if (isConfiguredHostedCallbackUrl(url, hostedCallbackUrl)) {
    return true;
  }

  return appOrigin !== null && url.origin === appOrigin && url.pathname === "/auth/callback";
}

export function parseAuthCallbackUrl(
  url: string,
  options: AuthCallbackParseOptions = {},
): AuthCallbackPayload | null {
  try {
    const urlObj = new URL(url);
    const appOrigin = options.appOrigin === undefined ? currentOrigin() : options.appOrigin;
    if (!isAllowedAuthCallbackUrl(urlObj, appOrigin, options.hostedCallbackUrl ?? null)) {
      return null;
    }

    const hashParams = new URLSearchParams(urlObj.hash.substring(1));

    const error =
      urlObj.searchParams.get("error_description") ??
      urlObj.searchParams.get("error") ??
      hashParams.get("error_description") ??
      hashParams.get("error");
    if (error) {
      return { type: "error", message: error };
    }

    const code = urlObj.searchParams.get("code");
    if (code) {
      return { type: "code", code };
    }

    const hasAccessToken =
      hashParams.has("access_token") || urlObj.searchParams.has("access_token");
    if (hasAccessToken) {
      return {
        type: "error",
        message:
          "Unexpected token callback (access_token). This app expects Auth Code + PKCE; ensure Supabase is configured for PKCE and your hosted callback forwards the ?code=... parameter.",
      };
    }

    return null;
  } catch {
    return null;
  }
}
