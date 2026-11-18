import {
  DASHBOARD_INTERVAL_STORAGE_KEY,
  DASHBOARD_PERIOD_STORAGE_KEY,
  pickForPortfolioRange,
  portfolioViewForPick,
  type DashboardPeriodPick,
} from "@/features/spending/lib/dashboard-period-sync";
import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { useSettingsContext } from "@/lib/settings-provider";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { BenchmarkSymbolSelector } from "@/components/benchmark-symbol-selector";
import {
  ANNUALIZED_RETURN_INFO_KEY as annualizedReturnInfo,
  MAX_DRAWDOWN_INFO_KEY as maxDrawdownInfo,
  MetricInfoPopoverBody,
  metricWarningItems,
  MONEY_WEIGHTED_RETURN_INFO_KEY,
  PRICE_RETURN_INFO_KEY,
  RETURN_ON_COST_INFO_KEY,
  SIMPLE_RETURN_INFO_KEY,
  TIME_WEIGHTED_RETURN_INFO_KEY,
  VOLATILITY_INFO_KEY as volatilityInfo,
} from "@/components/metric-display";
import { PerformanceChart, type PerformanceChartSeries } from "@/components/performance-chart";
import type { AccountScope, PerformanceReturnViewKey } from "@/lib/types";

import { PERFORMANCE_CHART_COLORS } from "@/components/performance-chart-colors";
import { useAccounts } from "@/hooks/use-accounts";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useAccountScopeStore } from "@/lib/account-scope-store";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { AccountPurpose, PORTFOLIO_SCOPE_ID } from "@/lib/constants";
import {
  performancePeriodPnl,
  performanceViewAnnualized,
  performanceViewReason,
  performanceViewReturn,
  presentedReturn,
  shouldDisplayAnnualizedPerformanceReturn,
  type ChosenReturnView,
} from "@/lib/performance";
import {
  ReturnMethodToggle,
  returnReasonText,
  returnViewName,
  returnViewShortName,
} from "@/components/return-percent";
import { useReturnMethod } from "@/hooks/use-return-method";
import { getPerformanceDateRangeForRequest } from "@/lib/performance-date-range";
import { DateRange, PerformanceResult, TrackedItem } from "@/lib/types";
import { cn, parseLocalDate } from "@/lib/utils";
import {
  AlertFeedback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselItem,
  DateRangeSelector,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  GainPercent,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PrivacyAmount,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  useDateFormatting,
  useNumberFormatting,
  type FormattingApi,
} from "@wealthfolio/ui";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@wealthfolio/ui/components/ui/empty";
import { isSameDay, subDays, subMonths } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccountSelector } from "../../components/account-selector";
import { AccountSelectorMobile } from "../../components/account-selector-mobile";
import { BenchmarkSymbolSelectorMobile } from "../../components/benchmark-symbol-selector-mobile";
import { useCalculatePerformanceHistory } from "./hooks/use-performance-data";
import {
  chartViewFor,
  comparablePerformanceChartData,
  type PerformanceMetric,
} from "./performance-chart-series";
import {
  ALL_PORTFOLIO_ITEM,
  migratePerformanceSelectedItemId,
  migratePerformanceSelectedItems,
  prunePerformanceSelectedItems,
} from "./performance-selection";
import { usePerformanceScopeBridge } from "./hooks/use-performance-scope-bridge";

type TFunction = ReturnType<typeof useTranslation>["t"];

// Helper function to sort comparison items (accounts first, then symbols)
function sortComparisonItems(items: TrackedItem[]): TrackedItem[] {
  return [...items].sort((a, b) => {
    // Sort by type first (accounts before symbols)
    if (a.type !== b.type) {
      return a.type === "account" ? -1 : 1;
    }
    // If same type, maintain original order
    return 0;
  });
}

/** Only the reserved all-portfolio item is synthetic; real account/portfolio names stay raw. */
function performanceItemLabel(item: { id: string; name: string }, t: TFunction): string {
  return item.id === PORTFOLIO_SCOPE_ID ? t("performance:all_portfolio") : item.name;
}

function trackingModeBadge(
  result: PerformanceResult,
  t: TFunction,
): {
  label: string;
  variant: "outline" | "warning";
} | null {
  if (result.isMixedTrackingMode) {
    return { label: t("performance:tracking_mode.mixed"), variant: "warning" };
  }
  if (result.isHoldingsMode) {
    return {
      label: t("performance:tracking_mode.holdings"),
      variant: "outline",
    };
  }
  return null;
}

type ChartExclusionKind = "missingData" | "dateOverlap";

interface ChartExclusion {
  kind: ChartExclusionKind;
  message: string;
}

function chartExclusion(
  result: PerformanceResult | undefined,
  metric: PerformanceMetric | PerformanceReturnViewKey,
  t: TFunction,
): ChartExclusion {
  if (!result) {
    return {
      kind: "missingData",
      message: t("performance:exclusion.no_data"),
    };
  }
  // A return the engine reports as unavailable has no line worth drawing; the
  // engine says why (e.g. no time-weighted return over a holdings account's
  // full history).
  if (
    (metric === "twr" || metric === "moneyWeighted" || metric === "returnOnCost") &&
    (performanceViewReturn(result, metric) == null ||
      (result.returns[metric].series ?? []).length < 2)
  ) {
    return {
      kind: "missingData",
      message: performanceViewReason(result, metric) ?? t("performance:exclusion.no_data"),
    };
  }

  return {
    kind: "dateOverlap",
    message: t("performance:exclusion.no_overlap"),
  };
}

function comparisonNoticeMessage(kinds: ChartExclusionKind[], t: TFunction): string {
  if (kinds.includes("missingData")) {
    return t("performance:comparison_notice.missing_return");
  }
  return t("performance:comparison_notice.not_enough_overlap");
}

function metricPresentation(
  metric: PerformanceMetric | PerformanceReturnViewKey,
  t: TFunction,
): {
  label: string;
  infoText: string;
} {
  switch (metric) {
    case "twr":
      return {
        label: t("performance:metric.time_weighted_return"),
        infoText: t(TIME_WEIGHTED_RETURN_INFO_KEY),
      };
    case "moneyWeighted":
      return {
        label: t("performance:metric.money_weighted_return"),
        infoText: t(MONEY_WEIGHTED_RETURN_INFO_KEY),
      };
    case "returnOnCost":
      return {
        label: t("performance:metric.return_on_cost"),
        infoText: t(RETURN_ON_COST_INFO_KEY),
      };
    case "volatility":
      return {
        label: t("performance:metric.volatility"),
        infoText: t(volatilityInfo),
      };
    case "drawdown":
      return {
        label: t("performance:metric.max_drawdown"),
        infoText: t(maxDrawdownInfo),
      };
  }
}

/**
 * A benchmark's views: its time-weighted view is the price return, and its
 * money-weighted view replays the selected scope's deposits into it.
 */
function benchmarkPresentation(
  view: PerformanceReturnViewKey,
  t: TFunction,
): { label: string; shortLabel: string; infoText: string } {
  if (view === "moneyWeighted") {
    return {
      label: t("performance:metric.benchmark_money_weighted"),
      shortLabel: t("performance:metric.benchmark_money_weighted_short"),
      infoText: t("performance:metric_info.benchmark_money_weighted"),
    };
  }
  return {
    label: t("performance:metric.price_return"),
    shortLabel: t("performance:metric.price_return_short"),
    infoText: t(PRICE_RETURN_INFO_KEY),
  };
}

function stripReturnLabel(label: string | undefined, t: TFunction): string {
  switch (label) {
    case t("performance:metric.time_weighted_return"):
      return t("performance:metric.time_weighted_short");
    case t("performance:metric.money_weighted_return"):
      return t("performance:metric.money_weighted_short");
    case t("performance:metric.return_on_cost"):
      return t("performance:metric.return_on_cost_short");
    case t("performance:metric.price_return"):
      return t("performance:metric.price_return_short");
    case t("performance:metric.benchmark_money_weighted"):
      return t("performance:metric.benchmark_money_weighted_short");
    default:
      return label ?? t("performance:metric.return");
  }
}

function riskValue(result: PerformanceResult, metric: "volatility" | "drawdown"): number | null {
  const value = metric === "volatility" ? result.risk.volatility : result.risk.maxDrawdown;
  return value == null ? null : Number(value);
}

