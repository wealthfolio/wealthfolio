import type { TaxonomyAllocation } from "@/lib/types";
import { formatPercent, PrivacyAmount } from "@wealthfolio/ui";
import { Card } from "@wealthfolio/ui/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type VariantType = "security-types" | "risk-composition";

interface CompactAllocationStripProps {
  title: string;
  allocation?: TaxonomyAllocation;
  baseCurrency?: string;
  isLoading?: boolean;
  variant?: VariantType;
  onSegmentClick?: (categoryId: string, categoryName: string) => void;
}

// Theme colors for Security Types
const THEME_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

// Risk colors - muted Flexoki tones that don't attract attention
const RISK_COLORS: Record<string, string> = {
  low: "var(--color-green-150)",
  medium: "var(--color-yellow-150)",
  high: "var(--color-orange-200)",
  unknown: "var(--color-base-200)",
};

// Fixed order for risk categories - ALWAYS in this order
const RISK_ORDER = ["low", "medium", "high", "unknown"] as const;

// Compact label translation keys for risk
const RISK_LABEL_KEYS: Record<string, string> = {
  low: "holdings:risk_low",
  medium: "holdings:risk_medium",
  high: "holdings:risk_high",
  unknown: "holdings:risk_none",
};

function normalizeRiskName(name: string): string {
  return name.toLowerCase().trim();
}

