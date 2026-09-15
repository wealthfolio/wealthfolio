export type HistoryChartMarkerVariant = "snapshot" | "buy" | "sell" | "split" | "activity";
export type HistoryChartMarkerTone =
  | "success"
  | "destructive"
  | "secondary"
  | "warning"
  | "info"
  | "default";
export type TradeMarkerVariant = Extract<HistoryChartMarkerVariant, "buy" | "sell">;

export interface RechartsMarkerShapeProps {
  cx?: number | string;
  cy?: number | string;
}

export interface RechartsActiveDotProps extends RechartsMarkerShapeProps {
  stroke?: string;
}

interface HistoryChartMarkerShapeProps extends RechartsMarkerShapeProps {
  variant: HistoryChartMarkerVariant;
  value?: number;
  label?: string;
  tone?: HistoryChartMarkerTone;
}

export function HistoryChartActiveDot({
  cx,
  cy,
  stroke = "var(--success)",
}: RechartsActiveDotProps) {
  return (
    <g transform={`translate(${cx ?? 0}, ${cy ?? 0})`} style={{ pointerEvents: "none" }}>
      <circle r={5} fill="var(--background)" />
      <circle r={3.5} fill={stroke} />
    </g>
  );
}

export function HistoryChartMarkerShape({
  cx,
  cy,
  variant,
  value = 0,
  label,
  tone,
}: HistoryChartMarkerShapeProps) {
  if (variant === "snapshot") {
    return (
      <g
        className={value >= 0 ? "text-success" : "text-destructive"}
        transform={`translate(${cx ?? 0}, ${cy ?? 0})`}
        style={{ pointerEvents: "none" }}
      >
        <circle r={10} fill="currentColor" opacity={0.14} />
        <circle r={6} fill="currentColor" stroke="var(--background)" strokeWidth={1.5} />
      </g>
    );
  }

  const markerLabel = label ?? markerLabelForVariant(variant);
  const markerTone = tone ?? markerToneForVariant(variant);
  const { fill, foreground } = markerColors(markerTone);

  return (
    <g style={{ pointerEvents: "none" }} transform={`translate(${cx ?? 0}, ${cy ?? 0})`}>
      <circle r={12} fill={fill} opacity={0.14} />
      <circle r={8} fill={fill} stroke="var(--background)" strokeWidth={1.5} />
      <text
        x={0}
        y={0}
        textAnchor="middle"
        dominantBaseline="central"
        fill={foreground}
        fontSize={markerLabel.length > 1 ? 7 : 10}
        fontWeight="bold"
      >
        {markerLabel}
      </text>
    </g>
  );
}

function markerLabelForVariant(variant: HistoryChartMarkerVariant) {
  if (variant === "buy") return "B";
  if (variant === "sell") return "S";
  if (variant === "split") return "SP";
  return "A";
}

function markerToneForVariant(variant: HistoryChartMarkerVariant): HistoryChartMarkerTone {
  if (variant === "buy") return "success";
  if (variant === "sell") return "destructive";
  if (variant === "split") return "warning";
  return "default";
}

function markerColors(tone: HistoryChartMarkerTone) {
  switch (tone) {
    case "success":
      return { fill: "var(--success)", foreground: "var(--success-foreground)" };
    case "destructive":
      return { fill: "var(--destructive)", foreground: "var(--destructive-foreground)" };
    case "secondary":
      return { fill: "var(--secondary)", foreground: "var(--secondary-foreground)" };
    case "warning":
      return { fill: "var(--warning)", foreground: "var(--warning-foreground)" };
    case "info":
      return { fill: "var(--info)", foreground: "var(--info-foreground)" };
    default:
      return { fill: "var(--primary)", foreground: "var(--primary-foreground)" };
  }
}
