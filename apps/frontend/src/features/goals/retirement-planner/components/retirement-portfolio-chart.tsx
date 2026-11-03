import type { GoalHealth, GoalType } from "@/lib/types";
import { useDateFormatting } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GoalMilestone } from "../lib/goal-milestones";
import type { ChartValueMode } from "./value-mode-toggle";
import { usePrivateAmountFormatting } from "../hooks/use-private-amount-formatting";

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

const MILESTONE_RADIUS = 11;
// Keeps markers clear of the age labels under the axis.
const MILESTONE_LIFT = 15;
const MILESTONE_STACK = 26;

// Same icons as the Create Goal templates.
const MILESTONE_ICONS: Record<GoalType, typeof Icons.Home> = {
  retirement: Icons.Target,
  education: Icons.Briefcase,
  home: Icons.Home,
  car: Icons.Car,
  wedding: Icons.Star,
  custom_save_up: Icons.Wallet,
};

function milestoneColor(status: GoalHealth): string {
  switch (status) {
    case "on_track":
      return "var(--success)";
    case "at_risk":
      return "var(--warning)";
    case "off_track":
      return "var(--destructive)";
    default:
      return CHART_COLORS.muted;
  }
}

function milestoneStatusLabel(status: GoalHealth, t: TFunction): string | null {
  switch (status) {
    case "on_track":
      return t("goals:dashboard.badge.on_track");
    case "at_risk":
      return t("goals:card.at_risk");
    case "off_track":
      return t("goals:card.off_track");
    default:
      return null;
  }
}

interface ActiveMilestone {
  milestone: GoalMilestone;
  x: number;
  y: number;
}

