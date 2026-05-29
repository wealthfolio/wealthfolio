import { useMemo } from "react";

import { PrivacyAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Activity } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";

import { getActivitySpendingAmount } from "../../lib/constants";

interface SpendingRhythmHeatmapProps {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  /** Number of past weeks to show. */
  weeks?: number;
  /** Color used for the densest cell. */
  accent?: string;
  currency: string;
}

interface Cell {
  date: Date;
  amount: number;
}

/**
 * 12-week × 7-day heatmap of daily outflow.
 *
 * Cell opacity = amount/maxCellAmount. Reads at a glance: vertical stripes
 * highlight day-of-week patterns; horizontal stripes highlight stretches of
 * heavy or light spending.
 */
export function SpendingRhythmHeatmap({
  activities,
  accountTypeById,
  weeks = 12,
  accent = "var(--success)",
  currency,
}: SpendingRhythmHeatmapProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { rows, max, heaviestDay, heaviestDayAvg } = useMemo(
    () => buildRhythm(activities, weeks, accountTypeById),
    [accountTypeById, activities, weeks],
  );

  return (
    <div>
      <div className="grid grid-cols-[auto_repeat(7,1fr)] gap-1.5">
        <div />
        {DAY_NAMES_SHORT.map((d, i) => (
          <div
            key={`hd-${i}`}
            className="text-muted-foreground/70 text-center text-[10px] uppercase"
          >
            {d}
          </div>
        ))}
        {rows.map((row, wi) => (
          <RhythmRow
            key={wi}
            weekIndex={wi}
            cells={row}
            max={max}
            accent={accent}
            isBalanceHidden={isBalanceHidden}
          />
        ))}
      </div>
      <div className="border-border/60 text-muted-foreground/80 mt-3 flex items-center justify-between border-t pt-2 text-xs">
        <span>
          Heaviest: <span className="text-foreground font-medium">{heaviestDay}</span>
        </span>
        {heaviestDayAvg > 0 && (
          <span className="tabular-nums">
            avg <PrivacyAmount value={heaviestDayAvg} currency={currency} />
          </span>
        )}
      </div>
    </div>
  );
}

function RhythmRow({
  weekIndex,
  cells,
  max,
  accent,
  isBalanceHidden,
}: {
  weekIndex: number;
  cells: Cell[];
  max: number;
  accent: string;
  isBalanceHidden: boolean;
}) {
  return (
    <>
      <div className="text-muted-foreground/70 self-center pr-1 text-right text-[10px]">
        W{weekIndex + 1}
      </div>
      {cells.map((cell, i) => {
        const t = max > 0 ? cell.amount / max : 0;
        const opacity = cell.amount === 0 ? 0.12 : 0.18 + t * 0.7;
        return (
          <div
            key={i}
            className="aspect-square rounded-md transition-opacity"
            style={{ backgroundColor: accent, opacity }}
            title={`${cell.date.toLocaleDateString()} · ${
              cell.amount > 0 ? (isBalanceHidden ? "••••" : cell.amount.toFixed(2)) : "no spend"
            }`}
          />
        );
      })}
    </>
  );
}

const DAY_NAMES_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES_LONG = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface RhythmResult {
  rows: Cell[][];
  max: number;
  heaviestDay: string;
  heaviestDayAvg: number;
}

function buildRhythm(
  activities: Activity[],
  weeks: number,
  accountTypeById?: Map<string, string>,
): RhythmResult {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekday = (today.getDay() + 6) % 7;
  const monThisWeek = new Date(today);
  monThisWeek.setDate(today.getDate() - weekday);

  const rows: Cell[][] = [];
  const cellByKey = new Map<string, Cell>();
  for (let w = weeks - 1; w >= 0; w--) {
    const row: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(monThisWeek);
      date.setDate(monThisWeek.getDate() - w * 7 + d);
      const cell: Cell = { date, amount: 0 };
      row.push(cell);
      cellByKey.set(formatDateISO(date), cell);
    }
    rows.push(row);
  }

  for (const a of activities) {
    const spendingAmount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
    if (spendingAmount === 0) continue;
    const key = formatDateISO(new Date(a.activityDate));
    const cell = cellByKey.get(key);
    if (cell) cell.amount += spendingAmount;
  }

  let max = 0;
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  const dayCount = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c.amount < 0) c.amount = 0;
      if (c.amount > max) max = c.amount;
      if (c.amount > 0) {
        dayTotals[i] += c.amount;
        dayCount[i] += 1;
      }
    }
  }

  let heaviestIdx = 0;
  for (let i = 1; i < 7; i++) {
    if (dayTotals[i] > dayTotals[heaviestIdx]) heaviestIdx = i;
  }
  const heaviestDay = dayTotals[heaviestIdx] > 0 ? `${DAY_NAMES_LONG[heaviestIdx]}s` : "—";
  const heaviestDayAvg =
    dayCount[heaviestIdx] > 0 ? dayTotals[heaviestIdx] / dayCount[heaviestIdx] : 0;

  return { rows, max, heaviestDay, heaviestDayAvg };
}
