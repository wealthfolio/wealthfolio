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
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import {
  AnimatedToggleGroup,
  Icons,
  MonthYearPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  useIsMobile,
} from "@wealthfolio/ui";

import { compactMonthLabel } from "../lib/month-period";
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
  maxMonth: string;
  onCustomMonthChange: (monthKey: string | null) => void;
  isLoading?: boolean;
  className?: string;
}

export function SpendingPeriodSelector({
  value,
  onValueChange,
  customMonth,
  maxMonth,
  onCustomMonthChange,
  isLoading,
  className,
}: SpendingPeriodSelectorProps) {
  const isMobile = useIsMobile();

  return (
    <div
      className={cn(
        "pointer-events-none relative w-full min-w-0 max-w-full overflow-hidden",
        className,
      )}
      aria-busy={isLoading ? "true" : undefined}
    >
      <div
        className={cn(
          "pointer-events-none relative z-30 flex w-full justify-start overflow-x-auto overflow-y-hidden sm:justify-center",
          "touch-pan-x snap-x snap-mandatory overscroll-x-contain scroll-smooth",
          "px-2 md:px-0",
          "[&::-webkit-scrollbar]:hidden",
          "[scrollbar-width:none]",
          "[-webkit-overflow-scrolling:touch]",
        )}
      >
        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          <SpendingPeriodToggle
            value={value}
            onValueChange={onValueChange}
            size={isMobile ? "compact" : "sm"}
            variant="default"
            className="bg-transparent"
          />
          <MonthPickerButton
            value={customMonth}
            defaultViewMonth={maxMonth}
            maxDate={maxMonth}
            onSelect={onCustomMonthChange}
            onClear={customMonth ? () => onCustomMonthChange(null) : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function MonthPickerButton({
  value,
  defaultViewMonth,
  maxDate,
  onSelect,
  onClear,
}: {
  value: string | null;
  defaultViewMonth: string;
  maxDate: string;
  onSelect: (monthKey: string) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const label = value ? compactMonthLabel(value) : null;
  const trigger = (
    <button
      type="button"
      className={cn(
        "flex h-8 items-center justify-center rounded-full transition-colors",
        label
          ? "bg-background/80 border-border/60 gap-1 border px-2.5 text-xs font-medium"
          : "bg-muted text-foreground/90 hover:text-foreground w-8",
      )}
      aria-label={
        label ? t("spending:period.viewingMonth", { label }) : t("spending:period.pickMonth")
      }
    >
      {label ? <span>{label}</span> : <Icons.Calendar className="h-3.5 w-3.5" />}
    </button>
  );
  const picker = (
    <MonthYearPicker
      value={value ?? defaultViewMonth}
      maxDate={maxDate}
      className={
        isMobile
          ? "w-full max-w-none p-0 [&>div:first-child]:mb-5 [&>div:first-child_button]:h-11 [&>div:first-child_button]:w-11 [&_.grid]:gap-3 [&_.grid_button]:h-12 [&_.grid_button]:text-base"
          : undefined
      }
      onChange={(monthKey) => {
        onSelect(monthKey);
        setOpen(false);
      }}
    />
  );

  return (
    <div className="flex items-center gap-1">
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-4xl mx-1 p-0">
            <SheetHeader className="border-border border-b px-6 py-4">
              <SheetTitle>{t("spending:period.selectMonth")}</SheetTitle>
            </SheetHeader>
            <div className="px-5 py-5 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)]">
              {picker}
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="center">
            {picker}
          </PopoverContent>
        </Popover>
      )}
      {label && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground flex h-5 w-5 items-center justify-center rounded-full text-base leading-none transition-colors"
          aria-label={t("spending:period.clearMonth")}
        >
          ×
        </button>
      )}
    </div>
  );
}