/** The other method's figure for the panel: its yearly rate from one year, else the period. */
function otherMethodFigure(
  result: PerformanceResult,
  view: ChosenReturnView,
  t: TFunction,
): { value: number | null; label: string; shortLabel: string } {
  const annualized = shouldDisplayAnnualizedPerformanceReturn(result)
    ? performanceViewAnnualized(result, view)
    : null;
  const isMoneyWeighted = view === "moneyWeighted";
  if (annualized != null) {
    return {
      value: annualized,
      label: t(
        isMoneyWeighted ? "performance:metric.annualized_mwr" : "performance:metric.annualized_twr",
      ),
      shortLabel: t(
        isMoneyWeighted ? "performance:metric.ann_mwr_short" : "performance:metric.ann_twr_short",
      ),
    };
  }
  return {
    value: performanceViewReturn(result, view),
    label: t(
      isMoneyWeighted
        ? "performance:metric.money_weighted_return"
        : "performance:metric.time_weighted_return",
    ),
    shortLabel: t(
      isMoneyWeighted ? "performance:metric.mwr_short" : "performance:metric.twr_short",
    ),
  };
}

function firstNotApplicableReason(result: PerformanceResult): string | undefined {
  return result.dataQuality.notApplicableReasons?.[0];
}

function isMoneyWeightedMessage(message: string): boolean {
  return /\bIRR\b|\bMWR\b|money-weighted|XIRR/i.test(message);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DECIMAL_RE = /\d+\.\d+/g;

/** Replace raw account UUIDs embedded in data-quality warnings with human-readable account names. */
function humanizeAccountIds(text: string, namesById: Map<string, string>): string {
  return text.replace(UUID_RE, (id) => namesById.get(id.toLowerCase()) ?? id);
}

/** Trim long raw decimals (e.g. "95.50000000") in warnings to readable amounts. */
function formatWarningNumbers(
  text: string,
  formatting: Pick<FormattingApi, "formatDecimal">,
): string {
  return text.replace(DECIMAL_RE, (value) =>
    formatting.formatDecimal(Number(value), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
}

/** Make a data-quality warning user-facing: real account names + tidy numbers. */
function presentWarning(
  text: string,
  namesById: Map<string, string>,
  formatting: Pick<FormattingApi, "formatDecimal">,
): string {
  return formatWarningNumbers(humanizeAccountIds(text, namesById), formatting);
}

function presentMoneyWeightedWarning(
  text: string,
  namesById: Map<string, string>,
  t: TFunction,
  formatting: Pick<FormattingApi, "formatDecimal">,
): string {
  // The engine's reason for a holdings account's full history, the one MWR
  // reason the app translates.
  if (
    text ===
    "Money-weighted return unavailable over the full history of a holdings account because deposits and withdrawals are not tracked."
  ) {
    return t("performance:exclusion.holdings_not_mwr");
  }
  return presentWarning(text, namesById, formatting)
    .replace(/\bXIRR\b/gi, t("performance:metric.annualized_mwr"))
    .replace(/\bIRR\b/g, "MWR");
}

function MetricValue({
  value,
  className,
  tone = "gain",
}: {
  value: number | null;
  className?: string;
  tone?: "gain" | "neutral";
}) {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  if (value == null) {
    return (
      <span className={cn(className, "text-muted-foreground/50 font-normal")}>
        {t("performance:not_available")}
      </span>
    );
  }

  if (tone === "neutral") {
    return (
      <span className={cn("text-foreground font-medium", className)}>
        {formatting.formatPercent(value)}
      </span>
    );
  }

  return <GainPercent value={value} animated={true} className={className} />;
}

const TILE_CLASS = "bg-muted/40 flex min-w-0 flex-col items-start gap-1.5 rounded-lg px-3 py-2.5";
const TILE_LABEL_CLASS = "text-muted-foreground truncate text-xs font-medium";
const TILE_VALUE_CLASS = "text-lg font-semibold leading-none tabular-nums";

// Phones lead with one large return ("hero") and list the rest in a small row ("mini").
const METRIC_VARIANT_CLASSES = {
  tile: { box: TILE_CLASS, label: TILE_LABEL_CLASS, value: TILE_VALUE_CLASS },
  hero: {
    box: "flex min-w-0 flex-col items-start gap-1.5",
    label: TILE_LABEL_CLASS,
    value: "text-3xl font-semibold leading-none tabular-nums",
  },
  mini: {
    box: "flex min-w-0 flex-col items-start gap-1",
    label: "text-muted-foreground truncate text-2xs font-medium",
    value: "text-sm font-semibold leading-none tabular-nums",
  },
} as const;

/**
 * The mobile reset in globals.css clips every .flex and .grid box, which cut a metric's
 * 44px warning tap area and scrolled it inside the label row. The tile and the phone
 * containers around it opt out.
 */
const METRIC_TAP_AREA_CLASS = "overflow-visible!";

/** One metric in the strip. An unavailable value reads N/A; its reason sits behind the warning. */
function MetricTile({
  label,
  value,
  tone = "gain",
  infoText,
  warningText,
  boldTerms,
  variant = "tile",
  className,
}: {
  label: string;
  value: number | null;
  tone?: "gain" | "neutral";
  infoText: string;
  warningText?: string | string[];
  boldTerms?: string[];
  variant?: keyof typeof METRIC_VARIANT_CLASSES;
  className?: string;
}) {
  const { t } = useTranslation();
  const warningItems = metricWarningItems(warningText);
  const classes = METRIC_VARIANT_CLASSES[variant];

  return (
    <div className={cn(classes.box, METRIC_TAP_AREA_CLASS, className)}>
      <div className={cn("flex max-w-full items-center gap-1", METRIC_TAP_AREA_CLASS)}>
        <span className={classes.label}>{label}</span>
        {warningItems.length > 0 && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  // Stays 16px on touch so the label row keeps its height; the variant's
                  // ::after, grown to 44px here, is the tap area.
                  className="text-warning hover:text-warning z-10 size-4 shrink-0 rounded-full p-0 max-lg:size-4 max-lg:after:-inset-[0.9375rem] pointer-coarse:size-4 pointer-coarse:after:-inset-[0.9375rem]"
                />
              }
            >
              <Icons.AlertTriangle className="h-3 w-3" />
              <span className="sr-only">
                {t("common:component.calculation_note_for", { label })}
              </span>
            </PopoverTrigger>
            <PopoverContent
              className="w-[34rem] max-w-[calc(100vw-2rem)] p-0 text-sm"
              side="bottom"
              align="start"
            >
              <MetricInfoPopoverBody
                infoText={infoText}
                warningItems={warningItems}
                boldTerms={boldTerms}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
      <MetricValue value={value} tone={tone} className={classes.value} />
    </div>
  );
}

interface StripHelpItem {
  label: string;
  infoText: string;
  warningText?: string | string[];
}

function StripHelpPopover({ items }: { items: StripHelpItem[] }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-6 w-6 rounded-full"
            aria-label={t("performance:help.aria_label")}
          />
        }
      >
        <Icons.Info className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-[34rem] max-w-[calc(100vw-2rem)] p-0" side="bottom" align="end">
        <div className="space-y-4 p-5">
          <div>
            <div className="text-sm font-semibold">{t("performance:help.title")}</div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("performance:help.description")}
            </div>
          </div>
          <div className="space-y-3">
            {items.map((item) => {
              const warnings = Array.from(
                new Set(
                  (Array.isArray(item.warningText)
                    ? item.warningText
                    : item.warningText
                      ? [item.warningText]
                      : []
                  )
                    .map((warning) => warning.trim())
                    .filter(Boolean),
                ),
              );
              return (
                <div
                  key={item.label}
                  className="border-border/60 border-t pt-3 first:border-t-0 first:pt-0"
                >
                  <div className="text-xs font-semibold">{item.label}</div>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {item.infoText}
                  </p>
                  {warnings.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {warnings.map((warning) => (
                        <div key={warning} className="text-warning text-xs leading-relaxed">
                          {warning}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface AttributionRow {
  label: string;
  value: number;
  description: string;
}

interface SelectedItemPlotState {
  isPlotted: boolean;
  reason?: string;
  reasonKind?: ChartExclusionKind;
}

const PLOTTED_ITEM_STATE: SelectedItemPlotState = { isPlotted: true };
const PERFORMANCE_HIDDEN_DATE_RANGES = ["1D"] as const;

function amountTone(value: number): string {
  if (value < 0) return "text-loss";
  if (value > 0) return "text-gain";
  return "text-muted-foreground";
}

function AttributionAmount({
  value,
  currency,
  className,
  tone = "semantic",
}: {
  value: number;
  currency: string;
  className?: string;
  tone?: "semantic" | "neutral";
}) {
  return (
    <PrivacyAmount
      value={value}
      currency={currency}
      className={cn(
        "whitespace-nowrap tabular-nums",
        tone === "semantic"
          ? amountTone(value)
          : value === 0
            ? "text-muted-foreground"
            : "text-foreground",
        className,
      )}
    />
  );
}

function AttributionRows({
  rows,
  currency,
  amountTone = "semantic",
}: {
  rows: AttributionRow[];
  currency: string;
  amountTone?: "semantic" | "neutral";
}) {
  return (
    <div className="border-border/60 divide-border/60 divide-y divide-dashed border-y">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-4 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">{row.label}</div>
            <div className="text-muted-foreground mt-1 text-xs">{row.description}</div>
          </div>
          <AttributionAmount
            value={row.value}
            currency={currency}
            tone={amountTone}
            className="text-sm font-medium"
          />
        </div>
      ))}
    </div>
  );
}

function AttributionDetailMetric({
  result,
  itemName,
  dateRangeLabel,
  isMobile,
  label,
  warnings,
  warningTerms,
  inline = false,
}: {
  result: PerformanceResult | null;
  itemName?: string;
  dateRangeLabel: string;
  isMobile: boolean;
  label?: string;
  warnings: string[];
  warningTerms: string[];
  /** A one-line link under the phone's main return, instead of a tile. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const resolvedLabel = label ?? t("performance:attribution.period_gain_loss");
  if (!result) return null;
  // A symbol has no attributed gain: its summary amount is unavailable.
  const periodPnl = performancePeriodPnl(result);
  if (periodPnl == null) return null;
  // A missing mixed-scope return series does not make attributed P&L incomplete.
  // Keep that warning with the return metric, alongside the existing IRR filter.
  const attributionWarnings = warnings.filter(
    (warning) => !warning.startsWith("Return series unavailable for "),
  );
  const isPartial = result.summary?.quality === "partial" && attributionWarnings.length > 0;

  const currency = result.scope.currency;
  const driverRows: AttributionRow[] = [
    {
      label: t("performance:attribution.unrealized_pnl"),
      value: Number(result.attribution.unrealizedPnlChange),
      description: t("performance:attribution.unrealized_pnl_desc"),
    },
    {
      label: t("performance:attribution.realized_pnl"),
      value: Number(result.attribution.realizedPnl),
      description: t("performance:attribution.realized_pnl_desc"),
    },
    {
      label: t("performance:attribution.income"),
      value: Number(result.attribution.income),
      description: t("performance:attribution.income_desc"),
    },
    {
      label: t("performance:attribution.fx_effect"),
      value: Number(result.attribution.fxEffect),
      description: t("performance:attribution.fx_effect_desc"),
    },
    {
      label: t("performance:attribution.fees"),
      value: -Number(result.attribution.fees),
      description: t("performance:attribution.fees_desc"),
    },
    {
      label: t("performance:attribution.taxes"),
      value: -Number(result.attribution.taxes),
      description: t("performance:attribution.taxes_desc"),
    },
  ];
  const flowRows: AttributionRow[] = [
    {
      label: t("performance:attribution.contributions"),
      value: Number(result.attribution.contributions),
      description: t("performance:attribution.contributions_desc"),
    },
    {
      label: t("performance:attribution.distributions"),
      value: -Number(result.attribution.distributions),
      description: t("performance:attribution.distributions_desc"),
    },
  ];

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      {inline ? (
        <Button
          type="button"
          variant="ghost"
          className="group h-auto min-h-0 gap-1.5 px-0 py-0.5 font-normal hover:bg-transparent has-[>svg]:px-0 max-lg:min-h-0 pointer-coarse:min-h-0"
          onClick={() => setIsOpen(true)}
        >
          <AttributionAmount
            value={periodPnl}
            currency={currency}
            className="text-sm font-medium"
          />
          <span className="text-muted-foreground text-xs">{resolvedLabel}</span>
          {isPartial && (
            <Badge variant="warning-subtle" className="text-2xs">
              {t("performance:attribution.partial_data")}
            </Badge>
          )}
          <Icons.ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0 rtl:rotate-180" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          // The button's own centring and border would sit its content lower than the other tiles.
          className={cn(
            TILE_CLASS,
            "hover:bg-muted/70 group h-auto w-full justify-start border-0 text-start font-normal",
          )}
          onClick={() => setIsOpen(true)}
        >
          <span className={TILE_LABEL_CLASS}>{resolvedLabel}</span>
          <span className="flex max-w-full flex-wrap items-center gap-1">
            <AttributionAmount value={periodPnl} currency={currency} className={TILE_VALUE_CLASS} />
            {isPartial && (
              <Badge variant="warning-subtle" className="text-2xs">
                {t("performance:attribution.partial_data")}
              </Badge>
            )}
            <Icons.ChevronRight className="text-muted-foreground/60 group-hover:text-muted-foreground h-3.5 w-3.5 shrink-0 transition-all group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
          </span>
        </Button>
      )}

      <SheetContent
        side={isMobile ? "bottom" : "inline-end"}
        className={cn(
          "flex flex-col p-0",
          isMobile ? "mx-1 h-[85vh] rounded-t-4xl" : "h-full w-full sm:max-w-md",
        )}
        showCloseButton={false}
      >
        <SheetHeader className="border-border border-b px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <SheetTitle className="text-xl">{t("performance:attribution.title")}</SheetTitle>
              <SheetDescription className="truncate">
                {[itemName, dateRangeLabel].filter(Boolean).join(" · ")}
              </SheetDescription>
            </div>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground h-8 w-8 shrink-0"
                />
              }
            >
              <Icons.X className="h-4 w-4" />
              <span className="sr-only">{t("performance:attribution.close")}</span>
            </SheetClose>
          </div>
          <div className="pt-3">
            <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("performance:attribution.period_gain_loss_lower")}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AttributionAmount
                value={periodPnl}
                currency={currency}
                className="text-xl leading-tight font-semibold"
              />
              {isPartial && (
                <Badge variant="warning-subtle">{t("performance:attribution.partial_data")}</Badge>
              )}
            </div>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
          {isPartial && (
            <div
              role="note"
              aria-label={t("performance:attribution.partial_data")}
              className="py-3.5"
            >
              <MetricInfoPopoverBody
                infoText={t("performance:metric.gain_loss_info")}
                warningItems={metricWarningItems(attributionWarnings)}
                boldTerms={warningTerms}
              />
            </div>
          )}
          <div className="py-3.5">
            <div className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
              {t("performance:attribution.performance_drivers")}
            </div>
            <AttributionRows rows={driverRows} currency={currency} />
          </div>

          <div className="py-3.5">
            <div className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
              {t("performance:attribution.cash_flows")}
            </div>
            <AttributionRows rows={flowRows} currency={currency} amountTone="neutral" />
          </div>
        </div>
        <div className="border-border bg-background flex items-center justify-between gap-4 border-t px-6 py-4">
          <div className="text-xs font-medium tracking-wide uppercase">
            {t("performance:attribution.total_gain_loss")}
          </div>
          <AttributionAmount
            value={periodPnl}
            currency={currency}
            className="text-base font-semibold"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PerformanceContent({
  chartData,
  emptyChartReason,
  isLoading,
  hasErrors,
  errorMessages,
  isMobile,
  showEndLabel,
  onScrub,
}: {
  chartData: PerformanceChartSeries[] | undefined;
  /** Why the selected item draws no line, when it has a return. */
  emptyChartReason: string | null;
  isLoading: boolean;
  hasErrors: boolean;
  errorMessages: string[];
  isMobile: boolean;
  showEndLabel: boolean;
  onScrub: (date: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-full w-full flex-col">
      {chartData && chartData.length > 0 && (
        <div className="min-h-0 w-full flex-1">
          <PerformanceChart
            data={chartData}
            compact={isMobile}
            showEndLabel={showEndLabel}
            onScrub={onScrub}
          />
        </div>
      )}

      {!chartData?.length && !isLoading && !hasErrors && (
        <Empty className="mx-auto flex max-w-105 items-center justify-center">
          <EmptyHeader>
            <EmptyMedia variant="icon">{<Icons.BarChart className="size-10" />}</EmptyMedia>
            <EmptyTitle>{t("performance:empty.title")}</EmptyTitle>
            <EmptyDescription>
              {emptyChartReason ?? t("performance:empty.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {/* Modern horizontal loader with improved UX */}
      {isLoading && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="animate-subtle-pulse absolute inset-0 border-2 border-transparent">
            <div className="animate-progress-border bg-primary absolute start-0 top-0 h-[2px] rtl:-scale-x-100"></div>
          </div>
          <div className="absolute end-4 bottom-4">
            <div className="bg-background/80 rounded-md border px-3 py-1.5 shadow-sm backdrop-blur-sm">
              <p className="text-muted-foreground flex items-center text-xs font-medium">
                <span className="bg-primary me-2 inline-block h-2 w-2 animate-pulse rounded-full"></span>
                {t("performance:calculating")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error display using AlertFeedback component */}
      {hasErrors && (
        <div className="w-full">
          <AlertFeedback title={t("performance:error_calculating")} variant="error">
            <div>
              {errorMessages.map((error, index) => (
                <p key={index} className="text-sm">
                  {error}
                </p>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={() => window.location.reload()} variant="default">
                {t("performance:retry")}
              </Button>
            </div>
          </AlertFeedback>
        </div>
      )}
    </div>
  );
}

const SelectedItemBadge = ({
  item,
  isSelected,
  isPlotted,
  isHidden = false,
  plotReason,
  contextLabel,
  onSelect,
  onDelete,
  color,
}: {
  item: TrackedItem;
  isSelected: boolean;
  isPlotted: boolean;
  /** Kept in the comparison but left off the chart. */
  isHidden?: boolean;
  plotReason?: string;
  contextLabel?: string;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  color?: string;
}) => {
  const { t } = useTranslation();
  const label = performanceItemLabel(item, t);
  return (
    <Badge
      className={cn(
        "text-foreground group relative cursor-pointer rounded-md border px-2.5 py-1.5 shadow-sm transition-all sm:px-3",
        "hover:bg-accent/80 hover:shadow-md",
        "has-[[data-badge-select]:focus-visible]:ring-ring has-[[data-badge-select]:focus-visible]:ring-2 has-[[data-badge-select]:focus-visible]:ring-offset-2",
        !isPlotted &&
          "text-muted-foreground bg-muted/30 hover:bg-muted/50 border-dashed shadow-none hover:shadow-sm",
        isSelected && "bg-warning-subtle hover:bg-warning-subtle/70",
        isHidden && "opacity-60",
      )}
      variant="secondary"
      title={plotReason}
    >
      {/* The select button stretches over the whole badge with ::after; the
          remove button sits beside it rather than inside another control. */}
      <button
        type="button"
        data-badge-select=""
        onClick={onSelect}
        aria-pressed={isSelected}
        className="flex cursor-pointer items-center space-x-2 outline-none after:absolute after:inset-0 after:content-[''] sm:space-x-3"
      >
        <div
          className={cn(
            "h-3 w-1 rounded-full sm:h-4",
            !isPlotted
              ? "bg-muted-foreground/35"
              : color
                ? "transition-opacity group-hover:opacity-80"
                : item.type === "account"
                  ? "bg-muted-foreground group-hover:bg-foreground transition-colors"
                  : "bg-warning group-hover:bg-warning transition-colors",
          )}
          style={isPlotted && color ? { backgroundColor: color } : undefined}
        />
        <span className="group-hover:text-foreground max-w-40 truncate text-xs font-medium transition-colors sm:text-sm">
          {label}
        </span>
        {!isPlotted && (
          <span className="bg-background/70 text-muted-foreground text-2xs rounded px-1.5 py-0.5 font-medium">
            {t("performance:not_plotted")}
          </span>
        )}
        {isPlotted && contextLabel && (
          <span className="bg-background/70 text-muted-foreground text-2xs rounded px-1.5 py-0.5 font-medium">
            {contextLabel}
          </span>
        )}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          // Desktop size on touch too; the variant's ::after keeps a larger tap area.
          "relative ms-2 size-5 transition-all duration-150 max-lg:size-5 max-lg:after:-inset-3 pointer-coarse:size-5 pointer-coarse:after:-inset-3",
          "hover:bg-destructive-subtle hover:text-destructive-subtle-foreground hover:scale-110",
          "focus-visible:ring-destructive/50 focus-visible:ring-2",
        )}
        onClick={onDelete}
        aria-label={t("performance:remove_item", { name: label })}
      >
        <Icons.Close className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
      </Button>
    </Badge>
  );
};

interface ComparedSeriesRow {
  item: TrackedItem;
  result: PerformanceResult | null;
  color?: string;
  isPlotted: boolean;
  isActive: boolean;
  isHidden: boolean;
}

const SERIES_TABLE_FOLDED_ROWS = 5;

/** One row per compared item, so their figures sit side by side under the chart. */
function ComparedSeriesTable({
  rows,
  onSelect,
  onToggleHidden,
  scrubValues,
}: {
  rows: ComparedSeriesRow[];
  onSelect: (item: TrackedItem) => void;
  onToggleHidden: (id: string) => void;
  /** While a finger is on the chart: each drawn series' value on that date. */
  scrubValues?: Map<string, number> | null;
}) {
  const { t } = useTranslation();
  const { returnView } = useReturnMethod();
  const [isExpanded, setIsExpanded] = useState(false);
  const canFold = rows.length > SERIES_TABLE_FOLDED_ROWS + 1;
  const shownRows = canFold && !isExpanded ? rows.slice(0, SERIES_TABLE_FOLDED_ROWS) : rows;
  const headClass = "text-muted-foreground px-2 py-2 text-end text-xs font-medium";
  const cellClass = "px-2 py-2 text-end text-sm tabular-nums";

  return (
    <div>
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">{t("performance:series_table.label")}</caption>
        <thead>
          <tr className="border-border/70 border-b">
            <th scope="col" className={cn(headClass, "w-auto text-start")}>
              {t("performance:series_table.name")}
            </th>
            <th scope="col" className={cn(headClass, "w-24")}>
              {t("performance:metric.return")}
            </th>
            <th scope="col" className={cn(headClass, "hidden w-24 sm:table-cell")}>
              {t("performance:metric.volatility")}
            </th>
            <th scope="col" className={cn(headClass, "hidden w-28 sm:table-cell")}>
              {t("performance:metric.max_drawdown_short")}
            </th>
            <td aria-hidden className="w-11" />
          </tr>
        </thead>
        <tbody>
          {shownRows.map((row) => {
            const label = performanceItemLabel(row.item, t);
            const rowReturn = presentedReturn(row.result, returnView);
            const returnValue = scrubValues
              ? (scrubValues.get(row.item.id) ?? null)
              : (rowReturn?.value ?? null);
            const muted = !row.isPlotted || row.isHidden;
            return (
              <tr
                key={row.item.id}
                className={cn(
                  "border-border/50 border-b last:border-b-0",
                  row.isActive && "bg-muted/40",
                )}
              >
                <td className="min-w-0 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => onSelect(row.item)}
                    aria-current={row.isActive ? "true" : undefined}
                    className={cn(
                      "focus-visible:outline-ring flex w-full min-w-0 items-center gap-2 rounded-sm text-start text-sm focus-visible:outline-2",
                      muted && "text-muted-foreground",
                      row.isActive && "font-medium",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-3.5 w-1 shrink-0 rounded-full",
                        !row.color && "bg-muted-foreground/35",
                      )}
                      style={
                        row.color && !row.isHidden ? { backgroundColor: row.color } : undefined
                      }
                    />
                    <span className="truncate">{label}</span>
                    {!row.isPlotted && (
                      <span className="bg-muted text-muted-foreground text-2xs shrink-0 rounded px-1.5 py-0.5 font-medium">
                        {t("performance:not_plotted")}
                      </span>
                    )}
                  </button>
                </td>
                <td className={cn(cellClass, muted && "opacity-60")}>
                  <MetricValue value={returnValue} className="text-sm font-medium" />
                  {!scrubValues && rowReturn?.isFallback && (
                    <span
                      className="text-muted-foreground text-2xs block"
                      title={returnViewName(rowReturn.view, t)}
                    >
                      {returnViewShortName(rowReturn.view, t)}
                    </span>
                  )}
                </td>
                <td className={cn(cellClass, "hidden sm:table-cell", muted && "opacity-60")}>
                  <MetricValue
                    value={row.result ? riskValue(row.result, "volatility") : null}
                    tone="neutral"
                    className="text-sm"
                  />
                </td>
                <td className={cn(cellClass, "hidden sm:table-cell", muted && "opacity-60")}>
                  <MetricValue
                    value={row.result ? riskValue(row.result, "drawdown") : null}
                    className="text-sm"
                  />
                </td>
                <td className="px-1 py-1.5 text-end">
                  {row.isPlotted && !row.isActive && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground size-8 max-lg:size-8 pointer-coarse:size-8"
                      aria-label={t(
                        row.isHidden
                          ? "performance:series_table.show_on_chart"
                          : "performance:series_table.hide_on_chart",
                        { name: label },
                      )}
                      onClick={() => onToggleHidden(row.item.id)}
                    >
                      {row.isHidden ? (
                        <Icons.EyeOff className="h-4 w-4" />
                      ) : (
                        <Icons.Eye className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canFold && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground mt-1 h-8 px-2 text-xs"
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
        >
          {isExpanded
            ? t("performance:series_table.show_less")
            : t("performance:series_table.show_all", { count: rows.length })}
          <Icons.ChevronDown
            className={cn("ms-1 h-3.5 w-3.5 transition-transform", isExpanded && "rotate-180")}
          />
        </Button>
      )}
    </div>
  );
}

export default function PerformancePage() {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const [storedSelectedItems, setSelectedItems] = usePersistentState<TrackedItem[]>(
    "performance:selectedItems",
    [ALL_PORTFOLIO_ITEM],
  );
  const [storedSelectedItemId, setSelectedItemId] = usePersistentState<string | null>(
    "performance:selectedItemId",
    null,
  );
  const { settings } = useSettingsContext();
  const todayISO = formatZonedDateKey(new Date(), settings?.timezone);
  const today = useMemo(() => parseLocalDate(todayISO), [todayISO]);
  const [savedDateRange, setSavedDateRange] = usePersistentState<DateRange | undefined | null>(
    "performance:dateRange",
    null,
  );
  const [sharedPick, setSharedPick] = usePersistentState<DashboardPeriodPick | null>(
    DASHBOARD_PERIOD_STORAGE_KEY,
    null,
  );
  const [, setDashboardPreset] = usePersistentState<string>(DASHBOARD_INTERVAL_STORAGE_KEY, "3M");
  // Once any dashboard tab has picked a period, show the range Investments shows.
  const sharedRange = useMemo(() => {
    const view = sharedPick && portfolioViewForPick(sharedPick, todayISO);
    if (!view) return null;
    // Performance has no 1D preset, and its All time preset starts at local 1970-01-01.
    if (view.code === "1D") return { from: subDays(today, 7), to: today };
    if (view.code === "ALL") return { from: new Date(1970, 0, 1), to: today };
    return view.range;
  }, [sharedPick, today, todayISO]);
  const dateRange = useMemo(
    () =>
      sharedRange ??
      (savedDateRange === null ? { from: subMonths(today, 12), to: today } : savedDateRange),
    [sharedRange, savedDateRange, today],
  );
  const setDateRange = (range: DateRange | undefined) => {
    setSavedDateRange(range);
    const pick = pickForPortfolioRange(range, todayISO);
    if (!pick) return;
    setSharedPick(pick);
    if (pick.kind === "portfolio") setDashboardPreset(pick.code);
  };

  useEffect(() => {
    if (!dateRange?.from || !dateRange?.to) return;
    if (isSameDay(dateRange.from, subDays(today, 1)) && isSameDay(dateRange.to, today)) {
      setSavedDateRange({ from: subDays(today, 7), to: today });
    }
  }, [dateRange, setSavedDateRange, today]);
  // Scope selectors include hidden accounts and mixed account types. Resolve
  // their names from the full inventory; the backend applies report eligibility.
  const {
    accounts,
    isLoading: isAccountsLoading,
    isError: isAccountsError,
    error: accountsError,
  } = useAccounts({
    filterActive: false,
    includeArchived: true,
  });

  // State for mobile dropdown menu
  const [accountSheetOpen, setAccountSheetOpen] = useState(false);
  const [benchmarkSheetOpen, setBenchmarkSheetOpen] = useState(false);
  // Series kept in the comparison but left off the chart.
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<string[]>([]);
  // Phones: the chart date under the finger, or null.
  const [scrubDate, setScrubDate] = useState<string | null>(null);
  const selectedItems = useMemo(() => {
    const migrated = migratePerformanceSelectedItems(storedSelectedItems);
    if (isAccountsLoading || isAccountsError) return migrated;
    // Reconcile before both fetching and bridging so neither can reuse stale IDs.
    return prunePerformanceSelectedItems(migrated, new Set(accounts.map((account) => account.id)));
  }, [accounts, isAccountsLoading, isAccountsError, storedSelectedItems]);
  const selectedItemId = migratePerformanceSelectedItemId(storedSelectedItemId);

  useEffect(() => {
    if (selectedItems !== storedSelectedItems) {
      // A bridge or user action may have replaced this snapshot already (also
      // when StrictMode replays mount effects). Never overwrite that newer list.
      setSelectedItems((current) => (current === storedSelectedItems ? selectedItems : current));
    }
  }, [selectedItems, setSelectedItems, storedSelectedItems]);

  useEffect(() => {
    if (selectedItemId !== storedSelectedItemId) {
      setSelectedItemId((current) => (current === storedSelectedItemId ? selectedItemId : current));
    }
  }, [selectedItemId, setSelectedItemId, storedSelectedItemId]);

  useEffect(() => {
    if (isAccountsLoading || isAccountsError) {
      return;
    }
    const selectedItemStillPresent =
      !selectedItemId || selectedItems.some((item) => item.id === selectedItemId);
    if (!selectedItemStillPresent) {
      setSelectedItemId((current) => (current === selectedItemId ? null : current));
    }
  }, [isAccountsLoading, isAccountsError, selectedItemId, selectedItems, setSelectedItemId]);

  const accountScope = useAccountScopeStore((state) => state.scope);
  const setAccountScope = useAccountScopeStore((state) => state.setScope);
  const releaseBridgedItem = useAccountScopeStore((state) => state.releaseBridgedItem);

  usePerformanceScopeBridge({
    accounts,
    isAccountsLoading: isAccountsLoading || isAccountsError,
    selectedItems,
    setSelectedItems,
    setSelectedItemId,
    sortItems: sortComparisonItems,
  });

  const accountNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of accounts) map.set(account.id.toLowerCase(), account.name);
    return map;
  }, [accounts]);

  // Benchmarks replay the money of the selected account or portfolio (the
  // first one when a benchmark is selected) for their money-weighted view.
  const { returnView } = useReturnMethod();
  // Only the money-weighted view shows the replay, so only it asks for one:
  // a time-weighted page does not reload every benchmark per selected account.
  const benchmarkScope = useMemo((): AccountScope | undefined => {
    if (returnView !== "moneyWeighted") return undefined;
    const accountItems = selectedItems.filter((item) => item.type === "account");
    const anchor = accountItems.find((item) => item.id === selectedItemId) ?? accountItems[0];
    if (!anchor) return undefined;
    return anchor.accountScope ?? { type: "account", accountId: anchor.id };
  }, [returnView, selectedItemId, selectedItems]);

  // Use the custom hook for parallel data fetching with effective date calculation
  const {
    data: performanceData,
    allTimeFrom,
    isLoading: isLoadingPerformance,
    hasErrors,
    errorMessages,
    displayDateRange,
  } = useCalculatePerformanceHistory({
    selectedItems: isAccountsLoading || isAccountsError ? [] : selectedItems,
    dateRange: getPerformanceDateRangeForRequest(dateRange),
    benchmarkScope,
  });

  const selectedPerformanceData = useMemo(() => {
    if (!performanceData?.length || !selectedItems) return null;
    const targetId = selectedItemId ?? performanceData.find((item) => item !== null)?.id; // Find first non-null item ID if none selected
    if (!targetId) return null;
    const found = performanceData.find((item) => item?.id === targetId);
    if (!found) return null;
    const selectedItem = selectedItems.find((item) => item.id === found.id);
    const name = selectedItem ? performanceItemLabel(selectedItem, t) : t("performance:unknown");
    return {
      result: found,
      name,
      isSymbol: selectedItem?.type === "symbol",
    };
  }, [selectedItemId, performanceData, selectedItems, t]);

  const activeChartAnchorId = selectedPerformanceData?.result.id ?? selectedItemId;
  // The selected item's own figure decides what the chart draws.
  const selectedChartMetric = useMemo(
    () => chartViewFor(performanceData, returnView, activeChartAnchorId ?? null),
    [activeChartAnchorId, performanceData, returnView],
  );

  // Calculate derived chart data
  const chartData = useMemo(() => {
    return comparablePerformanceChartData(
      performanceData,
      selectedChartMetric,
      activeChartAnchorId ?? null,
    ).map((item) => ({ ...item, name: performanceItemLabel(item, t) }));
  }, [activeChartAnchorId, performanceData, selectedChartMetric, t]);

  // A selected item with a return but no line (e.g. a mixed portfolio whose
  // accounts start inside the period) says so, instead of asking for accounts.
  const emptyChartReason = useMemo(() => {
    const anchor = performanceData?.find((item) => item?.id === activeChartAnchorId);
    if (!anchor) return null;
    return presentedReturn(anchor, returnView)
      ? t("performance:empty.no_curve")
      : returnReasonText(anchor, returnView, t);
  }, [activeChartAnchorId, performanceData, returnView, t]);

  const chartColorMap = useMemo(() => {
    const map = new Map<string, string>();
    chartData.forEach((series, index) => {
      map.set(series.id, PERFORMANCE_CHART_COLORS[index % PERFORMANCE_CHART_COLORS.length]);
    });
    return map;
  }, [chartData]);

  const itemPlotStateById = useMemo<Map<string, SelectedItemPlotState>>(() => {
    const chartedIds = new Set(chartData.map((series) => series.id));
    const resultById = new Map<string, PerformanceResult>();
    for (const item of performanceData ?? []) {
      if (item) {
        resultById.set(item.id, item);
      }
    }

    return new Map(
      selectedItems.map((item) => {
        const isAnchor = item.id === activeChartAnchorId;
        const isPlotted = isLoadingPerformance || hasErrors || isAnchor || chartedIds.has(item.id);
        const exclusion = isPlotted
          ? undefined
          : chartExclusion(resultById.get(item.id), selectedChartMetric, t);
        const plotState: SelectedItemPlotState = {
          isPlotted,
          reason: exclusion?.message,
          reasonKind: exclusion?.kind,
        };
        return [item.id, plotState];
      }),
    );
  }, [
    activeChartAnchorId,
    chartData,
    hasErrors,
    isLoadingPerformance,
    performanceData,
    selectedChartMetric,
    selectedItems,
    t,
  ]);

  const notPlottedItems = useMemo(
    () => selectedItems.filter((item) => itemPlotStateById.get(item.id)?.reason),
    [itemPlotStateById, selectedItems],
  );
  const comparisonNotice = useMemo(() => {
    if (!notPlottedItems.length) return null;
    const kinds = notPlottedItems
      .map((item) => itemPlotStateById.get(item.id)?.reasonKind)
      .filter((kind): kind is ChartExclusionKind => Boolean(kind));
    return {
      count: notPlottedItems.length,
      message: comparisonNoticeMessage(kinds, t),
    };
  }, [itemPlotStateById, notPlottedItems, t]);

  // Calculate selected item data
  const selectedItemData = useMemo(() => {
    if (!selectedPerformanceData) return null;
    const found = selectedPerformanceData.result;
    const isSymbol = selectedPerformanceData.isSymbol;
    // The chosen method, or a labelled stand-in when this scope cannot
    // support it (return on cost, then the other method).
    const presented = presentedReturn(found, returnView);
    const shownView = presented?.view ?? returnView;
    // A benchmark replays the selected scope's deposits only when there is a
    // scope with history; otherwise both its views are the price return, and
    // it reads as that one figure.
    const benchmarkReplayed =
      isSymbol &&
      performanceViewReturn(found, "moneyWeighted") !== performanceViewReturn(found, "twr");
    const selectedMetricPresentation = isSymbol
      ? benchmarkPresentation(benchmarkReplayed ? shownView : "twr", t)
      : metricPresentation(shownView, t);
    const selectedMetricValue = presented?.value ?? null;
    const rawWarnings = found.dataQuality.warnings ?? [];
    const rawMoneyWeightedWarnings = rawWarnings.filter(isMoneyWeightedMessage);
    const visibleWarnings = rawWarnings
      .filter((warning) => !isMoneyWeightedMessage(warning))
      .map((warning) => presentWarning(warning, accountNamesById, numberFormatting));
    const moneyWeightedWarnings = rawMoneyWeightedWarnings.map((warning) =>
      presentMoneyWeightedWarning(warning, accountNamesById, t, numberFormatting),
    );
    const chosenReason =
      returnReasonText(found, returnView, t) ??
      presented?.chosenUnavailableReason ??
      performanceViewReason(found, returnView);
    const rawReason =
      selectedMetricValue == null
        ? (chosenReason ?? firstNotApplicableReason(found))
        : presented?.isFallback
          ? (chosenReason ?? undefined)
          : undefined;
    // A symbol has no cash flows, so both methods equal its price return.
    // The second tile shows the method the first does not: the other one, or
    // the chosen one (unavailable, with its reason) when a stand-in leads.
    const otherView: ChosenReturnView =
      shownView === returnView ? (returnView === "twr" ? "moneyWeighted" : "twr") : returnView;
    // A benchmark's other view is its period figure, labelled for a benchmark.
    const otherFigure = isSymbol
      ? {
          value: performanceViewReturn(found, otherView),
          ...benchmarkPresentation(otherView, t),
          shortLabel: benchmarkPresentation(otherView, t).shortLabel,
        }
      : otherMethodFigure(found, otherView, t);
    const otherReason =
      otherFigure.value == null
        ? (returnReasonText(found, otherView, t) ?? performanceViewReason(found, otherView))
        : null;
    const otherWarnings = [
      ...(otherView === "moneyWeighted" ? moneyWeightedWarnings : []),
      ...(otherReason
        ? [presentMoneyWeightedWarning(otherReason, accountNamesById, t, numberFormatting)]
        : []),
    ];
    const showSecondaryReturn = shownView !== otherView && (!isSymbol || benchmarkReplayed);
    const secondaryReturnInfoText = isSymbol
      ? benchmarkPresentation(otherView, t).infoText
      : metricPresentation(otherView, t).infoText;
    const primaryWarnings = [
      ...visibleWarnings,
      ...(shownView === "moneyWeighted" ? moneyWeightedWarnings : []),
    ];
    const periodPnl = isSymbol ? null : performancePeriodPnl(found);
    const helpItems: StripHelpItem[] = [
      {
        label: selectedMetricPresentation.label,
        infoText: selectedMetricPresentation.infoText,
        warningText: primaryWarnings,
      },
      ...(showSecondaryReturn
        ? [
            {
              label: otherFigure.label,
              infoText: secondaryReturnInfoText,
              warningText: otherWarnings,
            },
          ]
        : []),
      {
        label: t("performance:metric.annualized_return"),
        infoText: t(annualizedReturnInfo),
      },
      {
        label: t("performance:metric.volatility"),
        infoText: t(volatilityInfo),
      },
      {
        label: t("performance:metric.max_drawdown"),
        infoText: t(maxDrawdownInfo),
      },
      ...(periodPnl != null
        ? [
            {
              label: t("performance:metric.gain_loss"),
              infoText: t("performance:metric.gain_loss_info"),
            },
          ]
        : []),
    ];
    return {
      id: found.id,
      name: selectedPerformanceData.name,
      result: found,
      selectedMetricValue,
      selectedMetricReason: rawReason
        ? presentWarning(rawReason, accountNamesById, numberFormatting)
        : undefined,
      warningTerms: Array.from(accountNamesById.values()),
      // Annualizing a few months extrapolates them into a misleading yearly rate.
      annualizedReturn: shouldDisplayAnnualizedPerformanceReturn(found)
        ? (presented?.annualized ?? null)
        : null,
      secondaryReturn: otherFigure.value,
      secondaryReturnLabel: otherFigure.label,
      secondaryReturnShortLabel: otherFigure.shortLabel,
      secondaryReturnInfoText,
      secondaryReturnWarnings: otherWarnings,
      showSecondaryReturn,
      volatility: riskValue(found, "volatility"),
      maxDrawdown: riskValue(found, "drawdown"),
      periodPnl,
      helpItems,
      ...selectedMetricPresentation,
      trackingModeBadge: trackingModeBadge(found, t),
      returnWarnings: primaryWarnings,
      volatilityWarnings: [],
      warnings: visibleWarnings,
      notApplicableReasons: found.dataQuality.notApplicableReasons ?? [],
    };
  }, [selectedPerformanceData, accountNamesById, numberFormatting, returnView, t]);

  const preserveCurrentChartAnchor = (fallbackId: string) => {
    setSelectedItemId(
      selectedItemId ?? selectedPerformanceData?.result.id ?? selectedItems[0]?.id ?? fallbackId,
    );
  };

  const handleAccountSelect = (account: { id: string; name: string }) => {
    const accountId = String(account.id);
    const exists = selectedItems.some((item) => item.id === accountId);

    if (exists) {
      releaseBridgedItem(accountId);
      setHiddenSeriesIds((current) => current.filter((hiddenId) => hiddenId !== accountId));
      const nextItems = sortComparisonItems(selectedItems.filter((item) => item.id !== accountId));
      setSelectedItems(nextItems);
      if (selectedItemId === accountId) {
        setSelectedItemId(null);
      }
      return;
    }

    const newItem: TrackedItem = {
      id: accountId,
      type: "account",
      name: account.name,
      accountScope:
        accountId === PORTFOLIO_SCOPE_ID ? { type: "all" } : { type: "account", accountId },
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newItem]));
    preserveCurrentChartAnchor(accountId);
  };

  const handlePortfolioSelect = (portfolio: { id: string; name: string }) => {
    const portfolioId = String(portfolio.id);
    const exists = selectedItems.some((item) => item.id === portfolioId);

    if (exists) {
      releaseBridgedItem(portfolioId);
      setHiddenSeriesIds((current) => current.filter((hiddenId) => hiddenId !== portfolioId));
      const nextItems = sortComparisonItems(
        selectedItems.filter((item) => item.id !== portfolioId),
      );
      setSelectedItems(nextItems);
      if (selectedItemId === portfolioId) {
        setSelectedItemId(null);
      }
      return;
    }

    // Tracked as an "account" so it lands in the chart's account-series path,
    // but the scope filter expands it to the portfolio's member account ids
    // at calc time (handled by the Rust `calculate_performance_history` cmd).
    const newItem: TrackedItem = {
      id: portfolioId,
      type: "account",
      name: portfolio.name,
      accountScope: { type: "portfolio", portfolioId },
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newItem]));
    preserveCurrentChartAnchor(portfolioId);
  };

  const handleSymbolSelect = (symbol: { id: string; name: string }) => {
    const symbolId = String(symbol.id);
    const exists = selectedItems.some((item) => item.id === symbolId);
    if (exists) return;

    const newSymbol: TrackedItem = {
      id: symbolId,
      type: "symbol",
      name: symbol.name,
    };

    setSelectedItems(sortComparisonItems([...selectedItems, newSymbol]));
    preserveCurrentChartAnchor(symbolId);
  };

  const handleBadgeSelect = (item: TrackedItem) => {
    setSelectedItemId(item.id);
  };

  const handleBadgeDelete = (e: React.MouseEvent, item: TrackedItem) => {
    e.stopPropagation();
    // A removed item that is added again should come back visible.
    setHiddenSeriesIds((current) => current.filter((hiddenId) => hiddenId !== item.id));
    if (item.type === "account") {
      handleAccountSelect({ id: item.id, name: item.name });
    } else {
      setSelectedItems((prev) => sortComparisonItems(prev.filter((i) => i.id !== item.id)));
    }
    if (selectedItemId === item.id) {
      setSelectedItemId(null);
    }
  };

  const toggleSeriesHidden = (id: string) => {
    setHiddenSeriesIds((current) =>
      current.includes(id) ? current.filter((hiddenId) => hiddenId !== id) : [...current, id],
    );
  };

  const handleSeriesSelect = (item: TrackedItem) => {
    setHiddenSeriesIds((current) => current.filter((hiddenId) => hiddenId !== item.id));
    handleBadgeSelect(item);
  };

  // The active series always draws; the others keep their colours when some are hidden.
  const visibleChartData = useMemo(
    () =>
      chartData
        .filter(
          (series) => series.id === activeChartAnchorId || !hiddenSeriesIds.includes(series.id),
        )
        .map((series) => ({ ...series, color: chartColorMap.get(series.id) })),
    [activeChartAnchorId, chartColorMap, chartData, hiddenSeriesIds],
  );

  // Comparing restarts every line where all series have data, so the active line's
  // end can differ from its Return tile. Label it only when the two agree.
  const endLabelMatchesReturn = useMemo(() => {
    const returns = visibleChartData[0]?.returns;
    const lastValue = returns?.[returns.length - 1]?.value;
    const tileValue = selectedItemData?.selectedMetricValue;
    return (
      lastValue != null && tileValue != null && Math.abs(Number(lastValue) - tileValue) < 0.00005
    );
  }, [selectedItemData?.selectedMetricValue, visibleChartData]);

  // Values on the scrubbed date come from the drawn lines, so they count from the chart's start.
  const scrubValues = useMemo(() => {
    if (!isMobile || !scrubDate) return null;
    const values = new Map<string, number>();
    for (const series of visibleChartData) {
      const point = series.returns.find((item) => item.date === scrubDate);
      if (point) values.set(series.id, Number(point.value));
    }
    return values.size ? values : null;
  }, [isMobile, scrubDate, visibleChartData]);
  const chartStartDate = visibleChartData[0]?.returns[0]?.date;
  const scrubDateLabel =
    scrubValues && scrubDate ? dateFormatting.formatCalendarDate(scrubDate) : null;
  const scrubRangeLabel =
    scrubValues && scrubDate && chartStartDate
      ? `${dateFormatting.formatCalendarDate(chartStartDate)} – ${scrubDateLabel}`
      : null;

  const seriesRows = useMemo<ComparedSeriesRow[]>(() => {
    const resultById = new Map<string, PerformanceResult>();
    for (const result of performanceData ?? []) {
      if (result) resultById.set(result.id, result);
    }
    const rows = selectedItems.map((item) => {
      const plotState = itemPlotStateById.get(item.id) ?? PLOTTED_ITEM_STATE;
      return {
        item,
        result: resultById.get(item.id) ?? null,
        color: plotState.isPlotted ? chartColorMap.get(item.id) : undefined,
        isPlotted: plotState.isPlotted,
        isActive: item.id === activeChartAnchorId,
        isHidden: hiddenSeriesIds.includes(item.id) && item.id !== activeChartAnchorId,
      };
    });
    // The active series leads, so folding the list never hides the line being read.
    return [...rows.filter((row) => row.isActive), ...rows.filter((row) => !row.isActive)];
  }, [
    activeChartAnchorId,
    chartColorMap,
    hiddenSeriesIds,
    itemPlotStateById,
    performanceData,
    selectedItems,
  ]);

  const renderBadge = (item: TrackedItem) => {
    const plotState = itemPlotStateById.get(item.id) ?? PLOTTED_ITEM_STATE;
    return (
      <CarouselItem key={item.id} className="basis-auto ps-2">
        <SelectedItemBadge
          item={item}
          isSelected={activeChartAnchorId === item.id}
          isPlotted={plotState.isPlotted}
          isHidden={hiddenSeriesIds.includes(item.id) && item.id !== activeChartAnchorId}
          plotReason={plotState.reason}
          onSelect={() => handleSeriesSelect(item)}
          onDelete={(e) => handleBadgeDelete(e, item)}
          color={plotState.isPlotted ? chartColorMap.get(item.id) : undefined}
        />
      </CarouselItem>
    );
  };

  const addButtonClassName =
    "text-muted-foreground hover:text-foreground hover:bg-muted/60 border-solid bg-transparent shadow-none";

  return (
    <>
      {/* Keep tablet filters below the tabs; wide screens have room in the header. */}
      <div className="pointer-events-auto mb-4 hidden items-center justify-end gap-2 md:flex xl:fixed xl:end-4 xl:top-4 xl:z-20 xl:mb-0">
        <AccountScopeSelector value={accountScope} onChange={setAccountScope} />
        <DateRangeSelector
          asOf={today}
          value={dateRange}
          onChange={setDateRange}
          hiddenRanges={PERFORMANCE_HIDDEN_DATE_RANGES}
          allTimeFrom={allTimeFrom}
        />
      </div>

      <div className="flex flex-col space-y-4">
        <div className="flex flex-wrap items-center justify-end gap-2 md:hidden">
          <ReturnMethodToggle size="compact" />
          <AccountScopeSelector value={accountScope} onChange={setAccountScope} />
          <DateRangeSelector
            asOf={today}
            value={dateRange}
            onChange={setDateRange}
            hiddenRanges={PERFORMANCE_HIDDEN_DATE_RANGES}
            allTimeFrom={allTimeFrom}
          />
        </div>

        {/* Mobile: Carousel + Plus button in same row */}
        <div className="flex items-center gap-2 md:hidden">
          {/* Selected items badges carousel. min-w-0 lets it shrink and scroll, so the
              badges can't push the Plus button off the screen. */}
          {selectedItems.length > 0 && (
            <Carousel
              opts={{
                align: "start",
                loop: false,
              }}
              className="min-w-0 flex-1 touch-pan-x overscroll-x-contain"
              data-no-swipe-drag
            >
              <CarouselContent className="-ms-2">{selectedItems.map(renderBadge)}</CarouselContent>
            </Carousel>
          )}

          {/* Mobile: Plus button with dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  className="bg-secondary/30 hover:bg-muted/80 size-9 flex-shrink-0 rounded-md border-[1.5px] border-none"
                  aria-label={t("performance:add_item")}
                />
              }
            >
              <Icons.Plus className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => setAccountSheetOpen(true)} className="py-4 md:py-2">
                <Icons.Briefcase className="me-2 h-4 w-4" />
                {t("performance:add_account")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setBenchmarkSheetOpen(true)}
                className="py-4 md:py-2"
              >
                <Icons.TrendingUp className="me-2 h-4 w-4" />
                {t("performance:add_benchmark")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Desktop: badges, then the add buttons in the same row */}
        <div className="hidden min-w-0 items-center gap-2 md:flex">
          {selectedItems.length > 0 && (
            <Carousel
              opts={{
                align: "start",
                loop: false,
              }}
              className="min-w-0 shrink"
            >
              <CarouselContent className="-ms-2">{selectedItems.map(renderBadge)}</CarouselContent>
            </Carousel>
          )}
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <AccountSelector
              setSelectedAccount={handleAccountSelect}
              variant="button"
              buttonText={t("performance:add_account")}
              includePortfolio={true}
              accountPurpose={AccountPurpose.PERFORMANCE}
              onPortfolioSelect={handlePortfolioSelect}
              className={addButtonClassName}
            />
            <BenchmarkSymbolSelector onSelect={handleSymbolSelect} className={addButtonClassName} />
          </div>
          {/* The header has no room beside the page tabs; the method sits with the chart's items. */}
          <ReturnMethodToggle size="compact" className="ms-auto shrink-0" />
        </div>

        {/* Mobile sheets controlled by dropdown - rendered but hidden by Sheet component */}
        <AccountSelectorMobile
          setSelectedAccount={(account) => {
            handleAccountSelect(account);
            setAccountSheetOpen(false);
          }}
          includePortfolio={true}
          accountPurpose={AccountPurpose.PERFORMANCE}
          open={accountSheetOpen}
          onOpenChange={setAccountSheetOpen}
          className="hidden"
          onPortfolioSelect={(portfolio) => {
            handlePortfolioSelect(portfolio);
            setAccountSheetOpen(false);
          }}
        />
        <BenchmarkSymbolSelectorMobile
          onSelect={(symbol) => {
            handleSymbolSelect(symbol);
            setBenchmarkSheetOpen(false);
          }}
          open={benchmarkSheetOpen}
          onOpenChange={setBenchmarkSheetOpen}
          className="hidden"
        />

        <Card className="flex flex-col">
          <CardHeader className={cn("gap-3", isMobile ? "px-3 pt-3 pb-1" : "px-6 pt-5 pb-2")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className={cn("text-lg sm:text-xl", isMobile && "text-base")}>
                  {t("performance:performance")}
                </CardTitle>
                <CardDescription className="mt-0.5 truncate text-xs sm:text-sm">
                  {[scrubDateLabel ?? displayDateRange, selectedItemData?.name]
                    .filter(Boolean)
                    .join(" · ")}
                </CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {selectedItemData?.trackingModeBadge && (
                  <Badge
                    variant={selectedItemData.trackingModeBadge.variant}
                    className="text-2xs h-5 rounded-md px-1.5 font-medium"
                  >
                    {selectedItemData.trackingModeBadge.label}
                  </Badge>
                )}
                {selectedItemData && <StripHelpPopover items={selectedItemData.helpItems} />}
              </div>
            </div>

            {performanceData && performanceData.length > 0 && isMobile && (
              <div className={cn("flex flex-col gap-3", METRIC_TAP_AREA_CLASS)}>
                <div className={cn("flex flex-col items-start gap-1", METRIC_TAP_AREA_CLASS)}>
                  <MetricTile
                    variant="hero"
                    label={stripReturnLabel(selectedItemData?.label, t)}
                    value={
                      scrubValues
                        ? (scrubValues.get(activeChartAnchorId ?? "") ?? null)
                        : (selectedItemData?.selectedMetricValue ?? null)
                    }
                    infoText={selectedItemData?.infoText ?? t(SIMPLE_RETURN_INFO_KEY)}
                    warningText={[
                      ...(selectedItemData?.returnWarnings ?? []),
                      ...(selectedItemData?.selectedMetricReason
                        ? [selectedItemData.selectedMetricReason]
                        : []),
                    ]}
                    boldTerms={selectedItemData?.warningTerms}
                  />
                  {scrubRangeLabel ? (
                    <span className="text-muted-foreground py-0.5 text-xs">{scrubRangeLabel}</span>
                  ) : (
                    selectedItemData?.periodPnl != null && (
                      <AttributionDetailMetric
                        inline
                        result={selectedItemData.result}
                        warnings={selectedItemData.warnings}
                        warningTerms={selectedItemData.warningTerms}
                        itemName={selectedItemData.name}
                        dateRangeLabel={displayDateRange}
                        isMobile={isMobile}
                        label={t("performance:metric.gain_loss")}
                      />
                    )
                  )}
                </div>
                {/* Period figures; they fade while the finger reads a single date. */}
                <div
                  className={cn(
                    "grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2 transition-opacity",
                    METRIC_TAP_AREA_CLASS,
                    scrubValues && "opacity-40",
                  )}
                >
                  {selectedItemData?.showSecondaryReturn && (
                    <MetricTile
                      variant="mini"
                      label={selectedItemData.secondaryReturnShortLabel}
                      value={selectedItemData.secondaryReturn}
                      infoText={selectedItemData.secondaryReturnInfoText}
                      warningText={selectedItemData.secondaryReturnWarnings}
                      boldTerms={selectedItemData.warningTerms}
                    />
                  )}
                  {selectedItemData?.annualizedReturn != null && (
                    <MetricTile
                      variant="mini"
                      label={t("performance:metric.annualized_short")}
                      value={selectedItemData.annualizedReturn}
                      infoText={t(annualizedReturnInfo)}
                    />
                  )}
                  <MetricTile
                    variant="mini"
                    label={t("performance:metric.volatility")}
                    value={selectedItemData?.volatility ?? null}
                    tone="neutral"
                    infoText={t(volatilityInfo)}
                    warningText={selectedItemData?.volatilityWarnings}
                    boldTerms={selectedItemData?.warningTerms}
                  />
                  <MetricTile
                    variant="mini"
                    label={t("performance:metric.drawdown_short")}
                    value={selectedItemData?.maxDrawdown ?? null}
                    infoText={t(maxDrawdownInfo)}
                  />
                </div>
              </div>
            )}

            {performanceData && performanceData.length > 0 && !isMobile && (
              <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]">
                <MetricTile
                  label={stripReturnLabel(selectedItemData?.label, t)}
                  value={selectedItemData?.selectedMetricValue ?? null}
                  infoText={selectedItemData?.infoText ?? t(SIMPLE_RETURN_INFO_KEY)}
                  warningText={[
                    ...(selectedItemData?.returnWarnings ?? []),
                    ...(selectedItemData?.selectedMetricReason
                      ? [selectedItemData.selectedMetricReason]
                      : []),
                  ]}
                  boldTerms={selectedItemData?.warningTerms}
                />
                {selectedItemData?.showSecondaryReturn && (
                  <MetricTile
                    label={selectedItemData.secondaryReturnLabel}
                    value={selectedItemData.secondaryReturn}
                    infoText={selectedItemData.secondaryReturnInfoText}
                    warningText={selectedItemData.secondaryReturnWarnings}
                    boldTerms={selectedItemData.warningTerms}
                  />
                )}
                {/* Only from one year: annualizing a few months misleads, and N/A would say why not. */}
                {selectedItemData?.annualizedReturn != null && (
                  <MetricTile
                    label={t("performance:metric.annualized_short")}
                    value={selectedItemData.annualizedReturn}
                    infoText={t(annualizedReturnInfo)}
                  />
                )}
                <MetricTile
                  label={t("performance:metric.volatility")}
                  value={selectedItemData?.volatility ?? null}
                  tone="neutral"
                  infoText={t(volatilityInfo)}
                  warningText={selectedItemData?.volatilityWarnings}
                  boldTerms={selectedItemData?.warningTerms}
                />
                <MetricTile
                  label={t("performance:metric.max_drawdown_short")}
                  value={selectedItemData?.maxDrawdown ?? null}
                  infoText={t(maxDrawdownInfo)}
                />
                {selectedItemData?.periodPnl != null && (
                  <AttributionDetailMetric
                    result={selectedItemData.result}
                    warnings={selectedItemData.warnings}
                    warningTerms={selectedItemData.warningTerms}
                    itemName={selectedItemData.name}
                    dateRangeLabel={displayDateRange}
                    isMobile={isMobile}
                    label={t("performance:metric.gain_loss")}
                  />
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className={cn(isMobile ? "px-2 pb-3" : "px-4 pb-5 sm:px-6")}>
            <div className="flex flex-col gap-3">
              {comparisonNotice && (
                <div className="border-border/70 bg-muted/20 flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
                  <div className="border-border bg-background mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full">
                    <Icons.Info className="text-muted-foreground h-3 w-3" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-foreground font-medium">
                      {t("performance:comparison_notice.not_plotted_count", {
                        count: comparisonNotice.count,
                      })}
                    </div>
                    <div className="text-muted-foreground mt-0.5">{comparisonNotice.message}</div>
                  </div>
                </div>
              )}
              <div className="h-72 sm:h-80 md:h-[max(22rem,calc(100vh-30rem))]">
                <PerformanceContent
                  chartData={visibleChartData}
                  emptyChartReason={emptyChartReason}
                  isLoading={isLoadingPerformance || isAccountsLoading}
                  hasErrors={hasErrors || isAccountsError}
                  errorMessages={
                    accountsError ? [accountsError.message, ...errorMessages] : errorMessages
                  }
                  isMobile={isMobile}
                  showEndLabel={endLabelMatchesReturn}
                  onScrub={setScrubDate}
                />
              </div>
              {seriesRows.length > 1 && performanceData?.some(Boolean) && (
                <ComparedSeriesTable
                  rows={seriesRows}
                  onSelect={handleSeriesSelect}
                  onToggleHidden={toggleSeriesHidden}
                  scrubValues={scrubValues}
                />
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
