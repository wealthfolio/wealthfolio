import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  useAmountFormatting,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CategoryMeta, CategoryMetaMap } from "@/features/spending/components/category-chips";

/** Spending results' coverage of currency conversions (not in the shared TS types yet). */
export interface CalculationQuality {
  missingFxTransactions: number;
  missingFxCurrencies: string[];
}

/** The `context` block the Spending read tools return. */
export interface SpendingToolContext {
  enabled: boolean;
  availability: "available" | "disabled" | "no_accounts";
  accountIds: string[];
  accounts: { id: string; name: string; currency: string; accountType: string }[];
  baseCurrency: string;
  timezone: string;
}

const CATEGORY_TAXONOMIES = ["spending_categories", "income_sources", "savings_categories"];

/** Category names (translated for seeded ones), colors and icons by category ID. */
export function useSpendingCategoryMeta(): CategoryMetaMap {
  const { t } = useTranslation();
  const spending = useTaxonomy(CATEGORY_TAXONOMIES[0]);
  const income = useTaxonomy(CATEGORY_TAXONOMIES[1]);
  const savings = useTaxonomy(CATEGORY_TAXONOMIES[2]);
  return useMemo(() => {
    const meta: CategoryMetaMap = new Map();
    for (const taxonomy of [spending.data, income.data, savings.data]) {
      taxonomy?.categories.forEach((category: TaxonomyCategory) => {
        meta.set(category.id, {
          name: getCategoryLabel(t, category.taxonomyId, category.id, category.name),
          color: category.color ?? null,
          icon: category.icon ?? null,
          parentId: category.parentId ?? null,
        });
      });
    }
    return meta;
  }, [spending.data, income.data, savings.data, t]);
}

/** The top-level category a (sub)category rolls up to. */
export function topLevelCategoryId(categoryId: string, meta: CategoryMetaMap): string {
  let id = categoryId;
  for (let depth = 0; depth < 8; depth += 1) {
    const parentId = meta.get(id)?.parentId;
    if (!parentId) return id;
    id = parentId;
  }
  return id;
}

export function categoryMetaOrFallback(
  categoryId: string,
  meta: CategoryMetaMap,
  fallbackName: string,
): CategoryMeta {
  return meta.get(categoryId) ?? { name: fallbackName, color: null, icon: null, parentId: null };
}

interface SpendingCardProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  children: ReactNode;
}

export function SpendingCard({ title, subtitle, badge, children }: SpendingCardProps) {
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            {subtitle && <p className="text-muted-foreground mt-1 text-xs">{subtitle}</p>}
          </div>
          {badge}
        </div>
      </CardHeader>
      <CardContent className="pb-4">{children}</CardContent>
    </Card>
  );
}

export function SpendingCardSkeleton({ title }: { title: string }) {
  return (
    <SpendingCard title={title}>
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-2 w-full" />
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-4 w-full" />
        ))}
      </div>
    </SpendingCard>
  );
}

/** Shown instead of a card when Spending is off or has no accounts. */
export function SpendingUnavailable({
  availability,
}: {
  availability: SpendingToolContext["availability"];
}) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.Info className="h-3.5 w-3.5 shrink-0" />
      <span>
        {availability === "disabled"
          ? t("ai:spendingCards.unavailableDisabled")
          : t("ai:spendingCards.unavailableNoAccounts")}
      </span>
    </div>
  );
}

/** Says when totals leave out transactions that had no exchange rate. */
export function MissingFxNote({ quality }: { quality?: CalculationQuality | null }) {
  const { t } = useTranslation();
  const count = quality?.missingFxTransactions ?? 0;
  if (count <= 0) return null;
  return (
    <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
      <Icons.AlertCircle className="h-3 w-3 shrink-0" />
      {t("ai:spendingCards.missingFx", { count })}
    </p>
  );
}

/** A thin horizontal bar; `fraction` is clamped to 0..1. */
export function SpendingBar({
  fraction,
  color,
  danger,
  className,
}: {
  fraction: number;
  color?: string | null;
  danger?: boolean;
  className?: string;
}) {
  const width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  const fill = danger ? "bg-destructive" : color ? undefined : "bg-primary";
  return (
    <div className={cn("bg-border h-1.5 w-full overflow-hidden rounded-full", className)}>
      <div
        className={cn("h-full rounded-full", fill)}
        style={{ width, ...(color && !danger ? { backgroundColor: color } : {}) }}
      />
    </div>
  );
}

const HIDDEN_AMOUNT = "•••••";

/** Formats an amount for a translated sentence, masked when balances are hidden. */
export function useSpendingAmount() {
  const { isBalanceHidden } = useBalancePrivacy();
  const amounts = useAmountFormatting();
  return useCallback(
    (value: number, currency: string) =>
      isBalanceHidden ? HIDDEN_AMOUNT : amounts.formatAmount(value, currency),
    [isBalanceHidden, amounts],
  );
}
