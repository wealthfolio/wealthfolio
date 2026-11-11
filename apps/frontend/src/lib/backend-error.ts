import i18n, { type TFunction } from "i18next";
import { LOAN_ERROR_KEYS } from "./loan-error-codes";

export const CONNECT_REBIND_REQUIRED = "CONNECT_REBIND_REQUIRED";
export const BACKUP_REAUTHENTICATION_REQUIRED = "BACKUP_REAUTHENTICATION_REQUIRED";
export const BACKUP_MANUAL_LIMIT = "BACKUP_MANUAL_LIMIT";

// Backend identifiers are an API contract; translation keys belong to the UI.
const ERROR_KEYS: Record<string, string> = {
  internal_error: "common:backendErrors.internal",
  invalid_input: "common:backendErrors.invalidInput",
  conflict: "common:backendErrors.conflict",
  not_found: "common:backendErrors.notFound",
  unauthorized: "common:backendErrors.unauthorized",
  forbidden: "common:backendErrors.forbidden",
  not_implemented: "common:backendErrors.unavailable",
  provider_key_missing: "common:backendErrors.providerKeyMissing",
  provider_unknown: "common:backendErrors.providerUnknown",
  provider_unavailable: "common:backendErrors.providerUnavailable",
  INVALID_SNAPSHOT_DATE: "account:snapshot.invalid_date_update_desc",
  ASSET_IDENTITY_CONFLICT: "asset:editSheet.identity_conflict",
  [CONNECT_REBIND_REQUIRED]: "common:profiles.errors.rebind",
  [BACKUP_REAUTHENTICATION_REQUIRED]: "settings:cloud_backup_reauth",
  [BACKUP_MANUAL_LIMIT]: "settings:cloud_backup_manual_limit",
  PROFILE_BUSY: "common:profiles.errors.busy",
  custom_provider_code_reserved: "common:backendErrors.customProviderCodeReserved",
  custom_provider_in_use: "common:backendErrors.customProviderInUse",
  ADDON_MANIFEST_MISSING: "common:backendErrors.addonManifestMissing",
  ADDON_MAIN_FILE_MISSING: "common:backendErrors.addonMainFileMissing",
  ADDON_NEEDS_NEWER_VERSION: "common:backendErrors.addonNeedsNewerVersion",
  QUOTE_CURRENCY_REQUIRED: "common:backendErrors.quoteCurrencyRequired",
  SUBSCRIPTION_REQUIRED: "connect:subscription.syncPausedDescription",
  PLAN_UPGRADE_REQUIRED: "connect:upgrade.title",
  RATE_LIMITED: "common:backendErrors.rateLimited",
};

/** Retains a code, never the server's arbitrary message, cause, or parameters. */
export class BackendError extends Error {
  readonly errorCode: string;
  readonly outcomeUnknown?: boolean;

  constructor(code: string, outcomeUnknown?: boolean) {
    // Keep existing loan form handling of the closed set of stable refusals.
    super(Object.hasOwn(LOAN_ERROR_KEYS, code) ? code : "The operation could not be completed.");
    this.name = "BackendError";
    this.outcomeUnknown = outcomeUnknown;
    this.errorCode =
      Object.hasOwn(ERROR_KEYS, code) || Object.hasOwn(LOAN_ERROR_KEYS, code)
        ? code
        : "internal_error";
    // Existing views read Error.message. Resolve that compatibility property on
    // access rather than caching a translation in React Query's error state.
    Object.defineProperty(this, "message", {
      configurable: true,
      get: () =>
        Object.hasOwn(LOAN_ERROR_KEYS, this.errorCode)
          ? this.errorCode
          : i18n.isInitialized
            ? backendErrorText(this, i18n.t)
            : "The operation could not be completed.",
    });
  }

  // Views show errors with String(error); keep the class name out of that text.
  override toString(): string {
    return this.message;
  }
}

/** Normalize both HTTP error envelopes and Tauri CommandError payloads. */
export function backendError(cause: unknown): BackendError | undefined {
  if (cause instanceof BackendError) return cause;
  if (typeof cause === "string") {
    if (
      cause.split(":")[0] === "PROFILE_BUSY" ||
      cause === "Profile operations are running. Wait for them to finish and try again." ||
      cause === "Connect account change is in progress. Try again."
    ) {
      return new BackendError("PROFILE_BUSY");
    }
    // Legacy desktop backup commands stringify DeviceSyncError::ApiError.
    const backupCode =
      /^(?:API error \(\d{3}\): )?(BACKUP_REAUTHENTICATION_REQUIRED|BACKUP_MANUAL_LIMIT)(?::|$)/.exec(
        cause,
      )?.[1];
    if (backupCode) return new BackendError(backupCode);
  }
  if (typeof cause === "string" && cause.split(":")[0] === CONNECT_REBIND_REQUIRED) {
    return new BackendError(CONNECT_REBIND_REQUIRED);
  }
  if (
    typeof cause === "string" &&
    (Object.hasOwn(ERROR_KEYS, cause) || Object.hasOwn(LOAN_ERROR_KEYS, cause))
  )
    return new BackendError(cause);
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("ServiceError" in cause) return backendError(cause.ServiceError);
  const code =
    "errorCode" in cause && typeof cause.errorCode === "string" ? cause.errorCode : undefined;
  const outcomeUnknown =
    "outcomeUnknown" in cause && typeof cause.outcomeUnknown === "boolean"
      ? cause.outcomeUnknown
      : undefined;
  if (code !== undefined || outcomeUnknown !== undefined) {
    return new BackendError(code ?? "internal_error", outcomeUnknown);
  }
  // Older desktop commands and local callers may still reject with code-only Errors.
  if (cause instanceof Error) return backendError(cause.message);
  return undefined;
}

/** Resolve at display time so changing language also changes visible errors. */
export function backendErrorText(cause: unknown, t: TFunction): string {
  const error = backendError(cause);
  const code = error?.errorCode ?? "internal_error";
  return t(ERROR_KEYS[code] ?? LOAN_ERROR_KEYS[code] ?? ERROR_KEYS.internal_error);
}
