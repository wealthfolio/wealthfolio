import type { User } from "@supabase/supabase-js";

/** Two-factor (Supabase MFA) settings live in the Connect dashboard, not in the app. */
export const MFA_SETTINGS_PATH = "/settings/security";

/** "Not now" on the two-factor nudge hides it for this long. */
export const MFA_NUDGE_SNOOZE_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The cloud API rejects an aal1 session of a 2FA account with
 * 403 `{ "code": "MFA_REQUIRED" }`. The backends pass the code through in the
 * error text ("API error 403: MFA_REQUIRED: ...").
 */
export function isMfaRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return !!message && /\bMFA_REQUIRED\b/.test(message);
}

/** Supabase rejects a wrong or stale TOTP code with one of these error codes. */
const REJECTED_CODE_ERRORS = new Set([
  "mfa_verification_failed",
  "mfa_verification_rejected",
  "mfa_challenge_expired",
]);

export function isMfaCodeRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && REJECTED_CODE_ERRORS.has(code);
}

export function hasVerifiedTotpFactor(user: User | null | undefined): boolean {
  return !!user?.factors?.some(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );
}

/**
 * The auth server no longer has the saved login: it was signed out elsewhere,
 * revoked, or deleted because two-factor authentication was turned on (Supabase
 * removes a user's other aal1 sessions when a code is verified). Entering a code
 * can't revive it; the user signs in again. The backend reports its own failed
 * refresh as CONNECT_SESSION_EXPIRED (crates/connect token_lifecycle.rs).
 */
export function isSavedLoginGone(error: unknown): boolean {
  if (error && typeof error === "object") {
    const { name, code } = error as { name?: unknown; code?: unknown };
    if (
      name === "AuthSessionMissingError" ||
      code === "session_not_found" ||
      code === "refresh_token_not_found"
    ) {
      return true;
    }
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return !!message && /\bCONNECT_SESSION_EXPIRED\b/.test(message);
}
