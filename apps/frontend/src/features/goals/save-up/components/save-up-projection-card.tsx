import type { SaveUpProjectionPointDTO } from "@/lib/types";
import { formatCompactAmount } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ProjectionPoint = SaveUpProjectionPointDTO;

// Keep in sync with the +/- range used by crates/core/src/planning/save_up.rs.
const RANGE_RATE_DELTA = 0.02;

function formatRate(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const COLORS = {
  nominal: { fill: "hsl(92, 24%, 70%)", stroke: "var(--success)" },
  range: { stroke: "hsl(91, 24%, 46%)" },
  target: "var(--muted-foreground)",
};

function formatDateLabel(v: string) {
  const [y, m] = v.split("-");
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

function ProjectionTooltip({
  active,
  payload,
  currency,
  isHidden,
  annualReturn,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  currency: string;
  isHidden: boolean;
  annualReturn: number;
}) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ProjectionPoint | undefined;
  if (!point) return null;

  const [y, m] = point.date.split("-");
  const label = `${MONTHS[Number(m) - 1]} ${y}`;
  const fmt = (v: number) => (isHidden ? "***" : formatCompactAmount(v, currency));

  const highRate = annualReturn + RANGE_RATE_DELTA;
  const lowRate = Math.max(0, annualReturn - RANGE_RATE_DELTA);

  const rows = [
    {
      label: t("goals:projection.series_projected"),
      value: point.nominal,
      color: COLORS.nominal.stroke,
      style: "solid",
    },
    {
      label: t("goals:projection.series_target"),
      value: point.target,
      color: COLORS.target,
      style: "dashed",
    },
    {
      label: t("goals:projection.high_range", { rate: formatRate(highRate) }),
      value: point.optimistic,
      color: COLORS.range.stroke,
      style: "band",
    },
    {
      label: t("goals:projection.low_range", { rate: formatRate(lowRate) }),
      value: point.pessimistic,
      color: COLORS.range.stroke,
      style: "band",
    },
  ] as const;

  return (
    <div className="bg-popover grid grid-cols-1 gap-1.5 rounded-md border p-2 shadow-md">
      <p className="text-muted-foreground text-xs">{label}</p>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between space-x-4">
          <div className="flex items-center space-x-1.5">
            <span
              className="block w-3"
              style={
                r.style === "dashed"
                  ? { borderTop: `1.5px dashed ${r.color}` }
                  : r.style === "band"
                    ? { height: "8px", backgroundColor: r.color, opacity: 0.18, borderRadius: 1 }
                    : { height: "2px", backgroundColor: r.color }
              }
            />
            <span className="text-muted-foreground text-xs">{r.label}:</span>
          </div>
          <span className="text-xs font-semibold tabular-nums">{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function ProjectionChart({
  data,
  currency,
  isHidden,
  annualReturn,
}: {
  data: ProjectionPoint[];
  currency: string;
  isHidden: boolean;
  annualReturn: number;
}) {
  const target = data[0]?.target ?? 0;
  const last = data.length > 0 ? data[data.length - 1] : null;
  const finalTarget = last?.target ?? 0;
  const finalProjected = last?.nominal ?? 0;
  const finalDate = last?.date;
  const fmtCompact = (v: number) => (isHidden ? "***" : formatCompactAmount(v, currency));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 10, right: 72, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="projNominal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COLORS.nominal.fill} stopOpacity={0.28} />
            <stop offset="70%" stopColor={COLORS.nominal.fill} stopOpacity={0.14} />
            <stop offset="100%" stopColor={COLORS.nominal.fill} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="projRange" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.range.stroke} stopOpacity={0.18} />
            <stop offset="100%" stopColor={COLORS.range.stroke} stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          tickFormatter={formatDateLabel}
          interval={Math.max(1, Math.floor(data.length / 7))}
          axisLine={false}
          tickLine={false}
        />
        <YAxis hide domain={[(min: number) => min * 0.95, "auto"]} />
        <Tooltip
          content={
            <ProjectionTooltip
              currency={currency}
              isHidden={isHidden}
              annualReturn={annualReturn}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="range"
          stroke="none"
          fill="url(#projRange)"
          fillOpacity={1}
          isAnimationActive={false}
          activeDot={false}
        />
        <Area
          type="monotone"
          dataKey="nominal"
          stroke={COLORS.nominal.stroke}
          strokeWidth={2.25}
          fill="url(#projNominal)"
          fillOpacity={1}
          animationDuration={300}
          animationEasing="ease-out"
        />
        {target > 0 && (
          <Line
            type="linear"
            dataKey="target"
            stroke={COLORS.target}
            strokeWidth={1.25}
            strokeOpacity={0.6}
            strokeDasharray="6 4"
            dot={false}
            activeDot={false}
            animationDuration={300}
            animationEasing="ease-out"
          />
        )}
        {finalDate && target > 0 && (
          <>
            <ReferenceLine
              x={finalDate}
              stroke={COLORS.target}
              strokeWidth={1}
              strokeDasharray="4 3"
              strokeOpacity={0.5}
              label={(props) => {
                // Render a custom date label anchored to the bottom-right of the
                // vertical line, matching how the amount callouts sit outside
                // the plot area on the right. Keeps it clear of the X-axis ticks.

                const vb = props.viewBox ?? {};
                const x = (typeof vb.x === "number" ? vb.x : 0) + 6;
                const y =
                  (typeof vb.y === "number" ? vb.y : 0) +
                  (typeof vb.height === "number" ? vb.height : 0);
                return (
                  <text
                    x={x}
                    y={y}
                    textAnchor="start"
                    fontSize={11}
                    fontWeight={600}
                    fill="var(--foreground)"
                  >
                    {formatDateLabel(finalDate)}
                  </text>
                );
              }}
            />
            <ReferenceDot
              x={finalDate}
              y={finalTarget}
              r={3}
              fill={COLORS.target}
              stroke="none"
              label={{
                value: fmtCompact(finalTarget),
                position: "right",
                fontSize: 11,
                fontWeight: 600,
                fill: "var(--muted-foreground)",
                dx: 6,
              }}
            />
            <ReferenceDot
              x={finalDate}
              y={finalProjected}
              r={3}
              fill={COLORS.nominal.stroke}
              stroke="none"
              label={{
                value: fmtCompact(finalProjected),
                position: "right",
                fontSize: 11,
                fontWeight: 700,
                fill: "var(--foreground)",
                dx: 6,
              }}
            />
          </>
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SaveUpProjectionCard({
  data,
  currency,
  isHidden,
  annualReturn,
}: {
  data: ProjectionPoint[];
  currency: string;
  isHidden: boolean;
  annualReturn: number;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-[0.15em]">
            {t("goals:projection.kicker")}
          </div>
          <CardTitle className="text-md leading-none tracking-tight">
            {t("goals:projection.title")}
          </CardTitle>
        </div>
        <div className="text-muted-foreground flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-[2px] w-5"
              style={{ backgroundColor: COLORS.nominal.stroke }}
            />
            {t("goals:projection.legend_projected")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-5 border-t border-dashed"
              style={{ borderColor: COLORS.target }}
            />
            {t("goals:projection.legend_target")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-5 rounded-[1px]"
              style={{ backgroundColor: COLORS.range.stroke, opacity: 0.18 }}
            />
            {t("goals:projection.legend_range", {
              pct: (RANGE_RATE_DELTA * 100).toFixed(0),
            })}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <ProjectionChart
          data={data}
          currency={currency}
          isHidden={isHidden}
          annualReturn={annualReturn}
        />
      </CardContent>
    </Card>
  );
}
