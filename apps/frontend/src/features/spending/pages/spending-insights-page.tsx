import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { useSettingsContext } from "@/lib/settings-provider";

import { Page, PageContent, PageHeader, useIsMobile, usePersistentState } from "@wealthfolio/ui";

import { CategoryTransactionsSheet } from "../components/reports/category-transactions-sheet";
import { HeatmapCellSheet } from "../components/reports/heatmap-cell-sheet";
import { SpendingPeriodSelector } from "../components/spending-period-toggle";
import { StageNav, type InsightsStage } from "../components/reports/insights/stage-nav";
import { WhatChangedStage } from "../components/reports/insights/what-changed-stage";
import { WhenWhereStage } from "../components/reports/insights/when-where-stage";
import { WhereIAmStage } from "../components/reports/insights/where-i-am-stage";
import { useCashActivities } from "../hooks/use-cash-activities";
import { useEventSpendingSummaries } from "../hooks/use-spending-events";
import { useSpendingInsight } from "../hooks/use-spending-insight";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { insightToReportProjection, UNCATEGORIZED_CATEGORY_ID } from "../lib/insight-projection";
import {
  SPENDING_MONTH_PARAM,
  SPENDING_MONTH_STORAGE_KEY,
  addMonthsToMonthKey,
  currentMonthKey,
  monthReportsRange,
  parseMonthKey,
} from "../lib/month-period";
import {
  INSIGHTS_PERIOD_STORAGE_KEY,
  INSIGHTS_PERIOD_UPDATED_AT_STORAGE_KEY,
  normalizeReportsPeriod,
  periodPreferenceTimestamp,
} from "../lib/period-preferences";
import {
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
  getZonedDateParts,
  zonedCalendarDateBoundaryToDate,
} from "../lib/timezone";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";
const STAGE_STORAGE_KEY = "spending-insights-stage";
const EMPTY_TAXONOMY: never[] = [];
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
    day: Math.min(currentEnd.day, daysInCalendarMonth(priorEndBase.year, priorEndBase.month)),
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

