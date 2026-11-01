import i18n from "i18next";
import type { SyncStatus } from "../types";

export function getBrokerSyncRunFailedMessage(): string {
  return i18n.t("connect:syncMessages.runFailed");
}

export function getBrokerSyncRunNeedsReviewMessage(): string {
  return i18n.t("connect:syncMessages.runNeedsReview");
}

function getBrokerSyncAccountFailedMessage(): string {
  return i18n.t("connect:syncMessages.accountFailed");
}

function getBrokerSyncAccountNeedsReviewMessage(): string {
  return i18n.t("connect:syncMessages.accountNeedsReview");
}

function getHoldingsSyncedActivityAttentionMessage(): string {
  return i18n.t("connect:syncMessages.holdingsSynced");
}

function getHoldingsDeferredActivityAttentionMessage(): string {
  return i18n.t("connect:syncMessages.holdingsDeferred");
}

/** Explains a known partial failure; null when the error has no specific message. */
export function getSpecificBrokerSyncIssueMessage(lastError?: string | null): string | null {
  const normalizedError = lastError?.toLowerCase() ?? "";

  if (normalizedError.startsWith("holdings synced")) {
    return getHoldingsSyncedActivityAttentionMessage();
  }

  if (normalizedError.startsWith("holdings sync deferred")) {
    return getHoldingsDeferredActivityAttentionMessage();
  }

  return null;
}

export function getBrokerSyncIssueMessage(
  syncStatus: SyncStatus,
  lastError?: string | null,
): string {
  return (
    getSpecificBrokerSyncIssueMessage(lastError) ??
    (syncStatus === "FAILED"
      ? getBrokerSyncAccountFailedMessage()
      : getBrokerSyncAccountNeedsReviewMessage())
  );
}
