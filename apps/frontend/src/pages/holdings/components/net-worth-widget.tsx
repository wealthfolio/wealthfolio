import { Card } from "@wealthfolio/ui/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { PrivacyAmount } from "@wealthfolio/ui";
import { useNetWorth } from "@/hooks/use-alternative-assets";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn, parseLocalDate } from "@/lib/utils";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface NetWorthWidgetProps {
  /** Optional date for as-of calculation (ISO format: YYYY-MM-DD). Defaults to today. */
  date?: string;
  /** Whether to show the category breakdown. Defaults to false. */
  showBreakdown?: boolean;
  /** Compact mode for smaller placements. Defaults to false. */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

interface BreakdownItem {
  label: string;
  value: number;
  isDebt?: boolean;
}

/**
 * Checks if a valuation is stale (older than 90 days)
 */
function isValuationStale(dateStr: string): boolean {
  const date = parseLocalDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > 90;
}

/**
 * Formats a date string to a human-readable format
 */
function formatDate(dateStr: string): string {
  const date = parseLocalDate(dateStr);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Loading skeleton for the NetWorthWidget
 */
const NetWorthWidgetSkeleton = ({ compact = false }: { compact?: boolean }) => (
  <Card className={cn("p-4", compact && "p-3")}>
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton className={cn("h-4 w-24", compact && "h-3 w-20")} />
        <Skeleton className="h-4 w-4" />
      </div>

      {/* Main amount */}
      <Skeleton className={cn("h-8 w-40", compact && "h-6 w-32")} />

      {/* Assets/Debts row */}
      <div className="flex items-center justify-between gap-4 pt-2">
        <div className="space-y-1">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-5 w-24" />
        </div>
      </div>
    </div>
  </Card>
);

/**
 * Error state for the NetWorthWidget
 */
const NetWorthWidgetError = ({ error, compact = false }: { error: Error; compact?: boolean }) => {
  const { t } = useTranslation();
  return (
    <Card className={cn("p-4", compact && "p-3")}>
      <div className="flex items-start gap-3">
        <div className="bg-destructive/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
          <Icons.AlertTriangle className="text-destructive h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-destructive text-sm font-medium">
            {t("holdings:failed_to_load_net_worth")}
          </p>
          <p className="text-muted-foreground mt-1 break-words text-xs">
            {error?.message || t("holdings:unexpected_error")}
          </p>
        </div>
      </div>
    </Card>
  );
};

/**
 * A breakdown row item showing label and value
 */
const BreakdownRow = ({
  item,
  currency,
  compact,
}: {
  item: BreakdownItem;
  currency: string;
  compact: boolean;
}) => (
  <div className="flex items-center justify-between py-1.5">
    <span className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>
      {item.label}
    </span>
    <span
      className={cn(
        "font-medium",
        compact ? "text-xs" : "text-sm",
        item.isDebt && "text-destructive",
      )}
    >
      {item.isDebt && "-"}
      <PrivacyAmount value={item.value} currency={currency} />
    </span>
  </div>
);

/**
 * NetWorthWidget - A reusable component that displays the user's net worth
 *
 * Features:
 * - Total net worth as the primary number
 * - Assets vs Debts breakdown
 * - Optional expandable category breakdown (investments, properties, vehicles, etc.)
 * - Staleness warning if any valuations are >90 days old
 * - Loading and error states
 * - Compact mode for smaller placements
 */
export const NetWorthWidget = ({
  date,
  showBreakdown = false,
  compact = false,
  className,
}: NetWorthWidgetProps) => {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const { data: netWorthData, isLoading, isError, error } = useNetWorth({ date });

  const [isBreakdownOpen, setIsBreakdownOpen] = useState(false);

  // Parse numeric values from the response (stored as strings for precision)
  const parsedValues = useMemo(() => {
    if (!netWorthData) return null;

    return {
      netWorth: parseFloat(netWorthData.netWorth) || 0,
      totalAssets: parseFloat(netWorthData.assets.total) || 0,
      totalLiabilities: parseFloat(netWorthData.liabilities.total) || 0,
      assetsBreakdown: netWorthData.assets.breakdown.map((item) => ({
        label: item.name,
        value: parseFloat(item.value) || 0,
      })),
      liabilitiesBreakdown: netWorthData.liabilities.breakdown.map((item) => ({
        label: item.name,
        value: parseFloat(item.value) || 0,
        isDebt: true,
      })),
    };
  }, [netWorthData]);

  // Build breakdown items for display
  const breakdownItems = useMemo((): BreakdownItem[] => {
    if (!parsedValues) return [];

    // Combine assets and liabilities breakdown
    return [...parsedValues.assetsBreakdown, ...parsedValues.liabilitiesBreakdown];
  }, [parsedValues]);

  // Check for stale valuations
  const hasStaleValuations = useMemo(() => {
    if (!netWorthData) return false;
    return (
      netWorthData.staleAssets.length > 0 ||
      (netWorthData.oldestValuationDate && isValuationStale(netWorthData.oldestValuationDate))
    );
  }, [netWorthData]);

  const currency = netWorthData?.currency || settings?.baseCurrency || "USD";

  // Loading state
  if (isLoading) {
    return <NetWorthWidgetSkeleton compact={compact} />;
  }

  // Error state
  if (isError && error) {
    return <NetWorthWidgetError error={error} compact={compact} />;
  }

  // No data state
  if (!parsedValues) {
    return null;
  }

  const hasBreakdownData = breakdownItems.length > 0;

  return (
    <Card className={cn("p-4", compact && "p-3", className)}>
      <div className="space-y-3">
        {/* Header with title and staleness warning */}
        <div className="flex items-center justify-between">
          <span
            className={cn(
              "text-muted-foreground font-medium uppercase tracking-wider",
              compact ? "text-[10px]" : "text-xs",
            )}
          >
            {t("holdings:net_worth")}
          </span>

          {hasStaleValuations && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1">
                    <Icons.AlertCircle className="text-warning h-4 w-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[250px]">
                  <p className="text-sm">
                    {t("holdings:stale_valuations_warning")}
                    {netWorthData?.oldestValuationDate && (
                      <>
                        {" "}
                        {t("holdings:last_update", {
                          date: formatDate(netWorthData.oldestValuationDate),
                        })}
                      </>
                    )}
                  </p>
                  {netWorthData && netWorthData.staleAssets.length > 0 && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {t("holdings:assets_need_valuations", {
                        count: netWorthData.staleAssets.length,
                      })}
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Main net worth amount */}
        <div
          className={cn(
            "font-semibold tracking-tight",
            compact ? "text-xl" : "text-2xl sm:text-3xl",
          )}
        >
          <PrivacyAmount value={parsedValues.netWorth} currency={currency} />
        </div>

        {/* Assets and Debts summary */}
        <div className="flex items-start justify-between gap-4 pt-1">
          <div className="flex flex-col gap-0.5">
            <span
              className={cn(
                "text-muted-foreground font-medium uppercase",
                compact ? "text-[9px]" : "text-[10px]",
              )}
            >
              {t("holdings:summary_assets")}
            </span>
            <span className={cn("text-success font-medium", compact ? "text-sm" : "text-base")}>
              <PrivacyAmount value={parsedValues.totalAssets} currency={currency} />
            </span>
          </div>

          <div className="flex flex-col items-end gap-0.5">
            <span
              className={cn(
                "text-muted-foreground font-medium uppercase",
                compact ? "text-[9px]" : "text-[10px]",
              )}
            >
              {t("holdings:summary_debts")}
            </span>
            <span className={cn("text-destructive font-medium", compact ? "text-sm" : "text-base")}>
              <PrivacyAmount value={parsedValues.totalLiabilities} currency={currency} />
            </span>
          </div>
        </div>

        {/* Optional breakdown by category */}
        {showBreakdown && hasBreakdownData && (
          <Collapsible open={isBreakdownOpen} onOpenChange={setIsBreakdownOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted/50 flex w-full items-center justify-between rounded-md py-2 transition-colors"
              >
                <span
                  className={cn(
                    "text-muted-foreground font-medium",
                    compact ? "text-xs" : "text-sm",
                  )}
                >
                  {t("holdings:category_breakdown")}
                </span>
                <Icons.ChevronDown
                  className={cn(
                    "text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200",
                    isBreakdownOpen && "rotate-180",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-border/50 divide-border/50 divide-y border-t pt-1">
                {breakdownItems.map((item) => (
                  <BreakdownRow
                    key={item.label}
                    item={item}
                    currency={currency}
                    compact={compact}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Card>
  );
};

export default NetWorthWidget;