export default function SpendingInsightsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const appTimezone = settings?.timezone ?? undefined;
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();

  const [persistedPeriod, setPersistedPeriod] = usePersistentState<string>(
    INSIGHTS_PERIOD_STORAGE_KEY,
    DEFAULT_REPORTS_PERIOD,
  );
  const [, setPeriodUpdatedAt] = usePersistentState<string>(
    INSIGHTS_PERIOD_UPDATED_AT_STORAGE_KEY,
    "0",
  );
  const [persistedMonth, setPersistedMonth] = usePersistentState<string | null>(
    SPENDING_MONTH_STORAGE_KEY,
    null,
  );
  const period = normalizeReportsPeriod(persistedPeriod) ?? DEFAULT_REPORTS_PERIOD;
  const [stage, setStage] = usePersistentState<InsightsStage>(STAGE_STORAGE_KEY, "where");
  const urlMonth = parseMonthKey(searchParams.get(SPENDING_MONTH_PARAM))
    ? searchParams.get(SPENDING_MONTH_PARAM)
    : null;
  const customMonth =
    urlMonth ??
    (!searchParams.has("period") && parseMonthKey(persistedMonth) ? persistedMonth : null);

  // ─── URL ↔ state sync ─────────────────────────────────────────────────────
  // ?stage=where|changed|when and ?period=MTD|LAST_MONTH|3M|6M|YTD|1Y drive the page
  // when present, otherwise fall back to the persisted localStorage values.
  // Linking from the dashboard (`/spending/insights?stage=where`) and reload-
  // ability of the current view both rely on this.
  useEffect(() => {
    const urlStage = searchParams.get("stage");
    if (urlStage && VALID_STAGES.includes(urlStage as InsightsStage) && urlStage !== stage) {
      setStage(urlStage as InsightsStage);
    }
    const urlPeriod = normalizeReportsPeriod(searchParams.get("period"));
    if (urlPeriod && urlPeriod !== period) {
      setPersistedPeriod(urlPeriod);
    }
    if (urlMonth && urlMonth !== persistedMonth) {
      setPersistedMonth(urlMonth);
    }
    // Eslint disable: we intentionally run only on URL change, not on every
    // state change — the inverse direction (state → URL) is handled by the
    // wrapped setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  const setPeriodAndUrl = useCallback(
    (next: ReportsPeriod) => {
      setPersistedPeriod(next);
      setPeriodUpdatedAt(periodPreferenceTimestamp());
      setPersistedMonth(null);
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("period", next);
          p.delete(SPENDING_MONTH_PARAM);
          return p;
        },
        { replace: true },
      );
    },
    [setPersistedPeriod, setPeriodUpdatedAt, setPersistedMonth, setSearchParams],
  );

  const setCustomMonthAndUrl = useCallback(
    (next: string | null) => {
      setPersistedMonth(next);
      setPeriodUpdatedAt(periodPreferenceTimestamp());
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("period", period);
          if (next) p.set(SPENDING_MONTH_PARAM, next);
          else p.delete(SPENDING_MONTH_PARAM);
          return p;
        },
        { replace: true },
      );
    },
    [period, setPersistedMonth, setPeriodUpdatedAt, setSearchParams],
  );

  // Events-timeline pagination — independent from `period`. Stored alongside
  // the period it was set against so changing periods resets the offset to 0
  // without needing a useEffect.
  const [offsetBinding, setOffsetBinding] = useState<{
    period: ReportsPeriod;
    offset: number;
  }>({ period, offset: 0 });
  const eventsWindowOffset = offsetBinding.period === period ? offsetBinding.offset : 0;
  const setEventsWindowOffset = useCallback(
    (next: number) => setOffsetBinding({ period, offset: Math.max(0, next) }),
    [period],
  );

  const monthRange = useMemo(
    () => (customMonth ? monthReportsRange(customMonth, appTimezone) : null),
    [customMonth, appTimezone],
  );
  const range = useMemo(
    () => monthRange ?? periodToReportsRange(period, appTimezone),
    [monthRange, period, appTimezone],
  );
  const whatChangedWindow = useMemo(() => {
    if (customMonth || period !== "MTD") return null;
    const current = monthToDateRange(appTimezone);
    return {
      current,
      prior: previousMonthMatchingRange(current, appTimezone),
    };
  }, [customMonth, period, appTimezone]);
  const eventsRange = useMemo(
    () => shiftRangeBack(range, period, eventsWindowOffset, appTimezone),
    [range, period, eventsWindowOffset, appTimezone],
  );
  const taxonomy = useTaxonomy(SPENDING_TAXONOMY);
  const incomeTaxonomy = useTaxonomy(INCOME_TAXONOMY);
  const savingsTaxonomy = useTaxonomy(SAVINGS_TAXONOMY);
  const { accounts = [] } = useAccounts({ filterActive: false });

  // ─── Single reconciled source of truth for the "Where I am" stage ─────────
  // One server call returns budgets + actuals + uncategorized + prior, all
  // computed against the same window — the math is reconciled by construction.
  const insightRequest = useMemo(
    () => ({
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      compare: "prior" as const,
    }),
    [range],
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
    () => (insight ? insightToReportProjection(insight) : null),
    [insight],
  );
  const whatChangedInsight = whatChangedRequest ? mtdComparisonInsight : insight;
  const whatChangedProjection = useMemo(
    () => (whatChangedInsight ? insightToReportProjection(whatChangedInsight) : null),
    [whatChangedInsight],
  );
  const isWhatChangedLoading = whatChangedRequest ? isMtdComparisonLoading : isInsightLoading;
  const whatChangedRange = whatChangedWindow?.current ?? range;
  const whatChangedPriorRange = whatChangedWindow?.prior;
  const categorySheetRange = stage === "changed" ? whatChangedRange : range;
  const taxonomyCategoriesForWhereIAm = useMemo(() => {
    const base = taxonomy.data?.categories ?? [];
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

  // 12-week activity window for the weekday × hour heatmap.
  const heatmapRequest = useMemo(() => {
    const end = getZonedDateParts(new Date(), appTimezone);
    const start = addCalendarDays(end, -HEATMAP_WEEKS * 7);
    return {
      startDate: zonedCalendarDateBoundaryToDate(start, "start", appTimezone).toISOString(),
      endDate: zonedCalendarDateBoundaryToDate(end, "end", appTimezone).toISOString(),
    };
  }, [appTimezone]);
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
    [heatmapInsight?.byDay],
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
  const heatmapCellActivities = useMemo(() => {
    if (!heatmapCell) return [];
    return heatmapActivities.filter((a) => {
      const d = new Date(a.activityDate);
      const zoned = getHeatmapDayHour(d);
      return (
        zoned?.weekday === heatmapCell.weekday &&
        zoned.hour >= heatmapCell.startHour &&
        zoned.hour < heatmapCell.endHour
      );
    });
  }, [getHeatmapDayHour, heatmapActivities, heatmapCell]);

  const taxonomyCategories = taxonomy.data?.categories ?? EMPTY_TAXONOMY;
  const accountTypeById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.accountType])),
    [accounts],
  );
  const maxPickerMonth = useMemo(
    () => addMonthsToMonthKey(currentMonthKey(appTimezone), -1),
    [appTimezone],
  );

  // Gate the entire page when tracking is disabled — mirrors spending-budget-page.
  // Without this, disabling tracking from ModuleCard leaves Insights live and
  // continues rendering numbers the user explicitly opted out of seeing.
  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/dashboard?tab=spending" replace />;
  }

  const periodToggle = (
    <SpendingPeriodSelector
      value={customMonth ? null : period}
      onValueChange={setPeriodAndUrl}
      customMonth={customMonth}
      maxMonth={maxPickerMonth}
      onCustomMonthChange={setCustomMonthAndUrl}
      className="w-[calc(100vw-6rem)] max-w-[calc(100vw-6rem)] sm:w-full sm:max-w-screen-md md:max-w-2xl"
    />
  );

  return (
    <Page>
      <PageHeader
        heading={isMobile ? undefined : t("spending:insightsPage.heading")}
        onBack={() => {
          if (window.history.length > 1) navigate(-1);
          else navigate("/dashboard?tab=spending");
        }}
        actions={periodToggle}
      />
      <PageContent className="space-y-5">
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
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
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
            priorRange={whatChangedPriorRange}
            timezone={appTimezone}
            currentReport={whatChangedProjection?.currentReport}
            priorReport={whatChangedProjection?.priorReport}
            months={whatChangedProjection?.months ?? []}
            taxonomyCategories={taxonomyCategoriesForWhereIAm}
            currency={whatChangedInsight?.currency ?? insight?.currency ?? baseCurrency}
            isLoading={isWhatChangedLoading}
            onCategoryClick={handleCategoryClick}
          />
        )}

        {stage === "when" && (
          <WhenWhereStage
            heatmapActivities={heatmapActivities}
            accountTypeById={accountTypeById}
            dailySpendByDate={heatmapDailySpendByDate}
            events={events}
            eventsErrored={eventsErrored}
            onRetryEvents={() => refetchEvents()}
            taxonomyCategories={taxonomyCategories}
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
      </PageContent>

      <CategoryTransactionsSheet
        open={!!activeCategory}
        onOpenChange={(open) => {
          if (!open) setActiveCategoryId(null);
        }}
        category={activeCategory}
        taxonomyCategories={taxonomyCategories}
        rangeStart={categorySheetRange.start}
        rangeEnd={categorySheetRange.end}
        currency={baseCurrency}
      />

      <HeatmapCellSheet
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
    </Page>
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
): ReportsRange {
  if (offset === 0) return range;
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
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const fmtNative = (ccy: string) => {
    if (isBalanceHidden) return "••••";
    const v = nativeTotals[ccy];
    if (v == null) return ccy;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: ccy,
        maximumFractionDigits: 0,
      }).format(Math.abs(v));
    } catch {
      // Unknown ISO code → fall back to bare magnitude + code.
      return `${Math.abs(v).toFixed(0)} ${ccy}`;
    }
  };
  const asOfDate = new Date(asOf).toLocaleDateString(undefined, {
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
    <div className="text-muted-foreground border-border/60 bg-muted/30 rounded-md border px-3 py-2 text-[11px]">
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
