/**
 * Canonical period toggle for spending surfaces that need named comparison
 * periods (This month / Last month / 3M / 6M / YTD / 1Y). Used by the Insights page
 * and any future page that compares period-over-period totals.
 *
 * Why this exists: prior to this primitive each surface inlined its own
 * `AnimatedToggleGroup` config with subtly different labels/items. This file
 * is the single source of truth for the canonical insights period set.
 *
 * Not used by:
 * - The Budget page (uses `MonthSwitcher` — budgets are inherently
 *   per-month with rollover, no useful "1Y" view).
 *
 * Dashboard links use shared period-preference keys so the most recent explicit
 * dashboard or insights period selection wins when moving between surfaces.
 */
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DateRange } from "@/lib/types";
import { cn } from "@/lib/utils";

import { AnimatedToggleGroup, useIsMobile } from "@wealthfolio/ui";

import { SpendingDatePicker } from "./spending-date-picker";
import { REPORTS_PERIODS, type ReportsPeriod } from "../lib/reports-period";

function useSpendingPeriodLabels(): Record<ReportsPeriod, ReactNode> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      MTD: (
        <>
          <span className="hidden sm:inline">{t("spending:period.thisMonth")}</span>
          <span className="sm:hidden">{t("spending:period.mtdShort")}</span>
        </>
      ),
      LAST_MONTH: (
        <>
          <span className="hidden sm:inline">{t("spending:period.lastMonth")}</span>
          <span className="sm:hidden">{t("spending:period.prevShort")}</span>
        </>
      ),
      "3M": "3M",
      "6M": "6M",
      YTD: "YTD",
      "1Y": "1Y",
    }),
    [t],
  );
}

interface SpendingPeriodToggleProps {
  value: ReportsPeriod | null;
  onValueChange: (next: ReportsPeriod) => void;
  /** Visual variant on `AnimatedToggleGroup`. Default mirrors prior call sites. */
  variant?: "default" | "secondary";
  /** Size pass-through. Default "xs" matches the prior insights placement. */
  size?: "compact" | "xs" | "sm" | "md";
  className?: string;
}

export function SpendingPeriodToggle({
  value,
  onValueChange,
  variant = "secondary",
  size = "xs",
  className,
}: SpendingPeriodToggleProps) {
  const labels = useSpendingPeriodLabels();
  return (
    <AnimatedToggleGroup
      variant={variant}
      size={size}
      items={REPORTS_PERIODS.map((p) => ({ value: p, label: labels[p] }))}
      value={value}
      onValueChange={onValueChange}
      className={className}
    />
  );
}

interface SpendingPeriodSelectorProps {
  value: ReportsPeriod | null;
  onValueChange: (next: ReportsPeriod) => void;
  customMonth: string | null;
  customRange?: DateRange;
  maxMonth: string;
  onCustomMonthChange: (monthKey: string | null) => void;
  onCustomRangeChange?: (range: DateRange | undefined) => void;
  isLoading?: boolean;
  className?: string;
}

export function SpendingPeriodSelector({
  value,
  onValueChange,
  customMonth,
  customRange,
  maxMonth,
  onCustomMonthChange,
  onCustomRangeChange,
  isLoading,
  className,
}: SpendingPeriodSelectorProps) {
  const isMobile = useIsMobile();

  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-full items-center justify-center gap-1.5",
        className,
      )}
      aria-busy={isLoading ? "true" : undefined}
    >
      <SpendingPeriodToggle
        value={value}
        onValueChange={onValueChange}
        size={isMobile ? "compact" : "sm"}
        variant="default"
        className="min-w-0 bg-transparent"
      />
      <SpendingDatePicker
        customMonth={customMonth}
        customRange={customRange}
        maxMonth={maxMonth}
        onCustomMonthChange={onCustomMonthChange}
        onCustomRangeChange={onCustomRangeChange}
      />
    </div>
  );
}
