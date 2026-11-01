import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useSearchParams } from "react-router-dom";

import { useIsMobileViewport } from "@/hooks";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { DateRange } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { useSettingsContext } from "@/lib/settings-provider";

import { useAmountFormatting, useDateFormatting } from "@wealthfolio/ui";
import { usePersistentState } from "@/hooks/use-persistent-state";

import { CategoryTransactionsSheet } from "../components/reports/category-transactions-sheet";
import { HeatmapCellSheet } from "../components/reports/heatmap-cell-sheet";
import { localizeReportCategories } from "../components/reports/report-localization";
import { StageNav, type InsightsStage } from "../components/reports/insights/stage-nav";
import { WhatChangedStage } from "../components/reports/insights/what-changed-stage";
import { WhenWhereStage } from "../components/reports/insights/when-where-stage";
import { WhereIAmStage } from "../components/reports/insights/where-i-am-stage";
import { SpendingPeriodSelector } from "../components/spending-period-toggle";
import { useCashActivities } from "../hooks/use-cash-activities";
import { useEventSpendingSummaries } from "../hooks/use-spending-events";
import { useSpendingInsight } from "../hooks/use-spending-insight";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { getActivitySpendingAmount, getVisibleSpendingAmount } from "../lib/constants";
import { insightToReportProjection, UNCATEGORIZED_CATEGORY_ID } from "../lib/insight-projection";
import {
  addMonthsToMonthKey,
  currentMonthKey,
  monthReportsRange,
  monthLabel,
  parseMonthKey,
  SPENDING_MONTH_PARAM,
  SPENDING_MONTH_STORAGE_KEY,
} from "../lib/month-period";
import {
  DASHBOARD_INTERVAL_STORAGE_KEY,
  DASHBOARD_PERIOD_STORAGE_KEY,
  portfolioPresetForSpendingPeriod,
  rangePick,
  spendingViewForPick,
  type DashboardPeriodPick,
} from "../lib/dashboard-period-sync";
import {
  INSIGHTS_PERIOD_STORAGE_KEY,
  normalizeReportsPeriod,
  SPENDING_INTERVAL_STORAGE_KEY,
} from "../lib/period-preferences";
import {
  SPENDING_RANGE_FROM_PARAM,
  SPENDING_RANGE_TO_PARAM,
  spendingRangeFromParams,
  spendingRangeToReportsRange,
} from "../lib/date-range-params";
import {
  comparisonRange,
  DEFAULT_REPORTS_PERIOD,
  periodToReportsRange,
  type ReportsPeriod,
  type ReportsRange,
} from "../lib/reports-period";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDaysBetweenInclusive,
  calendarMonthsBetweenInclusive,
  createZonedDayHourFormatter,
  daysInCalendarMonth,
  formatZonedDateKey,
  getZonedDateParts,
  zonedCalendarDateBoundaryToDate,
} from "../lib/timezone";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";
const STAGE_STORAGE_KEY = "spending-insights-stage";
const EMPTY_TAXONOMY: never[] = [];
const EMPTY_BUCKETS: never[] = [];
/** Heatmap window — last 12 weeks regardless of selected period. */
const HEATMAP_WEEKS = 12;
const HEATMAP_DAY_KEYS = [
  "spending:dayOfWeek.mon",
  "spending:dayOfWeek.tue",
  "spending:dayOfWeek.wed",
  "spending:dayOfWeek.thu",
  "spending:dayOfWeek.fri",
  "spending:dayOfWeek.sat",
  "spending:dayOfWeek.sun",
] as const;

function monthToDateRange(timezone?: string | null): ReportsRange {
  const today = getZonedDateParts(new Date(), timezone);
  const start = { year: today.year, month: today.month, day: 1 };
  return {
    start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(today, "end", timezone),
    days: calendarDaysBetweenInclusive(start, today),
    months: 1,
  };
}