export function CompactAllocationStrip({
  title,
  allocation,
  baseCurrency = "USD",
  isLoading,
  variant = "security-types",
  onSegmentClick,
}: CompactAllocationStripProps) {
  const { t } = useTranslation();
  const processedCategories = useMemo(() => {
    if (!allocation?.categories?.length) return [];

    const cats = allocation.categories.filter((cat) => cat.value > 0);
    const total = cats.reduce((sum, c) => sum + c.value, 0);
    if (total === 0) return [];

    if (variant === "risk-composition") {
      // Fixed order: Low → Medium → High → Unknown
      // Always include all slots to preserve mental model consistency
      const ordered = RISK_ORDER.map((riskLevel) => {
        const found = cats.find((c) => normalizeRiskName(c.categoryName) === riskLevel);
        const value = found?.value ?? 0;
        const percent = total > 0 ? (value / total) * 100 : 0;
        return {
          id: found?.categoryId ?? riskLevel,
          name: found?.categoryName ?? riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1),
          label: RISK_LABEL_KEYS[riskLevel] ? t(RISK_LABEL_KEYS[riskLevel]) : riskLevel,
          value,
          percent,
          color: RISK_COLORS[riskLevel] ?? RISK_COLORS.unknown,
          isEmpty: value === 0,
        };
      });

      return ordered;
    }

    // Security Types: sort by % descending, max 3, merge rest to Other
    const sorted = cats
      .map((c) => ({
        id: c.categoryId,
        name: c.categoryName,
        label: c.categoryName,
        value: c.value,
        percent: (c.value / total) * 100,
        isEmpty: false,
      }))
      .sort((a, b) => b.percent - a.percent);

    const maxCategories = 3;
    if (sorted.length <= maxCategories) {
      return sorted.map((c, i) => ({
        ...c,
        color: THEME_COLORS[i % THEME_COLORS.length],
      }));
    }

    const top = sorted.slice(0, maxCategories);
    const rest = sorted.slice(maxCategories);
    const otherValue = rest.reduce((sum, c) => sum + c.value, 0);
    const otherPercent = rest.reduce((sum, c) => sum + c.percent, 0);

    return [
      ...top.map((c, i) => ({
        ...c,
        color: THEME_COLORS[i % THEME_COLORS.length],
      })),
      {
        id: "other",
        name: t("holdings:other"),
        label: t("holdings:other"),
        value: otherValue,
        percent: otherPercent,
        color: THEME_COLORS[THEME_COLORS.length - 1],
        isEmpty: false,
      },
    ];
  }, [allocation, variant, t]);

  if (isLoading) {
    return (
      <Card className="p-3">
        <div className="bg-muted/50 mb-2 h-4 w-24 animate-pulse rounded" />
        <div className="bg-muted/30 mb-2 h-5 w-full animate-pulse rounded" />
        <div className="flex gap-3">
          <div className="bg-muted/50 h-4 w-16 animate-pulse rounded" />
          <div className="bg-muted/50 h-4 w-16 animate-pulse rounded" />
        </div>
      </Card>
    );
  }

  if (processedCategories.length === 0) {
    return (
      <Card className="p-3">
        <p className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
          {title}
        </p>
        <p className="text-muted-foreground mt-2 text-xs">{t("holdings:no_data")}</p>
      </Card>
    );
  }

  return (
    <Card className="p-3">
      <TooltipProvider>
        {/* Title */}
        <p className="text-muted-foreground mb-2 text-sm font-medium uppercase tracking-wider">
          {title}
        </p>

        {/* Stacked bar - prominent height with 1px separators */}
        <div className="mb-2 flex h-5 w-full overflow-hidden rounded">
          {processedCategories.map((category, index) => {
            const isRisk = variant === "risk-composition";
            const isEmpty = isRisk && "isEmpty" in category && category.isEmpty;
            const isLast = index === processedCategories.length - 1;

            return (
              <Tooltip key={category.id} delayDuration={100}>
                <TooltipTrigger asChild>
                  <div
                    className={`h-full transition-opacity ${isEmpty ? "" : "cursor-pointer hover:opacity-80"}`}
                    style={{
                      width: isEmpty ? "1px" : `${category.percent}%`,
                      backgroundColor: isEmpty ? "var(--color-base-200)" : category.color,
                      opacity: isEmpty ? 0.5 : 1,
                      // 1px separator via box-shadow (no extra DOM)
                      boxShadow: isLast ? "none" : "inset -1px 0 0 var(--background)",
                    }}
                    onClick={() => !isEmpty && onSegmentClick?.(category.id, category.name)}
                    role={isEmpty ? undefined : "button"}
                    tabIndex={isEmpty ? -1 : 0}
                    onKeyDown={(e) => {
                      if (!isEmpty && (e.key === "Enter" || e.key === " ")) {
                        onSegmentClick?.(category.id, category.name);
                      }
                    }}
                  />
                </TooltipTrigger>
                {!isEmpty && (
                  <TooltipContent side="top" align="center">
                    <div className="text-center">
                      <span className="text-muted-foreground text-[0.70rem] uppercase">
                        {category.name}
                      </span>
                      <div className="font-medium">{formatPercent(category.percent / 100)}</div>
                      <div className="text-muted-foreground text-xs">
                        <PrivacyAmount value={category.value} currency={baseCurrency} />
                      </div>
                    </div>
                  </TooltipContent>
                )}
              </Tooltip>
            );
          })}
        </div>

        {/* Legend row with micro chips - always show all risk categories */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {processedCategories.map((category) => {
            const isRisk = variant === "risk-composition";
            const isEmpty = isRisk && "isEmpty" in category && category.isEmpty;

            return (
              <div
                key={category.id}
                className={`flex items-center gap-1.5 text-xs transition-opacity ${isEmpty ? "opacity-50" : "cursor-pointer hover:opacity-70"}`}
                onClick={() => !isEmpty && onSegmentClick?.(category.id, category.name)}
                role={isEmpty ? undefined : "button"}
                tabIndex={isEmpty ? -1 : 0}
                onKeyDown={(e) => {
                  if (!isEmpty && (e.key === "Enter" || e.key === " ")) {
                    onSegmentClick?.(category.id, category.name);
                  }
                }}
              >
                <span
                  className="h-2.5 w-1 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: isEmpty ? "var(--color-base-200)" : category.color,
                  }}
                />
                <span className="text-muted-foreground">{category.label}</span>
                <span className="text-foreground font-medium">{Math.round(category.percent)}%</span>
              </div>
            );
          })}
        </div>
      </TooltipProvider>
    </Card>
  );
}
