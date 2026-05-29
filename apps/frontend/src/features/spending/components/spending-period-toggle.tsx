/**
 * Canonical period toggle for spending surfaces that need named comparison
 * periods (1M / 3M / 6M / YTD / 1Y). Used by the Insights page (and any
 * future page that compares period-over-period totals).
 *
 * Why this exists: prior to this primitive each surface inlined its own
 * `AnimatedToggleGroup` config with subtly different labels/items. This file
 * is the single source of truth for the canonical insights period set.
 *
 * Not used by:
 * - The Spending dashboard tab (uses `IntervalSelector` with a wider set
 *   including 1D/1W/5Y/ALL — free-form interval picking, not comparison).
 * - The Budget page (uses `MonthSwitcher` — budgets are inherently
 *   per-month with rollover, no useful "1Y" view).
 *
 * If we ever want cross-page period sync (e.g. picking 3M on the dashboard
 * propagating to insights), expose a `usePersistentSpendingPeriod` hook that
 * wraps a shared storage key. For now each surface owns its own key.
 */
import { AnimatedToggleGroup } from "@wealthfolio/ui";

import { REPORTS_PERIODS, type ReportsPeriod } from "../lib/reports-period";

export const SPENDING_PERIOD_LABELS: Record<ReportsPeriod, string> = {
  "1M": "1M",
  "3M": "3M",
  "6M": "6M",
  YTD: "YTD",
  "1Y": "1Y",
};

interface SpendingPeriodToggleProps {
  value: ReportsPeriod;
  onValueChange: (next: ReportsPeriod) => void;
  /** Visual variant on `AnimatedToggleGroup`. Default mirrors prior call sites. */
  variant?: "default" | "secondary";
  /** Size pass-through. Default "xs" matches the prior insights placement. */
  size?: "xs" | "sm" | "md";
}

export function SpendingPeriodToggle({
  value,
  onValueChange,
  variant = "secondary",
  size = "xs",
}: SpendingPeriodToggleProps) {
  return (
    <AnimatedToggleGroup
      variant={variant}
      size={size}
      items={REPORTS_PERIODS.map((p) => ({ value: p, label: SPENDING_PERIOD_LABELS[p] }))}
      value={value}
      onValueChange={onValueChange}
    />
  );
}