function previousMonthMatchingRange(range: ReportsRange, timezone?: string | null): ReportsRange {
  const currentStart = getZonedDateParts(range.start, timezone);
  const currentEnd = getZonedDateParts(range.end, timezone);
  const priorStartBase = addCalendarMonths(currentStart, -1);
  const priorEndBase = addCalendarMonths(currentEnd, -1);
  const priorStart = {
    ...priorStartBase,
    day: Math.min(currentStart.day, daysInCalendarMonth(priorStartBase.year, priorStartBase.month)),
  };
  const priorEnd = {
    ...priorEndBase,
    // Completed months compare in full; in-progress months keep matching dates.
    day:
      currentEnd.day === daysInCalendarMonth(currentEnd.year, currentEnd.month)
        ? daysInCalendarMonth(priorEndBase.year, priorEndBase.month)
        : Math.min(currentEnd.day, daysInCalendarMonth(priorEndBase.year, priorEndBase.month)),
  };

  return {
    start: zonedCalendarDateBoundaryToDate(priorStart, "start", timezone),
    end: zonedCalendarDateBoundaryToDate(priorEnd, "end", timezone),
    days: calendarDaysBetweenInclusive(priorStart, priorEnd),
    months: calendarMonthsBetweenInclusive(priorStart, priorEnd),
  };
}

/**
 * Spending insights — narrative-first, three-stage page.
 *
 *   Where I am   — pace card + spent + cashflow + breakdown table
 *   What changed — period-vs-period headline + sparklines + delta table
 *   When & where — weekday-hour heatmap + events headline + per-event cards
 *
 * Owns period + comparison + stage state at the top; each stage receives the
 * data it needs. Data hooks run unconditionally so switching stages is instant.
 */
const VALID_STAGES: InsightsStage[] = ["where", "changed", "when"];

interface SpendingInsightsPageProps {
  onToolbarActionsChange?: (actions: ReactNode | null) => void;
}

