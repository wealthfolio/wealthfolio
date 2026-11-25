import { deleteCategory } from "@/adapters";

import { movePayeeActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import { PAYEES_TAXONOMY_ID } from "./payee";

/**
 * Moves everything filed under one payee to another, then deletes the first.
 *
 * The transactions move in one write, on every account: one left on an
 * account no longer in Spending would keep the payee from being deleted. The
 * rules and the delete are ordinary writes after it, not one transaction.
 * Each step only moves things toward the destination, and the delete at the
 * end is refused by the server while anything still points at the source, so
 * a merge that stops halfway loses nothing and finishes when it is run again.
 */
export async function mergePayee(sourceId: string, destinationId: string): Promise<void> {
  if (sourceId === destinationId) throw new Error("A payee cannot be merged into itself");

  await movePayeeActivities(sourceId, destinationId);

  const rules = await listCategorizationRules();
  for (const rule of rules) {
    if (rule.taxonomyId !== PAYEES_TAXONOMY_ID || rule.categoryId !== sourceId) continue;
    await updateCategorizationRule(rule.id, { categoryId: destinationId });
  }

  await deleteCategory(PAYEES_TAXONOMY_ID, sourceId);
}
