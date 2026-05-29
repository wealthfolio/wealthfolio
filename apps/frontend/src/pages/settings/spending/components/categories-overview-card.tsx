import { useMemo } from "react";

import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";

import { OverviewCard, type OverviewChip } from "./overview-card";

interface Props {
  variant: "expense" | "income";
}

const TAXONOMY_ID = {
  expense: "spending_categories",
  income: "income_sources",
} as const;

export function CategoriesOverviewCard({ variant }: Props) {
  const taxonomyId = TAXONOMY_ID[variant];
  const { data, isLoading } = useTaxonomy(taxonomyId);

  const { chips, topCount, subCount } = useMemo(() => {
    const cats = (data?.categories ?? []) as TaxonomyCategory[];
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

  const title = variant === "expense" ? "Expense categories" : "Income sources";
  const description =
    topCount === 0
      ? variant === "expense"
        ? "Group transactions into expense buckets."
        : "Group transactions into income sources."
      : variant === "expense"
        ? `${topCount} top-level · ${subCount} subcategories`
        : `${topCount} sources${subCount > 0 ? ` · ${subCount} subcategories` : ""}`;

  return (
    <OverviewCard
      title={title}
      description={description}
      chips={chips}
      manageHref={`/settings/spending/categories?tab=${variant}`}
      emptyTitle={variant === "expense" ? "No expense categories yet" : "No income sources yet"}
      emptyDescription={
        variant === "expense"
          ? "Create categories to organize cash transactions."
          : "Create sources to categorize incoming cash flows."
      }
      emptyCtaLabel={variant === "expense" ? "Add category" : "Add source"}
      isLoading={isLoading}
      showDistribution
    />
  );
}
