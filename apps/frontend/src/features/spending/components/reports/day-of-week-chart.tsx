import { useMemo } from "react";
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

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
  const { isBalanceHidden } = useBalancePrivacy();
  const data: DayDatum[] = useMemo(
    () => buildSeries(activities, accountTypeById),
    [accountTypeById, activities],
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
                    Total: {isBalanceHidden ? "••••" : formatAmount(d.total, currency)}
                  </div>
                  <div className="text-muted-foreground">
                    Avg: {isBalanceHidden ? "••••" : formatAmount(d.avg, currency)} · {d.count}{" "}
                    {d.count === 1 ? "transaction" : "transactions"}
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
          Min{" "}
          {isBalanceHidden
            ? "••••"
            : formatCompactAmount(Math.min(...data.map((d) => d.total)), currency)}
        </span>
        <span>Max {isBalanceHidden ? "••••" : formatCompactAmount(peak, currency)}</span>
      </div>
    </div>
  );
}

function buildSeries(activities: Activity[], accountTypeById?: Map<string, string>): DayDatum[] {
  const totals = new Array(7).fill(0) as number[];
  const counts = new Array(7).fill(0) as number[];
  for (const a of activities) {
    const spendingAmount = getActivitySpendingAmount(a, accountTypeById?.get(a.accountId));
    if (spendingAmount === 0) continue;
    const dow = (new Date(a.activityDate).getDay() + 6) % 7; // Mon=0
    totals[dow] += spendingAmount;
    if (spendingAmount > 0) counts[dow] += 1;
  }
  return DAY_LABELS.map((day, i) => ({
    day,
    total: Math.max(0, totals[i]),
    count: counts[i],
    avg: counts[i] > 0 ? Math.max(0, totals[i]) / counts[i] : 0,
  }));
}
