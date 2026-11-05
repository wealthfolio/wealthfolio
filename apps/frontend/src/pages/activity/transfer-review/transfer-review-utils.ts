import type { TFunction } from "i18next";

import { ActivityType } from "@/lib/constants";
import {
  getEffectiveType,
  type Activity,
  type TransferMatchCandidate,
  type TransferMatchReason,
} from "@/lib/types";

/** Pairs per `linkTransferPairs` call; the core refuses more. */
export const MAX_PAIRS_PER_CALL = 500;

const REASON_KEYS: Record<TransferMatchReason, string | null> = {
  same_asset: "activity:transfer_match.same_asset",
  same_quantity: "activity:transfer_review.reason_same_quantity",
  same_amount: "activity:transfer_review.reason_same_amount",
  same_currency: "activity:transfer_review.reason_same_currency",
  same_date: "activity:transfer_review.reason_same_date",
  same_time: "activity:transfer_review.reason_same_time",
  // The conversion reason already says it is the same account.
  same_account: null,
  cash_fx_conversion: "activity:transfer_match.reason_fx_conversion",
};

/** The matcher's reasons, translated; its English text when it sent no codes. */
export function candidateReasons(t: TFunction, candidate: TransferMatchCandidate): string[] {
  if (!candidate.reasonCodes) return candidate.reasons;
  return candidate.reasonCodes.flatMap((code) => {
    const key = REASON_KEYS[code];
    return key ? [t(key)] : [];
  });
}

/** The matcher's warnings, translated; its English text when it sent no codes. */
export function candidateWarnings(t: TFunction, candidate: TransferMatchCandidate): string[] {
  if (!candidate.warningCodes) return candidate.warnings;
  return candidate.warningCodes.map((warning) => {
    switch (warning.code) {
      case "dates_differ":
        return t("activity:transfer_match.warning_dates_differ", { count: warning.days });
      case "currencies_differ":
        return t("activity:transfer_match.warning_currencies_differ", {
          source: warning.source,
          candidate: warning.candidate,
        });
      case "prices_differ":
        return t("activity:transfer_match.warning_prices_differ");
      case "another_match":
        return t("activity:transfer_review.warning_another_match");
    }
  });
}

/** A deposit or withdrawal, which linking converts into the transfer's other side. */
export function needsConversion(candidate: TransferMatchCandidate): boolean {
  const type = getEffectiveType(candidate.activity);
  return type === ActivityType.DEPOSIT || type === ActivityType.WITHDRAWAL;
}

/** Whether the row is marked as money moving into or out of the portfolio. */
export function isMarkedExternal(activity: Activity): boolean {
  const flow = activity.metadata?.flow as { is_external?: unknown } | undefined;
  return flow?.is_external === true;
}

/** A pair's two sides, the one money leaves first. */
export function pairInFlowOrder(source: Activity, counterpart: Activity): [Activity, Activity] {
  const type = getEffectiveType(source);
  return type === ActivityType.TRANSFER_OUT || type === ActivityType.WITHDRAWAL
    ? [source, counterpart]
    : [counterpart, source];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}
