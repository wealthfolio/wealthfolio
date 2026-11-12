import { ActivityType } from "@/lib/constants";
import {
  getEffectiveType,
  type Activity,
  type Asset,
  type TransferMatchCandidate,
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

/** Whether money leaves the account in this leg. */
export function isOutflow(activity: Activity): boolean {
  const type = getEffectiveType(activity);
  return type === ActivityType.TRANSFER_OUT || type === ActivityType.WITHDRAWAL;
}

/** A pair's two sides, the one money leaves first. */
export function pairInFlowOrder(source: Activity, counterpart: Activity): [Activity, Activity] {
  return isOutflow(source) ? [source, counterpart] : [counterpart, source];
}

/** Why a transfer needs a look, which decides its section. */
export type ReviewReason = "more_than_one" | "dates_differ" | "cash_flow" | "no_match" | "other";

/** Sections in the order they show: likely links first, no other side last. */
export const REVIEW_SECTIONS: readonly ReviewReason[] = [
  "dates_differ",
  "more_than_one",
  "cash_flow",
  "other",
  "no_match",
];

/**
 * A pair's reason, read from the core's codes on its candidate. A deposit or
 * withdrawal comes first because linking converts it, and the core never
 * flags one as another match.
 */
export function reviewReason(candidate: TransferMatchCandidate | undefined): ReviewReason {
  if (!candidate) return "no_match";
  if (needsConversion(candidate)) return "cash_flow";
  const warnings = candidate.warningCodes ?? [];
  if (warnings.some((warning) => warning.code === "another_match")) return "more_than_one";
  if (warnings.some((warning) => warning.code === "dates_differ")) return "dates_differ";
  return "other";
}

/** One row of Needs a look: a possible pair, or a transfer with no likely other side. */
export interface ReviewPair {
  key: string;
  reason: ReviewReason;
  /** The review row it comes from: Skip and Mark as external act on its activity. */
  row: UnlinkedTransfer;
  /** Absent when nothing matches the row. */
  candidate?: TransferMatchCandidate;
  /** The other side of each pair shown here that shares a leg with this one. */
  rivals: Activity[];
}

/**
 * The review rows as pairs: one per candidate, so a transfer with two likely
 * other sides shows two pairs, and so does a leg two transfers claim. Pairs
 * sharing a leg list each other as rivals and stay next to each other. Only
 * regroups the core's rows by identity: which candidates match is the core's
 * call.
 */
export function reviewPairs(rows: UnlinkedTransfer[]): ReviewPair[] {
  const pairs: ReviewPair[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.candidates.length === 0) {
      pairs.push({ key: row.activity.id, reason: "no_match", row, rivals: [] });
      continue;
    }
    for (const candidate of row.candidates) {
      const key = [row.activity.id, candidate.activity.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        key,
        reason: reviewReason(candidate),
        row,
        candidate,
        rivals: [],
      });
    }
  }

  const byLeg = new Map<string, ReviewPair[]>();
  for (const pair of pairs) {
    if (!pair.candidate) continue;
    for (const leg of [pair.row.activity, pair.candidate.activity]) {
      byLeg.set(leg.id, [...(byLeg.get(leg.id) ?? []), pair]);
    }
  }
  const legsOf = (pair: ReviewPair) =>
    pair.candidate ? [pair.row.activity, pair.candidate.activity] : [pair.row.activity];
  for (const pair of pairs) {
    if (!pair.candidate) continue;
    const rivals = new Map<string, Activity>();
    for (const leg of legsOf(pair)) {
      for (const other of byLeg.get(leg.id) ?? []) {
        if (other === pair) continue;
        const otherSide = legsOf(other).find((otherLeg) => otherLeg.id !== leg.id);
        if (otherSide) rivals.set(otherSide.id, otherSide);
      }
    }
    pair.rivals = [...rivals.values()];
    if (pair.rivals.length > 0) pair.reason = "more_than_one";
  }

  // Each pair is followed by the pairs it competes with.
  const ordered: ReviewPair[] = [];
  const placed = new Set<ReviewPair>();
  for (const pair of pairs) {
    const queue = [pair];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || placed.has(next)) continue;
      placed.add(next);
      ordered.push(next);
      for (const leg of legsOf(next)) queue.push(...(byLeg.get(leg.id) ?? []));
    }
  }
  return ordered;
}

/** Certain pairs between the same two accounts, in the direction money moved. */
export interface AccountRoute {
  fromAccountId: string;
  toAccountId: string;
  count: number;
  /** Earliest and latest out-leg dates, as epoch milliseconds. */
  first: number;
  last: number;
  /** The route's pairs, newest first. */
  rows: UnlinkedTransfer[];
  /** Cash moved, when every pair is cash in one currency. */
  total?: { amount: number; currency: string };
}

/** The certain pairs grouped by route, largest first. */
export function accountRoutes(rows: UnlinkedTransfer[]): AccountRoute[] {
  const routes = new Map<string, AccountRoute & { summable: boolean }>();
  for (const row of rows) {
    const counterpart = row.candidates[0]?.activity;
    if (!counterpart) continue;
    const [from, to] = pairInFlowOrder(row.activity, counterpart);
    const key = `${from.accountId}\u0000${to.accountId}`;
    const time = new Date(from.activityDate).getTime();
    const amount = from.amount == null ? Number.NaN : Math.abs(Number(from.amount));
    let route = routes.get(key);
    if (!route) {
      route = {
        fromAccountId: from.accountId,
        toAccountId: to.accountId,
        count: 0,
        first: time,
        last: time,
        rows: [],
        total: { amount: 0, currency: from.currency },
        summable: true,
      };
      routes.set(key, route);
    }
    route.count += 1;
    route.first = Math.min(route.first, time);
    route.last = Math.max(route.last, time);
    route.rows.push(row);
    route.summable &&= Number.isFinite(amount) && from.currency === route.total?.currency;
    if (route.summable && route.total) route.total.amount += amount;
  }
  return [...routes.values()]
    .map(({ summable, ...route }) => ({
      ...route,
      rows: [...route.rows].sort((left, right) => pairTime(right) - pairTime(left)),
      total: summable ? route.total : undefined,
    }))
    .sort((left, right) => right.count - left.count);
}

/** When a pair's money left, as epoch milliseconds. */
function pairTime(row: UnlinkedTransfer): number {
  const counterpart = row.candidates[0]?.activity;
  const [from] = counterpart ? pairInFlowOrder(row.activity, counterpart) : [row.activity];
  return new Date(from.activityDate).getTime();
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}
