import { formatCompactAmount } from "@wealthfolio/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartValueMode } from "./value-mode-toggle";

export type PlannerMode = "fire" | "traditional";

export interface ChartPoint {
  label: string; // category axis for reliable ReferenceLine
  age: number;
  portfolio: number; // start-of-age value used for visual comparison to required capital
  portfolioStart: number;
  portfolioEnd: number;
  target: number | undefined;
  withdrawal: number; // annual withdrawal (0 during accumulation)
  phase: string;
  annualContribution: number;
  annualIncome: number;
  annualExpenses: number;
  netChange: number;
}

export const PROJECTED_CHART_COLORS = {
  onTrack: { fill: "hsl(92, 24%, 70%)", stroke: "hsl(91, 43%, 29%)" },
  offTrack: { fill: "hsl(38, 75%, 50%)", stroke: "hsl(38, 75%, 50%)" },
} as const;

export const CHART_COLORS = {
  muted: "var(--muted-foreground)",
  foreground: "var(--foreground)",
  reference: "color-mix(in srgb, var(--muted-foreground) 58%, transparent)",
};

interface RetirementAxisTickProps {
  x?: number | string;
  y?: number | string;
  payload?: {
    value?: string;
  };
  retirementLabel: string;
  eventLabel: string;
}

function RetirementAxisTick({
  x = 0,
  y = 0,
  payload,
  retirementLabel,
  eventLabel,
}: RetirementAxisTickProps) {
  const value = payload?.value ?? "";
  const tickX = typeof x === "number" ? x : Number(x) || 0;
  const tickY = typeof y === "number" ? y : Number(y) || 0;
  if (value === retirementLabel) {
    return (
      <g transform={`translate(${tickX},${tickY})`}>
        <text textAnchor="middle" fill={CHART_COLORS.foreground}>
          <tspan x={0} dy={16} fontSize={12} fontWeight={500}>
            {value}
          </tspan>
          <tspan x={0} dy={18} fontSize={12} fontWeight={700}>
            {eventLabel}
          </tspan>
        </text>
      </g>
    );
  }

  return (
    <g transform={`translate(${tickX},${tickY})`}>
      <text textAnchor="middle" fill={CHART_COLORS.muted} fontSize={11}>
        {value.replace(/^Age\s+/, "")}
      </text>
    </g>
  );
}

interface ChartCalloutLabelProps {
  viewBox?: {
    x?: number;
    y?: number;
  };
  amount: string;
  fill: string;
  dx?: number;
  dy?: number;
}

function ChartCalloutLabel({ viewBox, amount, fill, dx = 10, dy = -5 }: ChartCalloutLabelProps) {
  const x = typeof viewBox?.x === "number" ? viewBox.x : 0;
  const y = typeof viewBox?.y === "number" ? viewBox.y : 0;
  const labelX = x + dx;
  const labelY = y + dy;

  return (
    <text x={labelX} y={labelY} textAnchor="start" fill={fill}>
      <tspan x={labelX} dy={0} fontSize={12} fontWeight={700}>
        {amount}
      </tspan>
    </text>
  );
}

