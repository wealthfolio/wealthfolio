import type { TFunction } from "i18next";

import { ActivityType } from "@/lib/constants";
import {
  getEffectiveType,
  type Activity,
  type Asset,
  type TransferMatchCandidate,
  type TransferMatchReason,
  type TransferMatchReview,
  type UnlinkedTransfer,
} from "@/lib/types";

/**
 * The review's activities carry only an asset id, a UUID. Adds each one's
 * ticker as `assetSymbol`, as searched activities have, so rows name the
 * security. Matching still keys on the asset id.
 */
export function withAssetSymbols(
  review: TransferMatchReview,
  assets: readonly Asset[],
): TransferMatchReview {
  const symbols = new Map<string, string>();
  for (const asset of assets) {
    if (asset.displayCode?.trim()) symbols.set(asset.id, asset.displayCode);
  }
  if (symbols.size === 0) return review;
  const named = <T extends Activity>(activity: T): T => {
    const assetSymbol = activity.assetId ? symbols.get(activity.assetId) : undefined;
    return assetSymbol ? { ...activity, assetSymbol } : activity;
  };
  const withNames = (row: UnlinkedTransfer): UnlinkedTransfer => ({
    ...row,
    activity: named(row.activity),
    candidates: row.candidates.map((candidate) => ({
      ...candidate,
      activity: named(candidate.activity),
    })),
  });
  return {
    ...review,
    certain: review.certain.map(withNames),
    needsReview: review.needsReview.map(withNames),
  };
}

/**
 * Pairs per Link all call, under the core's limit of 500. Small enough that
 * progress moves and a stop lands soon; each call emits one event.
 */
export const LINK_BATCH_SIZE = 100;

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

/** The matcher's timing reason for a pair ("Same time" or "Same day"), translated. */
export function timingReason(t: TFunction, candidate: TransferMatchCandidate): string | undefined {
  const code = candidate.reasonCodes?.find(
    (reason) => reason === "same_time" || reason === "same_date",
  );
  const key = code ? REASON_KEYS[code] : null;
  return key ? t(key) : undefined;
}

/** Why a transfer needs a look; rows whose reason is "other" show only under All. */
export type ReviewReason = "more_than_one" | "dates_differ" | "cash_flow" | "no_match" | "other";

export const REVIEW_REASONS: readonly Exclude<ReviewReason, "other">[] = [
  "more_than_one",
  "dates_differ",
  "cash_flow",
  "no_match",
];

/**
 * The row's reason, read from the core's codes on its best candidate. A
 * deposit or withdrawal comes first because its action differs (converting),
 * and the core never flags one as another match.
 */
export function reviewReason(row: UnlinkedTransfer): ReviewReason {
  const best = row.candidates[0];
  if (!best) return "no_match";
  if (needsConversion(best)) return "cash_flow";
  const warnings = best.warningCodes ?? [];
  if (warnings.some((warning) => warning.code === "another_match")) return "more_than_one";
  if (warnings.some((warning) => warning.code === "dates_differ")) return "dates_differ";
  return "other";
}

/** Certain pairs between the same two accounts, in the direction money moved. */
export interface AccountRoute {
  fromAccountId: string;
  toAccountId: string;
  count: number;
  /** Earliest and latest out-leg dates, as epoch milliseconds. */
  first: number;
  last: number;
}

/** The certain pairs grouped by route, largest first. */
export function accountRoutes(rows: UnlinkedTransfer[]): AccountRoute[] {
  const routes = new Map<string, AccountRoute>();
  for (const row of rows) {
    const counterpart = row.candidates[0]?.activity;
    if (!counterpart) continue;
    const [from, to] = pairInFlowOrder(row.activity, counterpart);
    const key = `${from.accountId}\u0000${to.accountId}`;
    const time = new Date(from.activityDate).getTime();
    const route = routes.get(key);
    if (route) {
      route.count += 1;
      route.first = Math.min(route.first, time);
      route.last = Math.max(route.last, time);
    } else {
      routes.set(key, {
        fromAccountId: from.accountId,
        toAccountId: to.accountId,
        count: 1,
        first: time,
        last: time,
      });
    }
  }
  return [...routes.values()].sort((left, right) => right.count - left.count);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}
