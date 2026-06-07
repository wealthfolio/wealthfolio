import { TimePeriod } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { formatAmount } from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MouseHandlerDataParam } from "recharts/types/synchronisation/types";
import {
  HistoryChartMarkerShape,
  type RechartsMarkerShapeProps,
  type TradeMarkerVariant,
} from "./history-chart-marker";

export interface HistoryChartActivity {
  variant: TradeMarkerVariant;
  date?: string | Date;
  quantity: string | null;
  unitPrice: string | null;
  id: string;
}

export interface HistoryChartData {
  timestamp: string;
  totalValue: number;
  currency: string;
  activities?: HistoryChartActivity[];
}

export interface HistoryChartActivityMarker {
  id: string;
  point: HistoryChartData;
  variant: TradeMarkerVariant;
}

interface SymbolTooltipProps<
  TPayload = {
    timestamp: string;
    currency: string;
    activities?: HistoryChartActivity[];
  },
> {
  active?: boolean;
  payload?: { value: number; payload: TPayload }[];
}

export default function HistoryChart({
  data,
  interval,
  activityMarkers = [],
  onActivityMarkerClick,
  avgCost,
  height = 350,
}: {
  data: HistoryChartData[];
  interval?: TimePeriod;
  height?: number;
  activityMarkers?: HistoryChartActivityMarker[];
  onActivityMarkerClick?: (marker: HistoryChartActivityMarker) => void;
  avgCost?: number;
}) {
  const [hoveredMarker, setHoveredMarker] = useState(false);
  const markerByTimestamp = useMemo(() => {
    const markers = new Map<string, HistoryChartActivityMarker>();
    for (const marker of activityMarkers) {
      markers.set(marker.point.timestamp, marker);
    }
    return markers;
  }, [activityMarkers]);

  const handleChartMove = (chartState: MouseHandlerDataParam) => {
    if (!onActivityMarkerClick || chartState.activeLabel == null) {
      setHoveredMarker(false);
      return;
    }

    setHoveredMarker(markerByTimestamp.has(String(chartState.activeLabel)));
  };

  return (
    <div className="relative flex h-full flex-col" data-no-swipe-drag>
      <div className="grow">
        <ResponsiveContainer width="100%" height="100%" minHeight={height}>
          <AreaChart
            data={data}
            stackOffset="sign"
            style={{
              cursor: onActivityMarkerClick && hoveredMarker ? "pointer" : undefined,
            }}
            margin={{
              top: 0,
              right: 0,
              left: 0,
              bottom: 0,
            }}
            onMouseMove={handleChartMove}
            onMouseLeave={() => setHoveredMarker(false)}
            onClick={(chartState) => {
              if (!onActivityMarkerClick || chartState?.activeLabel == null) return;
              const marker = markerByTimestamp.get(String(chartState.activeLabel));
              if (marker) {
                onActivityMarkerClick(marker);
              }
            }}
          >
            <defs>
              <linearGradient id="colorUv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--success)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--success)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <Tooltip
              content={(props) => <SymbolToolTip {...(props as unknown as SymbolTooltipProps)} />}
              wrapperStyle={{ pointerEvents: "none" }}
            />
            {interval !== "ALL" && interval !== "1Y" ? (
              <YAxis hide={true} type="number" domain={["auto", "auto"]} />
            ) : null}
            <XAxis hide dataKey="timestamp" type="category" />
            <Area
              isAnimationActive={true}
              animationDuration={300}
              animationEasing="ease-out"
              connectNulls={true}
              type="monotone"
              dataKey="totalValue"
              stroke="var(--success)"
              fillOpacity={1}
              fill="url(#colorUv)"
            />
            {avgCost != null && avgCost > 0 && (
              <ReferenceLine
                y={avgCost}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 2"
                strokeOpacity={0.5}
                label={{
                  value: `Avg ${formatAmount(avgCost, data[0]?.currency ?? "", false)}`,
                  position: "insideTopRight",
                  fontSize: 10,
                  fill: "var(--muted-foreground)",
                  opacity: 0.7,
                }}
              />
            )}
            {activityMarkers.map((marker) => {
              return (
                <ReferenceDot
                  r={10}
                  key={marker.id}
                  shape={(props: RechartsMarkerShapeProps) => (
                    <HistoryChartMarkerShape {...props} variant={marker.variant} />
                  )}
                  x={marker.point.timestamp}
                  y={marker.point.totalValue}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SymbolToolTip({ active, payload }: SymbolTooltipProps) {
  if (!active || !payload?.length) {
    return null;
  }
  const data = payload[0].payload;
  return (
    <div className="bg-popover pointer-events-none grid grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md">
      <p className="text-muted-foreground text-xs">{formatDate(data.timestamp)}</p>

      <p className="text-base font-bold">{formatAmount(payload[0].value, data.currency, false)}</p>

      {data.activities && data.activities.length > 0 && (
        <>
          <div className="border-border border-t" />
          {data.activities.map((act) => {
            const isBuy = act.variant === "buy";
            return (
              <div key={act.id} className="flex items-center justify-between space-x-2">
                <div className="flex items-center space-x-1.5">
                  <span
                    className={`block h-2.5 w-2.5 rounded-full ${isBuy ? "bg-success" : "bg-destructive"}`}
                  />
                  <span
                    className={`text-sm font-medium ${isBuy ? "text-success" : "text-destructive"}`}
                  >
                    {isBuy ? "Bought" : "Sold"}
                  </span>
                </div>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {parseFloat(act.quantity || "0")} at{" "}
                  {formatAmount(parseFloat(act.unitPrice || "0"), data.currency, false)}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
