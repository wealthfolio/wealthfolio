import { createCategory, getTaxonomy } from "@/adapters";
import type { TaxonomyCategory } from "@/lib/types";

import {
  assignActivityCategory,
  bulkAssignCategories,
  unassignActivityCategory,
} from "../adapters/cash-activities";

/** The activity taxonomy that says who a transaction was with. */
export const PAYEES_TAXONOMY_ID = "payees";

/**
 * Stands for "no payee" among the payee ids of a transaction search. Mirrors
 * `NO_PAYEE_ID` in `wealthfolio_spending::cash_activities`.
 */
export const NO_PAYEE_ID = "__none__";

/** The id of the payee among an activity's assignments, if it has one. */
export function payeeIdOf(
  assignments: readonly { taxonomyId: string; categoryId: string }[] | null | undefined,
): string | undefined {
  return assignments?.find((assignment) => assignment.taxonomyId === PAYEES_TAXONOMY_ID)
    ?.categoryId;
}

/** The payee with this name, ignoring case and surrounding spaces. */
export function findPayee(payees: TaxonomyCategory[], name: string): TaxonomyCategory | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  return payees.find((payee) => payee.name.trim().toLowerCase() === wanted);
}

/**
 * Files an activity under the payee called `name`, creating the payee the
 * first time the name is used. An empty name clears the activity's payee.
 */
export async function setActivityPayee(
  activityId: string,
  name: string,
  payees: TaxonomyCategory[],
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    await unassignActivityCategory(activityId, PAYEES_TAXONOMY_ID);
    return;
  }
  const payee = await ensurePayee(trimmed, payees);
  await assignActivityCategory(activityId, PAYEES_TAXONOMY_ID, payee.id);
}

/**
 * Files several activities under the payee called `name`, in one write. An
 * empty name clears the payee of each.
 */
export async function setActivitiesPayee(
  activityIds: string[],
  name: string,
  payees: TaxonomyCategory[],
): Promise<void> {
  if (activityIds.length === 0) return;
  const trimmed = name.trim();
  if (!trimmed) {
    await Promise.all(
      activityIds.map((activityId) => unassignActivityCategory(activityId, PAYEES_TAXONOMY_ID)),
    );
    return;
  }
  const payee = await ensurePayee(trimmed, payees);
  await bulkAssignCategories(
    activityIds.map((activityId) => ({
      activityId,
      taxonomyId: PAYEES_TAXONOMY_ID,
      categoryId: payee.id,
    })),
  );
}

/** The payee with this name, created if no payee has it yet. */
export async function ensurePayee(
  name: string,
  payees: TaxonomyCategory[],
): Promise<TaxonomyCategory> {
  const trimmed = name.trim();
  const existing = findPayee(payees, trimmed);
  if (existing) return existing;
  // A payee has no colour of its own to pick: it takes its taxonomy's.
  const taxonomy = await getTaxonomy(PAYEES_TAXONOMY_ID);
  if (!taxonomy) throw new Error("The payees taxonomy is missing");
  // The caller's list can be behind: the payee may have been added since.
  const added = findPayee(taxonomy.categories, trimmed);
  if (added) return added;
  return createCategory({
    taxonomyId: PAYEES_TAXONOMY_ID,
    parentId: null,
    name: trimmed,
    key: `payee_${crypto.randomUUID()}`,
    color: taxonomy.taxonomy.color,
    sortOrder: taxonomy.categories.length,
  });
}
