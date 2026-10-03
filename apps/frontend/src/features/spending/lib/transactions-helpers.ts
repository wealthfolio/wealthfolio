import type { TaxonomyCategory } from "@/lib/types";

import {
  getActivitySpendingAmount,
  getEffectiveCashActivityType,
  isCashActivityIncome,
} from "./constants";
import type {
  ActivitySplit,
  ActivityTaxonomyAssignment,
  CashActivity,
  CurrencyNet,
  NetSummary,
  TransferLinkStatus,
} from "../types/cash-activity";
import { formatZonedDateKey } from "./timezone";

/** Stable sorted Set→array used in React Query keys (insertion order is unstable). */
export function stableArr(s: Set<string>): string[] | undefined {
  if (s.size === 0) return undefined;
  return [...s].sort();
}

/** "transaction" / "transactions" given a count. */
export function pluralizeTransaction(n: number): string {
  return n === 1 ? "transaction" : "transactions";
}
export function pluralizeActivity(n: number): string {
  return n === 1 ? "activity" : "activities";
}

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

/**
 * View-model for a transaction row. Pulls the (single) activity-scope assignment
 * + its category metadata into a flat shape that the row component can render
 * without re-doing lookups.
 */
export interface TransactionRowVM {
  activity: CashActivity;
  category: {
    assignmentId: string;
    taxonomyId: string;
    id: string;
    name: string;
    color: string | null;
    parentName: string | null;
    parentColor: string | null;
  } | null;
  splitCount: number;
  needsReview: boolean;
}

/**
 * The sign a row renders, taken from the server's signed cash movement so the
 * figures on screen add up to the nets reported beside them. Positive is money
 * entering the account, negative money leaving; a row that moved no cash — an
 * unposted one, say — renders unsigned and contributes nothing.
 *
 * Deliberately independent of the spending/income/saving bucket: a transfer
 * between your own accounts is neither income nor an expense, but it still
 * visibly moves money, and hiding that is what made a transfer filter report
 * nothing.
 */
export function netSign(activity: CashActivity): string {
  const net = activity.netAmount;
  if (!Number.isFinite(net) || net === 0) return "";
  return net < 0 ? "-" : "+";
}

/** Amount sign + flow classification shared by the desktop row and mobile card. */
export interface TransactionDisplay {
  isOutflow: boolean;
  isIncome: boolean;
  isSaving: boolean;
  isRefund: boolean;
  isNeutral: boolean;
  /** "-" for outflow, "+" for income/refund, "" for neutral. */
  sign: string;
  /** Absolute-safe parsed amount (0 when unparseable). */
  safeAmount: number;
}

export function isTransferCashActivity(activity: {
  activityType: string;
  activityTypeOverride?: string | null;
}): boolean {
  const activityType = getEffectiveCashActivityType(activity);
  return activityType === "TRANSFER_IN" || activityType === "TRANSFER_OUT";
}

export function getTransferLinkStatus(activity: CashActivity): TransferLinkStatus | null {
  if (!isTransferCashActivity(activity)) {
    return null;
  }
  return activity.transferLinkStatus ?? (activity.sourceGroupId ? "linked" : "unlinked");
}

export function getTransactionDisplay(
  activity: CashActivity,
  accountType: string | undefined,
): TransactionDisplay {
  if (activity.cashFlowBucket) {
    const amount = parseFloat(activity.amount ?? "0");
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    const spendingAmount = getActivitySpendingAmount(activity, accountType);
    const isIncome = activity.cashFlowBucket === "income";
    const isSaving = activity.cashFlowBucket === "saving";
    const isOutflow = isSaving || (activity.cashFlowBucket === "spending" && spendingAmount > 0);
    const isNeutral = activity.cashFlowBucket === "neutral";
    const isRefund = activity.cashFlowBucket === "spending" && spendingAmount < 0;
    const sign = netSign(activity);
    return { isOutflow, isIncome, isSaving, isRefund, isNeutral, sign, safeAmount };
  }

  const spendingAmount = getActivitySpendingAmount(activity, accountType);
  const isOutflow = spendingAmount > 0;
  const activityType = getEffectiveCashActivityType(activity);
  const isInternalTransfer = !!activity.sourceGroupId && isTransferCashActivity(activity);
  const isIncome =
    !isInternalTransfer && isCashActivityIncome(activityType, accountType, activity.subtype);
  const isSaving = false;
  const isRefund = spendingAmount < 0;
  const isNeutral = !isOutflow && !isIncome && !isRefund;
  const sign = netSign(activity);
  const amount = parseFloat(activity.amount ?? "0");
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return { isOutflow, isIncome, isSaving, isRefund, isNeutral, sign, safeAmount };
}

