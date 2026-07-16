import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  formatPercent,
} from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";

// ============================================================================
// Types
// ============================================================================

interface GetAssetAllocationArgs {
  accountId?: string;
  groupBy?: string;
  taxonomyId?: string;
  categoryId?: string;
  displayMode?: "compact" | "full";
}

interface AllocationDto {
  categoryId: string;
  categoryName: string;
  color: string;
  value: number;
  percentage: number;
}

interface HoldingDto {
  symbol: string;
  name?: string;
  value: number;
  weight: number;
}

interface GetAssetAllocationOutput {
  allocations: AllocationDto[];
  totalValue: number;
  currency: string;
  groupBy: string;
  taxonomyId?: string;
  taxonomyName?: string;
  holdings?: HoldingDto[];
  categoryName?: string;
}

// ============================================================================
// Normalizer
// ============================================================================

/**
 * Normalizes the result to handle both wrapped and unwrapped formats,
 * as well as snake_case vs camelCase field names.
 */
function normalizeResult(
  result: unknown,
  fallbackCurrency: string,
): GetAssetAllocationOutput | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  // Handle wrapped format: { data: ..., meta: ... }
  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizeResult(candidate.data, fallbackCurrency);
  }

  // Parse allocations array (new format)
  const allocationsRaw = Array.isArray(candidate.allocations) ? candidate.allocations : [];
  const allocations: AllocationDto[] = allocationsRaw
    .map((entry) => entry as Record<string, unknown>)
    .map((entry, index) => ({
      categoryId:
        (entry.categoryId as string | undefined) ??
        (entry.category_id as string | undefined) ??
        (entry.category as string | undefined) ??
        `category-${index}`,
      categoryName:
        (entry.categoryName as string | undefined) ??
        (entry.category_name as string | undefined) ??
        (entry.category as string | undefined) ??
        "Unknown",
      color: (entry.color as string | undefined) ?? `var(--chart-${(index % 5) + 1})`,
      value: Number(entry.value ?? 0),
      percentage: Number(entry.percentage ?? 0),
    }));

  // Parse holdings array (drill-down mode)
  const holdingsRaw = Array.isArray(candidate.holdings) ? candidate.holdings : undefined;
  const holdings: HoldingDto[] | undefined = holdingsRaw?.map((entry) => {
    const h = entry as Record<string, unknown>;
    return {
      symbol: (h.symbol as string) ?? "",
      name: h.name as string | undefined,
      value: Number(h.value ?? h.market_value ?? 0),
      weight: Number(h.weight ?? h.weight_in_category ?? 0),
    };
  });

  return {
    allocations,
    totalValue: Number(
      (candidate.totalValue as number | string | undefined) ??
        (candidate.total_value as number | string | undefined) ??
        allocations.reduce((sum, c) => sum + c.value, 0),
    ),
    currency: (candidate.currency as string | undefined) ?? fallbackCurrency,
    groupBy:
      (candidate.groupBy as string | undefined) ?? (candidate.group_by as string | undefined) ?? "",
    taxonomyId:
      (candidate.taxonomyId as string | undefined) ?? (candidate.taxonomy_id as string | undefined),
    taxonomyName:
      (candidate.taxonomyName as string | undefined) ??
      (candidate.taxonomy_name as string | undefined),
    holdings,
    categoryName:
      (candidate.categoryName as string | undefined) ??
      (candidate.category_name as string | undefined),
  };
}

// ============================================================================
// Tool UI Component
// ============================================================================

export const AllocationToolUI = makeAssistantToolUI<
  GetAssetAllocationArgs,
  GetAssetAllocationOutput
>({
  toolName: "get_asset_allocation",
  render: (props) => {
    return <AllocationContent {...props} />;
  },
});

type AllocationContentProps = ToolCallMessagePartProps<
  GetAssetAllocationArgs,
  GetAssetAllocationOutput
>;

const AllocationContent = memo(AllocationContentImpl);

