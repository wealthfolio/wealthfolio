import type { Activity, TaxonomyCategory } from "@/lib/types";

import { getActivitySpendingAmount, isCashActivityIncome } from "./constants";
import type { ActivityTaxonomyAssignment, CashActivity } from "../types/cash-activity";

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

/**
 * View-model for a transaction row. Pulls the (single) activity-scope assignment
 * + its category metadata into a flat shape that the row component can render
 * without re-doing lookups.
 */
export interface TransactionRowVM {
  activity: Activity;
  category: {
    assignmentId: string;
    taxonomyId: string;
    id: string;
    name: string;
    color: string | null;
    parentName: string | null;
  } | null;
  needsReview: boolean;
}

/** Amount sign + flow classification shared by the desktop row and mobile card. */
export interface TransactionDisplay {
  isOutflow: boolean;
  isIncome: boolean;
  isRefund: boolean;
  isNeutral: boolean;
  /** "-" for outflow, "+" for income/refund, "" for neutral. */
  sign: string;
  /** Absolute-safe parsed amount (0 when unparseable). */
  safeAmount: number;
}

export function getTransactionDisplay(
  activity: Activity,
  accountType: string | undefined,
): TransactionDisplay {
  const spendingAmount = getActivitySpendingAmount(activity, accountType);
  const isOutflow = spendingAmount > 0;
  const isInternalTransfer =
    !!activity.sourceGroupId &&
    (activity.activityType === "TRANSFER_IN" || activity.activityType === "TRANSFER_OUT");
  const isIncome =
    !isInternalTransfer &&
    isCashActivityIncome(activity.activityType, accountType, activity.subtype);
  const isRefund = spendingAmount < 0;
  const isNeutral = !isOutflow && !isIncome && !isRefund;
  const sign = isOutflow ? "-" : isIncome || isRefund ? "+" : "";
  const amount = parseFloat(activity.amount ?? "0");
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return { isOutflow, isIncome, isRefund, isNeutral, sign, safeAmount };
}

export function toRowVM(
  item: CashActivity,
  allCategories: Map<string, TaxonomyCategory>,
): TransactionRowVM {
  const asg = (item.assignments ?? []).find(
    (x: ActivityTaxonomyAssignment) =>
      x.taxonomyId === SPENDING_TAXONOMY || x.taxonomyId === INCOME_TAXONOMY,
  );
  const cat = asg ? allCategories.get(asg.categoryId) : undefined;
  const parent = cat?.parentId ? allCategories.get(cat.parentId) : undefined;

  return {
    activity: item,
    category:
      asg && cat
        ? {
            assignmentId: asg.id,
            taxonomyId: asg.taxonomyId,
            id: cat.id,
            name: cat.name,
            color: cat.color ?? null,
            parentName: parent?.name ?? null,
          }
        : null,
    needsReview: item.needsReview,
  };
}
