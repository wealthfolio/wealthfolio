import type { TFunction } from "i18next";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { TaxonomyCategory } from "@/lib/types";

/** Presentation copies only. Keep query results and editable records raw. */
export function localizeReportCategories(
  t: TFunction,
  categories: TaxonomyCategory[],
): TaxonomyCategory[] {
  return categories.map((category) => ({
    ...category,
    name: getCategoryLabel(t, category.taxonomyId, category.id, category.name),
  }));
}
