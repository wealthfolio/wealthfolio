import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
} from "recharts";

import { DashboardCard } from "@/components/dashboard-card";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import type { DateRange, TaxonomyCategory } from "@/lib/types";
import { cn, formatAmount, formatDateISO } from "@/lib/utils";
import Balance from "@/pages/dashboard/balance";

import {
  Icons,
  PrivacyAmount,
  Skeleton,
  formatCompactAmount,
  usePersistentState,
} from "@wealthfolio/ui";

import { useBudget } from "../hooks/use-budget";
import { useCategorizationRules } from "../hooks/use-categorization-rules";
import { useCashActivities, useUncategorizedCount } from "../hooks/use-cash-activities";
import { useSpendingReport } from "../hooks/use-spending-report";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { SAVINGS_ROW_COLOR, SAVINGS_ROW_ID, buildWhereItWentRows } from "../lib/category-rollup";
import {
  SPENDING_MONTH_PARAM,
  SPENDING_MONTH_STORAGE_KEY,
  addMonthsToMonthKey,
  localDateFromParts,
  monthKeyFromParts,
  monthLabel,
  monthRange,
  parseMonthKey,
} from "../lib/month-period";
import {
  DASHBOARD_PERIOD_UPDATED_AT_STORAGE_KEY,
  INSIGHTS_PERIOD_STORAGE_KEY,
  INSIGHTS_PERIOD_UPDATED_AT_STORAGE_KEY,
  normalizeReportsPeriod,
  periodPreferenceTimestamp,
  shouldPreferDashboardPeriod,
} from "../lib/period-preferences";
import type { ReportsPeriod } from "../lib/reports-period";
import { FOREST_THEME, themeBg, type Palette } from "../lib/theme";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDaysBetweenInclusive,
  daysInCalendarMonth,
  formatZonedDateKey,
  getZonedDateParts,
  localDateBoundaryToISOString,
  localDateParts,
  zonedCalendarDateBoundaryToDate,
} from "../lib/timezone";
import { BudgetLineChartCard } from "./budget-line-chart-card";
import { CashFlowStrip } from "./cash-flow-strip";
import { EventsCard } from "./events-card";
import { RecentActivityCard } from "./recent-activity-card";
import { SpendingPeriodSelector } from "./spending-period-toggle";

const FUTURE_BAR = "#E5E7EB";
const SPENDING_TAXONOMY = "spending_categories";
type SpendingDashboardPeriod = "MTD" | "LAST_MONTH" | "3M" | "6M" | "YTD" | "1Y";

type SpendingSelection =
  | { kind: "period"; code: SpendingDashboardPeriod }
  | { kind: "month"; monthKey: string; restoreCode: SpendingDashboardPeriod };

const SPENDING_DASHBOARD_PERIODS: SpendingDashboardPeriod[] = [
  "MTD",
  "LAST_MONTH",
  "3M",
  "6M",
  "YTD",
  "1Y",
];

const DEFAULT_INTERVAL: SpendingDashboardPeriod = "MTD";
const INTERVAL_STORAGE_KEY = "spending-interval";
const INTERVAL_DESCRIPTIONS: Record<SpendingDashboardPeriod, string> = {
  MTD: "spending:tabContent.intervalMtd",
  LAST_MONTH: "spending:tabContent.intervalLastMonth",
  "3M": "spending:tabContent.interval3M",
  "6M": "spending:tabContent.interval6M",
  YTD: "spending:tabContent.intervalYtd",
  "1Y": "spending:tabContent.interval1Y",
};

// The three insights stages, surfaced as a "Dig deeper" strip under Recent
// activity. Mirrors the StageNav on /spending/insights.
const INSIGHT_STAGES = [
  {
    stage: "where",
    labelKey: "spending:tabContent.stageWhereLabel",
    subKey: "spending:tabContent.stageWhereSub",
    Icon: Icons.PieChart,
  },
  {
    stage: "changed",
    labelKey: "spending:tabContent.stageChangedLabel",
    subKey: "spending:tabContent.stageChangedSub",
    Icon: Icons.TrendingUp,
  },
  {
    stage: "when",
    labelKey: "spending:tabContent.stageWhenLabel",
    subKey: "spending:tabContent.stageWhenSub",
    Icon: Icons.Calendar,
  },
] as const;

function rangeToReportRequest(range: DateRange | undefined, timezone?: string | null) {
  const from = range?.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = range?.to ?? new Date();
  return {
    startDate: localDateBoundaryToISOString(from, "start", timezone),
    endDate: localDateBoundaryToISOString(to, "end", timezone),
  };
}

function isSpendingDashboardPeriod(
  value: string | null | undefined,
): value is SpendingDashboardPeriod {
  return SPENDING_DASHBOARD_PERIODS.includes(value as SpendingDashboardPeriod);
}

function normalizeSpendingDashboardPeriod(
  value: string | null | undefined,
): SpendingDashboardPeriod {
  if (isSpendingDashboardPeriod(value)) return value;
  if (value === "5Y" || value === "ALL") return "1Y";
  return DEFAULT_INTERVAL;
}

function spendingIntervalData(code: SpendingDashboardPeriod, timezone?: string | null) {
  const today = getZonedDateParts(new Date(), timezone);
  const { start, end } = (() => {
    switch (code) {
      case "MTD":
        return { start: { year: today.year, month: today.month, day: 1 }, end: today };
      case "LAST_MONTH": {
        const lastMonth = addCalendarMonths({ year: today.year, month: today.month, day: 1 }, -1);
        return {
          start: { year: lastMonth.year, month: lastMonth.month, day: 1 },
          end: {
            year: lastMonth.year,
            month: lastMonth.month,
            day: daysInCalendarMonth(lastMonth.year, lastMonth.month),
          },
        };
      }
      case "3M":
        return { start: addCalendarMonths(today, -3), end: today };
      case "6M":
        return { start: addCalendarMonths(today, -6), end: today };
      case "YTD":
        return { start: { year: today.year, month: 1, day: 1 }, end: today };
      case "1Y":
        return { start: { ...today, year: today.year - 1 }, end: today };
    }
  })();

  return {
    code,
    description: INTERVAL_DESCRIPTIONS[code],
    range: {
      from: localDateFromParts(start),
      to: localDateFromParts(end),
    },
  };
}

function insightPeriodForDashboardInterval(code: SpendingDashboardPeriod): ReportsPeriod {
  if (code === "LAST_MONTH") return "LAST_MONTH";
  return code;
}

function selectionFromParams(
  params: URLSearchParams,
  persistedInterval: string,
  persistedMonth: string | null,
): SpendingSelection {
  const intervalParam = params.get("spendingInterval");
  const monthParam = params.get(SPENDING_MONTH_PARAM);
  const restoreCode = normalizeSpendingDashboardPeriod(intervalParam ?? persistedInterval);
  const monthKey = monthParam ?? (intervalParam === null ? persistedMonth : null);
  if (monthKey && parseMonthKey(monthKey)) return { kind: "month", monthKey, restoreCode };
  return { kind: "period", code: restoreCode };
}

function budgetMonthStateForSelection(
  selection: SpendingSelection,
  currentMonthKey: string,
): { monthKey: string; touched: boolean } {
  if (selection.kind === "period" && selection.code === "LAST_MONTH") {
    return { monthKey: addMonthsToMonthKey(currentMonthKey, -1), touched: true };
  }
  if (selection.kind === "month" && selection.monthKey <= currentMonthKey) {
    return { monthKey: selection.monthKey, touched: true };
  }
  return { monthKey: currentMonthKey, touched: false };
}