export function toRowVM(
  item: CashActivity,
  allCategories: Map<string, TaxonomyCategory>,
): TransactionRowVM {
  const expectedTaxonomy =
    item.cashFlowBucket === "income"
      ? INCOME_TAXONOMY
      : item.cashFlowBucket === "saving"
        ? SAVINGS_TAXONOMY
        : item.cashFlowBucket === "spending"
          ? SPENDING_TAXONOMY
          : null;
  const asg = expectedTaxonomy
    ? (item.assignments ?? []).find(
        (x: ActivityTaxonomyAssignment) => x.taxonomyId === expectedTaxonomy,
      )
    : undefined;
  const splits = expectedTaxonomy
    ? (item.splits ?? []).filter((x: ActivitySplit) => x.taxonomyId === expectedTaxonomy)
    : [];
  const cat = asg ? allCategories.get(asg.categoryId) : undefined;
  const parent = cat?.parentId ? allCategories.get(cat.parentId) : undefined;

  return {
    activity: item,
    category:
      splits.length === 0 && asg && cat
        ? {
            assignmentId: asg.id,
            taxonomyId: asg.taxonomyId,
            id: cat.id,
            name: cat.name,
            color: cat.color ?? null,
            parentName: parent?.name ?? null,
            parentColor: parent?.color ?? null,
          }
        : null,
    splitCount: splits.length,
    needsReview: item.needsReview,
  };
}

/** One day's worth of rows, as rendered by the grouped transactions table. */
export interface TransactionDayGroup {
  /** Zoned `YYYY-MM-DD` key — also the React key for the header row. */
  key: string;
  /** Instant of the first row in the day, for header date formatting. */
  date: Date;
  rows: TransactionRowVM[];
  /**
   * Signed net of the day in `currency`, or `null` when the day has no
   * contributing rows or mixes currencies (there is no FX rate on the row
   * view-model, so a mixed-currency sum would be meaningless).
   */
  net: CurrencyNet | null;
}

/**
 * Signed sum of `rows`, split per currency and matching what the rows render:
 * outflows subtract, income and refunds add, and neutral rows — which show no
 * sign at all — contribute nothing and never introduce a currency of their own.
 *
 * There is no FX here by design. Each row lands in its own currency's bucket,
 * so a mixed set reports one total per currency instead of a single number that
 * silently assumes a rate.
 */
