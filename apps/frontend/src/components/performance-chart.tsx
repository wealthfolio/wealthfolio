import { PERFORMANCE_CHART_COLORS } from "@/components/performance-chart-colors";
import {
  formatPerformanceAxisDate,
  percentTicks,
  performanceAxis,
  valueRange,
} from "@/components/performance-chart-axis";
import { ReturnData } from "@/lib/types";
import { useChartScrubHaptic } from "@/hooks/use-chart-scrub-haptic";
import { cn } from "@/lib/utils";
import { useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { ChartConfig, ChartContainer, ChartTooltip } from "@wealthfolio/ui/components/ui/chart";
import { useId, useMemo, useRef } from "react";
import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

// Recharts computes vertical grid positions even with `vertical={false}`. On a
// new chart's first render it does so with default axis settings, measuring one
// tick label per data point in the DOM (~1 s for 1,300 points in Chromium).
const noVerticalGridPoints = () => [];

/** Rows the tooltip lists before it folds the rest into "+N". */
const TOOLTIP_MAX_ROWS = 6;
/** A phone draws at most this many points; daily points on a long range only add jitter. */
const COMPACT_MAX_POINTS = 160;
/** Share of a phone chart at each end with no x-axis label; half a date label is up to ~25px of ~340px. */
const COMPACT_AXIS_EDGE_GAP = 0.08;
/** Every k-th point, keeping the last so the line still ends on the period's value. */
function thinPoints<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
}

export interface PerformanceChartSeries {
  id: string;
  name: string;
  returns: ReturnData[];
  /** The series' colour on the page; it keeps its colour while others are hidden. */
  color?: string;
}

interface PerformanceChartProps {
  /** The first series is the active one: filled, drawn strongest, labelled at its end. */
  data: PerformanceChartSeries[];
  /** Phone layout: fewer ticks, smaller text, no end label. */
  compact?: boolean;
  /** Label the active line's last value. Off when it would disagree with the page's figure. */
  showEndLabel?: boolean;
  /**
   * Phones only: the date under the finger (null when lifted). The page shows the
   * values there instead of a tooltip that the finger would cover.
   */
  onScrub?: (date: string | null) => void;
}

function seriesColor(series: PerformanceChartSeries, index: number): string {
  return series.color ?? PERFORMANCE_CHART_COLORS[index % PERFORMANCE_CHART_COLORS.length];
}

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string;
}