function budgetSelectionSyncKey(selection: SpendingSelection, currentMonthKey: string): string {
  if (selection.kind === "month") return `month:${selection.monthKey}`;
  if (selection.code === "LAST_MONTH") return `period:${selection.code}:${currentMonthKey}`;
  return `period:${selection.code}`;
}

function selectionData(selection: SpendingSelection, timezone?: string | null) {
  if (selection.kind === "month") {
    return {
      range: monthRange(selection.monthKey),
      description: monthLabel(selection.monthKey),
      insightPeriod: "LAST_MONTH" as ReportsPeriod,
    };
  }

  const interval = spendingIntervalData(selection.code, timezone);
  return {
    range: interval.range,
    description: interval.description,
    insightPeriod: insightPeriodForDashboardInterval(selection.code),
  };
}

function previousFullMonthRange(range: DateRange): DateRange | undefined {
  if (!range.from) return undefined;
  const start = localDateParts(range.from);
  const priorMonth = addCalendarMonths({ year: start.year, month: start.month, day: 1 }, -1);
  return monthRange(monthKeyFromParts(priorMonth));
}

function usesCalendarMonthComparison(selection: SpendingSelection) {
  return (
    selection.kind === "month" || (selection.kind === "period" && selection.code === "LAST_MONTH")
  );
}

function priorRange(
  range: DateRange | undefined,
  selection?: SpendingSelection,
): DateRange | undefined {
  if (!range?.from || !range?.to) return undefined;
  if (selection && usesCalendarMonthComparison(selection)) {
    return previousFullMonthRange(range);
  }
  const start = localDateParts(range.from);
  const end = localDateParts(range.to);
  const days = calendarDaysBetweenInclusive(start, end);
  if (days <= 0) return undefined;
  const priorEnd = addCalendarDays(start, -1);
  const priorStart = addCalendarDays(priorEnd, -(days - 1));
  return {
    from: localDateFromParts(priorStart),
    to: localDateFromParts(priorEnd),
  };
}

/**
 * Map a spending-chart bar `key` to the [from, to] date range it covers, so a
 * bar click can deep-link into the Transactions list for that period. The key
 * shape depends on granularity (see the barData builder): `YYYY-MM-DD` for the
 * day/week start, `YYYY-MM` for a month.
 */