export default function SpendingInsightsPage({
  onToolbarActionsChange,
}: SpendingInsightsPageProps) {
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobileViewport();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const appTimezone = settings?.timezone ?? undefined;
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();

  const [persistedPeriod, setPersistedPeriod] = usePersistentState<string>(
    INSIGHTS_PERIOD_STORAGE_KEY,
    DEFAULT_REPORTS_PERIOD,
  );
  const [persistedMonth, setPersistedMonth] = usePersistentState<string | null>(
    SPENDING_MONTH_STORAGE_KEY,
    null,
  );
  const [sharedPick, setSharedPick] = usePersistentState<DashboardPeriodPick | null>(
    DASHBOARD_PERIOD_STORAGE_KEY,
    null,
  );
  const [, setPortfolioPreset] = usePersistentState<string>(DASHBOARD_INTERVAL_STORAGE_KEY, "3M");
  // Kept in step so the Spending tab falls back to the same preset.
  const [, setSpendingInterval] = usePersistentState<string>(SPENDING_INTERVAL_STORAGE_KEY, "MTD");
  const todayISO = formatZonedDateKey(new Date(), appTimezone);
  // A link that names a period opens on it; it is applied once below and then
  // removed from the URL. Otherwise follow the period last picked on the
  // dashboard tabs or here, then the persisted preference.
  const urlPeriod = normalizeReportsPeriod(searchParams.get("period"));
  const urlMonth = parseMonthKey(searchParams.get(SPENDING_MONTH_PARAM))
    ? searchParams.get(SPENDING_MONTH_PARAM)
    : null;
  const urlRange = useMemo(() => spendingRangeFromParams(searchParams), [searchParams]);
  const hasUrlPeriod = !!urlPeriod || !!urlMonth || !!urlRange;
  const sharedView = useMemo(
    () => (!hasUrlPeriod && sharedPick ? spendingViewForPick(sharedPick, todayISO) : null),
    [hasUrlPeriod, sharedPick, todayISO],
  );
  const period =
    urlPeriod ??
    (sharedView?.kind === "period"
      ? sharedView.code
      : (normalizeReportsPeriod(persistedPeriod) ?? DEFAULT_REPORTS_PERIOD));
  const [stage, setStage] = usePersistentState<InsightsStage>(STAGE_STORAGE_KEY, "where");
  const customRange = urlRange ?? (sharedView?.kind === "range" ? sharedView.range : undefined);
  const customMonth = customRange
    ? null
    : (urlMonth ??
      (hasUrlPeriod
        ? null
        : sharedView
          ? sharedView.kind === "month"
            ? sharedView.monthKey
            : null
          : parseMonthKey(persistedMonth)
            ? persistedMonth
            : null));
  const sharePeriod = useCallback(
    (code: ReportsPeriod) => {
      setSharedPick({ kind: "spending", code });
      setPortfolioPreset(portfolioPresetForSpendingPeriod(code));
    },
    [setSharedPick, setPortfolioPreset],
  );

  const setStageAndUrl = useCallback(
    (next: InsightsStage) => {
      setStage(next);
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("stage", next);
          return p;
        },
        { replace: true },
      );
    },
    [setStage, setSearchParams],
  );

  // Picks live in the shared period and the persisted preference, never in the
  // URL, so back/forward cannot bring back an older period.
  const selectPeriod = useCallback(
    (next: ReportsPeriod) => {
      setPersistedPeriod(next);
      setSpendingInterval(next);
      sharePeriod(next);
      setPersistedMonth(null);
    },
    [setPersistedPeriod, setSpendingInterval, sharePeriod, setPersistedMonth],
  );

  const selectCustomMonth = useCallback(
    (next: string | null) => {
      setPersistedMonth(next);
      if (next) setSharedPick({ kind: "month", monthKey: next });
      else sharePeriod(period);
    },
    [setPersistedMonth, setSharedPick, sharePeriod, period],
  );

  const selectCustomRange = useCallback(
    (next: DateRange | undefined) => {
      if (next && (!next.from || !next.to)) return;
      setPersistedMonth(null);
      if (next?.from && next.to) setSharedPick(rangePick({ from: next.from, to: next.to }));
      else sharePeriod(period);
    },
    [setPersistedMonth, setSharedPick, sharePeriod, period],
  );

  // ?stage=where|changed|when drives the page when present. A period named in
  // the URL (?period=, ?spendingMonth=, ?spendingFrom=&spendingTo=) is applied
  // once like a pick and then dropped from the URL.
  useEffect(() => {
    const urlStage = searchParams.get("stage");
    if (urlStage && VALID_STAGES.includes(urlStage as InsightsStage) && urlStage !== stage) {
      setStage(urlStage as InsightsStage);
    }
    if (!hasUrlPeriod) return;
    if (urlRange || urlMonth) {
      setPersistedPeriod(period);
      setSpendingInterval(period);
      if (urlRange) selectCustomRange(urlRange);
      else selectCustomMonth(urlMonth);
    } else {
      selectPeriod(period);
    }
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const param of [
          "period",
          SPENDING_MONTH_PARAM,
          SPENDING_RANGE_FROM_PARAM,
          SPENDING_RANGE_TO_PARAM,
        ]) {
          p.delete(param);
        }
        return p;
      },
      { replace: true },
    );
    // Runs only when the URL changes; the setters read the state it produced.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [searchParams]);

  const selectionKey = customRange
    ? `${formatDateISO(customRange.from)}:${formatDateISO(customRange.to)}`
    : (customMonth ?? period);
  const [offsetBinding, setOffsetBinding] = useState({ selectionKey, offset: 0 });
  const eventsWindowOffset = offsetBinding.selectionKey === selectionKey ? offsetBinding.offset : 0;
  const setEventsWindowOffset = (next: number) =>
    setOffsetBinding({ selectionKey, offset: Math.max(0, next) });

  const monthRange = useMemo(
    () => (customMonth ? monthReportsRange(customMonth, appTimezone) : null),
    [customMonth, appTimezone],
  );
  const range = useMemo(
    () =>
      customRange
        ? spendingRangeToReportsRange(customRange, appTimezone)
        : (monthRange ?? periodToReportsRange(period, appTimezone)),
    [customRange, monthRange, period, appTimezone],
  );
  const whatChangedWindow = useMemo(() => {
    if (customRange || customMonth || period !== "MTD") return null;
    const current = monthToDateRange(appTimezone);
    return {
      current,
      prior: previousMonthMatchingRange(current, appTimezone),
    };
  }, [customRange, customMonth, period, appTimezone]);
  const eventsRange = useMemo(
    () => shiftRangeBack(range, period, eventsWindowOffset, appTimezone, !!customRange),
    [range, period, eventsWindowOffset, appTimezone, customRange],
  );
  const taxonomy = useTaxonomy(SPENDING_TAXONOMY);
  const incomeTaxonomy = useTaxonomy(INCOME_TAXONOMY);
  const savingsTaxonomy = useTaxonomy(SAVINGS_TAXONOMY);
  const displaySpendingCategories = useMemo(
    () => localizeReportCategories(t, taxonomy.data?.categories ?? EMPTY_TAXONOMY),
    [taxonomy.data?.categories, t],
  );
  const { accounts = [] } = useAccounts({ filterActive: false });

  // ─── Single reconciled source of truth for the "Where I am" stage ─────────
  // One server call returns budgets + actuals + uncategorized + prior, all
  // computed against the same window — the math is reconciled by construction.
  const customPriorRange = useMemo(
    () => (customRange ? comparisonRange(range, "prior", appTimezone) : null),
    [customRange, range, appTimezone],
  );
  const insightRequest = useMemo(
    () => ({
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      compare: "prior" as const,
      ...(customPriorRange
        ? {
            compareStartDate: customPriorRange.start.toISOString(),
            compareEndDate: customPriorRange.end.toISOString(),
          }
        : {}),
    }),
    [range, customPriorRange],
  );
  const {
    data: insight,
    isLoading: isInsightLoading,
    isError: insightErrored,
    refetch: refetchInsight,
  } = useSpendingInsight(insightRequest);
  const whatChangedRequest = useMemo(() => {
    if (!whatChangedWindow) return null;
    return {
      startDate: whatChangedWindow.current.start.toISOString(),
      endDate: whatChangedWindow.current.end.toISOString(),
      compareStartDate: whatChangedWindow.prior.start.toISOString(),
      compareEndDate: whatChangedWindow.prior.end.toISOString(),
      compare: "prior" as const,
    };
  }, [whatChangedWindow]);
  const {
    data: mtdComparisonInsight,
    isLoading: isMtdComparisonLoading,
    isError: mtdComparisonErrored,
    refetch: refetchMtdComparison,
  } = useSpendingInsight(
    whatChangedRequest ?? insightRequest,
    stage === "changed" && !!whatChangedRequest,
  );

  // Project the reconciled insight into the presentation shapes used by the
  // existing child cards. Every number still flows from one server query.
  const insightProjection = useMemo(
    () => (insight ? insightToReportProjection(insight, dateFormatting) : null),
    [insight, dateFormatting],
  );
  const whatChangedInsight = whatChangedRequest ? mtdComparisonInsight : insight;
  const whatChangedProjection = useMemo(
    () =>
      whatChangedInsight ? insightToReportProjection(whatChangedInsight, dateFormatting) : null,
    [whatChangedInsight, dateFormatting],
  );
  const isWhatChangedLoading = whatChangedRequest ? isMtdComparisonLoading : isInsightLoading;
  const whatChangedRange = whatChangedWindow?.current ?? range;
  const whatChangedPriorRange = whatChangedWindow?.prior;
  const categorySheetRange = stage === "changed" ? whatChangedRange : range;
  // Must be picked by the same expression as `categorySheetRange`: the two
  // stages run different windows, and pairing one stage's range with the
  // other's aggregate would divide a partial-month total by a full month.
  const categorySheetInsight = stage === "changed" ? whatChangedInsight : insight;
  const taxonomyCategoriesForWhereIAm = useMemo(() => {
    const base = taxonomy.data?.categories ?? EMPTY_TAXONOMY;
    if (!insight || insight.uncategorized.txnCount === 0) return base;
    // Synthetic top-level row so the breakdown table renders an
    // "Uncategorized" line. Matches the colors/shape of a regular category.
    const now = new Date().toISOString();
    return [
      ...base,
      {
        id: UNCATEGORIZED_CATEGORY_ID,
        taxonomyId: SPENDING_TAXONOMY,
        parentId: null,
        name: t("spending:insightsPage.uncategorized"),
        key: UNCATEGORIZED_CATEGORY_ID,
        color: "#9CA3AF",
        icon: null,
        description: null,
        sortOrder: 9999,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }, [insight, taxonomy.data?.categories, t]);
  const displayComparisonCategories = useMemo(
    () => localizeReportCategories(t, taxonomyCategoriesForWhereIAm),
    [taxonomyCategoriesForWhereIAm, t],
  );

  // Custom selections also scope the weekday × hour heatmap.
  const heatmapRequest = useMemo(() => {
    if (customRange)
      return { startDate: range.start.toISOString(), endDate: range.end.toISOString() };
    const end = getZonedDateParts(new Date(), appTimezone);
    const start = addCalendarDays(end, -HEATMAP_WEEKS * 7);
    return {
      startDate: zonedCalendarDateBoundaryToDate(start, "start", appTimezone).toISOString(),
      endDate: zonedCalendarDateBoundaryToDate(end, "end", appTimezone).toISOString(),
    };
  }, [appTimezone, customRange, range]);
  const { data: heatmapActivities = [] } = useCashActivities(heatmapRequest);
  const {
    data: heatmapInsight,
    isError: heatmapInsightErrored,
    refetch: refetchHeatmapInsight,
  } = useSpendingInsight(heatmapRequest, stage === "when");
  const heatmapDailySpendByDate = useMemo(
    () =>
      heatmapInsight
        ? new Map(heatmapInsight.byDay.map((day) => [day.date, day.spent] as const))
        : undefined,
    [heatmapInsight],
  );

  const eventsRequest = useMemo(
    () => ({
      startDate: eventsRange.start.toISOString(),
      endDate: eventsRange.end.toISOString(),
    }),
    [eventsRange],
  );
  const {
    data: events = [],
    isError: eventsErrored,
    refetch: refetchEvents,
  } = useEventSpendingSummaries(eventsRequest);

  const onJumpToBreakdown = useCallback(() => {
    const el = document.getElementById("breakdown");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Click-through sheet for category transactions. The synthetic Uncategorized
  // row has no real category to filter activities by — clicks on it are
  // silently ignored for now (follow-up: route to a dedicated "uncategorized
  // transactions" filter so users can categorize them in-place).
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const handleCategoryClick = useCallback((categoryId: string) => {
    if (categoryId === UNCATEGORIZED_CATEGORY_ID) return;
    setActiveCategoryId(categoryId);
  }, []);
  const activeCategory = useMemo(
    () =>
      activeCategoryId
        ? (taxonomy.data?.categories.find((c) => c.id === activeCategoryId) ?? null)
        : null,
    [activeCategoryId, taxonomy.data?.categories],
  );

  // Click-through sheet for heatmap cells (weekday × hour)
  const [heatmapCell, setHeatmapCell] = useState<{
    weekday: number;
    startHour: number;
    endHour: number;
  } | null>(null);
  const handleHeatmapCellClick = useCallback(
    (weekday: number, startHour: number, endHour: number) => {
      setHeatmapCell({ weekday, startHour, endHour });
    },
    [],
  );
  const getHeatmapDayHour = useMemo(() => createZonedDayHourFormatter(appTimezone), [appTimezone]);
  const accountTypeById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.accountType])),
    [accounts],
  );
  const heatmapCellActivities = useMemo(() => {
    if (!heatmapCell) return [];
    return heatmapActivities.filter((a) => {
      const d = new Date(a.activityDate);
      const zoned = getHeatmapDayHour(d);
      if (
        zoned?.weekday !== heatmapCell.weekday ||
        zoned.hour < heatmapCell.startHour ||
        zoned.hour >= heatmapCell.endHour
      ) {
        return false;
      }
      // Spend that is entirely excluded left the cell value; keep it out of
      // the cell's sheet too. Non-spending rows are listed as before.
      const accountType = accountTypeById.get(a.accountId);
      return (
        getVisibleSpendingAmount(a, accountType) !== 0 ||
        getActivitySpendingAmount(a, accountType) === 0
      );
    });
  }, [accountTypeById, getHeatmapDayHour, heatmapActivities, heatmapCell]);

  const taxonomyCategories = taxonomy.data?.categories ?? EMPTY_TAXONOMY;
  const maxPickerMonth = useMemo(
    () => addMonthsToMonthKey(currentMonthKey(appTimezone), -1),
    [appTimezone],
  );

  const periodToggle = useMemo(
    () => (
      <SpendingPeriodSelector
        value={customMonth || customRange ? null : period}
        onValueChange={selectPeriod}
        customMonth={customMonth}
        customRange={customRange}
        onCustomRangeChange={selectCustomRange}
        maxMonth={maxPickerMonth}
        onCustomMonthChange={selectCustomMonth}
        appearance="header"
      />
    ),
    [
      customMonth,
      customRange,
      period,
      selectPeriod,
      selectCustomRange,
      maxPickerMonth,
      selectCustomMonth,
    ],
  );

  useEffect(() => {
    onToolbarActionsChange?.(isMobile ? null : periodToggle);
    return () => onToolbarActionsChange?.(null);
  }, [isMobile, onToolbarActionsChange, periodToggle]);

  // Gate the entire page when tracking is disabled — mirrors spending-budget-page.
  // Without this, disabling tracking from ModuleCard leaves Insights live and
  // continues rendering numbers the user explicitly opted out of seeing.
  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/dashboard?tab=spending" replace />;
  }

  return (
    <>
      <div className="space-y-5">
        {(isMobile || !onToolbarActionsChange) && (
          <div className="flex justify-end">{periodToggle}</div>
        )}
        {(customRange || customMonth) && (
          <p className="text-muted-foreground text-sm" data-testid="spending-selected-range">
            {customRange ? (
              <>
                {dateFormatting.formatCalendarDate(
                  {
                    year: customRange.from.getFullYear(),
                    month: customRange.from.getMonth() + 1,
                    day: customRange.from.getDate(),
                  },
                  { month: "short", day: "numeric", year: "numeric" },
                )}
                {" – "}
                {dateFormatting.formatCalendarDate(
                  {
                    year: customRange.to.getFullYear(),
                    month: customRange.to.getMonth() + 1,
                    day: customRange.to.getDate(),
                  },
                  { month: "short", day: "numeric", year: "numeric" },
                )}
              </>
            ) : customMonth ? (
              monthLabel(customMonth, dateFormatting)
            ) : null}
          </p>
        )}
        <StageNav stage={stage} onStageChange={setStageAndUrl} />

        {insight?.foreignCurrencies && insight.foreignCurrencies.length > 0 && (
          <ForeignCurrencyBanner
            currency={insight.currency}
            foreign={insight.foreignCurrencies}
            nativeTotals={insight.nativeOutflowByCurrency ?? {}}
            asOf={insight.period.end}
          />
        )}

        {(insightErrored ||
          (stage === "changed" && mtdComparisonErrored) ||
          (stage === "when" && heatmapInsightErrored)) && (
          <div className="border-warning-subtle-border bg-warning-subtle text-warning-subtle-foreground flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs">
            <span>
              <span className="font-semibold">{t("spending:insightsPage.loadError")}</span>{" "}
              {t("spending:insightsPage.showingZeros")}
            </span>
            <button
              type="button"
              onClick={() => {
                if (insightErrored) void refetchInsight();
                if (mtdComparisonErrored) void refetchMtdComparison();
                if (heatmapInsightErrored) void refetchHeatmapInsight();
              }}
              className="text-foreground hover:underline"
            >
              {t("common:retry")}
            </button>
          </div>
        )}

        {stage === "where" && (
          <WhereIAmStage
            range={range}
            priorRange={customPriorRange ?? undefined}
            currentReport={insightProjection?.currentReport}
            priorReport={insightProjection?.priorReport}
            months={insightProjection?.months ?? []}
            taxonomyCategories={taxonomyCategoriesForWhereIAm}
            incomeCategories={incomeTaxonomy.data?.categories ?? EMPTY_TAXONOMY}
            savingsCategories={savingsTaxonomy.data?.categories ?? EMPTY_TAXONOMY}
            budget={insightProjection?.budget}
            currency={insight?.currency ?? baseCurrency}
            isLoading={isInsightLoading}
            reconciledPace={insight?.headline.pace}
            onJumpToBreakdown={onJumpToBreakdown}
            onCategoryClick={handleCategoryClick}
          />
        )}

        {stage === "changed" && (
          <WhatChangedStage
            range={whatChangedRange}
            priorRange={whatChangedPriorRange ?? customPriorRange ?? undefined}
            timezone={appTimezone}
            currentReport={whatChangedProjection?.currentReport}
            priorReport={whatChangedProjection?.priorReport}
            months={whatChangedProjection?.months ?? []}
            taxonomyCategories={displayComparisonCategories}
            currency={whatChangedInsight?.currency ?? insight?.currency ?? baseCurrency}
            isLoading={isWhatChangedLoading}
            onCategoryClick={handleCategoryClick}
          />
        )}

        {stage === "when" && (
          <WhenWhereStage
            baselinePeriod={
              customRange
                ? {
                    from: formatDateISO(customRange.from),
                    to: formatDateISO(customRange.to),
                    days: range.days,
                  }
                : undefined
            }
            customRange={!!customRange}
            heatmapActivities={heatmapActivities}
            accountTypeById={accountTypeById}
            dailySpendByDate={heatmapDailySpendByDate}
            events={events}
            eventsErrored={eventsErrored}
            onRetryEvents={() => refetchEvents()}
            taxonomyCategories={displaySpendingCategories}
            currency={heatmapInsight?.currency ?? baseCurrency}
            timezone={appTimezone}
            rangeStart={eventsRange.start}
            rangeEnd={eventsRange.end}
            windowOffset={eventsWindowOffset}
            onPrevWindow={() => setEventsWindowOffset(eventsWindowOffset + 1)}
            onNextWindow={() => setEventsWindowOffset(eventsWindowOffset - 1)}
            onHeatmapCellClick={handleHeatmapCellClick}
          />
        )}
      </div>

      <CategoryTransactionsSheet
        open={!!activeCategory}
        onOpenChange={(open) => {
          if (!open) setActiveCategoryId(null);
        }}
        category={activeCategory}
        taxonomyCategories={taxonomyCategories}
        rangeStart={categorySheetRange.start}
        rangeEnd={categorySheetRange.end}
        buckets={categorySheetInsight?.byDayByCategory ?? EMPTY_BUCKETS}
        rangeDays={categorySheetRange.days}
        daysElapsed={categorySheetInsight?.headline.pace.daysElapsed ?? 0}
        isStatsLoading={stage === "changed" ? isWhatChangedLoading : isInsightLoading}
        currency={categorySheetInsight?.currency ?? baseCurrency}
      />

      <HeatmapCellSheet
        customRange={customRange}
        open={!!heatmapCell}
        onOpenChange={(open) => {
          if (!open) setHeatmapCell(null);
        }}
        activities={heatmapCellActivities}
        dayLabel={heatmapCell ? t(HEATMAP_DAY_KEYS[heatmapCell.weekday]) : null}
        hour={heatmapCell?.startHour ?? null}
        endHour={heatmapCell?.endHour ?? null}
        timezone={appTimezone}
        currency={baseCurrency}
      />
    </>
  );
}