function GoalMilestoneMarker({
  cx,
  cy,
  milestone,
  label,
  isActive,
  onShow,
  onHide,
  onOpen,
}: {
  cx: number;
  cy: number;
  milestone: GoalMilestone;
  label: string;
  isActive: boolean;
  onShow: (active: ActiveMilestone) => void;
  onHide: () => void;
  onOpen?: (goalId: string) => void;
}) {
  const color = milestoneColor(milestone.statusHealth);
  const Icon = MILESTONE_ICONS[milestone.goalType] ?? Icons.Target;
  const show = () => onShow({ milestone, x: cx, y: cy });
  return (
    <g
      role={onOpen ? "link" : "img"}
      tabIndex={0}
      aria-label={label}
      className={onOpen ? "cursor-pointer outline-none" : "outline-none"}
      onMouseEnter={show}
      onMouseLeave={onHide}
      onFocus={show}
      onBlur={onHide}
      onClick={() => onOpen?.(milestone.id)}
      onKeyDown={(event) => {
        if (onOpen && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen(milestone.id);
        }
      }}
    >
      {isActive && (
        <circle
          cx={cx}
          cy={cy}
          r={MILESTONE_RADIUS + 3}
          fill="none"
          stroke={color}
          strokeOpacity={0.35}
        />
      )}
      {/* Dashed: savings goals keep this money apart from the projection. */}
      <circle
        cx={cx}
        cy={cy}
        r={MILESTONE_RADIUS}
        fill="var(--background)"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="3 2"
      />
      <g transform={`translate(${cx - 6} ${cy - 6})`}>
        <Icon size={12} color={color} />
      </g>
    </g>
  );
}

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
          <tspan x={0} dy={16} fontSize="0.75rem" fontWeight={500}>
            {value}
          </tspan>
          <tspan x={0} dy={18} fontSize="0.75rem" fontWeight={700}>
            {eventLabel}
          </tspan>
        </text>
      </g>
    );
  }

  return (
    <g transform={`translate(${tickX},${tickY})`}>
      <text textAnchor="middle" fill={CHART_COLORS.muted} fontSize="0.6875rem">
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
      <tspan x={labelX} dy={0} fontSize="0.75rem" fontWeight={700}>
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
  // oxlint-disable-next-line typescript/no-explicit-any
  payload?: any[];
  currency: string;
  valueMode: ChartValueMode;
  projectedStroke: string;
}) {
  const formatting = usePrivateAmountFormatting();
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
          {formatting.formatCompactAmount(point.portfolioStart, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between space-x-4">
        <span className="text-muted-foreground text-xs">
          {t("goals:portfolio_chart.end_portfolio")}
        </span>
        <span className="text-xs font-semibold tabular-nums">
          {formatting.formatCompactAmount(point.portfolioEnd, currency)}
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
            {formatting.formatCompactAmount(point.target, currency)}
          </span>
        </div>
      )}
      {point.annualContribution > 0 && (
        <div className="flex items-center justify-between space-x-4">
          <span className="text-muted-foreground text-xs">
            {t("goals:portfolio_chart.contribution_yr")}
          </span>
          <span className="text-xs font-semibold tabular-nums">
            {formatting.formatCompactAmount(point.annualContribution, currency)}
          </span>
        </div>
      )}
      {point.annualIncome > 0 && (
        <div className="flex items-center justify-between space-x-4">
          <span className="text-muted-foreground text-xs">
            {t("goals:portfolio_chart.income_yr")}
          </span>
          <span className="text-xs font-semibold tabular-nums">
            {formatting.formatCompactAmount(point.annualIncome, currency)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between space-x-4">
        <span className="text-muted-foreground text-xs">
          {t("goals:coverage_chart.planned_spending_yr")}
        </span>
        <span className="text-xs font-semibold tabular-nums">
          {formatting.formatCompactAmount(point.annualExpenses, currency)}
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
            -{formatting.formatCompactAmount(point.withdrawal, currency)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between space-x-4 border-t pt-1">
        <span className="text-muted-foreground text-xs">
          {t("goals:portfolio_chart.net_portfolio_change")}
        </span>
        <span
          className={`text-xs font-semibold tabular-nums ${
            point.netChange >= 0 ? "text-gain" : "text-loss"
          }`}
        >
          {point.netChange >= 0 ? "+" : "-"}
          {formatting.formatCompactAmount(Math.abs(point.netChange), currency)}
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
  goalMilestones = [],
  onOpenGoal,
}: {
  data: ChartPoint[];
  currency: string;
  retirementAge: number;
  projectedFireAge?: number | null;
  valueMode: ChartValueMode;
  plannerMode: PlannerMode;
  projectedIsOnTrack: boolean;
  goalMilestones?: GoalMilestone[];
  onOpenGoal?: (goalId: string) => void;
}) {
  const formatting = usePrivateAmountFormatting();
  const dateFormatting = useDateFormatting();
  const { t } = useTranslation();
  const [activeMilestone, setActiveMilestone] = useState<ActiveMilestone | null>(null);
  const [chartWidth, setChartWidth] = useState(600);
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
      ? formatting.formatCompactAmount(retirementPoint.portfolio, currency)
      : null;
  const projectedPalette = projectedIsOnTrack
    ? PROJECTED_CHART_COLORS.onTrack
    : PROJECTED_CHART_COLORS.offTrack;
  const retirementTargetValue =
    retirementPoint && typeof retirementPoint.target === "number" ? retirementPoint.target : null;
  const retirementTargetValueLabel =
    retirementTargetValue != null && retirementTargetValue > 0
      ? formatting.formatCompactAmount(retirementTargetValue, currency)
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

  const placedMilestones = useMemo(() => {
    // Markers closer than their own width move up a row. The plot spans the chart
    // minus the Y axis (the side margins cancel out).
    const yearWidth = Math.max(1, chartWidth - 48) / Math.max(1, data.length - 1);
    const minGapYears = (2 * MILESTONE_RADIUS + 4) / yearWidth;
    const rowLastAge: number[] = [];
    return goalMilestones.flatMap((milestone) => {
      const point = data.find((p) => p.age === milestone.age);
      if (!point) return [];
      let stack = rowLastAge.findIndex((age) => milestone.age - age >= minGapYears);
      if (stack === -1) stack = rowLastAge.length;
      rowLastAge[stack] = milestone.age;
      const date = dateFormatting.formatCalendarDate(milestone.targetDate.slice(0, 10), {
        month: "short",
        year: "numeric",
      });
      const target =
        milestone.targetAmount != null
          ? t("goals:portfolio_chart.goal_milestone_target", {
              amount: formatting.formatCompactAmount(milestone.targetAmount, currency),
              date,
            })
          : date;
      const status = milestoneStatusLabel(milestone.statusHealth, t);
      const label = status
        ? t("goals:portfolio_chart.goal_milestone_aria", { name: milestone.title, target, status })
        : t("goals:portfolio_chart.goal_milestone_aria_no_status", {
            name: milestone.title,
            target,
          });
      return [{ milestone, point, stack, target, status, label }];
    });
  }, [chartWidth, currency, data, dateFormatting, formatting, goalMilestones, t]);
  const activePlaced = activeMilestone
    ? placedMilestones.find((placed) => placed.milestone.id === activeMilestone.milestone.id)
    : undefined;

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
      <ResponsiveContainer width="100%" height={320} onResize={(width) => setChartWidth(width)}>
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
            tick={{ fontSize: "0.6875rem", fill: CHART_COLORS.muted }}
            tickFormatter={(v: number) => formatting.formatCompactAmount(v, currency)}
            width={48}
            axisLine={false}
            tickLine={false}
            domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.22)]}
          />
          <RTooltip
            active={activeMilestone ? false : undefined}
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
                fontSize: "0.6875rem",
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
            // The hover dot can land on a goal marker; let the marker get the pointer.
            activeDot={{ pointerEvents: "none" }}
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

          {/* Savings goals at their target dates, drawn last so they sit on top */}
          {placedMilestones.map(({ milestone, point }) => (
            <ReferenceLine
              key={`${milestone.id}-guide`}
              segment={[
                { x: point.label, y: 0 },
                { x: point.label, y: point.portfolio },
              ]}
              stroke={milestoneColor(milestone.statusHealth)}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="2 3"
            />
          ))}
          {placedMilestones.map(({ milestone, point, stack, label }) => (
            <ReferenceDot
              key={milestone.id}
              x={point.label}
              y={0}
              ifOverflow="visible"
              shape={(props: { cx?: number; cy?: number }) => (
                <GoalMilestoneMarker
                  cx={props.cx ?? 0}
                  cy={(props.cy ?? 0) - MILESTONE_LIFT - stack * MILESTONE_STACK}
                  milestone={milestone}
                  label={label}
                  isActive={activeMilestone?.milestone.id === milestone.id}
                  onShow={setActiveMilestone}
                  onHide={() => setActiveMilestone(null)}
                  onOpen={onOpenGoal}
                />
              )}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {activeMilestone && activePlaced && (
        // SVG coordinates are physical, so this card is placed with physical left/top.
        <div
          className={`bg-popover pointer-events-none absolute z-10 w-max max-w-56 -translate-y-full rounded-md border p-2.5 text-xs shadow-md ${
            activeMilestone.x < 112 ? "-translate-x-3" : "-translate-x-1/2"
          }`}
          style={{ left: activeMilestone.x, top: activeMilestone.y - MILESTONE_RADIUS - 6 }}
        >
          <p className="font-medium">{activeMilestone.milestone.title}</p>
          <p className="text-muted-foreground tabular-nums">{activePlaced.target}</p>
          {activePlaced.status && (
            <p
              className="font-medium"
              style={{ color: milestoneColor(activeMilestone.milestone.statusHealth) }}
            >
              {activePlaced.status}
            </p>
          )}
          <p className="text-muted-foreground mt-1">
            {t("goals:portfolio_chart.goal_milestone_not_projected")}
          </p>
        </div>
      )}
    </div>
  );
}
