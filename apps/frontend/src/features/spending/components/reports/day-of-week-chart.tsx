import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Activity } from "@/lib/types";
import { formatAmount } from "@/lib/utils";

import { getActivitySpendingAmount } from "../../lib/constants";

interface DayOfWeekChartProps {
  activities: Activity[];
  accountTypeById?: Map<string, string>;
  currency: string;
  accent?: string;
}

const DAY_LABEL_KEYS = [
  "spending:dayOfWeek.mon",
  "spending:dayOfWeek.tue",
  "spending:dayOfWeek.wed",
  "spending:dayOfWeek.thu",
  "spending:dayOfWeek.fri",
  "spending:dayOfWeek.sat",
  "spending:dayOfWeek.sun",
];

interface DayDatum {
  day: string;
  total: number;
  count: number;
  avg: number;
}

/**
 * Day-of-week distribution — total spend per weekday across the supplied
 * activity window. The y-axis is hidden; bars are sized relative to each
 * other and labeled in the tooltip.
 */
export function DayOfWeekChart({
  activities,
  accountTypeById,
  currency,
  accent = "var(--success)",
}: DayOfWeekChartProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const data: DayDatum[] = useMemo(
    () => buildSeries(activities, accountTypeById, t),
    [accountTypeById, activities, t],
  );
  const peak = useMemo(() => Math.max(0, ...data.map((d) => d.total)), [data]);

  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="day"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <Tooltip
            cursor={{ fill: "var(--chart-cursor)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as DayDatum;
              return (
                <div className="bg-background rounded-md border px-3 py-2 text-xs shadow-sm">
                  <div className="text-foreground font-semibold">{d.day}</div>
                  <div className="text-muted-foreground">
                    {t("spending:dayOfWeek.total")}:{" "}
                    {isBalanceHidden ? "••••" : formatAmount(d.total, currency)}
                  </div>
                  <div className="text-muted-foreground">
                    {t("spending:dayOfWeek.avg")}:{" "}
                    {isBalanceHidden ? "••••" : formatAmount(d.avg, currency)} ·{" "}
                    {t("spending:dayOfWeek.transactionCount", { count: d.count })}
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={accent}
                fillOpacity={peak > 0 ? 0.35 + (d.total / peak) * 0.55 : 0.35}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="text-muted-foreground/70 mt-1 flex justify-between text-[10px] tabular-nums">
        <span>
          {t("spending:dayOfWeek.min")}{" "}
          {isBalanceHidden
            ? "••••"
            : formatCompactAmount(Math.min(...data.map((d) => d.total)), currency)}
        </span>
        <span>
          {t("spending:dayOfWeek.max")}{" "}
          {isBalanceHidden ? "••••" : formatCompactAmount(peak, currency)}
        </span>
      </div>
    </div>
  );
}

function buildSeries(
  activities: Activity[],
  accountTypeById: Map<string, string> | undefined,
  t: TFunction,
): DayDatum[] {
  const totals = new Array(7).fill(0) as number[];
  const counts = new Array(7).fill(0) as number[];
  for (const a of activities) {
    const spendingAmount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
    if (spendingAmount === 0) continue;
    const dow = (new Date(a.activityDate).getDay() + 6) % 7; // Mon=0
    totals[dow] += spendingAmount;
    if (spendingAmount > 0) counts[dow] += 1;
  }
  return DAY_LABEL_KEYS.map((key, i) => ({
    day: t(key),
    total: Math.max(0, totals[i]),
    count: counts[i],
    avg: counts[i] > 0 ? Math.max(0, totals[i]) / counts[i] : 0,
  }));
}
