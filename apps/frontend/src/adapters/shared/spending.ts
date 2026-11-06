// Spending Categorization Commands
import type { SpendCategory, SpendCategoryKind } from "@wealthfolio/addon-sdk";
import type {
  CategorizationRule,
  CategorizationRunSummary,
  NewCategorizationRule,
  UpdateCategorizationRule,
} from "@/features/spending/types/rule";
import type { SpendingSettings } from "@/features/spending/types";
import type { TaxonomyCategory } from "@/lib/types";

import { invoke, logger } from "./platform";
import { getTaxonomy } from "./taxonomies";

const MAX_CATEGORY_PATH_DEPTH = 8;

/** Maps the addon-facing `SpendCategoryKind` to Wealthfolio's fixed taxonomy ids. */
export const SPEND_CATEGORY_KIND_TO_TAXONOMY_ID: Record<SpendCategoryKind, string> = {
  expense: "spending_categories",
  income: "income_sources",
  saving: "savings_categories",
};

/** Reverse of {@link SPEND_CATEGORY_KIND_TO_TAXONOMY_ID}. */
export const TAXONOMY_ID_TO_SPEND_CATEGORY_KIND: Record<string, SpendCategoryKind> = {
  spending_categories: "expense",
  income_sources: "income",
  savings_categories: "saving",
};

export const isSpendingEnabled = async (): Promise<boolean> => {
  try {
    const settings = await invoke<SpendingSettings>("get_spending_settings");
    return settings.enabled;
  } catch (e) {
    logger.error("Error fetching spending settings.");
    throw e;
  }
};

export const listCategorizationRules = async (): Promise<CategorizationRule[]> => {
  try {
    return await invoke<CategorizationRule[]>("list_categorization_rules");
  } catch (e) {
    logger.error("Error listing categorization rules.");
    throw e;
  }
};

export const createCategorizationRule = async (
  rule: NewCategorizationRule,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("create_categorization_rule", { rule });
  } catch (e) {
    logger.error("Error creating categorization rule.");
    throw e;
  }
};

export const updateCategorizationRule = async (
  id: string,
  patch: UpdateCategorizationRule,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("update_categorization_rule", { id, patch });
  } catch (e) {
    logger.error("Error updating categorization rule.");
    throw e;
  }
};

/**
 * Atomically create-or-update the rule identified by `rule.id` (required).
 * Unlike list-then-create-or-update, this is race-free against itself, so
 * calling it twice with the same id never collides or duplicates.
 */
export const upsertCategorizationRule = async (
  rule: NewCategorizationRule,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("upsert_categorization_rule", { rule });
  } catch (e) {
    logger.error("Error saving categorization rule.");
    throw e;
  }
};

export const deleteCategorizationRule = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_categorization_rule", { id });
  } catch (e) {
    logger.error("Error deleting categorization rule.");
    throw e;
  }
};

export const rerunCategorizationRules = async (onlyUncategorized: boolean): Promise<number> => {
  try {
    return await invoke<number>("rerun_categorization_rules", { onlyUncategorized });
  } catch (e) {
    logger.error("Error re-running categorization rules.");
    throw e;
  }
};

export const rerunCategorizationRulesDetailed = async (
  onlyUncategorized: boolean,
): Promise<CategorizationRunSummary> => {
  try {
    return await invoke<CategorizationRunSummary>("rerun_categorization_rules_detailed", {
      onlyUncategorized,
    });
  } catch (e) {
    logger.error("Error re-running categorization rules.");
    throw e;
  }
};

/** Builds a "Parent / Child" display path for a category, capped at depth to survive accidental cycles. */
function buildCategoryPath(
  category: TaxonomyCategory,
  byId: Map<string, TaxonomyCategory>,
): string {
  const parts = [category.name];
  let parentId = category.parentId ?? null;
  let depth = 0;
  while (parentId && depth < MAX_CATEGORY_PATH_DEPTH) {
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId ?? null;
    depth += 1;
  }
  return parts.join(" / ");
}

/**
 * Lists spend categories flattened into addon-facing options with a display
 * path. Omit `kind` to load all three activity-scope taxonomies (expense,
 * income, saving). Skips a taxonomy that doesn't exist rather than failing.
 */
export const getSpendCategories = async (kind?: SpendCategoryKind): Promise<SpendCategory[]> => {
  const kinds = kind
    ? [kind]
    : (Object.keys(SPEND_CATEGORY_KIND_TO_TAXONOMY_ID) as SpendCategoryKind[]);

  const perKind = await Promise.all(
    kinds.map(async (k): Promise<SpendCategory[]> => {
      const taxonomyId = SPEND_CATEGORY_KIND_TO_TAXONOMY_ID[k];
      const taxonomy = await getTaxonomy(taxonomyId);
      if (!taxonomy) return [];

      const byId = new Map(taxonomy.categories.map((category) => [category.id, category]));
      return taxonomy.categories.map((category) => ({
        kind: k,
        taxonomyId,
        categoryId: category.id,
        key: category.key,
        name: category.name,
        path: buildCategoryPath(category, byId),
      }));
    }),
  );

  return perKind.flat();
};
