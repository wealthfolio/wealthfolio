import type { TFunction } from "i18next";
import english from "@/i18n/locales/en/common.json";
import type { TaxonomyAllocation, CategoryAllocation } from "@/lib/types";

const taxonomyNames: Record<string, string> = english.taxonomyNames;
const categoryNames: Record<string, Record<string, string>> = english.categoryNames;

/** Only unchanged built-in names are translated; custom and renamed records stay verbatim. */
export function getTaxonomyLabel(t: TFunction, taxonomyId: string, name: string): string {
  return taxonomyNames[taxonomyId] === name
    ? t(`common:taxonomyNames.${taxonomyId}`, { defaultValue: name })
    : name;
}

export function getCategoryLabel(
  t: TFunction,
  taxonomyId: string,
  categoryId: string,
  name: string,
): string {
  if (categoryId === "__UNKNOWN__") return t("common:unknown");
  return categoryNames[taxonomyId]?.[categoryId] === name
    ? t(`common:categoryNames.${taxonomyId}.${categoryId}`, { defaultValue: name })
    : name;
}

/** A view copy only: never use these names as mutation or persistence input. */
export function localizeAllocation(
  t: TFunction,
  allocation: TaxonomyAllocation,
): TaxonomyAllocation {
  const category = (row: CategoryAllocation, parentName?: string): CategoryAllocation => {
    const name =
      row.isResidual && parentName
        ? t("common:allocation_other_in_category", { category: parentName })
        : getCategoryLabel(t, allocation.taxonomyId, row.categoryId, row.categoryName);
    return {
      ...row,
      categoryName: name,
      children: row.children?.map((child) => category(child, name)),
    };
  };
  return {
    ...allocation,
    taxonomyName: getTaxonomyLabel(t, allocation.taxonomyId, allocation.taxonomyName),
    categories: allocation.categories.map((row) => category(row)),
  };
}

/** Seeded budget groups are editable too; never translate a user rename. */
export function getBudgetGroupLabel(t: TFunction, id: string, name: string): string {
  const names: Record<string, string> = english.budgetGroupNames;
  return names[id] === name ? t(`common:budgetGroupNames.${id}`, { defaultValue: name }) : name;
}

/** Translate only unchanged seeded event types, never user-created types or event names. */
export function getEventTypeLabel(t: TFunction, id: string, name: string): string {
  const names: Record<string, string> = english.eventTypeNames;
  return names[id] === name ? t(`common:eventTypeNames.${id}`, { defaultValue: name }) : name;
}

/** Localize a tool's category path only through identities supplied with that path. */
export function getCategoryPathLabel(
  t: TFunction,
  taxonomyId: string,
  categoryId: string,
  path: string,
  categories: readonly { categoryId: string; name: string; path: string }[],
): string {
  const category = categories.find((row) => row.categoryId === categoryId && row.path === path);
  if (!category) return path;
  const label = getCategoryLabel(t, taxonomyId, categoryId, category.name);
  if (path === category.name) return label;
  const suffix = ` / ${category.name}`;
  if (!path.endsWith(suffix)) return path;
  const parentPath = path.slice(0, -suffix.length);
  const parents = categories.filter((row) => row.path === parentPath);
  const parentLabel =
    parents.length === 1
      ? getCategoryPathLabel(t, taxonomyId, parents[0].categoryId, parentPath, categories)
      : parentPath;
  return `${parentLabel} / ${label}`;
}
