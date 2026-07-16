import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useTaxonomy } from "@/hooks/use-taxonomies";

import { OverviewCard, type OverviewChip } from "./overview-card";

interface Props {
  variant: "expense" | "income" | "savings";
}

const TAXONOMY_ID = {
  expense: "spending_categories",
  income: "income_sources",
  savings: "savings_categories",
} as const;

export function CategoriesOverviewCard({ variant }: Props) {
  const { t } = useTranslation();
  const taxonomyId = TAXONOMY_ID[variant];
  const { data, isLoading } = useTaxonomy(taxonomyId);

  const { chips, topCount, subCount } = useMemo(() => {
    const cats = data?.categories ?? [];
    const top = cats.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
    const sub = cats.filter((c) => c.parentId);
    // Use number of children as a rough "weight" so the distribution bar
    // visually emphasizes top-level categories with more subcategories.
    const items: OverviewChip[] = top.map((c) => {
      const childCount = sub.filter((s) => s.parentId === c.id).length;
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        value: Math.max(1, childCount),
      };
    });
    return {
      chips: items,
      topCount: top.length,
      subCount: sub.length,
    };
  }, [data?.categories]);

  const base = `settings:spending.categories_overview.${variant}`;
  const title = t(`${base}.title`);
  const description =
    topCount === 0
      ? t(`${base}.description_empty`)
      : variant === "expense"
        ? t("settings:spending.categories_overview.expense.description", {
            top: topCount,
            sub: subCount,
          })
        : subCount > 0
          ? t(`${base}.description_with_sub`, {
              top: topCount,
              sub: subCount,
            })
          : t(`${base}.description`, { top: topCount });
  const tab = variant === "savings" ? "savings" : variant;

  return (
    <OverviewCard
      title={title}
      description={description}
      chips={chips}
      manageHref={`/settings/spending/categories?tab=${tab}`}
      emptyTitle={t(`${base}.empty_title`)}
      emptyDescription={t(`${base}.empty_description`)}
      emptyCtaLabel={
        variant === "income"
          ? t("settings:spending.categories_overview.add_source")
          : t("settings:spending.categories_overview.add_category")
      }
      isLoading={isLoading}
      showDistribution
    />
  );
}