function barKeyToRange(
  key: string,
  granularity: "day" | "week" | "month",
): { from: string; to: string } {
  if (granularity === "day") return { from: key, to: key };
  if (granularity === "week") {
    const [y, m, d] = key.split("-").map(Number);
    return { from: key, to: formatDateISO(new Date(y, m - 1, d + 6)) };
  }
  const [y, m] = key.split("-").map(Number);
  // Day 0 of the next month resolves to the last day of this month.
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, "0")}` };
}

export default function SpendingTabContent() {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const appTimezone = settings?.timezone ?? undefined;
  const navigate = useNavigate();
  const { accountIds: spendingAccountIds, isLoading: spendingSettingsLoading } =
    useSpendingSettings();

  const [searchParams, setSearchParams] = useSearchParams();
  // URL-driven so `/dashboard?tab=spending&spendingInterval=3M` is shareable
  // and survives reload. Falls back to the persisted preference, then to
  // DEFAULT_INTERVAL. The "spendingInterval" prefix avoids colliding with
  // other dashboard tabs that may want their own `?interval`.
  const [persistedInterval, setPersistedInterval] = usePersistentState<string>(
    INTERVAL_STORAGE_KEY,
    DEFAULT_INTERVAL,
  );
  const [persistedMonth, setPersistedMonth] = usePersistentState<string | null>(
    SPENDING_MONTH_STORAGE_KEY,
    null,
  );
  const [persistedInsightPeriod] = usePersistentState<string | null>(
    INSIGHTS_PERIOD_STORAGE_KEY,
    null,
  );
  const [insightPeriodUpdatedAt] = usePersistentState<string>(
    INSIGHTS_PERIOD_UPDATED_AT_STORAGE_KEY,
    "0",
  );
  const [dashboardPeriodUpdatedAt, setDashboardPeriodUpdatedAt] = usePersistentState<string>(
    DASHBOARD_PERIOD_UPDATED_AT_STORAGE_KEY,
    "0",
  );
  const selection = useMemo(
    () => selectionFromParams(searchParams, persistedInterval, persistedMonth),
    [searchParams, persistedInterval, persistedMonth],
  );
  const selectedPeriod = selection.kind === "period" ? selection.code : null;
  const customMonth = selection.kind === "month" ? selection.monthKey : null;
  const restoreCode = selection.kind === "month" ? selection.restoreCode : selection.code;
  const {
    range: dateRange,
    description: selectedIntervalDescription,
    insightPeriod,
  } = useMemo(() => selectionData(selection, appTimezone), [selection, appTimezone]);
  const theme: Palette = FOREST_THEME;

  const [whereItWentView, setWhereItWentView] = usePersistentState<"list" | "map">(
    "spending-where-view",
    "list",
  );

  const reportReq = useMemo(
    () => rangeToReportRequest(dateRange, appTimezone),
    [dateRange, appTimezone],
  );
  // `priorRange` returns undefined for invalid / zero-span ranges; in that
  // case feeding it back through `rangeToReportRequest` produces the
  // current-month default, which would make priorReport identical to
  // currentReport (priorSpending == totalSpending) and surface a misleading
  // "About the same as prior period" delta line. Track whether we actually
  // have a prior window and gate the query on it.
  const priorRangeForReport = useMemo(
    () => priorRange(dateRange, selection),
    [dateRange, selection],
  );
  const priorReportReq = useMemo(
    () =>
      priorRangeForReport ? rangeToReportRequest(priorRangeForReport, appTimezone) : reportReq,
    [priorRangeForReport, reportReq, appTimezone],
  );

  const {
    data: report,
    isLoading,
    isError: reportErrored,
    refetch: refetchReport,
  } = useSpendingReport(reportReq);
  const { data: priorReport, isLoading: isPriorLoading } = useSpendingReport(
    priorReportReq,
    /* enabled */ priorRangeForReport !== undefined,
  );
  const { data: activities = [], isError: activitiesErrored } = useCashActivities({
    startDate: reportReq.startDate,
    endDate: reportReq.endDate,
  });
  const taxonomy = useTaxonomy(SPENDING_TAXONOMY);
  const { data: budget, isError: budgetErrored } = useBudget();
  const todayParts = useMemo(() => getZonedDateParts(new Date(), appTimezone), [appTimezone]);
  const currentBudgetMonthKey = useMemo(() => monthKeyFromParts(todayParts), [todayParts]);
  const budgetSyncKey = useMemo(
    () => budgetSelectionSyncKey(selection, currentBudgetMonthKey),
    [selection, currentBudgetMonthKey],
  );
  const lastBudgetSyncKey = useRef(budgetSyncKey);
  const [budgetMonthKey, setBudgetMonthKey] = useState(() => {
    return budgetMonthStateForSelection(selection, currentBudgetMonthKey).monthKey;
  });
  const [budgetMonthTouched, setBudgetMonthTouched] = useState(() => {
    return budgetMonthStateForSelection(selection, currentBudgetMonthKey).touched;
  });
  useEffect(() => {
    if (lastBudgetSyncKey.current === budgetSyncKey) return;
    lastBudgetSyncKey.current = budgetSyncKey;
    const next = budgetMonthStateForSelection(selection, currentBudgetMonthKey);
    setBudgetMonthKey(next.monthKey);
    setBudgetMonthTouched(next.touched);
  }, [budgetSyncKey, currentBudgetMonthKey, selection]);
  useEffect(() => {
    setBudgetMonthKey((monthKey) => {
      if (!budgetMonthTouched) return currentBudgetMonthKey;
      return monthKey > currentBudgetMonthKey ? currentBudgetMonthKey : monthKey;
    });
  }, [budgetMonthTouched, currentBudgetMonthKey]);
  const { data: budgetCardBudget, isError: budgetCardBudgetErrored } = useBudget(budgetMonthKey);
  const { accounts = [] } = useAccounts({ filterActive: false });
  const { data: categorizationRules = [], isLoading: categorizationRulesLoading } =
    useCategorizationRules();
  const { data: uncategorizedCount = 0 } = useUncategorizedCount(
    reportReq.startDate,
    reportReq.endDate,
  );
  // Aggregated error state for the headline banner. Activities / budget
  // failures degrade more silently than report (their absence shows up as
  // a flat treemap or hidden chips), but the user deserves a signal.
  const dataErrored =
    reportErrored || activitiesErrored || budgetErrored || budgetCardBudgetErrored;
  const hasNoIncludedAccounts = !spendingSettingsLoading && spendingAccountIds.length === 0;

  const budgetMonthRange = useMemo(() => {
    const month = parseMonthKey(budgetMonthKey) ?? todayParts;
    const start = { year: month.year, month: month.month, day: 1 };
    const end =
      budgetMonthKey === currentBudgetMonthKey
        ? todayParts
        : { ...month, day: daysInCalendarMonth(month.year, month.month) };
    return { from: localDateFromParts(start), to: localDateFromParts(end) };
  }, [budgetMonthKey, currentBudgetMonthKey, todayParts]);
  const monthReportReq = useMemo(
    () => rangeToReportRequest(budgetMonthRange, appTimezone),
    [budgetMonthRange, appTimezone],
  );
  const { data: monthReport } = useSpendingReport(monthReportReq);
  const budgetMonthActivityRange = useMemo(
    () => ({
      from: formatDateISO(budgetMonthRange.from),
      to: formatDateISO(budgetMonthRange.to),
    }),
    [budgetMonthRange],
  );
  const shiftBudgetMonth = (months: number) => {
    setBudgetMonthTouched(true);
    setBudgetMonthKey((monthKey) => {
      const next = addMonthsToMonthKey(monthKey, months);
      return next > currentBudgetMonthKey ? currentBudgetMonthKey : next;
    });
  };

  const historyReportReq = useMemo(() => {
    const month = parseMonthKey(budgetMonthKey) ?? todayParts;
    const monthStart = { year: month.year, month: month.month, day: 1 };
    const historyStart = addCalendarMonths(monthStart, -3);
    const historyEndMonth = addCalendarMonths(monthStart, -1);
    const historyEnd = {
      ...historyEndMonth,
      day: daysInCalendarMonth(historyEndMonth.year, historyEndMonth.month),
    };
    return {
      startDate: zonedCalendarDateBoundaryToDate(historyStart, "start", appTimezone).toISOString(),
      endDate: zonedCalendarDateBoundaryToDate(historyEnd, "end", appTimezone).toISOString(),
    };
  }, [budgetMonthKey, appTimezone, todayParts]);
  const { data: historyReport } = useSpendingReport(historyReportReq);

  const historicalDailyAvg = useMemo(() => {
    const total = historyReport?.current.outflow ?? 0;
    if (total <= 0) return 0;
    const month = parseMonthKey(budgetMonthKey) ?? todayParts;
    const monthStart = { year: month.year, month: month.month, day: 1 };
    const start = addCalendarMonths(monthStart, -3);
    const endMonth = addCalendarMonths(monthStart, -1);
    const end = { ...endMonth, day: daysInCalendarMonth(endMonth.year, endMonth.month) };
    const days = Math.max(1, calendarDaysBetweenInclusive(start, end));
    return total / days;
  }, [historyReport?.current.outflow, budgetMonthKey, todayParts]);

  // Always render in the user's base currency. The backend FX-converts every
  // activity in `report` to base at period end, so labeling by the first
  // activity's currency (the pre-FX behavior) would mislabel multi-currency
  // accounts. Single-currency users see the same number either way.
  const currency = baseCurrency;
  const dashboardInsightHref = useMemo(() => {
    const preferDashboardPeriod = shouldPreferDashboardPeriod({
      persistedInsightPeriod,
      dashboardUpdatedAt: dashboardPeriodUpdatedAt,
      insightUpdatedAt: insightPeriodUpdatedAt,
    });
    const linkPeriod = preferDashboardPeriod
      ? insightPeriod
      : (normalizeReportsPeriod(persistedInsightPeriod) ?? insightPeriod);
    const monthParams =
      preferDashboardPeriod && selection.kind === "month"
        ? `&${SPENDING_MONTH_PARAM}=${selection.monthKey}`
        : "";
    const href = (stage: (typeof INSIGHT_STAGES)[number]["stage"], hash = "") =>
      `/spending/insights?stage=${stage}&period=${linkPeriod}${monthParams}${hash}`;
    const cashflow = href("where", "#cashflow");
    return {
      where: href("where"),
      changed: href("changed"),
      when: href("when"),
      cashflow,
    };
  }, [
    dashboardPeriodUpdatedAt,
    insightPeriod,
    insightPeriodUpdatedAt,
    persistedInsightPeriod,
    selection,
  ]);
  const accountTypeById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.accountType])),
    [accounts],
  );

  const totalSpending = report?.current.outflow ?? 0;
  const totalSaved = report?.current.saved ?? 0;
  const priorSpending = priorReport?.current.outflow ?? 0;
  const delta = totalSpending - priorSpending;
  // `deltaPct` is a RATIO (0.2 == 20%) used for thresholds; convert to
  // percentage on render. `displayDeltaPct` is the same ratio but null'd out
  // when prior is too small to make the percentage meaningful — that gating
  // is only for *display*, not for fact-detection (e.g. "spending doubled"
  // is interesting even when prior was $50 — the insight should still fire,
  // even if we choose not to render the eye-popping % delta).
  const deltaPct = priorSpending > 0 ? delta / priorSpending : 0;
  const priorIsMeaningful = priorSpending >= Math.max(100, totalSpending * 0.02);
  const displayDeltaPct = priorIsMeaningful ? deltaPct : null;
  const maxPickerMonth = useMemo(
    () => addMonthsToMonthKey(currentBudgetMonthKey, -1),
    [currentBudgetMonthKey],
  );

  const handleIntervalSelect = (code: SpendingDashboardPeriod) => {
    setPersistedInterval(code);
    setPersistedMonth(null);
    setDashboardPeriodUpdatedAt(periodPreferenceTimestamp());
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("spendingInterval", code);
        p.delete(SPENDING_MONTH_PARAM);
        return p;
      },
      { replace: true },
    );
    if (code === "LAST_MONTH") {
      setBudgetMonthKey(addMonthsToMonthKey(currentBudgetMonthKey, -1));
      setBudgetMonthTouched(true);
    } else {
      setBudgetMonthKey(currentBudgetMonthKey);
      setBudgetMonthTouched(false);
    }
  };

  const handleCustomMonthSelect = (monthKey: string | null) => {
    setPersistedMonth(monthKey);
    setDashboardPeriodUpdatedAt(periodPreferenceTimestamp());
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (monthKey) {
          p.set("spendingInterval", restoreCode);
          p.set(SPENDING_MONTH_PARAM, monthKey);
        } else {
          p.set("spendingInterval", restoreCode);
          p.delete(SPENDING_MONTH_PARAM);
        }
        return p;
      },
      { replace: true },
    );
    if (monthKey && monthKey <= currentBudgetMonthKey) {
      setBudgetMonthKey(monthKey);
      setBudgetMonthTouched(true);
    } else {
      setBudgetMonthKey(currentBudgetMonthKey);
      setBudgetMonthTouched(false);
    }
  };

  const granularity: "day" | "week" | "month" = useMemo(() => {
    if (selection.kind === "month") return "day";
    switch (selection.code) {
      case "MTD":
      case "LAST_MONTH":
        return "day";
      case "3M":
      case "6M":
        return "week";
      default:
        return "month";
    }
  }, [selection]);

  const { barData, avgValue, avgLabel } = useMemo(() => {
    const buckets = report?.byDay ?? [];
    if (buckets.length === 0)
      return { barData: [], avgValue: 0, avgLabel: t("spending:tabContent.avg") };
    const sorted = buckets.slice().sort((a, b) => a.date.localeCompare(b.date));
    const todayParts = getZonedDateParts(new Date(), appTimezone);
    const todayKey = formatZonedDateKey(new Date(), appTimezone);
    const monthLabels = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    const groups = new Map<
      string,
      { key: string; label: string; sortKey: string; value: number; future: boolean }
    >();
    for (const b of sorted) {
      const [yStr, mStr, dStr] = b.date.split("-");
      const year = parseInt(yStr, 10);
      const month = parseInt(mStr, 10);
      const day = parseInt(dStr, 10);
      const date = new Date(year, month - 1, day);

      let key: string;
      let label: string;
      let sortKey: string;
      if (granularity === "day") {
        key = b.date;
        label = day === 1 ? `${monthLabels[month - 1]} 1` : String(day);
        sortKey = b.date;
      } else if (granularity === "week") {
        const weekday = (date.getDay() + 6) % 7;
        const monday = new Date(date);
        monday.setDate(date.getDate() - weekday);
        key = formatDateISO(monday);
        label = `${monthLabels[monday.getMonth()]} ${monday.getDate()}`;
        sortKey = key;
      } else {
        key = `${year}-${mStr}`;
        label =
          year !== todayParts.year
            ? `${monthLabels[month - 1]} '${String(year).slice(2)}`
            : monthLabels[month - 1];
        sortKey = `${yStr}-${mStr}`;
      }

      const future = b.date > todayKey;
      const e =
        groups.get(key) ??
        ({ key, label, sortKey, value: 0, future } as {
          key: string;
          label: string;
          sortKey: string;
          value: number;
          future: boolean;
        });
      e.value += b.outflow;
      if (!future) e.future = false;
      groups.set(key, e);
    }
    let data = Array.from(groups.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    if (granularity === "day" && dateRange?.from && dateRange?.to) {
      const padded = new Map(data.map((d) => [d.key, d]));
      const cursor = new Date(
        dateRange.from.getFullYear(),
        dateRange.from.getMonth(),
        dateRange.from.getDate(),
      );
      const end = new Date(
        dateRange.to.getFullYear(),
        dateRange.to.getMonth(),
        dateRange.to.getDate(),
      );
      while (cursor <= end) {
        const key = formatDateISO(cursor);
        if (!padded.has(key)) {
          const day = cursor.getDate();
          const month = cursor.getMonth();
          padded.set(key, {
            key,
            label: day === 1 ? `${monthLabels[month]} 1` : String(day),
            sortKey: key,
            value: 0,
            future: key > todayKey,
          });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      data = Array.from(padded.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    }

    const observed = data.filter((d) => d.value > 0);
    const avg =
      observed.length > 0 ? observed.reduce((s, d) => s + d.value, 0) / observed.length : 0;
    const labelByGranularity =
      granularity === "day"
        ? t("spending:tabContent.dailyAvg")
        : granularity === "week"
          ? t("spending:tabContent.weeklyAvg")
          : t("spending:tabContent.monthlyAvg");
    return { barData: data, avgValue: avg, avgLabel: labelByGranularity };
  }, [report?.byDay, granularity, dateRange, appTimezone, t]);

  const categoriesMeta = useMemo(() => {
    const meta = new Map<
      string,
      { name: string; color: string | null; icon: string | null; parentId: string | null }
    >();
    (taxonomy.data?.categories ?? []).forEach((c: TaxonomyCategory) => {
      meta.set(c.id, {
        name: c.name,
        color: c.color ?? null,
        icon: c.icon ?? null,
        parentId: c.parentId ?? null,
      });
    });
    return meta;
  }, [taxonomy.data?.categories]);

  const categoryRows = useMemo(() => {
    if (!report) return [];
    return buildWhereItWentRows({
      spendingBreakdown: report.spendingBreakdown,
      priorSpendingBreakdown: priorReport?.spendingBreakdown ?? [],
      categoriesMeta,
      totalSaved,
      priorSaved: priorReport?.current.saved ?? 0,
      uncategorizedLabel: t("spending:insightsPage.uncategorized"),
      savingsLabel: t("spending:cashFlow.saving"),
    });
  }, [report, priorReport, categoriesMeta, t, totalSaved]);

  const insights = useMemo(() => {
    const items: {
      icon: string;
      title: React.ReactNode;
      sub: React.ReactNode;
      action?: React.ReactNode;
    }[] = [];
    if (priorSpending > 0 && deltaPct > 0.2) {
      items.push({
        icon: "!",
        title: (
          <>
            {t("spending:tabContent.spendingAbovePrefix")}{" "}
            <span className="font-semibold">
              {t("spending:tabContent.pctAbove", { pct: (deltaPct * 100).toFixed(0) })}
            </span>{" "}
            {t("spending:tabContent.thePriorPeriod")}
          </>
        ),
        sub: t("spending:tabContent.moreThan", {
          more: isBalanceHidden ? "••••" : formatAmount(delta, currency),
          prior: isBalanceHidden ? "••••" : formatAmount(priorSpending, currency),
        }),
      });
    }
    const uncategorized = categoryRows.find((c) => c.id === "__uncategorized__");
    if (uncategorized && uncategorized.txCount > 0) {
      const hasNoCategorizationRules =
        !categorizationRulesLoading && categorizationRules.length === 0;
      items.push({
        icon: "+",
        title: (
          <>
            <span className="font-semibold">
              {t("spending:tabContent.uncategorizedCount", { count: uncategorized.txCount })}
            </span>{" "}
            {t("spending:tabContent.totaling")}{" "}
            <PrivacyAmount value={uncategorized.amount} currency={currency} />.
          </>
        ),
        sub: t("spending:tabContent.categorizeToImprove"),
        action: (
          <Link
            to="/assistant"
            state={{
              aiPrompt: t("spending:tabContent.aiCategorizePrompt"),
            }}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
            style={{ color: theme.deep }}
          >
            <Icons.Sparkles className="h-3 w-3" />
            {t("spending:tabContent.askAiCategorize")}
          </Link>
        ),
      });
      if (hasNoCategorizationRules) {
        items.push({
          icon: "!",
          title: (
            <>
              {t("spending:tabContent.noRulesSet")}{" "}
              <Link
                to="/settings/spending/rules"
                className="font-semibold underline-offset-4 hover:underline"
              >
                {t("spending:tabContent.createRules")}
              </Link>
            </>
          ),
          sub: t("spending:tabContent.automateMatching"),
        });
      }
    }
    return items;
  }, [
    deltaPct,
    delta,
    priorSpending,
    categoryRows,
    currency,
    isBalanceHidden,
    categorizationRules,
    categorizationRulesLoading,
    theme.deep,
    t,
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      {dataErrored && (
        <div className="mx-4 mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 md:mx-6 lg:mx-8 dark:text-amber-300">
          <span>
            <span className="font-semibold">{t("spending:tabContent.loadError")}</span>{" "}
            {t("spending:insightsPage.showingZeros")}
          </span>
          <button
            type="button"
            onClick={() => void refetchReport()}
            className="text-foreground hover:underline"
          >
            {t("common:retry")}
          </button>
        </div>
      )}
      <div className="px-4 pb-6 pt-2 md:px-6 md:pb-2 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
          <div>
            <div className="text-muted-foreground/80 text-[11px] font-semibold uppercase tracking-[0.12em]">
              {t("spending:tabContent.spentLabel")}
              {selectedIntervalDescription
                ? ` · ${selectedIntervalDescription.startsWith("spending:") ? t(selectedIntervalDescription) : selectedIntervalDescription}`
                : ""}
            </div>
            <Balance
              isLoading={isLoading}
              targetValue={totalSpending}
              currency={currency}
              displayCurrency={true}
            />
            <div className="text-md flex items-center">
              {isPriorLoading ? (
                <Skeleton className="mt-1 h-4 w-56" />
              ) : priorSpending > 0 ? (
                <SpendingDeltaLine
                  delta={delta}
                  currency={currency}
                  deltaPct={
                    displayDeltaPct !== null && Math.abs(displayDeltaPct) <= 5
                      ? displayDeltaPct
                      : null
                  }
                />
              ) : null}
            </div>
          </div>
          <CashFlowStrip
            income={report?.current.income ?? 0}
            spending={report?.current.outflow ?? 0}
            saving={report?.current.saved ?? 0}
            currency={currency}
            isLoading={isLoading}
            incomeHref={dashboardInsightHref.cashflow}
            spendingHref={dashboardInsightHref.cashflow}
            savingHref={dashboardInsightHref.cashflow}
          />
        </div>
      </div>

      <div
        className="flex grow flex-col"
        style={{
          backgroundImage: `linear-gradient(to top, ${themeBg(theme, 0.3)}, ${themeBg(theme, 0.15)} 50%, transparent 100%)`,
        }}
      >
        <div className="h-[280px] [&_.recharts-layer]:outline-none [&_.recharts-rectangle]:outline-none [&_.recharts-surface]:outline-none">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Skeleton className="h-full w-full" />
            </div>
          ) : barData.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center">
              <Icons.CreditCard className="text-muted-foreground/30 mb-3 h-12 w-12" />
              <p className="text-muted-foreground text-sm">
                {t("spending:tabContent.noSpendingInPeriod")}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 8, right: 24, left: 16, bottom: 8 }}>
                <defs>
                  <linearGradient id="spending-bar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.deep} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={theme.mid} stopOpacity={0.7} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  interval="preserveStartEnd"
                  minTickGap={granularity === "day" ? 8 : 16}
                />
                <Tooltip
                  cursor={{ fill: "rgba(0,0,0,0.04)" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload as {
                      key: string;
                      label: string;
                      value: number;
                      future: boolean;
                    };
                    return (
                      <div className="bg-background rounded-md border px-3 py-2 text-xs shadow-sm">
                        <div className="text-muted-foreground">{p.key}</div>
                        <div className="text-foreground font-semibold tabular-nums">
                          {p.future ? "—" : <PrivacyAmount value={p.value} currency={currency} />}
                        </div>
                        {avgValue > 0 && (
                          <div className="text-muted-foreground/70 mt-1 flex items-center gap-1.5 tabular-nums">
                            <span
                              aria-hidden
                              className="inline-block h-px w-3 border-t border-dashed border-current opacity-60"
                            />
                            <span>
                              {avgLabel} · {formatCompactAmount(avgValue, currency)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {avgValue > 0 && (
                  <ReferenceLine
                    y={avgValue}
                    stroke="var(--muted-foreground)"
                    strokeDasharray="3 3"
                    strokeOpacity={0.4}
                  />
                )}
                <Bar
                  dataKey="value"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                  onClick={(data: unknown) => {
                    const entry = ((data as { payload?: (typeof barData)[number] })?.payload ??
                      data) as (typeof barData)[number];
                    if (!entry || entry.future || entry.value <= 0) return;
                    const { from, to } = barKeyToRange(entry.key, granularity);
                    navigate(`/activities?tab=spending&from=${from}&to=${to}`);
                  }}
                >
                  {barData.map((entry, i) => (
                    <Cell
                      key={`cell-${i}`}
                      fill={entry.future ? FUTURE_BAR : "url(#spending-bar)"}
                      opacity={entry.future ? 0.7 : 1}
                      style={{ cursor: entry.future || entry.value <= 0 ? "default" : "pointer" }}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="flex w-full justify-center">
            <SpendingPeriodSelector
              className="pointer-events-auto relative z-20 w-full max-w-screen-sm sm:max-w-screen-md md:max-w-2xl lg:max-w-3xl"
              value={selectedPeriod}
              onValueChange={handleIntervalSelect}
              customMonth={customMonth}
              maxMonth={maxPickerMonth}
              onCustomMonthChange={handleCustomMonthSelect}
              isLoading={isLoading}
            />
          </div>
        </div>

        <div className="grow px-4 pb-[var(--mobile-nav-total-offset)] pt-24 md:px-6 md:pb-6 md:pt-20 lg:px-10 lg:pb-8 lg:pt-24">
          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3 lg:gap-20">
            <div className="contents lg:col-span-2 lg:block lg:space-y-6">
              <DashboardCard
                title={t("spending:tabContent.whereItWent")}
                className="order-1 overflow-hidden lg:order-none"
                action={
                  <div className="flex items-center gap-3">
                    <SegmentedToggle
                      ariaLabel={t("spending:tabContent.whereItWentView")}
                      items={[
                        { value: "list", label: t("spending:tabContent.listView") },
                        { value: "map", label: t("spending:tabContent.mapView") },
                      ]}
                      value={whereItWentView}
                      onChange={(v) => setWhereItWentView(v as "list" | "map")}
                    />
                    <Link
                      to={dashboardInsightHref.where}
                      className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
                    >
                      {t("spending:tabContent.viewAll")}
                    </Link>
                  </div>
                }
              >
                {isLoading ? (
                  <Skeleton className="h-[260px] w-full rounded-lg" />
                ) : whereItWentView === "map" ? (
                  <CategoryTreemapMono
                    rows={categoryRows}
                    total={totalSpending + totalSaved}
                    currency={currency}
                    themeColor={theme.deep}
                    hasNoIncludedAccounts={hasNoIncludedAccounts}
                    savingsHref={dashboardInsightHref.cashflow}
                  />
                ) : (
                  <CategoryRankedBar
                    rows={categoryRows}
                    total={totalSpending + totalSaved}
                    currency={currency}
                    themeColor={theme.deep}
                    groupRows={budget?.computed.groupRows ?? []}
                    hasNoIncludedAccounts={hasNoIncludedAccounts}
                    savingsHref={dashboardInsightHref.cashflow}
                  />
                )}
              </DashboardCard>

              <div className="order-3 lg:order-none">
                <RecentActivityCard
                  activities={activities}
                  accountTypeById={accountTypeById}
                  categoriesMeta={categoriesMeta}
                  currency={currency}
                  uncategorizedCount={uncategorizedCount}
                />
              </div>

              <div className="order-6 lg:order-none">
                <h2 className="pb-2 text-sm font-semibold tracking-tight">
                  {t("spending:tabContent.digDeeper")}
                </h2>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  {INSIGHT_STAGES.map((s) => (
                    <Link
                      key={s.stage}
                      to={dashboardInsightHref[s.stage]}
                      className="border-border/50 bg-background/30 hover:border-border hover:bg-background/60 group flex flex-col gap-3 rounded-lg border p-3.5 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <s.Icon className="h-4 w-4" style={{ color: theme.deep }} />
                        <Icons.ArrowRight className="text-muted-foreground/40 group-hover:text-foreground h-3.5 w-3.5 transition-colors" />
                      </div>
                      <div>
                        <div className="text-foreground text-sm font-medium">{t(s.labelKey)}</div>
                        <div className="text-muted-foreground/80 mt-0.5 text-xs leading-snug">
                          {t(s.subKey)}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>

            <div className="contents lg:col-span-1 lg:block lg:space-y-6">
              <div className="order-2 lg:order-none">
                <BudgetLineChartCard
                  monthKey={budgetMonthKey}
                  today={todayParts}
                  isCurrentMonth={budgetMonthKey === currentBudgetMonthKey}
                  onPreviousMonth={() => shiftBudgetMonth(-1)}
                  onNextMonth={() => shiftBudgetMonth(1)}
                  canGoNextMonth={budgetMonthKey < currentBudgetMonthKey}
                  activityRange={budgetMonthActivityRange}
                  target={budgetCardBudget?.computed.totals.spendingPlanned ?? 0}
                  spent={monthReport?.current.outflow ?? 0}
                  currency={budgetCardBudget?.computed.currency ?? currency}
                  historicalDailyAvg={historicalDailyAvg}
                  allocations={
                    budgetCardBudget?.computed.groupRows.flatMap((row) => row.categories) ?? []
                  }
                  spendingBreakdown={monthReport?.spendingBreakdown ?? []}
                  categoriesMeta={categoriesMeta}
                  monthByDay={monthReport?.byDay ?? []}
                  historicalByDay={historyReport?.byDay ?? []}
                />
              </div>

              {insights.length > 0 && (
                <div className="border-border/40 bg-card/70 order-4 rounded-xl border p-4 backdrop-blur-xl md:p-5 lg:order-none">
                  <div className="mb-2 flex items-center gap-2">
                    <Icons.AlertCircle className="h-4 w-4 shrink-0" style={{ color: theme.deep }} />
                    <h3 className="text-foreground text-sm font-semibold">
                      {t("spending:tabContent.worthALook")}
                    </h3>
                    <span className="text-muted-foreground/70 ml-auto text-xs">
                      {t("spending:tabContent.signalCount", { count: insights.length })}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {insights.map((ins, i) => (
                      <div key={i} className="flex gap-2 text-xs">
                        <span
                          className="w-4 shrink-0 text-base font-bold leading-none"
                          style={{
                            color: ins.icon === "!" ? "#C28B47" : theme.deep,
                          }}
                        >
                          {ins.icon}
                        </span>
                        <div>
                          <div className="text-foreground">{ins.title}</div>
                          <div className="text-muted-foreground/80 mt-0.5">{ins.sub}</div>
                          {ins.action && <div>{ins.action}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <Link
                    to={dashboardInsightHref.changed}
                    className="text-muted-foreground hover:text-foreground ml-6 mt-3 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                  >
                    {t("spending:tabContent.seeTrends")}
                    <Icons.ChevronRight className="h-3 w-3" />
                  </Link>
                </div>
              )}

              <div className="order-5 lg:order-none">
                <EventsCard
                  activities={activities}
                  accountTypeById={accountTypeById}
                  categoriesMeta={categoriesMeta}
                  eventSummaryEndDate={reportReq.endDate}
                  eventSummaryStartDate={reportReq.startDate}
                  periodEndDate={dateRange?.to ? formatDateISO(dateRange.to) : reportReq.endDate}
                  periodStartDate={
                    dateRange?.from ? formatDateISO(dateRange.from) : reportReq.startDate
                  }
                  theme={theme}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── small inline components ──────────────────────────────────────────────

function SegmentedToggle({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  /** A11y label for the group — without this, screen readers announce two
   *  unrelated buttons instead of a single logical control. */
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="bg-card/40 border-border/60 inline-flex max-w-full items-center gap-0.5 rounded-full border p-0.5"
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            aria-pressed={active}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Where it went — Map (treemap) and List variants ──────────────────────

interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  amount: number;
}

/**
 * Deep-link for a "Where it went" node. The synthetic uncategorized bucket has
 * no real category id, so it routes to the status filter — the category filter
 * would match nothing and render an empty list.
 */
function spendingActivityHref(id: string, savingsHref?: string): string {
  if (id === SAVINGS_ROW_ID) return savingsHref ?? "/activities?tab=spending";
  return id === "__uncategorized__"
    ? "/activities?tab=spending&status=uncategorized"
    : `/activities?tab=spending&category=${id}`;
}

function WhereItWentEmptyState({ hasNoIncludedAccounts }: { hasNoIncludedAccounts: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="py-6 text-center">
      {hasNoIncludedAccounts ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            {t("spending:tabContent.noAccountsSelected")}
          </p>
          <Link
            to="/settings/spending"
            className="text-foreground inline-flex text-xs underline-offset-4 hover:underline"
          >
            {t("spending:tabContent.openSpendingSettings")}
          </Link>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("spending:hierarchy.noCategorizedSpending")}
        </p>
      )}
    </div>
  );
}

interface CategoryTreemapNodeProps {
  depth?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  amount?: number;
  pct?: number;
  fill?: string;
  currency?: string;
  id?: string;
}

interface CategoryTreemapNodeMonoProps extends CategoryTreemapNodeProps {
  accent?: string | null;
  onActivate?: (id: string) => void;
}

function CategoryTreemapMono({
  rows,
  total,
  currency,
  themeColor,
  hasNoIncludedAccounts,
  savingsHref,
}: {
  rows: CategoryRow[];
  total: number;
  currency: string;
  themeColor: string;
  hasNoIncludedAccounts: boolean;
  savingsHref?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (rows.length === 0 || total <= 0) {
    return <WhereItWentEmptyState hasNoIncludedAccounts={hasNoIncludedAccounts} />;
  }

  const top = rows.slice(0, 8);
  const restAmount = rows.slice(8).reduce((s, r) => s + r.amount, 0);
  const data: {
    name: string;
    amount: number;
    fill: string;
    accent: string | null;
    id: string;
    pct: number;
  }[] = top.map((r) => ({
    name: r.name,
    amount: r.amount,
    fill: themeColor,
    accent: r.color,
    id: r.id,
    pct: total > 0 ? (r.amount / total) * 100 : 0,
  }));
  if (restAmount > 0) {
    data.push({
      name: t("spending:hero.other"),
      amount: restAmount,
      fill: themeColor,
      accent: null,
      id: "__other__",
      pct: total > 0 ? (restAmount / total) * 100 : 0,
    });
  }

  return (
    <div className="border-border/60 bg-card/40 overflow-hidden rounded-xl border p-4 backdrop-blur-xl md:p-5">
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={data}
            dataKey="amount"
            aspectRatio={4 / 3}
            stroke="transparent"
            content={
              (
                <CategoryTreemapNodeMono
                  currency={currency}
                  onActivate={(id) => {
                    if (id && id !== "__other__") {
                      navigate(spendingActivityHref(id, savingsHref));
                    }
                  }}
                />
              ) as unknown as React.ReactElement
            }
            isAnimationActive={false}
            onClick={(node: unknown) => {
              const id = (node as { id?: string } | null)?.id;
              if (id && id !== "__other__") {
                navigate(spendingActivityHref(id, savingsHref));
              }
            }}
          >
            <Tooltip
              cursor={{ fill: "rgba(0,0,0,0.04)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { name: string; amount: number; pct: number };
                return (
                  <div className="bg-background rounded-md border px-3 py-2 text-xs shadow-sm">
                    <div className="text-foreground font-semibold">{p.name}</div>
                    <div className="text-muted-foreground tabular-nums">
                      <PrivacyAmount value={p.amount} currency={currency} /> · {p.pct.toFixed(1)}%
                    </div>
                  </div>
                );
              }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const CategoryTreemapNodeMono: FC<CategoryTreemapNodeMonoProps> = ({
  depth = 0,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  name,
  amount = 0,
  pct = 0,
  fill = "#7DB3D9",
  currency = "USD",
  accent,
  id,
  onActivate,
}) => {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  if (depth === 0) return null;

  const showName = width > 56 && height > 32;
  const labelFontSize = Math.max(9.5, Math.min(11.5, Math.min(width, height) * 0.11));
  const amountFontSize = Math.max(11, Math.min(15, Math.min(width, height) * 0.15));
  const pctFontSize = 10;
  const padX = Math.max(10, width * 0.05);
  const padY = Math.max(10, height * 0.07);

  const fillOpacity = 0.12 + Math.min(0.55, (pct / 30) * 0.55);
  const dotR = Math.max(2.5, Math.min(4, Math.min(width, height) * 0.04));
  const showDot = accent && width > 40 && height > 28;

  const amountText = isBalanceHidden ? "••••" : formatAmount(amount, currency);
  const pctText = `${pct.toFixed(1)}%`;
  const amountTextW = amountText.length * amountFontSize * 0.58;
  const pctTextW = pctText.length * pctFontSize * 0.6;
  const innerW = Math.max(0, width - padX * 2);
  const showAmount = width > 60 && height > 48;
  const showPct = showAmount && height > 70 && amountTextW + pctTextW + 8 <= innerW;

  const isOther = id === "__other__";
  const isClickable = !!id && !isOther;
  const a11yProps = isClickable
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `${name ?? t("spending:filters.category")}: ${amountText}, ${pctText}`,
        onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate?.(id);
          }
        },
      }
    : {};

  return (
    <g style={{ cursor: isClickable ? "pointer" : "default" }} {...a11yProps}>
      <rect
        x={x + 1}
        y={y + 1}
        width={Math.max(0, width - 2)}
        height={Math.max(0, height - 2)}
        rx={5}
        ry={5}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={fill}
        strokeOpacity={0.4}
        strokeWidth={0.75}
      />
      {showDot && (
        <circle cx={x + padX + dotR} cy={y + padY + dotR} r={dotR} fill={accent ?? "transparent"} />
      )}
      {/* Visual labels — the parent <g> already carries an aria-label with
          the full "<name>: <amount>, <pct>" string, so the SVG <text> nodes
          are decorative and would otherwise double-announce on screen
          readers. */}
      {showName && (
        <text
          x={x + padX + (showDot ? dotR * 2 + 6 : 0)}
          y={y + padY + labelFontSize - 2}
          fill="var(--foreground)"
          className="font-semibold uppercase"
          style={{ fontSize: labelFontSize, letterSpacing: "0.06em", opacity: 0.7 }}
          aria-hidden
        >
          {truncateForBox(
            name ?? "",
            width - padX * 2 - (showDot ? dotR * 2 + 6 : 0),
            labelFontSize,
          )}
        </text>
      )}
      {showAmount && (
        <text
          x={x + padX}
          y={y + height - padY}
          fill="var(--foreground)"
          className="font-semibold tabular-nums"
          style={{ fontSize: amountFontSize, opacity: 0.92 }}
          aria-hidden
        >
          {truncateForBox(amountText, innerW - (showPct ? pctTextW + 8 : 0), amountFontSize)}
        </text>
      )}
      {showPct && (
        <text
          x={x + width - padX}
          y={y + height - padY}
          textAnchor="end"
          fill="var(--foreground)"
          className="tabular-nums"
          style={{ fontSize: pctFontSize, opacity: 0.5 }}
          aria-hidden
        >
          {pctText}
        </text>
      )}
    </g>
  );
};

function CategoryRankedBar({
  rows,
  total,
  currency,
  themeColor,
  groupRows = [],
  hasNoIncludedAccounts,
  savingsHref,
}: {
  rows: CategoryRow[];
  total: number;
  currency: string;
  themeColor: string;
  hasNoIncludedAccounts: boolean;
  /**
   * Budget groups (Needs / Wants / …). When any category here is assigned to a
   * group, the list switches to a grouped layout with collapsible group rows.
   */
  groupRows?: import("../types/budget").BudgetGroupRow[];
  savingsHref?: string;
}) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  // Memoize derivations so we don't rebuild the Map + reduce + slices on every
  // parent re-render — this card lives inside a chart-heavy page.
  const derived = useMemo(() => {
    const categoryGroup = new Map<string, { id: string; name: string; color: string | null }>();
    for (const g of groupRows) {
      for (const cat of g.categories) {
        categoryGroup.set(cat.categoryId, {
          id: g.group.id,
          name: g.group.name,
          color: g.group.color,
        });
      }
    }
    const hasAnyGroup = rows.some((r) => categoryGroup.has(r.id));
    const categorizedSum = rows.reduce((s, r) => s + r.amount, 0);
    const uncategorizedAmount = Math.max(0, total - categorizedSum);

    const top = rows.slice(0, 7);
    const restAmount = rows.slice(7).reduce((s, r) => s + r.amount, 0);
    const barSegments: CategoryRow[] = [...top];
    if (restAmount > 0) {
      barSegments.push({
        id: "__other__",
        name: t("spending:hero.other"),
        amount: restAmount,
        color: null,
        icon: null,
      });
    }
    return { categoryGroup, hasAnyGroup, uncategorizedAmount, top, restAmount, barSegments };
  }, [rows, total, groupRows, t]);

  if (rows.length === 0 || total <= 0) {
    return <WhereItWentEmptyState hasNoIncludedAccounts={hasNoIncludedAccounts} />;
  }

  const { categoryGroup, hasAnyGroup, uncategorizedAmount, top, restAmount, barSegments } = derived;

  const StackedBar = (
    <div className="bg-foreground/10 relative flex h-3 w-full overflow-hidden rounded-full">
      {barSegments.map((s, i) => {
        const share = (s.amount / total) * 100;
        const color = s.color ?? themeColor;
        return (
          <div
            key={s.id}
            className="h-full transition-opacity hover:opacity-80"
            style={{
              width: `${share}%`,
              backgroundColor: color,
              opacity: 0.85 - i * 0.05,
              borderRight: "1px solid var(--card)",
            }}
            title={`${s.name} — ${
              isBalanceHidden ? "••••" : formatAmount(s.amount, currency)
            } (${share.toFixed(1)}%)`}
          />
        );
      })}
    </div>
  );

  if (hasAnyGroup) {
    // Group rows by their group assignment; unassigned categories + the
    // uncategorized bucket fall into a synthetic "Other" group.
    interface Bucket {
      id: string;
      name: string;
      color: string | null;
      categories: CategoryRow[];
      total: number;
    }
    const buckets = new Map<string, Bucket>();
    const ensureBucket = (id: string, name: string, color: string | null) => {
      let b = buckets.get(id);
      if (!b) {
        b = { id, name, color, categories: [], total: 0 };
        buckets.set(id, b);
      }
      return b;
    };
    // Seed declared groups first so they keep the user's sortOrder when totals tie.
    for (const g of groupRows) ensureBucket(g.group.id, g.group.name, g.group.color);

    // The backend ships an "Other" system group (key="other"). Reuse it for
    // unassigned categories so we don't render two "Other" rows side by side.
    const fallbackGroup =
      groupRows.find((g) => g.group.key === "other") ??
      groupRows.find((g) => g.group.name.toLowerCase() === "other");
    const ensureOther = () =>
      fallbackGroup
        ? ensureBucket(fallbackGroup.group.id, fallbackGroup.group.name, fallbackGroup.group.color)
        : ensureBucket("__other__", t("spending:hero.other"), null);

    for (const row of rows) {
      let b: Bucket;
      if (row.id === SAVINGS_ROW_ID) {
        b = ensureBucket(SAVINGS_ROW_ID, t("spending:cashFlow.saving"), SAVINGS_ROW_COLOR);
      } else {
        const g = categoryGroup.get(row.id);
        b = g ? ensureBucket(g.id, g.name, g.color) : ensureOther();
      }
      b.categories.push(row);
      b.total += row.amount;
    }
    if (uncategorizedAmount > 0.01) {
      const b = ensureOther();
      b.categories.push({
        id: "__uncategorized__",
        name: t("spending:tabContent.uncategorizedReview"),
        color: null,
        icon: null,
        amount: uncategorizedAmount,
      });
      b.total += uncategorizedAmount;
    }

    // Preserve insertion order: declared groups follow the user's `sortOrder`
    // from the backend (mockup convention), and the synthetic "Other" bucket
    // naturally lands last because it's only created on demand.
    const orderedBuckets = Array.from(buckets.values()).filter((b) => b.total > 0);

    return (
      <div>
        {StackedBar}
        <div className="mt-3 space-y-2">
          {orderedBuckets.map((bucket) => (
            <GroupedCategoryBlock
              key={bucket.id}
              bucket={bucket}
              total={total}
              currency={currency}
              themeColor={themeColor}
              savingsHref={savingsHref}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Flat layout (no budget groups configured) — unchanged. ──────────
  const uncategorizedShare = total > 0 ? (uncategorizedAmount / total) * 100 : 0;
  return (
    <div className="border-border/60 bg-card/40 overflow-hidden rounded-xl border p-4 backdrop-blur-xl md:p-5">
      {StackedBar}

      <div className="mt-3 space-y-1.5">
        {top.map((r, i) => {
          const share = (r.amount / total) * 100;
          const color = r.color ?? themeColor;
          return (
            <Link
              key={r.id}
              to={spendingActivityHref(r.id, savingsHref)}
              className="hover:bg-muted/40 group flex items-center gap-2.5 rounded-md px-1 py-1 transition-colors"
            >
              <span
                className="block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: color, opacity: 0.85 - i * 0.05 }}
              />
              <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs font-medium">
                {r.name}
              </span>
              <span className="text-muted-foreground/70 w-12 text-right text-[11px] tabular-nums">
                {share.toFixed(1)}%
              </span>
              <span className="text-foreground w-24 text-right text-xs font-semibold tabular-nums">
                <PrivacyAmount value={r.amount} currency={currency} />
              </span>
            </Link>
          );
        })}
        {uncategorizedAmount > 0.01 && (
          <Link
            to="/activities?tab=spending&status=uncategorized"
            className="border-border/60 hover:bg-muted/40 mt-1 flex items-center gap-2.5 rounded-md border border-dashed px-2 py-1.5 transition-colors"
          >
            <Icons.AlertCircle className="text-muted-foreground h-3 w-3 shrink-0" />
            <span className="text-foreground/80 min-w-0 flex-1 text-xs font-medium">
              {t("spending:tabContent.uncategorizedImprove")}
            </span>
            <span className="text-muted-foreground/70 w-12 text-right text-[11px] tabular-nums">
              {uncategorizedShare.toFixed(1)}%
            </span>
            <span className="text-foreground w-24 text-right text-xs font-semibold tabular-nums">
              <PrivacyAmount value={uncategorizedAmount} currency={currency} />
            </span>
          </Link>
        )}
        {restAmount > 0 && (
          <div className="text-muted-foreground/60 px-1 pt-1 text-[10px]">
            {t("spending:tabContent.plusMore", { count: rows.length - 7 })} ·{" "}
            <PrivacyAmount value={restAmount} currency={currency} />
          </div>
        )}
      </div>
    </div>
  );
}

function GroupedCategoryBlock({
  bucket,
  total,
  currency,
  themeColor,
  savingsHref,
}: {
  bucket: {
    id: string;
    name: string;
    color: string | null;
    categories: CategoryRow[];
    total: number;
  };
  total: number;
  currency: string;
  themeColor: string;
  savingsHref?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const share = total > 0 ? (bucket.total / total) * 100 : 0;
  const accent = bucket.color ?? themeColor;
  // Sort categories by spend descending, but always pin the uncategorized
  // bucket to the end — it's a "to-do" row, not a normal category.
  const sortedCats = useMemo(
    () =>
      bucket.categories.slice().sort((a, b) => {
        if (a.id === "__uncategorized__") return 1;
        if (b.id === "__uncategorized__") return -1;
        return b.amount - a.amount;
      }),
    [bucket.categories],
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="hover:bg-muted/40 flex w-full items-center gap-2.5 rounded-md px-1 py-1 transition-colors"
      >
        <Icons.ChevronRight
          className={cn(
            "text-muted-foreground/70 h-3 w-3 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ backgroundColor: accent }}
        />
        <span className="text-foreground min-w-0 flex-1 truncate text-left text-xs font-semibold uppercase tracking-wide">
          {bucket.name}
        </span>
        <span className="text-muted-foreground/80 w-12 text-right text-[11px] font-medium tabular-nums">
          {share.toFixed(1)}%
        </span>
        <span className="text-foreground w-24 text-right text-xs font-semibold tabular-nums">
          <PrivacyAmount value={bucket.total} currency={currency} />
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-6">
          {sortedCats.map((cat) => {
            const catShare = total > 0 ? (cat.amount / total) * 100 : 0;
            const isUncategorized = cat.id === "__uncategorized__";
            const to = spendingActivityHref(cat.id, savingsHref);
            const dotColor = cat.color ?? accent;
            return (
              <Link
                key={cat.id}
                to={to}
                className="hover:bg-muted/40 flex items-center gap-2.5 rounded-md px-1 py-1 transition-colors"
              >
                <span
                  className="block h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: dotColor, opacity: 0.85 }}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs font-medium",
                    isUncategorized ? "text-muted-foreground/90 italic" : "text-foreground/90",
                  )}
                >
                  {cat.name}
                </span>
                <span className="text-muted-foreground/70 w-12 text-right text-[11px] tabular-nums">
                  {catShare.toFixed(1)}%
                </span>
                <span className="text-foreground w-24 text-right text-xs font-medium tabular-nums">
                  <PrivacyAmount value={cat.amount} currency={currency} />
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function truncateForBox(text: string, boxWidth: number, fontSize: number): string {
  if (!text) return "";
  const charW = fontSize * 0.62;
  const max = Math.max(2, Math.floor(boxWidth / charW));
  return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
}

function SpendingDeltaLine({
  delta,
  currency,
  deltaPct,
}: {
  delta: number;
  currency: string;
  deltaPct: number | null;
}) {
  const { t } = useTranslation();
  const isFlat = Math.abs(delta) < 1;
  const direction = delta < 0 ? t("spending:tabContent.down") : t("spending:tabContent.up");
  const tone = isFlat ? "text-muted-foreground" : delta < 0 ? "text-success" : "text-destructive";

  if (isFlat) {
    return (
      <span className="text-muted-foreground lg:text-md text-sm font-light">
        {t("spending:tabContent.aboutSame")}
      </span>
    );
  }

  const pctSuffix = deltaPct !== null ? ` (${(Math.abs(deltaPct) * 100).toFixed(1)}%)` : "";

  return (
    <span className="lg:text-md text-sm font-light">
      <span className={cn("font-medium", tone)}>
        {direction} <PrivacyAmount value={Math.abs(delta)} currency={currency} />
        {pctSuffix}
      </span>{" "}
      <span className="text-muted-foreground">{t("spending:tabContent.fromPriorPeriod")}</span>
    </span>
  );
}
