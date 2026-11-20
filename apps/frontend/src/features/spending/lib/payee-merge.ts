import { deleteCategory } from "@/adapters";

import { bulkAssignCategories, searchCashActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import type { CategorizationRule } from "../types/rule";
import { PAYEES_TAXONOMY_ID } from "./payee";

/** Transactions moved per request. The search caps a page at 1,000 rows. */
const PAGE_SIZE = 500;

/** What still points at a payee: it can only be deleted once nothing does. */
export interface PayeeReferences {
  transactions: number;
  rules: CategorizationRule[];
}

const rulesFor = (rules: CategorizationRule[], payeeId: string) =>
  rules.filter((rule) => rule.taxonomyId === PAYEES_TAXONOMY_ID && rule.categoryId === payeeId);

export async function getPayeeReferences(payeeId: string): Promise<PayeeReferences> {
  const [found, rules] = await Promise.all([
    searchCashActivities({ payeeIds: [payeeId], limit: 1, offset: 0 }),
    listCategorizationRules(),
  ]);
  return { transactions: found.totalCount, rules: rulesFor(rules, payeeId) };
}

/**
 * Moves everything filed under one payee to another, then deletes the first.
 *
 * It runs as ordinary writes, one after the other, not as one transaction.
 * Each step only moves things toward the destination, and the delete at the
 * end is refused by the server while anything still points at the source, so
 * a merge that stops halfway loses nothing and finishes when it is run again.
 */
export async function mergePayee(sourceId: string, destinationId: string): Promise<void> {
  if (sourceId === destinationId) throw new Error("A payee cannot be merged into itself");

  // Each page moved leaves the search, so the next page is again the first.
  for (let remaining = Infinity; remaining > 0;) {
    const page = await searchCashActivities({
      payeeIds: [sourceId],
      limit: PAGE_SIZE,
      offset: 0,
    });
    if (page.items.length === 0) break;
    // Guards the loop: a page that moved must have shrunk the total.
    if (page.totalCount >= remaining) throw new Error("Payee merge is not making progress");
    remaining = page.totalCount;
    await bulkAssignCategories(
      page.items.map((activity) => ({
        activityId: activity.id,
        taxonomyId: PAYEES_TAXONOMY_ID,
        categoryId: destinationId,
      })),
    );
  }

  for (const rule of rulesFor(await listCategorizationRules(), sourceId)) {
    await updateCategorizationRule(rule.id, { categoryId: destinationId });
  }

  await deleteCategory(PAYEES_TAXONOMY_ID, sourceId);
}
