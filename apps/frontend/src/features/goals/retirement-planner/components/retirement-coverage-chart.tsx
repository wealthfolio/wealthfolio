import { formatCompactAmount } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PROJECTED_CHART_COLORS } from "./retirement-portfolio-chart";
import type { ChartValueMode } from "./value-mode-toggle";

export const COVERAGE_COLORS = {
  income: "var(--fi-stream-1)",
  portfolio: PROJECTED_CHART_COLORS.offTrack.stroke,
  shortfall: "hsl(8, 67%, 48%)",
  planned: "#888",
};

export interface CoverageProjectionPoint {
  label: string;
  age: number;
  plannedSpending: number;
  retirementIncome: number;
  portfolioWithdrawal: number;
  shortfall: number;
  taxes: number;
}

function CoverageProjectionTooltip({
  active,
  payload,
  currency,
  valueMode,
}: {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  currency: string;
  valueMode: ChartValueMode;
}) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as CoverageProjectionPoint | undefined;
  if (!point) return null;
  const valueLabel =
    valueMode === "real" ? t("goals:value_mode.todays_money") : t("goals:value_mode.nominal_money");
  const funded = point.retirementIncome + point.portfolioWithdrawal;
  const coveragePct =
    point.plannedSpending > 0 ? Math.min(100, (funded / point.plannedSpending) * 100) : 0;

  return (
    <div className="bg-popover grid grid-cols-1 gap-1.5 rounded-md border p-2.5 shadow-md">
      <p className="text-muted-foreground text-xs font-medium">
        {t("goals:coverage_chart.age_value", { age: point.age, valueLabel })}
      </p>
      <div className="flex items-center justify-between gap-5">
        <div className="flex items-center gap-1.5">
          <span className="block h-0 w-3 border-b border-dashed border-[#888]" />
          <span className="text-muted-foreground text-xs">
            {t("goals:coverage_chart.planned_spending_yr")}
          </span>
        </div>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.plannedSpending, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-5">
        <div className="flex items-center gap-1.5">
          <span
            className="block h-2 w-2 rounded-sm"
            style={{ backgroundColor: COVERAGE_COLORS.income }}
          />
          <span className="text-muted-foreground text-xs">
            {t("goals:coverage_chart.retirement_income_used_yr")}
          </span>
        </div>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.retirementIncome, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-5">
        <div className="flex items-center gap-1.5">
          <span
            className="block h-2 w-2 rounded-sm"
            style={{ backgroundColor: COVERAGE_COLORS.portfolio }}
          />
          <span className="text-muted-foreground text-xs">
            {t("goals:coverage_chart.portfolio_withdrawal_used_yr")}
          </span>
        </div>
        <span className="text-xs font-semibold tabular-nums">
          {formatCompactAmount(point.portfolioWithdrawal, currency)}
        </span>
      </div>
      {point.shortfall > 0 && (
        <div className="flex items-center justify-between gap-5">
          <div className="flex items-center gap-1.5">
            <span
              className="block h-2 w-2 rounded-sm"
              style={{ backgroundColor: COVERAGE_COLORS.shortfall }}
            />
            <span className="text-muted-foreground text-xs">
              {t("goals:coverage_chart.unfunded_spending_yr")}
            </span>
          </div>
          <span className="text-xs font-semibold tabular-nums text-red-500">
            {formatCompactAmount(point.shortfall, currency)}
          </span>
        </div>
      )}
      {point.taxes > 0 && (
        <div className="flex items-center justify-between gap-5">
          <span className="text-muted-foreground text-xs">
            {t("goals:coverage_chart.withdrawal_taxes_yr")}
          </span>
          <span className="text-xs font-semibold tabular-nums">
            +{formatCompactAmount(point.taxes, currency)}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between gap-5 border-t pt-1">
        <span className="text-muted-foreground text-xs">
          {t("goals:coverage_chart.spending_covered")}
        </span>
        <span
          className={`text-xs font-semibold tabular-nums ${
            coveragePct >= 100
              ? "text-green-600"
              : coveragePct >= 75
                ? "text-amber-600"
                : "text-red-500"
          }`}
        >
          {coveragePct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

export function RetirementCoverageChart({
  data,
  ticks,
  currency,
  valueMode,
  fireAgeForBudget,
  referenceLabelPrefix,
}: {
  data: CoverageProjectionPoint[];
  ticks: number[];
  currency: string;
  valueMode: ChartValueMode;
  fireAgeForBudget: number;
  referenceLabelPrefix: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 16, right: 28, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="coverageIncome" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COVERAGE_COLORS.income} stopOpacity={0.38} />
            <stop offset="100%" stopColor={COVERAGE_COLORS.income} stopOpacity={0.08} />
          </linearGradient>
          <linearGradient id="coveragePortfolio" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COVERAGE_COLORS.portfolio} stopOpacity={0.32} />
            <stop offset="100%" stopColor={COVERAGE_COLORS.portfolio} stopOpacity={0.08} />
          </linearGradient>
          <linearGradient id="coverageShortfall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COVERAGE_COLORS.shortfall} stopOpacity={0.5} />
            <stop offset="100%" stopColor={COVERAGE_COLORS.shortfall} stopOpacity={0.18} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="age"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={ticks}
          tick={{ fontSize: 11 }}
          tickFormatter={(age: number) => String(Math.round(age))}
          axisLine={false}
          tickLine={false}
          allowDataOverflow={false}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          tickFormatter={(v: number) => formatCompactAmount(v, currency)}
          width={60}
          axisLine={false}
          tickLine={false}
          domain={[0, "auto"]}
        />
        <RTooltip
          content={<CoverageProjectionTooltip currency={currency} valueMode={valueMode} />}
        />
        <ReferenceLine
          x={fireAgeForBudget}
          stroke="#888"
          strokeWidth={1}
          strokeDasharray="4 3"
          strokeOpacity={0.5}
          label={{
            value: `${referenceLabelPrefix} · ${fireAgeForBudget}`,
            position: "top",
            fontSize: 10,
            fontWeight: 600,
            fill: "#888",
          }}
        />
        <Area
          type="linear"
          dataKey="retirementIncome"
          stackId="coverage"
          stroke={COVERAGE_COLORS.income}
          strokeWidth={0}
          fill="url(#coverageIncome)"
          animationDuration={300}
        />
        <Area
          type="linear"
          dataKey="portfolioWithdrawal"
          stackId="coverage"
          stroke={COVERAGE_COLORS.portfolio}
          strokeWidth={0}
          fill="url(#coveragePortfolio)"
          animationDuration={300}
        />
        <Area
          type="linear"
          dataKey="shortfall"
          stackId="coverage"
          stroke={COVERAGE_COLORS.shortfall}
          strokeWidth={1.2}
          strokeOpacity={0.8}
          fill="url(#coverageShortfall)"
          animationDuration={300}
        />
        <Line
          type="linear"
          dataKey="plannedSpending"
          stroke={COVERAGE_COLORS.planned}
          strokeWidth={1.5}
          strokeDasharray="6 4"
          dot={false}
          activeDot={false}
          animationDuration={300}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
