/**
 * Weekday × hour heatmap. Pulled out of when-where-stage.tsx so the larger
 * file can focus on the events timeline + detail panel; this card is fully
 * self-contained (no shared state with the rest of the stage).
 */
import { useMemo, type FC } from "react";
import { useTranslation } from "react-i18next";

import { formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { Activity } from "@/lib/types";
import { cn, formatAmount } from "@/lib/utils";

import { getActivitySpendingAmount } from "../../../lib/constants";
import { createZonedDayHourFormatter, type ZonedDayHour } from "../../../lib/timezone";

const CARD_CLASS = "border-border/60 bg-card/40 rounded-2xl border p-5 backdrop-blur-xl";
const LABEL_CLASS = "text-muted-foreground/70 text-[10px] font-normal uppercase tracking-[0.12em]";

const DAY_NAME_KEYS = [
  "spending:dayOfWeek.mon",
  "spending:dayOfWeek.tue",
  "spending:dayOfWeek.wed",
  "spending:dayOfWeek.thu",
  "spending:dayOfWeek.fri",
  "spending:dayOfWeek.sat",
  "spending:dayOfWeek.sun",
];
const HOUR_LABELS = ["12a", "3a", "6a", "9a", "12p", "3p", "6p", "9p"];

export interface WhenYouSpendCardProps {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  dailySpendByDate?: Map<string, number>;
  currency: string;
  timezone?: string | null;
  onCellClick?: (weekday: number, startHour: number, endHour: number) => void;
}

export const WhenYouSpendCard: FC<WhenYouSpendCardProps> = ({
  activities,
  accountTypeById,
  dailySpendByDate,
  currency,
  timezone,
  onCellClick,
}) => {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const isPhone = useIsMobileViewport();
  const cols = isPhone ? 8 : 24;
  const grid = useMemo(
    () => buildWeekdayHourGrid(activities, accountTypeById, dailySpendByDate, cols, timezone),
    [accountTypeById, activities, dailySpendByDate, cols, timezone],
  );

  if (activities.length === 0) {
    return (
      <div className={CARD_CLASS}>
        <header className="mb-3">
          <h3 className="text-foreground text-base font-semibold tracking-tight">
            {t("spending:whenYouSpend.title")}
          </h3>
          <p className="text-muted-foreground text-xs">{t("spending:whenYouSpend.subtitle")}</p>
        </header>
        <div className="text-muted-foreground py-8 text-center text-sm">
          {t("spending:whenYouSpend.noActivity")}
        </div>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-foreground text-base font-semibold tracking-tight">
            {t("spending:whenYouSpend.title")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {isPhone
              ? t("spending:whenYouSpend.subtitleShort")
              : t("spending:whenYouSpend.subtitle")}
          </p>
        </div>
        {!isPhone && (
          <span className={LABEL_CLASS}>{t("spending:whenYouSpend.medianPerWeekday")}</span>
        )}
      </header>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1">
        {/* Hour-axis label row */}
        <div />
        <div className="text-muted-foreground/70 grid grid-cols-8 text-[10px]">
          {HOUR_LABELS.map((h, i) => (
            <span key={i} className="text-left">
              {h}
            </span>
          ))}
        </div>
        <div />

        {/* 7 weekday rows */}
        {DAY_NAME_KEYS.map((dayKey, di) => {
          const row = grid.cells[di];
          const median = grid.medians[di];
          return (
            <Row
              key={di}
              day={t(dayKey)}
              weekdayIndex={di}
              cells={row}
              max={grid.max}
              median={median}
              currency={currency}
              isPhone={isPhone}
              isBalanceHidden={isBalanceHidden}
              onCellClick={onCellClick}
              noSpendLabel={t("spending:whenYouSpend.noSpend")}
            />
          );
        })}
      </div>

      <div className="border-border/40 mt-4 flex items-center justify-between border-t pt-3 text-[11px]">
        {!isPhone && (
          <span className="text-muted-foreground/70">
            {t("spending:whenYouSpend.legendIntro")}{" "}
            <span className="dark:hidden">{t("spending:whenYouSpend.darker")}</span>
            <span className="hidden dark:inline">{t("spending:whenYouSpend.brighter")}</span>{" "}
            {t("spending:whenYouSpend.moreSpend")}
          </span>
        )}
        <Legend />
      </div>
    </div>
  );
};

function Row({
  day,
  weekdayIndex,
  cells,
  max,
  median,
  currency,
  isPhone,
  isBalanceHidden,
  onCellClick,
  noSpendLabel,
}: {
  day: string;
  weekdayIndex: number;
  cells: number[];
  max: number;
  median: number;
  currency: string;
  isPhone: boolean;
  isBalanceHidden: boolean;
  onCellClick?: (weekday: number, startHour: number, endHour: number) => void;
  noSpendLabel: string;
}) {
  const cols = cells.length;
  const hoursPerCell = Math.max(1, Math.round(24 / cols));
  return (
    <>
      <div className="text-muted-foreground/80 pr-1 text-right text-[11px]">{day}</div>
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}
      >
        {cells.map((amount, i) => {
          const t = max > 0 ? amount / max : 0;
          const opacity =
            amount === 0
              ? "var(--heatmap-empty-opacity)"
              : `calc(var(--heatmap-min-opacity) + ${t} * var(--heatmap-range-opacity))`;
          const startHour = i * hoursPerCell;
          const endHour = Math.min(23, startHour + hoursPerCell - 1);
          const range =
            hoursPerCell === 1
              ? formatHour(startHour)
              : `${formatHour(startHour)}–${formatHour(endHour + 1)}`;
          const label = `${day} ${range} · ${
            amount > 0 ? (isBalanceHidden ? "••••" : formatAmount(amount, currency)) : noSpendLabel
          }`;
          if (!onCellClick) {
            return (
              <div
                key={i}
                className="aspect-square rounded-[3px]"
                style={{ backgroundColor: "var(--heatmap-accent)", opacity }}
                title={label}
              />
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => onCellClick(weekdayIndex, startHour, Math.min(24, endHour + 1))}
              className="aspect-square rounded-[3px] transition-all hover:scale-110 hover:ring-1 hover:ring-[var(--ring)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
              style={{ backgroundColor: "var(--heatmap-accent)", opacity }}
              title={label}
              aria-label={label}
            />
          );
        })}
      </div>
      <div
        className={cn(
          "text-foreground/90 inline-flex items-center pl-1 text-xs tabular-nums",
          !isPhone && "gap-2",
        )}
      >
        {!isPhone && <span className="bg-foreground/30 inline-block h-px w-6" />}
        <span className="font-medium">
          {isBalanceHidden ? "••••" : formatCompactAmount(median, currency)}
        </span>
      </div>
    </>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <span className="text-muted-foreground/70 inline-flex items-center gap-1.5">
      <span>{t("spending:whenYouSpend.less")}</span>
      {[0.18, 0.4, 0.65, 0.95].map((o, i) => (
        <span
          key={i}
          className="h-2.5 w-2.5 rounded-[2px]"
          style={{ backgroundColor: "var(--heatmap-accent)", opacity: o }}
        />
      ))}
      <span>{t("spending:whenYouSpend.more")}</span>
    </span>
  );
}

function formatHour(h: number): string {
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  if (h === 24) return "12am";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

interface WeekdayHourGrid {
  /** [weekdayIndex (Mon=0..Sun=6)][hour 0..23] = total spend in that bucket. */
  cells: number[][];
  max: number;
  /** Median daily total per weekday — i.e. across the 12 weeks, median of that weekday's daily total. */
  medians: number[];
}

function buildWeekdayHourGrid(
  activities: Activity[],
  accountTypeById?: Map<string, string>,
  dailySpendByDate?: Map<string, number>,
  cols = 24,
  timezone?: string | null,
): WeekdayHourGrid {
  const safeCols = cols > 0 && cols <= 24 ? cols : 24;
  const hoursPerCell = Math.max(1, Math.round(24 / safeCols));
  const cells: number[][] = Array.from({ length: 7 }, () => new Array(safeCols).fill(0));
  // Per (weekday, dayKey) → daily total. Used to compute the median per weekday.
  const dayTotals = new Map<string, number>();
  const getZonedDayHour = createZonedDayHourFormatter(timezone);
  const rawSpendByDate = dailySpendByDate
    ? buildRawSpendByDate(activities, accountTypeById, getZonedDayHour)
    : undefined;

  for (const a of activities) {
    const rawAmount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
    if (rawAmount === 0) continue;
    const date = new Date(a.activityDate);
    const zoned = getZonedDayHour(date);
    if (!zoned) continue;
    const dayKey = zoned.dayKey;
    const convertedDayTotal = dailySpendByDate?.get(dayKey);
    const rawDayTotal = rawSpendByDate?.get(dayKey) ?? 0;
    const amt =
      convertedDayTotal != null && rawDayTotal > 0
        ? rawAmount * (convertedDayTotal / rawDayTotal)
        : rawAmount;
    const { weekday, hour } = zoned;
    const bucket = Math.min(safeCols - 1, Math.floor(hour / hoursPerCell));
    cells[weekday][bucket] += amt;
    const key = `${weekday}|${dayKey}`;
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + amt);
  }

  for (const row of cells) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] < 0) row[i] = 0;
    }
  }
  for (const [key, value] of dayTotals) {
    if (value <= 0) dayTotals.delete(key);
  }

  const max = Math.max(0, ...cells.flat());

  const medians: number[] = [];
  for (let d = 0; d < 7; d++) {
    const values: number[] = [];
    for (const [key, total] of dayTotals) {
      const [weekdayStr] = key.split("|");
      if (parseInt(weekdayStr, 10) === d) values.push(total);
    }
    medians.push(median(values));
  }

  return { cells, max, medians };
}

function buildRawSpendByDate(
  activities: Activity[],
  accountTypeById?: Map<string, string>,
  getZonedDayHour: (date: Date) => ZonedDayHour | null = createZonedDayHourFormatter(),
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const a of activities) {
    const amount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
    if (amount === 0) continue;
    const date = new Date(a.activityDate);
    const zoned = getZonedDayHour(date);
    if (!zoned) continue;
    const dayKey = zoned.dayKey;
    totals.set(dayKey, (totals.get(dayKey) ?? 0) + amount);
  }
  return totals;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
