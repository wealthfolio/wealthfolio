import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { PrivacyAmount, Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

import type { MonthBucket } from "../../types/report";

interface CashflowAreaChartProps {
  months: MonthBucket[];
  currency: string;
  isLoading: boolean;
}

interface CashflowDatum {
  label: string;
  income: number;
  spending: number;
  net: number;
}

/** Income (positive area) vs Spending (positive area, separately stacked) with a Net line overlay.
 *  Recharts can stack signed areas natively, but we keep the two flows separate so the user can
 *  see both magnitudes; the Net line tells the saved-vs-overspent story directly.
 */
export function CashflowAreaChart({ months, currency, isLoading }: CashflowAreaChartProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const data: CashflowDatum[] = useMemo(
    () =>
      months.map((m) => {
        const income = m.report?.current.income ?? 0;
        const spending = m.report?.current.outflow ?? 0;
        return { label: m.label, income, spending, net: income - spending };
      }),
    [months],
  );

  if (isLoading && data.every((d) => d.income === 0 && d.spending === 0)) {
    return <Skeleton className="h-[260px] w-full rounded-lg" />;
  }

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="cashflow-income" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--success)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="cashflow-spending" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            strokeOpacity={0.4}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) =>
              isBalanceHidden ? "••" : formatCompactAmount(v, currency)
            }
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.2 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as CashflowDatum;
              return (
                <div className="bg-background min-w-[180px] rounded-md border px-3 py-2 text-xs shadow-sm">
                  <div className="text-foreground mb-1 font-semibold">{d.label}</div>
                  <Row
                    label={t("spending:cashFlow.income")}
                    value={d.income}
                    currency={currency}
                    tone="success"
                  />
                  <Row
                    label={t("spending:cashFlow.spending")}
                    value={d.spending}
                    currency={currency}
                    tone="destructive"
                  />
                  <div className="bg-border my-1.5 h-px" />
                  <Row
                    label={t("spending:cashFlow.net")}
                    value={d.net}
                    currency={currency}
                    tone={d.net >= 0 ? "success" : "destructive"}
                    bold
                  />
                </div>
              );
            }}
          />
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11 }}
          />
          <Area
            type="monotone"
            name={t("spending:cashFlow.income")}
            dataKey="income"
            stroke="var(--success)"
            strokeWidth={1.5}
            fill="url(#cashflow-income)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            name={t("spending:cashFlow.spending")}
            dataKey="spending"
            stroke="var(--destructive)"
            strokeWidth={1.5}
            fill="url(#cashflow-spending)"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            name={t("spending:cashFlow.net")}
            dataKey="net"
            stroke="var(--foreground)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Row({
  label,
  value,
  currency,
  tone,
  bold,
}: {
  label: string;
  value: number;
  currency: string;
  tone: "success" | "destructive" | "muted";
  bold?: boolean;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${toneClass} ${bold ? "font-semibold" : "font-medium"}`}>
        {value < 0 ? "−" : ""}
        <PrivacyAmount value={Math.abs(value)} currency={currency} />
      </span>
    </div>
  );
}
