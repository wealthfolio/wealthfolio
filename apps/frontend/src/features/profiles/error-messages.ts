import type { TFunction } from "i18next";

/** Keep diagnostic codes in state; render only curated, translated copy. */
export function profileErrorMessage(error: unknown, t: TFunction<"common">): string {
  if (error == null || error === "") return "";
  if (!(error instanceof Error) && typeof error !== "string") return t("profiles.errors.generic");
  const raw = error instanceof Error ? error.message : error;
  if (!raw) return "";
  const code = /\b(?:PROFILE_[A-Z_]+|CONNECT_[A-Z_]+)\b/.exec(raw)?.[0];
  switch (code) {
    case "PROFILE_COOLDOWN": {
      const seconds = /PROFILE_COOLDOWN:\s*Try again in (\d+) seconds?\b/.exec(raw)?.[1];
      return seconds
        ? t("profiles.errors.cooldown", { count: Number(seconds) })
        : t("profiles.errors.cooldownUnknown");
    }
    case "PROFILE_ORIGIN_REJECTED":
      return t("profiles.errors.originRejected");
    case "PROFILE_LOCKED":
      return t("profiles.errors.locked");
    case "PROFILE_STARTUP_FAILED":
      return t("profiles.errors.startupFailed");
    case "PROFILE_SESSION_INTERRUPTED":
      return t("profiles.errors.sessionInterrupted");
    case "PROFILE_STALE":
      return t("profiles.errors.stale");
    case "PROFILE_NOT_FOUND":
      return t("profiles.errors.notFound");
    case "PROFILE_PASSWORD_INVALID":
      return t("profiles.errors.incorrectProof");
    case "PROFILE_COPY_FAILED":
      return t("profiles.errors.copy");
    case "PROFILE_PASSWORD_LENGTH":
      return t("profiles.errors.passwordLength", { min: 4, max: 128 });
    case "PROFILE_INVALID":
      if (raw.includes("profile name of 1–60")) return t("profiles.errors.name");
      if (raw.includes("bundled avatar")) return t("profiles.errors.avatar");
      if (raw.includes("confirm deletion")) return t("profiles.errors.confirmDeletion");
      if (raw.includes("characters for your password"))
        return t("profiles.errors.passwordLength", { min: 4, max: 128 });
      return t("profiles.errors.invalid");
    case "PROFILE_UNAVAILABLE":
      if (raw.includes("Another Wealthfolio process")) return t("profiles.errors.inUse");
      if (raw.includes("credential store")) return t("profiles.errors.credentials");
      return t("profiles.errors.unavailable");
    case "CONNECT_PROFILE_EXISTS":
      return t("profiles.errors.duplicateAccount");
    case "CONNECT_IDENTITY_MISMATCH":
      return t("profiles.errors.accountMismatch");
    case "CONNECT_TEAM_CHANGED":
      return t("profiles.errors.teamChanged");
    case "CONNECT_REBIND_REQUIRED":
      return t("profiles.errors.rebind");
    default:
      return t("profiles.errors.generic");
  }
}

/** Map profile failures while preserving unrelated feature messages. */
export function profileAwareErrorMessage(message: string, t: TFunction<"common">): string {
  if (/\b(?:PROFILE_[A-Z_]+|CONNECT_[A-Z_]+)\b/.test(message)) {
    return profileErrorMessage(message, t);
  }
  if (
    message.includes("Profile operations are running") ||
    message.includes("Connect account change is in progress")
  ) {
    return t("profiles.errors.busy");
  }
  if (message.includes("No pending profile login")) return t("profiles.errors.stale");
  if (
    message.includes("Profile runtime is unavailable") ||
    message.includes("Profile database is unavailable")
  ) {
    return t("profiles.errors.unavailable");
  }
  return message;
}