function PerformanceTooltip({
  active,
  payload,
  label,
  series,
  formatValue,
  formatDate,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  series: PerformanceChartSeries[];
  formatValue: (value: number) => string;
  formatDate: (date: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const activeId = series[0]?.id;
  // Highest first reads as a ranking; the active series is listed even when it ranks low.
  const rows = series
    .map((item, index) => {
      const entry = payload.find((point) => point.dataKey === item.id);
      return entry?.value == null
        ? null
        : {
            id: item.id,
            name: item.name,
            color: seriesColor(item, index),
            value: Number(entry.value),
          };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.value - a.value);
  let shown = rows.slice(0, TOOLTIP_MAX_ROWS);
  const activeRow = rows.find((row) => row.id === activeId);
  if (activeRow && !shown.includes(activeRow)) {
    shown = [...shown.slice(0, TOOLTIP_MAX_ROWS - 1), activeRow];
  }
  const more = rows.length - shown.length;

  return (
    <div className="border-border/60 bg-background min-w-40 rounded-lg border px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground mb-1.5 font-medium">{formatDate(String(label))}</div>
      <div className="space-y-1">
        {shown.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <span
              className="h-2.5 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span
              className={cn(
                "text-muted-foreground max-w-44 truncate",
                row.id === activeId && "text-foreground font-medium",
              )}
            >
              {row.name}
            </span>
            <span
              className={cn(
                "ms-auto ps-3 font-medium tabular-nums",
                row.value > 0 ? "text-gain" : row.value < 0 ? "text-loss" : "text-muted-foreground",
              )}
            >
              {formatValue(row.value)}
            </span>
          </div>
        ))}
        {more > 0 && <div className="text-muted-foreground ps-3">+{more}</div>}
      </div>
    </div>
  );
}

export function PerformanceChart({
  data,
  compact = false,
  showEndLabel = true,
  onScrub,
}: PerformanceChartProps) {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();
  const fillId = `performance-fill-${useId().replace(/:/g, "")}`;
  const fingerDownRef = useRef(false);
  const usesTouchRef = useRef(false);
  const scrubHaptic = useChartScrubHaptic();

  // Built once per data change: a finger drag re-renders the page on every move, and
  // rebuilding these scanned every series once per plotted date.
  const { formattedData, axis, yAxis, zeroOffset } = useMemo(() => {
    const baseReturns = data[0]?.returns ?? [];
    const plotted = compact ? thinPoints(baseReturns, COMPACT_MAX_POINTS) : baseReturns;
    const valuesBySeries = data.map(
      (series) =>
        [series.id, new Map(series.returns.map((point) => [point.date, point.value]))] as const,
    );
    const rows = plotted.map((item) => {
      const dataPoint: Record<string, number | string> = { date: item.date };
      for (const [id, values] of valuesBySeries) {
        const value = values.get(item.date);
        if (value != null) dataPoint[id] = value;
      }
      return dataPoint;
    });
    // The active fill fades toward the 0% line from both sides; the gradient spans
    // the area's own box, which runs from its lowest value (or 0) to its highest.
    const { min: areaBottom, max: areaTop } = valueRange(
      baseReturns.map((point) => Number(point.value)),
    );
    return {
      formattedData: rows,
      yAxis: percentTicks(
        data.flatMap((series) => series.returns.map((point) => Number(point.value))),
        compact ? 3 : 5,
      ),
      zeroOffset: areaTop === areaBottom ? 0 : areaTop / (areaTop - areaBottom),
      // Phones plot to the card's edge, so a first or last label there would be cut.
      axis: performanceAxis(
        plotted.map((point) => point.date),
        compact ? 4 : 6,
        compact ? COMPACT_AXIS_EDGE_GAP : 0,
      ),
    };
  }, [compact, data]);
  const lastIndex = formattedData.length - 1;
  const formatSigned = (value: number) =>
    numberFormatting.formatPercent(value, { signDisplay: "exceptZero" });

  const chartConfig = data.reduce((config, series, index) => {
    config[series.id] = {
      label: series.name,
      color: seriesColor(series, index),
    };
    return config;
  }, {} as ChartConfig);

  const reportScrub = (state: MouseHandlerDataParam) =>
    onScrub?.(
      state.isTooltipActive && state.activeLabel != null ? String(state.activeLabel) : null,
    );
  // Recharts delivers touchmove a frame late but touchend at once, so a late move could
  // restart the scrub after the finger lifted. Only moves while a finger is down count,
  // and once touch is used, the mouse events browsers emulate after a tap are ignored.
  const handleTouchMove = (state: MouseHandlerDataParam) => {
    if (!fingerDownRef.current) return;
    reportScrub(state);
    if (state.isTooltipActive) scrubHaptic.tick(state.activeLabel);
  };
  const handleMouseMove = (state: MouseHandlerDataParam) => {
    if (!usesTouchRef.current) reportScrub(state);
  };
  const endScrub = () => {
    fingerDownRef.current = false;
    scrubHaptic.reset();
    onScrub?.(null);
  };

  const tickStyle = compact ? { fontSize: "0.6875rem" } : undefined;
  const activeColor = data[0] ? seriesColor(data[0], 0) : undefined;

  const renderEndLabel = ({
    x,
    y,
    index,
    value,
  }: {
    x?: number | string;
    y?: number | string;
    index?: number;
    value?: unknown;
  }) => {
    if (index !== lastIndex || value == null) return <g />;
    return (
      <text
        x={Number(x) + 8}
        y={Number(y)}
        dy="0.35em"
        fill={activeColor}
        className="text-xs font-semibold tabular-nums"
      >
        {formatSigned(Number(value))}
      </text>
    );
  };

  return (
    <div
      className="h-full w-full"
      onTouchStart={
        compact
          ? () => {
              usesTouchRef.current = true;
              fingerDownRef.current = true;
            }
          : undefined
      }
      onTouchEnd={compact ? endScrub : undefined}
      onTouchCancel={compact ? endScrub : undefined}
    >
      <ChartContainer
        config={chartConfig}
        className="h-full w-full"
        data-no-swipe-drag={compact || undefined}
      >
        <ResponsiveContainer width="100%" height="100%" aspect={undefined}>
          <ComposedChart
            data={formattedData}
            margin={
              compact
                ? { top: 14, right: 4, left: 4, bottom: 4 }
                : { top: 8, right: showEndLabel ? 64 : 16, left: 8, bottom: 4 }
            }
            onMouseMove={compact ? handleMouseMove : undefined}
            onMouseLeave={compact ? endScrub : undefined}
            onTouchMove={compact ? handleTouchMove : undefined}
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor={activeColor} stopOpacity={0.22} />
                <stop offset={zeroOffset} stopColor={activeColor} stopOpacity={0.02} />
                <stop
                  offset={1}
                  stopColor={activeColor}
                  stopOpacity={zeroOffset < 1 ? 0.16 : 0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              verticalCoordinatesGenerator={noVerticalGridPoints}
              strokeOpacity={0.5}
            />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={compact ? 6 : 8}
              ticks={axis.ticks}
              interval={0}
              tick={tickStyle}
              tickFormatter={(date: string) =>
                formatPerformanceAxisDate(date, axis, dateFormatting)
              }
            />
            {/* Phones label the gridlines inside the chart, so the lines get the full width
                and a narrow axis can't clip a minus sign. */}
            <YAxis
              tickFormatter={(value: number) =>
                numberFormatting.formatPercent(value, { digits: yAxis.digits })
              }
              tickLine={false}
              axisLine={false}
              ticks={yAxis.ticks}
              domain={[yAxis.ticks[0], yAxis.ticks[yAxis.ticks.length - 1]]}
              interval={0}
              orientation={compact ? "right" : "left"}
              mirror={compact}
              tickMargin={compact ? 0 : 8}
              // Lines pass under these in-chart labels; a card-coloured outline keeps them legible.
              tick={
                compact
                  ? {
                      fontSize: "0.6875rem",
                      dy: -7,
                      stroke: "var(--card)",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                      paintOrder: "stroke",
                    }
                  : undefined
              }
            />
            <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.45} />
            <ChartTooltip
              cursor={{
                stroke: "var(--muted-foreground)",
                strokeOpacity: 0.4,
                strokeWidth: 1,
              }}
              content={(props) =>
                compact ? null : (
                  <PerformanceTooltip
                    {...(props as unknown as {
                      active?: boolean;
                      payload?: TooltipEntry[];
                      label?: string | number;
                    })}
                    series={data}
                    formatValue={formatSigned}
                    formatDate={(date) =>
                      dateFormatting.formatCalendarDate(date, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })
                    }
                  />
                )
              }
            />
            {/* Context lines first, so the active series draws on top of them. */}
            {data.slice(1).map((series, offset) => (
              <Line
                key={series.id}
                type="monotone"
                dataKey={series.id}
                stroke={seriesColor(series, offset + 1)}
                strokeOpacity={0.75}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 2.5, strokeWidth: 0 }}
                connectNulls={true}
                name={series.name}
                isAnimationActive={compact ? false : "auto"}
                animationDuration={300}
              />
            ))}
            {data[0] && (
              <Area
                key={data[0].id}
                type="monotone"
                dataKey={data[0].id}
                stroke={activeColor}
                strokeWidth={2.25}
                fill={`url(#${fillId})`}
                fillOpacity={1}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0 }}
                connectNulls={true}
                name={data[0].name}
                isAnimationActive={compact ? false : "auto"}
                animationDuration={300}
                label={!compact && showEndLabel ? renderEndLabel : false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}
