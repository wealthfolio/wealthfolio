import { useHapticFeedback } from "@/hooks";
import { ChartConfig, ChartContainer } from "@wealthfolio/ui/components/ui/chart";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { formatDate } from "@/lib/utils";
import { AmountDisplay } from "@wealthfolio/ui";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, ReferenceDot, Tooltip, XAxis, YAxis } from "recharts";
import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";
import {
  HistoryChartActiveDot,
  HistoryChartMarkerShape,
  type RechartsActiveDotProps,
  type RechartsMarkerShapeProps,
} from "./history-chart-marker";
import { getAutomaticHistoryChartScale, type HistoryChartScaleMode } from "./history-chart-scale";

const CHART_SCRUB_HAPTIC_INTERVAL_MS = 80;

export interface HistoryChartData {
  date: string;
  totalValue: number;
  netContribution: number;
  currency: string;
}

interface HistoryChartProps {
  data: HistoryChartData[];
  isLoading?: boolean;
  /** Dates with manual snapshots (YYYY-MM-DD format) */
  snapshotDates?: string[];
  /** Toggle visibility of snapshot markers */
  showMarkers?: boolean;
  /** Callback when a marker is clicked */
  onMarkerClick?: (date: string) => void;
  /** Controls how the Y-axis domain is calculated. */
  scaleMode?: HistoryChartScaleMode;
  /** Expands the domain to show net contribution when the widened span stays under this ratio. */
  netContributionMaxDomainSpanRatio?: number;
  /** Keeps narrow ranges from zooming too aggressively. Ratio is relative to the visible center. */
  minDomainSpanRatio?: number;
}

interface TooltipEntry {
  dataKey?: string | number;
  payload?: HistoryChartData;
}

interface TooltipBaseProps {
  active?: boolean;
  payload?: TooltipEntry[];
}

interface CustomTooltipProps extends TooltipBaseProps {
  isBalanceHidden: boolean;
  isChartHovered: boolean;
}

const CustomTooltip = ({
  active,
  payload,
  isBalanceHidden,
  isChartHovered,
}: CustomTooltipProps) => {
  const { t } = useTranslation();
  if (!active || !payload?.length) {
    return null;
  }

  const totalValueData = payload.find(
    (item): item is TooltipEntry & { dataKey: "totalValue"; payload: HistoryChartData } =>
      item?.dataKey === "totalValue" && item.payload !== undefined,
  );
  const netContributionData = payload.find(
    (item): item is TooltipEntry & { dataKey: "netContribution"; payload: HistoryChartData } =>
      item?.dataKey === "netContribution" && item.payload !== undefined,
  );

  const tvPayload = totalValueData?.payload;
  const ncPayload = netContributionData?.payload;

  if (!tvPayload) {
    return null;
  }

  const netContributionPayload = ncPayload ?? tvPayload;
  const tooltipColor = tvPayload.totalValue >= 0 ? "var(--success)" : "var(--destructive)";

  return (
    <div className="bg-popover pointer-events-none grid grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md">
      <p className="text-muted-foreground text-xs">{formatDate(tvPayload.date)}</p>

      <div className="flex items-center justify-between space-x-2">
        <div className="flex items-center space-x-1.5">
          <span className="block h-0.5 w-3" style={{ backgroundColor: tooltipColor }} />
          <span className="text-muted-foreground text-xs">
            {t("common:component.total_value_label")}
          </span>
        </div>
        <AmountDisplay
          value={tvPayload.totalValue}
          currency={tvPayload.currency}
          isHidden={isBalanceHidden}
          className="text-xs font-semibold"
        />
      </div>
      {isChartHovered && netContributionPayload && (
        <div className="flex items-center justify-between space-x-2">
          <div className="flex items-center space-x-1.5">
            <span
              className="block h-0 w-3 border-b-2 border-dashed"
              style={{ borderColor: "var(--muted-foreground)" }}
            />
            <span className="text-muted-foreground text-xs">
              {t("common:component.net_deposit_label")}
            </span>
          </div>
          <AmountDisplay
            value={netContributionPayload.netContribution}
            currency={netContributionPayload.currency}
            isHidden={isBalanceHidden}
            className="text-xs font-semibold"
          />
        </div>
      )}
    </div>
  );
};

