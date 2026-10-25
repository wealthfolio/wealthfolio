import {
  DASHBOARD_INTERVAL_STORAGE_KEY,
  DASHBOARD_PERIOD_STORAGE_KEY,
  portfolioPeriodRange,
  portfolioViewForPick,
  rangePick,
  type DashboardPeriodPick,
} from "@/features/spending/lib/dashboard-period-sync";
import { addMonthsToMonthKey, monthLabel } from "@/features/spending/lib/month-period";
import { localDateParts } from "@/features/spending/lib/timezone";
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
  const customRange = pick?.kind === "range" && view.code === null ? view.range : undefined;

  const label = useMemo(() => {
    if (view.code) return t(`ui:interval.${view.code}`);
    if (customMonth) return monthLabel(customMonth, dateFormatting);
    const format = (date: Date | undefined) =>
      date
        ? dateFormatting.formatCalendarDate(localDateParts(date), {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";
    return `${format(view.range?.from)} – ${format(view.range?.to)}`;
  }, [customMonth, dateFormatting, t, view]);

  const selectPreset = (code: TimePeriod) => {
    setPick({ kind: "portfolio", code });
    setLastPreset(code);
  };
  const clearCustom = () => setPick({ kind: "portfolio", code: lastPreset });

  return {
    code: view.code,
    range: view.range,
    label,
    customMonth,
    customRange,
    // Same bound as the Spending picker: the current month is This month there.
    maxMonth: addMonthsToMonthKey(todayISO.slice(0, 7), -1),
    selectPreset,
    selectMonth: (monthKey: string | null) =>
      monthKey ? setPick({ kind: "month", monthKey }) : clearCustom(),
    selectRange: (range: DateRange | undefined) => {
      if (!range) clearCustom();
      else if (range.from && range.to) setPick(rangePick({ from: range.from, to: range.to }));
    },
  };
}
