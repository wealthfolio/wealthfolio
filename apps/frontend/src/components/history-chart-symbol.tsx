import { TimePeriod } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { useAmountFormatting, useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  type HistoryChartMarkerTone,
  type HistoryChartMarkerVariant,
  type RechartsMarkerShapeProps,
} from "./history-chart-marker";

type SymbolActivityMarkerVariant = Exclude<HistoryChartMarkerVariant, "snapshot">;

export interface HistoryChartActivity {
  variant: SymbolActivityMarkerVariant;
  markerLabel?: string;
  markerTone?: HistoryChartMarkerTone;
  activityType?: string;
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
  variant: SymbolActivityMarkerVariant;
  markerLabel?: string;
  markerTone?: HistoryChartMarkerTone;
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
  averageCost,
  height = 350,
}: {
  data: HistoryChartData[];
  interval?: TimePeriod;
  height?: number;
  activityMarkers?: HistoryChartActivityMarker[];
  onActivityMarkerClick?: (marker: HistoryChartActivityMarker) => void;
  averageCost?: number;
}) {
  const amountFormatting = useAmountFormatting();
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
            {averageCost != null && averageCost > 0 && (
              <ReferenceLine
                y={averageCost}
                stroke="var(--foreground)"
                strokeDasharray="4 3"
                strokeWidth={1}
                ifOverflow="extendDomain"
                label={{
                  value: amountFormatting.formatPrice(averageCost, data[0]?.currency ?? "", false),
                  position: "insideBottomLeft",
                  fill: "var(--foreground)",
                  fontSize: 11,
                }}
              />
            )}
            {activityMarkers.map((marker) => {
              return (
                <ReferenceDot
                  r={10}
                  key={marker.id}
                  shape={(props: RechartsMarkerShapeProps) => (
                    <HistoryChartMarkerShape
                      {...props}
                      variant={marker.variant}
                      label={marker.markerLabel}
                      tone={marker.markerTone}
                    />
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
  const amountFormatting = useAmountFormatting();
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  if (!active || !payload?.length) {
    return null;
  }
  const data = payload[0].payload;
  return (
    <div className="bg-popover pointer-events-none grid grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md">
      <p className="text-muted-foreground text-xs">{formatDate(data.timestamp, dateFormatting)}</p>

      <p className="text-base font-bold">
        {amountFormatting.formatPrice(payload[0].value, data.currency, false)}
      </p>

      {data.activities && data.activities.length > 0 && (
        <>
          <div className="border-border border-t" />
          {data.activities.map((act) => {
            const tone = act.markerTone ?? markerToneForVariant(act.variant);
            const markerClass = markerTextClass(tone);
            const dotClass = markerDotClass(tone);
            const label =
              act.variant === "buy"
                ? t("common:component.activity_bought")
                : act.variant === "sell"
                  ? t("common:component.activity_sold")
                  : formatActivityType(act.activityType, t);
            const hasPriceDetails = Boolean(act.quantity && act.unitPrice);
            return (
              <div key={act.id} className="flex items-center justify-between space-x-2">
                <div className="flex items-center space-x-1.5">
                  <span className={`block h-2.5 w-2.5 rounded-full ${dotClass}`} />
                  <span className={`text-sm font-medium ${markerClass}`}>{label}</span>
                </div>
                {hasPriceDetails && (
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {t("common:component.activity_quantity_at_price", {
                      quantity: numberFormatting.formatQuantity(parseFloat(act.quantity || "0")),
                      price: amountFormatting.formatPrice(
                        parseFloat(act.unitPrice || "0"),
                        data.currency,
                        false,
                      ),
                    })}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function markerToneForVariant(variant: SymbolActivityMarkerVariant): HistoryChartMarkerTone {
  if (variant === "buy") return "success";
  if (variant === "sell") return "destructive";
  if (variant === "split") return "warning";
  return "default";
}

function markerTextClass(tone: HistoryChartMarkerTone) {
  switch (tone) {
    case "success":
      return "text-success";
    case "destructive":
      return "text-destructive";
    case "secondary":
      return "text-secondary-foreground";
    case "warning":
      return "text-warning";
    default:
      return "text-primary";
  }
}

function markerDotClass(tone: HistoryChartMarkerTone) {
  switch (tone) {
    case "success":
      return "bg-success";
    case "destructive":
      return "bg-destructive";
    case "secondary":
      return "bg-secondary";
    case "warning":
      return "bg-warning";
    default:
      return "bg-primary";
  }
}

function formatActivityType(activityType: string | undefined, t: TFunction) {
  if (!activityType) return t("common:component.activity_generic");
  return activityType
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
