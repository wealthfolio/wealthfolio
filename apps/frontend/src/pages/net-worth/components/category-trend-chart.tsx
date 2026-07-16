import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

interface CategoryTrendChartProps {
  data: { date: string; value: number }[];
  /** Stroke / fill color (CSS color string). */
  color: string;
}

/** Compact single-series area chart of a category's value over the range. */
export function CategoryTrendChart({ data, color }: CategoryTrendChartProps) {
  const { t } = useTranslation();
  const gradientId = `category-trend-gradient-${useId().replace(/:/g, "")}`;

  if (data.length < 2) {
    return (
      <div className="text-muted-foreground/60 flex h-32 items-center justify-center text-xs">
        {t("insights:networth.trend.not_enough_history")}
      </div>
    );
  }

  return (
    <div className="h-32 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
