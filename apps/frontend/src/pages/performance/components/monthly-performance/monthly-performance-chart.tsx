import React, { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from "recharts";
import { GainPercent } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import type { MonthlyComparisonCell, MonthlyViewMode } from "../../monthly-performance-utils";

const MONTH_KEYS = [
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
] as const;

export interface MonthlyPerformanceChartProps {
  year: number;
  months: (MonthlyComparisonCell | null)[];
  viewMode: MonthlyViewMode;
  portfolioName: string;
  benchmarkName?: string;
}

interface ChartMonthPoint {
  monthIndex: number;
  name: string;
  portfolioReturn: number | null;
  benchmarkReturn: number | null;
  relativeReturn: number | null;
  value: number | null;
}

export const MonthlyPerformanceChart: React.FC<MonthlyPerformanceChartProps> = ({
  year,
  months,
  viewMode,
  portfolioName,
  benchmarkName,
}) => {
  const { t } = useTranslation();

  const data: ChartMonthPoint[] = useMemo(() => {
    return MONTH_KEYS.map((name, index) => {
      const cell = months[index];
      const pRet = cell?.portfolioReturn ?? null;
      const bRet = cell?.benchmarkReturn ?? null;
      const rRet = cell?.relativeReturn ?? null;

      let value: number | null = null;
      if (viewMode === "benchmark") {
        value = bRet;
      } else if (viewMode === "relative") {
        value = rRet;
      } else {
        value = pRet;
      }

      return {
        monthIndex: index,
        name,
        portfolioReturn: pRet,
        benchmarkReturn: bRet,
        relativeReturn: rRet,
        value,
      };
    });
  }, [months, viewMode]);

  // Determine domain bounds
  const { yMin, yMax } = useMemo(() => {
    const validValues = data.map((d) => d.value).filter((v): v is number => v !== null);
    if (validValues.length === 0) {
      return { yMin: -0.05, yMax: 0.05 };
    }
    const maxAbs = Math.max(...validValues.map((v) => Math.abs(v)), 0.02);
    // Add small headroom
    const roundedMax = Math.ceil(maxAbs * 110) / 100;
    return { yMin: -roundedMax, yMax: roundedMax };
  }, [data]);

  return (
    <div className="relative h-48 w-full select-none sm:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 28, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="positiveBarGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4ade80" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={0.8} />
            </linearGradient>
            <linearGradient id="negativeBarGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity={0.8} />
              <stop offset="100%" stopColor="#dc2626" stopOpacity={0.95} />
            </linearGradient>
          </defs>

          {/* Vertical month guide columns background */}
          <CartesianGrid
            strokeDasharray="0"
            stroke="var(--border)"
            strokeOpacity={0.25}
            horizontal={false}
            vertical={true}
          />

          <XAxis
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            dy={4}
          />

          <YAxis
            orientation="right"
            domain={[yMin, yMax]}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
            tickFormatter={(val: number) => {
              if (Math.abs(val) < 0.0001) return "0.00%";
              return `${val > 0 ? "+" : ""}${(val * 100).toFixed(2)}%`;
            }}
            width={48}
          />

          <ReferenceLine y={0} stroke="var(--border)" strokeOpacity={0.8} strokeWidth={1} />

          <Tooltip
            cursor={{ fill: "var(--accent)", fillOpacity: 0.15 }}
            content={({ active, payload }) => {
              if (!active || !payload || !payload.length) return null;
              const point = payload[0].payload as ChartMonthPoint;
              if (
                point.portfolioReturn === null &&
                point.benchmarkReturn === null &&
                point.relativeReturn === null
              ) {
                return null;
              }

              return (
                <div className="bg-popover text-popover-foreground border-border min-w-[12rem] rounded-lg border p-2.5 shadow-md">
                  <div className="text-muted-foreground mb-1.5 border-b pb-1 font-mono text-xs font-semibold">
                    {point.name} {year}
                  </div>
                  <div className="space-y-1 text-xs">
                    {point.portfolioReturn !== null && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground truncate">{portfolioName}:</span>
                        <GainPercent
                          value={point.portfolioReturn}
                          className="font-mono font-medium"
                        />
                      </div>
                    )}
                    {benchmarkName && point.benchmarkReturn !== null && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground truncate">{benchmarkName}:</span>
                        <GainPercent
                          value={point.benchmarkReturn}
                          className="font-mono font-medium"
                        />
                      </div>
                    )}
                    {benchmarkName && point.relativeReturn !== null && (
                      <div className="border-border/60 mt-1 flex items-center justify-between gap-4 border-t pt-1">
                        <span className="text-muted-foreground font-medium">
                          {t("performance:monthly.alpha")}:
                        </span>
                        <GainPercent
                          value={point.relativeReturn}
                          className="font-mono font-semibold"
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            }}
          />

          <Bar
            dataKey="value"
            radius={4}
            maxBarSize={48}
            isAnimationActive={true}
            animationDuration={400}
          >
            {data.map((entry, index) => {
              const val = entry.value;
              if (val === null) return <Cell key={`cell-${index}`} fill="transparent" />;
              const isPositive = val >= 0;
              return (
                <Cell
                  key={`cell-${index}`}
                  fill={isPositive ? "url(#positiveBarGradient)" : "url(#negativeBarGradient)"}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
