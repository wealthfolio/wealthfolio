import { PERFORMANCE_CHART_COLORS } from "@/components/performance-chart-colors";
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@wealthfolio/ui/components/ui/chart";
import { ReturnData } from "@/lib/types";
import { formatPercent } from "@wealthfolio/ui";
import { differenceInDays, differenceInMonths, format, parseISO } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

interface PerformanceChartProps {
  data: {
    id: string;
    name: string;
    returns: ReturnData[];
    isReference?: boolean;
  }[];
}

function isChineseLocale(): boolean {
  return typeof document !== "undefined" && document.documentElement.lang === "zh-CN";
}

function formatChartDate(date: Date, options: Intl.DateTimeFormatOptions): string {
  if (!isChineseLocale()) return "";
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

export function PerformanceChart({ data }: PerformanceChartProps) {
  const formattedData = data[0]?.returns?.map((item) => {
    const dataPoint: Record<string, number | string> = { date: item.date };
    data.forEach((series) => {
      const matchingPoint = series.returns?.find((p) => p.date === item.date);
      if (matchingPoint) {
        dataPoint[series.id] = matchingPoint.value;
      }
    });
    return dataPoint;
  });

  // Calculate appropriate tick interval based on date range
  const getTickInterval = () => {
    if (!formattedData?.length) return 30;

    const firstDate = parseISO(String(formattedData[0].date));
    const lastDate = parseISO(String(formattedData[formattedData.length - 1].date));
    const monthsDiff = differenceInMonths(lastDate, firstDate);
    const daysDiff = differenceInDays(lastDate, firstDate);

    if (daysDiff <= 7) return 0; // Show all days for 1 week
    if (daysDiff <= 31) return 7; // Weekly for 1 month
    if (monthsDiff <= 3) return 14; // Bi-weekly for 3 months
    if (monthsDiff <= 6) return 30; // Monthly for 6 months
    if (monthsDiff <= 12) return 60; // Bi-monthly for 1 year
    if (monthsDiff <= 36) return 90; // Quarterly for 3 years
    return 180; // Semi-annually for longer periods
  };

  // Format date based on range
  const formatXAxis = (dateStr: string) => {
    if (!formattedData?.length) return "";

    const date = parseISO(dateStr);
    const firstDate = parseISO(String(formattedData[0].date));
    const lastDate = parseISO(String(formattedData[formattedData.length - 1].date));
    const monthsDiff = differenceInMonths(lastDate, firstDate);
    const daysDiff = differenceInDays(lastDate, firstDate);

    if (daysDiff <= 31) {
      const localized = formatChartDate(date, { month: "short", day: "numeric" });
      if (localized) return localized;
      return format(date, "MMM d"); // e.g., "Sep 15"
    }
    if (monthsDiff <= 36) {
      const localized = formatChartDate(date, { year: "numeric", month: "short" });
      if (localized) return localized;
      return format(date, "MMM yyyy"); // e.g., "Sep 2023"
    }
    return format(date, "yyyy"); // e.g., "2023"
  };

  // Update the chartConfig and Line components to use PERFORMANCE_CHART_COLORS
  const chartConfig = data.reduce((config, series, index) => {
    config[series.id] = {
      label: series.name,
      color: PERFORMANCE_CHART_COLORS[index % PERFORMANCE_CHART_COLORS.length],
    };
    return config;
  }, {} as ChartConfig);

  const tooltipFormatter = (
    value: ValueType | undefined,
    name: NameType | undefined,
  ): [string, string] => {
    const formattedValue = formatPercent(Number(value ?? 0));
    return [formattedValue + " - ", (name ?? "").toString()];
  };

  const tooltipLabelFormatter = (label: React.ReactNode) =>
    typeof label === "string"
      ? formatChartDate(parseISO(label), { year: "numeric", month: "long", day: "numeric" }) ||
        format(parseISO(label), "PPP")
      : "";

  return (
    <div className="h-full w-full">
      <ChartContainer config={chartConfig} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%" aspect={undefined}>
          <LineChart data={formattedData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatXAxis}
              interval={getTickInterval()}
            />
            <YAxis
              tickFormatter={(value: number) => formatPercent(value)}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              domain={["auto", "auto"]}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  formatter={tooltipFormatter}
                  labelFormatter={tooltipLabelFormatter}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent payload={[]} />} />
            {data.map((series, seriesIndex) => (
              <Line
                isAnimationActive={true}
                animationDuration={300}
                connectNulls={true}
                key={series.id}
                type="linear"
                dataKey={series.id}
                stroke={PERFORMANCE_CHART_COLORS[seriesIndex % PERFORMANCE_CHART_COLORS.length]}
                strokeWidth={series.isReference ? 1.75 : 2}
                strokeDasharray={series.isReference ? "5 5" : undefined}
                dot={false}
                name={series.name}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