export function HistoryChart({
  data,
  isLoading,
  snapshotDates,
  showMarkers,
  onMarkerClick,
  scaleMode,
  netContributionMaxDomainSpanRatio,
  minDomainSpanRatio,
}: HistoryChartProps) {
  const { t } = useTranslation();
  const { triggerHaptic } = useHapticFeedback();
  const { isBalanceHidden } = useBalancePrivacy();
  const [isChartHovered, setIsChartHovered] = useState(false);
  const [hoveredMarker, setHoveredMarker] = useState(false);
  const isMobile = useIsMobileViewport();
  const isTouchScrubbingRef = useRef(false);
  const lastHapticLabelRef = useRef<string | number | undefined>(undefined);
  const lastHapticAtRef = useRef(0);
  const id = useId();
  const fillGradientId = `historyFill-${id}`;
  const strokeGradientId = `historyStroke-${id}`;
  const scaleConfig = useMemo(
    () =>
      getAutomaticHistoryChartScale(data, {
        ...(scaleMode ? { mode: scaleMode } : {}),
        ...(netContributionMaxDomainSpanRatio === undefined
          ? {}
          : { netContributionMaxDomainSpanRatio }),
        ...(minDomainSpanRatio === undefined ? {} : { minDomainSpanRatio }),
      }),
    [data, scaleMode, netContributionMaxDomainSpanRatio, minDomainSpanRatio],
  );

  const chartConfig = {
    totalValue: {
      label: t("common:component.total_value"),
    },
    netContribution: {
      label: t("common:component.net_contribution"),
    },
  } satisfies ChartConfig;

  // Compute where y=0 falls in the gradient (0=top, 1=bottom)
  // to split green (positive) / red (negative) fill & stroke
  const { zeroOffset, allPositive, allNegative } = useMemo(() => {
    if (data.length === 0) return { zeroOffset: 0, allPositive: true, allNegative: false };
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) {
      if (d.totalValue < min) min = d.totalValue;
      if (d.totalValue > max) max = d.totalValue;
    }
    if (min >= 0) return { zeroOffset: 1, allPositive: true, allNegative: false };
    if (max <= 0) return { zeroOffset: 0, allPositive: false, allNegative: true };
    const [domainMin, domainMax] = scaleConfig.domain;
    const offset = domainMax / (domainMax - domainMin);
    return { zeroOffset: offset, allPositive: false, allNegative: false };
  }, [data, scaleConfig.domain]);

  // Build a map of date -> index for efficient lookup
  const dateToIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    data.forEach((item, index) => {
      map.set(item.date, index);
    });
    return map;
  }, [data]);

  // Get marker data points (snapshot dates that exist in the chart data)
  const markerDataPoints = useMemo(() => {
    if (!showMarkers || !snapshotDates || snapshotDates.length === 0) {
      return [];
    }
    return snapshotDates
      .map((date) => {
        const index = dateToIndexMap.get(date);
        if (index !== undefined && data[index]) {
          return {
            date,
            index,
            value: data[index].totalValue,
          };
        }
        return null;
      })
      .filter((item): item is { date: string; index: number; value: number } => item !== null);
  }, [showMarkers, snapshotDates, dateToIndexMap, data]);

  // Set for efficient marker date lookup (used by chart onClick)
  const markerDateSet = useMemo(
    () => new Set(markerDataPoints.map((p) => p.date)),
    [markerDataPoints],
  );
  const singleDataPoint =
    data.length === 1 && !markerDateSet.has(data[0].date) ? data[0] : undefined;

  if (isLoading && data.length === 0) {
    return null;
  }

  // Gradient stops for fill and stroke based on zero crossing
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

  const handleChartMove = (chartState: MouseHandlerDataParam) => {
    if (!showMarkers || chartState.activeLabel == null) {
      setHoveredMarker(false);
    } else {
      setHoveredMarker(markerDateSet.has(String(chartState.activeLabel)));
    }

    maybeTriggerScrubHaptic(chartState);
  };

  return (
    <ChartContainer config={chartConfig} className="h-full w-full" data-no-swipe-drag>
      <AreaChart
        data={data}
        stackOffset="sign"
        style={{
          cursor: showMarkers && isChartHovered && hoveredMarker ? "pointer" : undefined,
        }}
        margin={{
          top: 0,
          right: 0,
          left: 0,
          bottom: 0,
        }}
        onMouseEnter={() => setIsChartHovered(true)}
        onMouseLeave={() => {
          setIsChartHovered(false);
          setHoveredMarker(false);
          resetTouchScrubState();
        }}
        onMouseMove={handleChartMove}
        onClick={(chartState) => {
          if (!showMarkers || chartState?.activeLabel == null) return;
          const clickedDate = String(chartState.activeLabel);
          if (markerDateSet.has(clickedDate)) {
            onMarkerClick?.(clickedDate);
          }
        }}
        onTouchStart={(chartState) => {
          isTouchScrubbingRef.current = true;
          setIsChartHovered(true);
          handleChartMove(chartState);
        }}
        onTouchMove={handleChartMove}
        onTouchEnd={() => {
          setIsChartHovered(false);
          setHoveredMarker(false);
          resetTouchScrubState();
        }}
      >
        <defs>
          <linearGradient id={fillGradientId} x1="0" y1="0" x2="0" y2="1">
            {allNegative ? (
              <>
                <stop offset="5%" stopColor="var(--destructive)" stopOpacity={0.2} />
                <stop offset="70%" stopColor="var(--destructive)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0} />
              </>
            ) : allPositive ? (
              <>
                <stop offset="5%" stopColor="var(--success)" stopOpacity={0.2} />
                <stop offset="70%" stopColor="var(--success)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="var(--success)" stopOpacity={0.2} />
                <stop offset={zeroPercent} stopColor="var(--success)" stopOpacity={0.05} />
                <stop offset={zeroPercent} stopColor="var(--destructive)" stopOpacity={0.05} />
                <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0.2} />
              </>
            )}
          </linearGradient>
          <linearGradient id={strokeGradientId} x1="0" y1="0" x2="0" y2="1">
            {allNegative ? (
              <stop offset="0%" stopColor="var(--destructive)" />
            ) : allPositive ? (
              <stop offset="0%" stopColor="var(--success)" />
            ) : (
              <>
                <stop offset={zeroPercent} stopColor="var(--success)" />
                <stop offset={zeroPercent} stopColor="var(--destructive)" />
              </>
            )}
          </linearGradient>
        </defs>
        <Tooltip
          position={isMobile ? { y: 60 } : { y: -20 }}
          cursor={{ stroke: "var(--border)", strokeWidth: 1, pointerEvents: "none" }}
          wrapperStyle={{ pointerEvents: "none" }}
          content={(props) => (
            <CustomTooltip
              {...(props as unknown as TooltipBaseProps)}
              isBalanceHidden={isBalanceHidden}
              isChartHovered={isChartHovered}
            />
          )}
        />
        <XAxis hide dataKey="date" type="category" />
        <YAxis
          hide
          type="number"
          scale={scaleConfig.scale === "log" ? "log" : "auto"}
          domain={scaleConfig.domain}
        />
        <Area
          isAnimationActive={true}
          animationDuration={300}
          animationEasing="ease-out"
          connectNulls={true}
          type="monotone"
          dataKey="totalValue"
          stroke={`url(#${strokeGradientId})`}
          activeDot={(props: RechartsActiveDotProps & { payload?: HistoryChartData }) =>
            showMarkers && props.payload?.date && markerDateSet.has(props.payload.date) ? null : (
              <HistoryChartActiveDot {...props} stroke="var(--success)" />
            )
          }
          fillOpacity={1}
          fill={`url(#${fillGradientId})`}
          style={{ pointerEvents: "none" }}
        />
        {scaleConfig.showNetContribution && (
          <Area
            isAnimationActive={true}
            animationDuration={300}
            animationEasing="ease-out"
            connectNulls={true}
            type="monotone"
            dataKey="netContribution"
            stroke="var(--muted-foreground)"
            activeDot={false}
            fill="transparent"
            strokeDasharray="5 5"
            strokeOpacity={isChartHovered ? 0.8 : 0}
            style={{ pointerEvents: "none" }}
          />
        )}
        {showMarkers &&
          markerDataPoints.map((point) => (
            <ReferenceDot
              key={`marker-${point.date}`}
              x={point.date}
              y={point.value}
              shape={(props: RechartsMarkerShapeProps) => (
                <HistoryChartMarkerShape {...props} variant="snapshot" value={point.value} />
              )}
            />
          ))}
        {singleDataPoint && (
          <ReferenceDot
            x={singleDataPoint.date}
            y={singleDataPoint.totalValue}
            r={4}
            fill={singleDataPoint.totalValue >= 0 ? "var(--success)" : "var(--destructive)"}
            stroke="var(--background)"
            strokeWidth={2}
          />
        )}
      </AreaChart>
    </ChartContainer>
  );
}