export function netSummary(rows: TransactionRowVM[], baseCurrency?: string): NetSummary {
  // Tallied per currency, mirroring the server: a currency whose rows cancel is
  // reported nowhere, so its conversion residual must not reach the total
  // either, and one currency failing to convert must not veto a total the
  // others can support.
  const tallies = new Map<
    string,
    { native: number; compensation: number; gross: number; converted: number | null }
  >();

  for (const row of rows) {
    const net = row.activity.netAmount;
    if (!Number.isFinite(net) || net === 0) continue;

    const tally = tallies.get(row.activity.currency) ?? {
      native: 0,
      compensation: 0,
      gross: 0,
      converted: 0,
    };
    // Neumaier: each addition loses the low bits of whichever operand is
    // smaller, so they are recovered and carried in `compensation` rather than
    // left to accumulate as error.
    const sum = tally.native + net;
    tally.compensation +=
      Math.abs(tally.native) >= Math.abs(net) ? tally.native - sum + net : net - sum + tally.native;
    tally.native = sum;
    tally.gross += Math.abs(net);
    if (tally.converted !== null) {
      const base = row.activity.netAmountBase;
      tally.converted =
        typeof base === "number" && Number.isFinite(base) ? tally.converted + base : null;
    }
    tallies.set(row.activity.currency, tally);
  }

  // The server nets in decimal, so its cancellations are exact; the f64 sum
  // here does not cancel as cleanly, and the residue would surface as a stray
  // "+0.00" pill for a currency that actually nets to nothing.
  //
  // Two different errors could produce that residue. Summation error, which
  // grows with the number of rows and their magnitudes, is removed above by
  // carrying the compensation. What remains is only the inputs' own
  // representation error — each amount is the nearest double to a decimal
  // figure — which is bounded by one epsilon of the gross summed, whatever the
  // row count. So the threshold can sit at that bound rather than far above it.
  //
  // The distinction is not academic: a fixed relative bound loose enough to
  // absorb summation error (1e-12 of gross, say) discards a genuine 0.00000001
  // sitting alongside a 20,000,000 that cancels, because it judges the residual
  // against the gross rather than against the error actually made.
  const contributing = [...tallies].filter(
    ([, tally]) => Math.abs(tally.native + tally.compensation) > tally.gross * Number.EPSILON,
  );

  const byCurrency = contributing.map(([currency, tally]) => ({
    currency,
    amount: tally.native + tally.compensation,
  }));

  const converted =
    baseCurrency && contributing.length > 1 && contributing.every(([, t]) => t.converted !== null)
      ? {
          currency: baseCurrency,
          amount: contributing.reduce((sum, [, t]) => sum + t.converted!, 0),
        }
      : null;

  return { byCurrency, converted };
}

/**
 * Buckets date-sorted rows into day groups, preserving the incoming order.
 * Bucketing uses `timezone` so a late-evening activity lands on the day the
 * user perceives — the same key the header then formats.
 */
export function groupRowsByDay(
  rows: TransactionRowVM[],
  timezone: string | undefined,
): TransactionDayGroup[] {
  const groups = new Map<string, TransactionDayGroup>();

  for (const row of rows) {
    const activityDate = new Date(row.activity.activityDate);
    if (!Number.isFinite(activityDate.getTime())) continue;
    const key = formatZonedDateKey(activityDate, timezone);

    let group = groups.get(key);
    if (!group) {
      group = { key, date: activityDate, rows: [], net: null };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  for (const group of groups.values()) {
    // The header's amount column has room for a single figure, so a day that
    // mixes currencies shows no net; the totals in the filter bar have the room
    // to report one per currency.
    const totals = netSummary(group.rows).byCurrency;
    group.net = totals.length === 1 ? totals[0] : null;
  }

  return [...groups.values()];
}

/** One entry in the flat rendering of the day-grouped transaction list. */
export type TransactionListItem =
  | {
      kind: "header";
      /** Stable across renders, so the virtualizer keeps item identity. */
      key: string;
      group: TransactionDayGroup;
      /**
       * True for the trailing day only. Its count and net describe just the
       * rows fetched so far, so the header labels itself as partial while more
       * pages are pending.
       */
      isLastGroup: boolean;
    }
  | { kind: "row"; key: string; row: TransactionRowVM };

/**
 * Flattens day groups into the single index space a virtualizer needs, with
 * each header immediately preceding its own rows — the same reading order the
 * nested rendering produced.
 */
export function flattenDayGroups(groups: TransactionDayGroup[]): TransactionListItem[] {
  const items: TransactionListItem[] = [];

  groups.forEach((group, index) => {
    items.push({
      kind: "header",
      key: `day:${group.key}`,
      group,
      isLastGroup: index === groups.length - 1,
    });
    for (const row of group.rows) {
      items.push({ kind: "row", key: row.activity.id, row });
    }
  });

  return items;
}
