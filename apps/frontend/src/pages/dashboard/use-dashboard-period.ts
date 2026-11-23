import {
  DASHBOARD_INTERVAL_STORAGE_KEY,
  DASHBOARD_PERIOD_STORAGE_KEY,
  portfolioPeriodRange,
  portfolioViewForPick,
  portfolioPresetForSpendingPeriod,
  getPresetWindow,
  rangePick,
  stepCalendarPick,
  stepDashboardPeriod,
  type DashboardPeriodPick,
} from "@/features/spending/lib/dashboard-period-sync";
import { addMonthsToMonthKey, monthLabel } from "@/features/spending/lib/month-period";
import { localDateParts } from "@/features/spending/lib/timezone";
import { parseCalendarYear, yearLabel } from "@/features/spending/lib/year-period";
import { usePersistentState } from "@/hooks/use-persistent-state";
import type { DateRange } from "@/lib/types";
import { useDateFormatting, type TimePeriod } from "@wealthfolio/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

const DEFAULT_INTERVAL: TimePeriod = "3M";

/**
 * The period Investments and Net Worth share with the Spending tab. Before any
 * tab has picked one, each tab keeps reading its own saved preset.
 */
export function useDashboardPeriod(
  todayISO: string,
  ownPreset: { key: string; initial: TimePeriod } = {
    key: DASHBOARD_INTERVAL_STORAGE_KEY,
    initial: DEFAULT_INTERVAL,
  },
) {
  const { t } = useTranslation();
  const dateFormatting = useDateFormatting();
  const [pick, setPick] = usePersistentState<DashboardPeriodPick | null>(
    DASHBOARD_PERIOD_STORAGE_KEY,
    null,
  );
  const [lastPreset, setLastPreset] = usePersistentState<TimePeriod>(
    DASHBOARD_INTERVAL_STORAGE_KEY,
    DEFAULT_INTERVAL,
  );
  const [savedPreset] = usePersistentState<TimePeriod>(ownPreset.key, ownPreset.initial);

  const view = useMemo(
    () =>
      (pick && portfolioViewForPick(pick, todayISO)) ?? {
        code: savedPreset,
        range: portfolioPeriodRange(savedPreset, todayISO),
      },
    [pick, savedPreset, todayISO],
  );
  const customMonth = pick?.kind === "month" && view.code === null ? pick.monthKey : null;
  const customYear =
    pick?.kind === "year" && view.code === null ? parseCalendarYear(pick.year, todayISO) : null;
  const customRange = pick?.kind === "range" && view.code === null ? view.range : undefined;
  const presetWindow = getPresetWindow(pick);
  const selectedPreset = presetWindow
    ? presetWindow.preset.kind === "portfolio"
      ? presetWindow.preset.code
      : portfolioPresetForSpendingPeriod(presetWindow.preset.code)
    : view.code;
  const navigationPick: DashboardPeriodPick = customMonth
    ? { kind: "month", monthKey: customMonth }
    : customYear !== null
      ? { kind: "year", year: customYear }
      : presetWindow && pick
        ? pick
        : { kind: "portfolio", code: view.code ?? "ALL" };

  const label = useMemo(() => {
    if (view.code) return t(`ui:interval.${view.code}`);
    if (customMonth) return monthLabel(customMonth, dateFormatting);
    if (customYear !== null) return yearLabel(customYear, dateFormatting);
    if (presetWindow && view.range?.from && view.range.to) {
      return dateFormatting.formatCalendarDateRange(
        localDateParts(view.range.from),
        localDateParts(view.range.to),
        {
          month: "short",
          day: "numeric",
          year: "numeric",
        },
      );
    }
    const format = (date: Date | undefined) =>
      date
        ? dateFormatting.formatCalendarDate(localDateParts(date), {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";
    return `${format(view.range?.from)} – ${format(view.range?.to)}`;
  }, [customMonth, customYear, dateFormatting, presetWindow, t, view]);

  const selectPreset = (code: TimePeriod) => {
    setPick({ kind: "portfolio", code });
    setLastPreset(code);
  };
  const clearCustom = () =>
    setPick(presetWindow?.preset ?? { kind: "portfolio", code: lastPreset });
  // Clear returns to the preset this tab showed before the custom pick, which
  // can differ from the last preset picked (Net Worth's own ALL, for example).
  const pickCustom = (next: DashboardPeriodPick) => {
    if (view.code) setLastPreset(view.code);
    setPick(next);
  };
  // Portfolio tabs have rolling 1M; only Spending has a current calendar-month preset.
  const stepPeriod = (direction: -1 | 1) =>
    navigationPick.kind === "month"
      ? stepCalendarPick(navigationPick, direction, todayISO)
      : stepDashboardPeriod(navigationPick, direction, todayISO);

  return {
    code: view.code,
    selectedPreset,
    range: view.range,
    label,
    customMonth,
    customYear,
    customRange,
    isHistorical: !!customMonth || customYear !== null || !!presetWindow,
    // Same bound as the Spending picker: the current month is This month there.
    maxMonth: addMonthsToMonthKey(todayISO.slice(0, 7), -1),
    maxYear: Number(todayISO.slice(0, 4)) - 1,
    navigation: {
      label,
      previousDisabled: !stepPeriod(-1),
      nextDisabled: !stepPeriod(1),
      onStep: (direction: -1 | 1) => {
        const next = stepPeriod(direction);
        if (next) pickCustom(next);
      },
    },
    selectPreset,
    selectMonth: (monthKey: string | null) =>
      monthKey ? pickCustom({ kind: "month", monthKey }) : clearCustom(),
    selectYear: (year: number | null) => {
      if (year === null) clearCustom();
      else if (parseCalendarYear(year, todayISO) !== null) pickCustom({ kind: "year", year });
    },
    selectRange: (range: DateRange | undefined) => {
      if (!range) clearCustom();
      else if (range.from && range.to) pickCustom(rangePick({ from: range.from, to: range.to }));
    },
  };
}
