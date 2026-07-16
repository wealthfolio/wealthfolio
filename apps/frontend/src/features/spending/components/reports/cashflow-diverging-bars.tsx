import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PrivacyAmount, Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

/** Generic cashflow datum — caller supplies one per bucket (month, week, or day). */
export interface CashflowPoint {
  label: string;
  income: number;
  outflow: number;
}

interface CashflowDivergingBarsProps {
  points: CashflowPoint[];
  currency: string;
  isLoading: boolean;
}

interface CashflowDatum {
  label: string;
  /** Income, plotted positive (above zero). */
  income: number;
  /** Spending plotted as a negative value so the bar drops below zero. */
  spendingNeg: number;
  /** Raw spending magnitude (used in tooltip). */
  spending: number;
  /** Income − spending. */
  net: number;
  hasData: boolean;
}

/**
 * Cashflow as a diverging bar chart — income above zero, spending below zero,
 * one pair of bars per month, with a Net line overlay.
 *
 * Mirrors the literal mental model of money flowing in vs out and is honest
 * with discrete monthly data (no implied between-point values that an area
 * chart would draw via splines).
 */
export function CashflowDivergingBars({ points, currency, isLoading }: CashflowDivergingBarsProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const data: CashflowDatum[] = useMemo(
    () =>
      points.map((p) => ({
        label: p.label,
        income: p.income,
        spending: p.outflow,
        spendingNeg: -p.outflow,
        net: p.income - p.outflow,
        hasData: p.income > 0 || p.outflow > 0,
      })),
    [points],
  );

  // Drop leading months with no data so the chart starts where the user
  // actually has activity (avoids the "flat zero baseline for half the chart"
  // problem the area version had).
  const visibleData = useMemo(() => {
    const firstNonZero = data.findIndex((d) => d.income > 0 || d.spending > 0);
    return firstNonZero === -1 ? data : data.slice(firstNonZero);
  }, [data]);

  if (isLoading && visibleData.every((d) => d.income === 0 && d.spending === 0)) {
    return <Skeleton className="h-[260px] w-full rounded-lg" />;
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={visibleData}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          // `stackOffset="sign"` is recharts' built-in handler for diverging
          // bars: same `stackId` + opposite signs ⇒ both bars share the x slot
          // and grow in opposite directions from the zero baseline.
          stackOffset="sign"
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            strokeOpacity={0.4}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) =>
              isBalanceHidden ? "••" : formatCompactAmount(Math.abs(v), currency)
            }
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            width={56}
          />
          {/* Zero baseline — solid, slightly stronger than the gridlines */}
          <ReferenceLine y={0} stroke="var(--border)" strokeOpacity={0.9} />
          <Tooltip
            cursor={{ fill: "var(--chart-cursor)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as CashflowDatum;
              return (
                <div className="bg-background min-w-[180px] rounded-md border px-3 py-2 text-xs shadow-sm">
                  <div className="text-foreground mb-1 font-semibold">{d.label}</div>
                  <Row
                    label={t("spending:cashFlow.income")}
                    value={d.income}
                    currency={currency}
                    tone="success"
                  />
                  <Row
                    label={t("spending:cashFlow.spending")}
                    value={d.spending}
                    currency={currency}
                    tone="destructive"
                    showMinus
                  />
                  <div className="bg-border my-1.5 h-px" />
                  <Row
                    label={t("spending:cashFlow.net")}
                    value={d.net}
                    currency={currency}
                    tone={d.net >= 0 ? "success" : "destructive"}
                    showMinus={d.net < 0}
                    bold
                  />
                </div>
              );
            }}
          />
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
          />
          {/* Same `stackId` on both bars + parent `stackOffset="sign"`:
              recharts puts them in the same x slot and lets each grow in its
              own direction (income up from zero, spendingNeg down from zero).
              Same radius on both — recharts rounds the corners away from the
              baseline (the bar's visible free end in either direction). */}
          <Bar
            dataKey="income"
            name={t("spending:cashFlow.income")}
            stackId="cashflow"
            fill="var(--success)"
            fillOpacity={0.85}
            radius={[3, 3, 0, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          />
          <Bar
            dataKey="spendingNeg"
            name={t("spending:cashFlow.spending")}
            stackId="cashflow"
            fill="var(--destructive)"
            fillOpacity={0.8}
            radius={[3, 3, 0, 0]}
            maxBarSize={18}
            isAnimationActive={false}
          />
          {/* Net line overlay — dot per point, no smoothing */}
          <Line
            type="linear"
            dataKey="net"
            name={t("spending:cashFlow.net")}
            stroke="var(--foreground)"
            strokeWidth={1.5}
            dot={{ r: 2.5, fill: "var(--foreground)", strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Row({
  label,
  value,
  currency,
  tone,
  bold,
  showMinus,
}: {
  label: string;
  value: number;
  currency: string;
  tone: "success" | "destructive" | "muted";
  bold?: boolean;
  showMinus?: boolean;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${toneClass} ${bold ? "font-semibold" : "font-medium"}`}>
        {showMinus ? "−" : ""}
        <PrivacyAmount value={Math.abs(value)} currency={currency} />
      </span>
    </div>
  );
}