/** Shift the events window back by `offset` periods. Calendar-aligned for the
 *  month-based periods; YTD pages back by a full year so each click lands on
 *  the prior year's window. */
const MONTHS_PER_PERIOD: Record<ReportsPeriod, number> = {
  MTD: 1,
  LAST_MONTH: 1,
  "3M": 3,
  "6M": 6,
  YTD: 12,
  "1Y": 12,
};

function shiftRangeBack(
  range: ReportsRange,
  period: ReportsPeriod,
  offset: number,
  timezone?: string | null,
  customRange = false,
): ReportsRange {
  if (offset === 0) return range;
  if (customRange) {
    const start = addCalendarDays(getZonedDateParts(range.start, timezone), -range.days * offset);
    const end = addCalendarDays(getZonedDateParts(range.end, timezone), -range.days * offset);
    return {
      ...range,
      start: zonedCalendarDateBoundaryToDate(start, "start", timezone),
      end: zonedCalendarDateBoundaryToDate(end, "end", timezone),
    };
  }
  const months = MONTHS_PER_PERIOD[period] * offset;
  const start = zonedCalendarDateBoundaryToDate(
    addCalendarMonths(getZonedDateParts(range.start, timezone), -months),
    "start",
    timezone,
  );
  const end = zonedCalendarDateBoundaryToDate(
    addCalendarMonths(getZonedDateParts(range.end, timezone), -months),
    "end",
    timezone,
  );
  return { ...range, start, end };
}