function RetirementChartTooltip({
  active,
  payload,
  currency,
  valueMode,
  projectedStroke,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  currency: string;
  valueMode: ChartValueMode;
  projectedStroke: string;
}) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;
  const valueLabel =
    valueMode === "real" ? t("goals:value_mode.todays_money") : t("goals:value_mode.nominal_money");
  const phaseLabel =
    point.phase === "fire"
      ? t("goals:portfolio_chart.phase_retirement")
      : t("goals:portfolio_chart.phase_accumulation");

  return (
    <div className="bg-popover grid grid-cols-1 gap-1.5 rounded-md border p-2.5 shadow-md">
      <p className="text-muted-foreground text-xs font-medium">
        {t("goals:portfolio_chart.tooltip_header", {
          age: point.age,
          phase: phaseLabel,
          valueLabel,
        })}
      </p>
      <div className="flex items-center justify-between space-x-4">
        <div className="flex items-center space-x-1.5">
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: projectedStroke }}
          />
          <span className="text-muted-foreground text-xs">
            {t("goals:portfolio_chart.start_portfolio")}
          </span>
        </div>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.portfolioStart, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between space-x-4">
        <span className="text-muted-foreground text-xs">
          {t("goals:portfolio_chart.end_portfolio")}
        </span>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.portfolioEnd, currency)}
        </span>
      </div>
      {point.target != null && (
        <div className="flex items-center justify-between space-x-4">
          <div className="flex items-center space-x-1.5">
            <span className="block h-0 w-3 border-b border-dashed border-[#888]" />
            <span className="text-muted-foreground text-xs">
              {t("goals:portfolio_chart.what_youll_need")}
            </span>
          </div>
          <span className="text-xs font-semibold tabular-nums">
            {formatCompactAmount(point.target, currency)}
          </span>
        </div>
      )}
      {point.annualContribution > 0 && (
        <div className="flex items-center justify-between space-x-4">
          <span className="text-muted-foreground text-xs">
            {t("goals:portfolio_chart.contribution_yr")}
          </span>
          <span className="text-xs font-semibold tabular-nums">
            {formatCompactAmount(point.annualContribution, currency)}
          </span>
        </div>
      )}
      {point.annualIncome > 0 && (
        <div className="flex items-center justify-between space-x-4">
          <span className="text-muted-foreground text-xs">
            {t("goals:portfolio_chart.income_yr")}
          </span>
          <span className="text-xs font-semibold tabular-nums">
            {formatCompactAmount(point.annualIncome, currency)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between space-x-4">
        <span className="text-muted-foreground text-xs">
          {t("goals:coverage_chart.planned_spending_yr")}
        </span>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.annualExpenses, currency)}
        </span>
      </div>
      {point.withdrawal > 0 && (
        <div className="flex items-center justify-between space-x-4">
          <div className="flex items-center space-x-1.5">
            <span className="text-destructive block h-2 w-2 rounded-full" />
            <span className="text-muted-foreground text-xs">
              {t("goals:portfolio_chart.portfolio_withdrawal_yr")}
            </span>
          </div>
          <span className="text-destructive text-xs font-semibold tabular-nums">
            -{formatCompactAmount(point.withdrawal, currency)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between space-x-4 border-t pt-1">
        <span className="text-muted-foreground text-xs">
          {t("goals:portfolio_chart.net_portfolio_change")}
        </span>
        <span
          className={`text-xs font-semibold tabular-nums ${
            point.netChange >= 0 ? "text-green-600" : "text-red-500"
          }`}
        >
          {point.netChange >= 0 ? "+" : "-"}
          {formatCompactAmount(Math.abs(point.netChange), currency)}
        </span>
      </div>
    </div>
  );
}

export function RetirementChart({
  data,
  currency,
  retirementAge,
  projectedFireAge,
  valueMode,
  plannerMode,
  projectedIsOnTrack,
}: {
  data: ChartPoint[];
  currency: string;
  retirementAge: number;
  projectedFireAge?: number | null;
  valueMode: ChartValueMode;
  plannerMode: PlannerMode;
  projectedIsOnTrack: boolean;
}) {
  const { t } = useTranslation();
  const retirementLabel = `Age ${retirementAge}`;
  const isFireMode = plannerMode === "fire";
  const eventLabel = isFireMode
    ? t("goals:portfolio_chart.event_goal")
    : t("goals:portfolio_chart.event_retirement");
  const showProjectedFiLine =
    isFireMode && projectedFireAge != null && projectedFireAge !== retirementAge;
  const projectedFiLabel = showProjectedFiLine ? `Age ${projectedFireAge}` : "";
  const retirementPoint = data.find((point) => point.age === retirementAge);
  const retirementPortfolioValueLabel =
    retirementPoint && retirementPoint.portfolio > 0
      ? formatCompactAmount(retirementPoint.portfolio, currency)
      : null;
  const projectedPalette = projectedIsOnTrack
    ? PROJECTED_CHART_COLORS.onTrack
    : PROJECTED_CHART_COLORS.offTrack;
  const retirementTargetValue =
    retirementPoint && typeof retirementPoint.target === "number" ? retirementPoint.target : null;
  const retirementTargetValueLabel =
    retirementTargetValue != null && retirementTargetValue > 0
      ? formatCompactAmount(retirementTargetValue, currency)
      : null;
  const retirementIndex = data.findIndex((point) => point.age === retirementAge);
  const calloutElbowLabel =
    retirementIndex >= 0
      ? data[Math.min(retirementIndex + 1, data.length - 1)]?.label
      : retirementLabel;
  const calloutEndLabel =
    retirementIndex >= 0
      ? data[Math.min(retirementIndex + 2, data.length - 1)]?.label
      : retirementLabel;
  const canDrawCallouts =
    Boolean(calloutElbowLabel) &&
    Boolean(calloutEndLabel) &&
    calloutElbowLabel !== retirementLabel &&
    calloutEndLabel !== calloutElbowLabel;
  const axisTicks = useMemo(() => {
    const interval = Math.max(1, Math.floor(data.length / 6));
    const ticks = new Set<string>();
    data.forEach((point, index) => {
      if (index % interval === 0) ticks.add(point.label);
    });
    ticks.add(retirementLabel);
    ticks.add(data[data.length - 1]?.label);
    return data.map((point) => point.label).filter((label) => ticks.has(label));
  }, [data, retirementLabel]);

  if (data.length < 2) return null;

  const chartMaxValue = Math.max(
    ...data.map((point) => Math.max(point.portfolio, point.target ?? 0)),
  );
  const calloutValuesAreClose =
    retirementPoint &&
    retirementTargetValue != null &&
    chartMaxValue > 0 &&
    Math.abs(retirementTargetValue - retirementPoint.portfolio) / chartMaxValue < 0.08;
  const highCalloutLift = chartMaxValue * 0.19;
  const lowCalloutLift = chartMaxValue * (calloutValuesAreClose ? 0.055 : 0.11);
  const targetCalloutValue =
    retirementTargetValue != null
      ? retirementTargetValue +
        (calloutValuesAreClose && retirementPoint
          ? retirementTargetValue >= retirementPoint.portfolio
            ? highCalloutLift
            : lowCalloutLift
          : lowCalloutLift)
      : null;
  const portfolioCalloutValue =
    retirementPoint != null
      ? retirementPoint.portfolio +
        (calloutValuesAreClose
          ? retirementPoint.portfolio > (retirementTargetValue ?? 0)
            ? highCalloutLift
            : lowCalloutLift
          : lowCalloutLift)
      : null;
  // Offset labels vertically when ages are close to avoid overlap
  const agesClose = showProjectedFiLine && Math.abs((projectedFireAge ?? 0) - retirementAge) <= 3;

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart data={data} margin={{ top: 24, right: 12, left: -12, bottom: 38 }}>
          <defs>
            <linearGradient id="retirementPortfolio" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={projectedPalette.fill} stopOpacity={0.3} />
              <stop offset="60%" stopColor={projectedPalette.fill} stopOpacity={0.15} />
              <stop offset="100%" stopColor={projectedPalette.fill} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={(props) => (
              <RetirementAxisTick
                {...props}
                retirementLabel={retirementLabel}
                eventLabel={eventLabel}
              />
            )}
            tickFormatter={(label: string) => label.replace(/^Age\s+/, "")}
            ticks={axisTicks}
            interval={0}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: CHART_COLORS.muted }}
            tickFormatter={(v: number) => formatCompactAmount(v, currency)}
            width={48}
            axisLine={false}
            tickLine={false}
            domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.22)]}
          />
          <RTooltip
            content={
              <RetirementChartTooltip
                currency={currency}
                valueMode={valueMode}
                projectedStroke={projectedPalette.stroke}
              />
            }
          />

          {/* Projected FI age vertical line — render FIRST so retirement line draws on top */}
          {showProjectedFiLine && (
            <ReferenceLine
              x={projectedFiLabel}
              stroke="var(--success)"
              strokeWidth={1}
              strokeDasharray="4 3"
              strokeOpacity={0.8}
              label={{
                value: t("goals:portfolio_chart.fi_reference", { age: projectedFireAge }),
                position: "top",
                fontSize: 10,
                fill: "var(--success)",
                dy: agesClose ? -12 : 0,
              }}
            />
          )}

          {/* Retirement age vertical line */}
          <ReferenceLine
            x={retirementLabel}
            stroke={CHART_COLORS.reference}
            strokeWidth={1}
            strokeDasharray="4 3"
            strokeOpacity={0.5}
          />

          {/* Target — dashed line (no fill, just stroke) */}
          <Area
            type="linear"
            dataKey="target"
            name={t("goals:portfolio_chart.series_required")}
            stroke={CHART_COLORS.reference}
            strokeWidth={1.5}
            strokeDasharray="6 4"
            fill="none"
            activeDot={false}
            animationDuration={300}
          />

          {/* Portfolio — filled golden area */}
          <Area
            type="linear"
            dataKey="portfolio"
            name={t("goals:portfolio_chart.series_projected")}
            stroke={projectedPalette.stroke}
            strokeWidth={1.5}
            fill="url(#retirementPortfolio)"
            fillOpacity={1}
            animationDuration={300}
            animationEasing="ease-out"
          />

          {canDrawCallouts &&
            retirementPoint &&
            retirementTargetValue != null &&
            targetCalloutValue != null &&
            retirementTargetValueLabel && (
              <>
                <ReferenceLine
                  segment={[
                    { x: retirementLabel, y: retirementTargetValue },
                    { x: calloutElbowLabel, y: targetCalloutValue },
                  ]}
                  stroke={CHART_COLORS.reference}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                />
                <ReferenceLine
                  segment={[
                    { x: calloutElbowLabel, y: targetCalloutValue },
                    { x: calloutEndLabel, y: targetCalloutValue },
                  ]}
                  stroke={CHART_COLORS.reference}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  label={(props) => (
                    <ChartCalloutLabel
                      {...props}
                      amount={retirementTargetValueLabel}
                      fill={CHART_COLORS.muted}
                    />
                  )}
                />
              </>
            )}
          {canDrawCallouts &&
            retirementPoint &&
            portfolioCalloutValue != null &&
            retirementPortfolioValueLabel && (
              <>
                <ReferenceLine
                  segment={[
                    { x: retirementLabel, y: retirementPoint.portfolio },
                    { x: calloutElbowLabel, y: portfolioCalloutValue },
                  ]}
                  stroke={projectedPalette.stroke}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                />
                <ReferenceLine
                  segment={[
                    { x: calloutElbowLabel, y: portfolioCalloutValue },
                    { x: calloutEndLabel, y: portfolioCalloutValue },
                  ]}
                  stroke={projectedPalette.stroke}
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  label={(props) => (
                    <ChartCalloutLabel
                      {...props}
                      amount={retirementPortfolioValueLabel}
                      fill={CHART_COLORS.foreground}
                    />
                  )}
                />
              </>
            )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