function AllocationContentImpl({ args, result, status }: AllocationContentProps) {
  const { t } = useTranslation();
  const typedArgs = args as GetAssetAllocationArgs | undefined;
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = normalizeResult(result, baseCurrency);

  // Detect drill-down mode (holdings may be empty for a valid category)
  const isDrillDown = parsed?.holdings !== undefined;

  // Sort categories by value descending
  const sortedCategories = useMemo(() => {
    if (!parsed?.allocations) return [];
    return [...parsed.allocations].filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  }, [parsed?.allocations]);

  // Sort holdings by value descending
  const sortedHoldings = useMemo(() => {
    if (!parsed?.holdings) return [];
    return [...parsed.holdings].sort((a, b) => b.value - a.value);
  }, [parsed?.holdings]);

  const currency = parsed?.currency ?? baseCurrency;
  const totalValue = parsed?.totalValue ?? 0;

  const formatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    [currency],
  );

  const taxonomyName = parsed?.taxonomyName ?? t("ai:allocation.defaultTitle");
  const categoryName = parsed?.categoryName;
  const isLoading = status?.type === "running";
  const isComplete = status?.type === "complete" || status?.type === "incomplete";
  const hasError = status?.type === "incomplete" && status.reason === "error";
  const categoryCount = sortedCategories.length;
  const holdingsCount = sortedHoldings.length;

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:allocation.fetched")} />;
  }

  // Format value with privacy
  const formatValue = (value: number) => {
    if (isBalanceHidden) {
      return "******";
    }
    return formatter.format(value);
  };

  // Calculate total for percentages
  const computedTotal = useMemo(() => {
    return sortedCategories.reduce((sum, c) => sum + c.value, 0);
  }, [sortedCategories]);

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">{t("ai:allocation.title")}</CardTitle>
              <Skeleton className="mt-1 h-3 w-16" />
            </div>
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="mt-2">
            <Skeleton className="h-7 w-32" />
          </div>
        </CardHeader>
        <CardContent className="pb-4">
          <Skeleton className="mb-4 h-6 w-full rounded-md" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-3 rounded-sm" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (hasError) {
    return (
      <Card className="bg-muted/40 border-destructive/30 w-full">
        <CardContent className="py-4">
          <p className="text-destructive text-sm">{t("ai:allocation.error")}</p>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (isComplete && categoryCount === 0 && holdingsCount === 0) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full">
        <CardContent className="py-4">
          <p className="text-muted-foreground text-sm">{t("ai:allocation.empty")}</p>
        </CardContent>
      </Card>
    );
  }

  // Drill-down mode: show holdings table
  if (isDrillDown) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">
                {categoryName ?? t("ai:allocation.holdings")}
              </CardTitle>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("ai:allocation.holdingsCount", { count: holdingsCount })}
              </p>
            </div>
            <Badge variant="outline" className="text-xs">
              {t("ai:allocation.drillDown")}
            </Badge>
          </div>
          <div className="mt-2">
            <span className="text-xl font-bold">{formatValue(totalValue)}</span>
          </div>
        </CardHeader>
        <CardContent className="pb-4">
          <div className="max-h-[250px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="pb-2 font-medium">{t("ai:allocation.colSymbol")}</th>
                  <th className="pb-2 font-medium">{t("ai:allocation.colName")}</th>
                  <th className="pb-2 text-right font-medium">{t("ai:allocation.colValue")}</th>
                  <th className="pb-2 text-right font-medium">{t("ai:allocation.colWeight")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map((holding, index) => (
                  <tr key={`${holding.symbol}-${index}`} className="border-border/50 border-b">
                    <td className="py-2 font-medium">{holding.symbol}</td>
                    <td className="text-muted-foreground truncate py-2">{holding.name ?? "-"}</td>
                    <td className="py-2 text-right tabular-nums">{formatValue(holding.value)}</td>
                    <td className="text-muted-foreground py-2 text-right tabular-nums">
                      {formatPercent(holding.weight / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Allocation mode: show stacked bar + legend
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">{taxonomyName}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("ai:allocation.categories", { count: categoryCount })}
            </p>
          </div>
          {typedArgs?.accountId && typedArgs.accountId !== "all" && (
            <Badge variant="outline" className="text-xs uppercase">
              {typedArgs.accountId}
            </Badge>
          )}
        </div>
        <div className="mt-2">
          <span className="text-xl font-bold">{formatValue(totalValue)}</span>
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        <TooltipProvider>
          {/* Horizontal stacked bar */}
          <div className="mb-4 flex h-6 w-full items-center gap-0.5 overflow-hidden rounded-md">
            {sortedCategories.map((category, index) => {
              const percent = computedTotal > 0 ? category.value / computedTotal : 0;
              const widthPercent = percent * 100;

              if (widthPercent < 0.5) return null;

              return (
                <Tooltip key={category.categoryId} delayDuration={100}>
                  <TooltipTrigger asChild>
                    <div
                      className="flex h-full cursor-default items-center justify-center transition-opacity hover:opacity-80"
                      style={{
                        width: `${widthPercent}%`,
                        backgroundColor: category.color || `var(--chart-${(index % 5) + 1})`,
                        minWidth: widthPercent >= 1 ? "4px" : undefined,
                      }}
                    >
                      {widthPercent > 12 && (
                        <span className="text-background truncate px-1 text-[10px] font-medium">
                          {formatPercent(percent)}
                        </span>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="center">
                    <div className="text-center">
                      <span className="text-muted-foreground text-[0.70rem] uppercase">
                        {category.categoryName}
                      </span>
                      <div className="font-medium">{formatPercent(percent)}</div>
                      {!isBalanceHidden && (
                        <div className="text-muted-foreground text-xs">
                          {formatValue(category.value)}
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* Legend list */}
          <div className="max-h-[200px] space-y-1.5 overflow-y-auto">
            {sortedCategories.map((category, index) => {
              const percent = computedTotal > 0 ? category.value / computedTotal : 0;

              return (
                <div
                  key={category.categoryId}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div
                      className="h-3 w-3 flex-shrink-0 rounded-sm"
                      style={{
                        backgroundColor: category.color || `var(--chart-${(index % 5) + 1})`,
                      }}
                    />
                    <span className="text-foreground truncate">{category.categoryName}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3 tabular-nums">
                    <span className="text-muted-foreground w-12 text-right">
                      {formatPercent(percent)}
                    </span>
                    <span className="text-foreground w-20 text-right font-medium">
                      {formatValue(category.value)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