/** Small notice rendered when activities in non-target currencies contributed.
 *  Single-foreign-currency reports get a "source: €1,200 EUR" hint (shows the
 *  pre-FX native total). Multi-currency reports get a list. Always names the
 *  FX as-of date so the user knows what rate snapshot was used. */
function ForeignCurrencyBanner({
  currency,
  foreign,
  nativeTotals,
  asOf,
}: {
  currency: string;
  foreign: string[];
  nativeTotals: Record<string, number>;
  asOf: string; // RFC3339
}) {
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const fmtNative = (ccy: string) => {
    if (isBalanceHidden) return "••••";
    const v = nativeTotals[ccy];
    if (v == null) return ccy;
    // Intl rejects malformed codes → fall back to bare magnitude + code.
    if (!/^[A-Za-z]{3}$/.test(ccy)) return `${Math.abs(v).toFixed(0)} ${ccy}`;
    return amountFormatting.formatRoundedAmount(Math.abs(v), ccy);
  };
  const asOfDate = dateFormatting.formatDate(asOf, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const detail =
    foreign.length === 1 ? (
      <>
        {t("spending:insightsPage.source")}{" "}
        <span className="font-medium">{fmtNative(foreign[0])}</span>
      </>
    ) : (
      <>
        {t("spending:insightsPage.sources")} {foreign.map((c) => fmtNative(c)).join(" + ")}
      </>
    );
  return (
    <div className="text-muted-foreground border-border/60 bg-muted/30 text-2xs rounded-md border px-3 py-2">
      <span className="text-foreground/90 font-medium">
        {t("spending:insightsPage.multiCurrency")}
      </span>{" "}
      {t("spending:insightsPage.multiCurrencyDetail", {
        currency,
        foreign: foreign.join(", "),
        asOfDate,
      })}{" "}
      {detail}.
    </div>
  );
}
