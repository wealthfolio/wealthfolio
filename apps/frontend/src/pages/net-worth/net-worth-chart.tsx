import { useHapticFeedback } from "@/hooks";
import { ChartConfig, ChartContainer } from "@wealthfolio/ui/components/ui/chart";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { formatDate } from "@/lib/utils";
import { AmountDisplay } from "@wealthfolio/ui";
import { useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Area, AreaChart, Tooltip, YAxis } from "recharts";
import type { NetWorthHistoryPoint } from "@/lib/types";
import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";

// Goldish orange for net worth chart (consistent across light/dark modes)
const CHART_COLOR = "hsl(38, 75%, 50%)";
const NEGATIVE_COLOR = "var(--destructive)";
const CHART_SCRUB_HAPTIC_INTERVAL_MS = 80;

interface ChartDataPoint {
  date: string;
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  currency: string;
}

interface TooltipEntry {
  dataKey?: string | number;
  payload?: ChartDataPoint;
}

interface TooltipBaseProps {
  active?: boolean;
  payload?: TooltipEntry[];
}

interface CustomTooltipProps extends TooltipBaseProps {
  isBalanceHidden: boolean;
  t: TFunction;
}

const CustomTooltip = ({ active, payload, isBalanceHidden, t }: CustomTooltipProps) => {
  if (!active || !payload?.length) {
    return null;
  }

  const entry = payload[0]?.payload;
  if (!entry) {
    return null;
  }

  const hasLiabilities = entry.totalLiabilities > 0;
  const tooltipColor = entry.netWorth >= 0 ? CHART_COLOR : NEGATIVE_COLOR;

  return (
    <div className="bg-popover grid grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md">
      <p className="text-muted-foreground text-xs">{formatDate(entry.date)}</p>

      {/* Net Worth - primary value */}
      <div className="flex items-center justify-between space-x-4">
        <div className="flex items-center space-x-1.5">
          <span className="block h-0.5 w-3" style={{ backgroundColor: tooltipColor }} />
          <span className="text-muted-foreground text-xs">
            {t("insights:networth.chart.net_worth_label")}
          </span>
        </div>
        <AmountDisplay
          value={entry.netWorth}
          currency={entry.currency}
          isHidden={isBalanceHidden}
          className="text-xs font-semibold"
        />
      </div>

      {/* Show breakdown only if there are liabilities (otherwise net worth = assets) */}
      {hasLiabilities && (
        <div className="border-border mt-1 border-t pt-1.5">
          <div className="flex items-center justify-between space-x-4">
            <span className="text-muted-foreground/70 text-xs">
              {t("insights:networth.chart.assets_label")}
            </span>
            <AmountDisplay
              value={entry.totalAssets}
              currency={entry.currency}
              isHidden={isBalanceHidden}
              className="text-muted-foreground text-xs"
            />
          </div>
          <div className="flex items-center justify-between space-x-4">
            <span className="text-muted-foreground/70 text-xs">
              {t("insights:networth.chart.liabilities_label")}
            </span>
            <span className="text-muted-foreground text-xs">
              -
              <AmountDisplay
                value={entry.totalLiabilities}
                currency={entry.currency}
                isHidden={isBalanceHidden}
                className="inline text-xs"
              />
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Transform NetWorthHistoryPoint data to chart-compatible format
 */
function transformData(data: NetWorthHistoryPoint[]): ChartDataPoint[] {
  return data.map((point) => ({
    date: point.date,
    netWorth: parseFloat(point.netWorth) || 0,
    totalAssets: parseFloat(point.totalAssets) || 0,
    totalLiabilities: parseFloat(point.totalLiabilities) || 0,
    currency: point.currency,
  }));
}

interface NetWorthChartProps {
  data: NetWorthHistoryPoint[];
  isLoading?: boolean;
}

export function NetWorthChart({ data, isLoading }: NetWorthChartProps) {
  const { t } = useTranslation();
  const { triggerHaptic } = useHapticFeedback();
  const { isBalanceHidden } = useBalancePrivacy();
  const isMobile = useIsMobileViewport();
  const isTouchScrubbingRef = useRef(false);
  const lastHapticLabelRef = useRef<string | number | undefined>(undefined);
  const lastHapticAtRef = useRef(0);
  const id = useId();
  const fillGradientId = `nwFill-${id}`;
  const strokeGradientId = `nwStroke-${id}`;

  const chartData = transformData(data);

  const chartConfig = {
    netWorth: {
      label: t("insights:networth.chart.net_worth"),
    },
  } satisfies ChartConfig;

  // Compute where y=0 falls in the gradient (0=top, 1=bottom)
  const { zeroOffset, allPositive, allNegative } = useMemo(() => {
    if (chartData.length === 0) return { zeroOffset: 0, allPositive: true, allNegative: false };
    let min = Infinity;
    let max = -Infinity;
    for (const d of chartData) {
      if (d.netWorth < min) min = d.netWorth;
      if (d.netWorth > max) max = d.netWorth;
    }
    if (min >= 0) return { zeroOffset: 1, allPositive: true, allNegative: false };
    if (max <= 0) return { zeroOffset: 0, allPositive: false, allNegative: true };
    // Account for the 2% padding on the Y domain minimum
    const adjustedMin = min - Math.abs(min) * 0.02;
    const offset = max / (max - adjustedMin);
    return { zeroOffset: offset, allPositive: false, allNegative: false };
  }, [chartData]);

  if (isLoading || chartData.length === 0) {
    return null;
  }

  const zeroPercent = `${(zeroOffset * 100).toFixed(1)}%`;

  const maybeTriggerScrubHaptic = (chartState: MouseHandlerDataParam) => {
    if (!isMobile || !isTouchScrubbingRef.current || !chartState.isTooltipActive) {
      return;
    }

    const activeLabel = chartState.activeLabel;
    if (activeLabel == null || activeLabel === lastHapticLabelRef.current) {
      return;
    }

    const now = Date.now();
    if (now - lastHapticAtRef.current < CHART_SCRUB_HAPTIC_INTERVAL_MS) {
      return;
    }

    lastHapticLabelRef.current = activeLabel;
    lastHapticAtRef.current = now;
    triggerHaptic();
  };

  const resetTouchScrubState = () => {
    isTouchScrubbingRef.current = false;
    lastHapticLabelRef.current = undefined;
  };

  return (
    <ChartContainer config={chartConfig} className="h-full w-full" data-no-swipe-drag>
      <AreaChart
        data={chartData}
        margin={{
          top: 0,
          right: 0,
          left: 0,
          bottom: 0,
        }}
        onMouseLeave={resetTouchScrubState}
        onTouchStart={(chartState) => {
          isTouchScrubbingRef.current = true;
          maybeTriggerScrubHaptic(chartState);
        }}
        onTouchMove={maybeTriggerScrubHaptic}
        onTouchEnd={resetTouchScrubState}
      >
        <defs>
          <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
            {allNegative ? (
              <>
                <stop offset="5%" stopColor={NEGATIVE_COLOR} stopOpacity={0.2} />
                <stop offset="70%" stopColor={NEGATIVE_COLOR} stopOpacity={0.12} />
                <stop offset="100%" stopColor={NEGATIVE_COLOR} stopOpacity={0} />
              </>
            ) : allPositive ? (
              <>
                <stop offset="5%" stopColor={CHART_COLOR} stopOpacity={0.2} />
                <stop offset="70%" stopColor={CHART_COLOR} stopOpacity={0.12} />
                <stop offset="100%" stopColor={CHART_COLOR} stopOpacity={0} />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor={CHART_COLOR} stopOpacity={0.2} />
                <stop offset={zeroPercent} stopColor={CHART_COLOR} stopOpacity={0.05} />
                <stop offset={zeroPercent} stopColor={NEGATIVE_COLOR} stopOpacity={0.05} />
                <stop offset="100%" stopColor={NEGATIVE_COLOR} stopOpacity={0.2} />
              </>
            )}
          </linearGradient>
          <linearGradient id={strokeGradientId} x1="0" y1="0" x2="0" y2="1">
            {allNegative ? (
              <stop offset="0%" stopColor={NEGATIVE_COLOR} />
            ) : allPositive ? (
              <stop offset="0%" stopColor={CHART_COLOR} />
            ) : (
              <>
                <stop offset={zeroPercent} stopColor={CHART_COLOR} />
                <stop offset={zeroPercent} stopColor={NEGATIVE_COLOR} />
              </>
            )}
          </linearGradient>
        </defs>
        <Tooltip
          position={isMobile ? { y: 60 } : { y: -20 }}
          content={(props) => (
            <CustomTooltip
              {...(props as unknown as TooltipBaseProps)}
              isBalanceHidden={isBalanceHidden}
              t={t}
            />
          )}
        />
        <YAxis
          hide
          type="number"
          domain={[(dataMin: number) => dataMin - Math.abs(dataMin) * 0.02, "auto"]}
        />

        {/* Net Worth (main filled area) */}
        <Area
          isAnimationActive={true}
          animationDuration={300}
          animationEasing="ease-out"
          connectNulls={true}
          type="monotone"
          dataKey="netWorth"
          stroke={`url(#${strokeGradientId})`}
          fillOpacity={1}
          fill={`url(#${fillGradientId})`}
        />
      </AreaChart>
    </ChartContainer>
  );
}
