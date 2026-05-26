import type { Activity, TaxonomyCategory } from "@/lib/types";

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
