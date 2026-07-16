import { DashboardCard } from "@/components/dashboard-card";
import { useTranslation } from "react-i18next";
import { CompactAmount } from "./compact-amount";
import { CARD_LABEL, toneClass, toneFill, type Velocity } from "./utils";

function DriverRow({
  label,
  value,
  months,
  total,
  currency,
}: {
  label: string;
  value: number;
  months: number;
  total: number;
  currency: string;
}) {
  const { t } = useTranslation();
  const perMonth = months > 0 ? value / months : value;
  const share = total > 0 ? (Math.abs(value) / total) * 100 : 0;
  const sign = Math.abs(value) < 0.005 ? "" : value > 0 ? "+" : "-";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground/70 text-xs">{label}</span>
        <span className={`text-sm font-semibold tabular-nums ${toneClass(value)}`}>
          {sign}
          <CompactAmount value={Math.abs(perMonth)} currency={currency} />
          <span className="text-muted-foreground/50 font-normal">
            {t("insights:networth.velocity.per_month")}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <div className="bg-muted/40 h-1 flex-1 overflow-hidden rounded-full">
          <div
            className="h-full rounded-full"
            style={{ width: `${share}%`, backgroundColor: toneFill(value) }}
          />
        </div>
        <span className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">
          {Math.round(share)}% · {sign}
          <CompactAmount value={Math.abs(value)} currency={currency} />
        </span>
      </div>
    </div>
  );
}

interface VelocityCardProps {
  velocity: Velocity;
  /** Average monthly net worth change over the trailing year, for the pace multiple. */
  trailingYearMonthly?: number;
  currency: string;
  periodLabel: string;
}

export function VelocityCard({
  velocity,
  trailingYearMonthly,
  currency,
  periodLabel,
}: VelocityCardProps) {
  const { t } = useTranslation();
  const { perMonth, netChange, months, marketGains, contributions, equityBuilt } = velocity;
  const total = Math.abs(marketGains) + Math.abs(contributions) + Math.abs(equityBuilt);
  const multiple =
    trailingYearMonthly && Math.abs(trailingYearMonthly) > 0.005
      ? perMonth / trailingYearMonthly
      : null;
  const perMonthSign = Math.abs(perMonth) < 0.005 ? "" : perMonth > 0 ? "+" : "-";
  const netSign = Math.abs(netChange) < 0.005 ? "" : netChange > 0 ? "+" : "-";
  const monthsRounded = Math.max(1, Math.round(months));

  return (
    <DashboardCard title={t("insights:networth.velocity.monthly_pace")} meta={periodLabel}>
      <div className="flex items-baseline gap-0.5">
        <span className={`text-lg font-bold tabular-nums ${toneClass(perMonth)}`}>
          {perMonthSign}
          <CompactAmount value={Math.abs(perMonth)} currency={currency} />
        </span>
        <span className="text-muted-foreground text-sm">
          {t("insights:networth.velocity.per_month")}
        </span>
      </div>
      <p className="text-muted-foreground/80 mt-1 text-xs tabular-nums">
        {netSign}
        <CompactAmount value={Math.abs(netChange)} currency={currency} />{" "}
        {t("insights:networth.velocity.over_months", { count: monthsRounded })}
        {multiple != null &&
          t("insights:networth.velocity.trailing_pace", { multiple: multiple.toFixed(1) })}
      </p>

      <p className={`${CARD_LABEL} mb-3 mt-5`}>
        {t("insights:networth.velocity.drivers_of_change", { period: periodLabel })}
      </p>
      <div className="space-y-3.5">
        <DriverRow
          label={t("insights:networth.velocity.market_returns")}
          value={marketGains}
          months={months}
          total={total}
          currency={currency}
        />
        <DriverRow
          label={t("insights:networth.velocity.contributions")}
          value={contributions}
          months={months}
          total={total}
          currency={currency}
        />
        <DriverRow
          label={t("insights:networth.velocity.equity_built")}
          value={equityBuilt}
          months={months}
          total={total}
          currency={currency}
        />
      </div>
    </DashboardCard>
  );
}
