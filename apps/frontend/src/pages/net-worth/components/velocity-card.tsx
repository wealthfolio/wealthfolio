import { DashboardCard } from "@/components/dashboard-card";
import { useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { CompactAmount } from "./compact-amount";
import { CARD_LABEL, toneClass, toneFill, type Velocity } from "./utils";

function signOf(value: number): string {
  return Math.abs(value) < 0.005 ? "" : value > 0 ? "+" : "-";
}

function DriverRow({
  label,
  perMonth,
  width,
  currency,
}: {
  label: string;
  perMonth: number;
  /** Bar length relative to the largest driver, 0–100. */
  width: number;
  currency: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground/80 text-xs">{label}</span>
        <span className="text-sm font-medium tabular-nums">
          {signOf(perMonth)}
          <CompactAmount value={Math.abs(perMonth)} currency={currency} displayCurrency={false} />
        </span>
      </div>
      <div className="bg-muted/50 h-1 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, backgroundColor: toneFill(perMonth) }}
        />
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
  const { formatCalendarDate } = useDateFormatting();
  const { formatDecimal, formatPercent } = useNumberFormatting();
  const {
    perMonth,
    netChange,
    months,
    startDate,
    portfolioGains,
    otherAssetChanges,
    contributions,
    equityBuilt,
  } = velocity;
  const ratio =
    trailingYearMonthly && Math.abs(trailingYearMonthly) > 0.005
      ? perMonth / trailingYearMonthly
      : 0;
  // Opposite-signed paces have no meaningful multiple.
  const multiple = ratio > 0 ? ratio : null;

  // Only drivers that moved, largest first; labels follow the direction.
  const drivers = [
    {
      key: "portfolio",
      value: portfolioGains,
      label:
        portfolioGains < 0
          ? t("insights:networth.velocity.investment_losses")
          : t("insights:networth.velocity.investment_gains"),
    },
    {
      key: "other",
      value: otherAssetChanges,
      label: t("insights:networth.velocity.other_assets"),
    },
    {
      key: "contributions",
      value: contributions,
      label:
        contributions < 0
          ? t("insights:networth.velocity.withdrawals")
          : t("insights:networth.velocity.contributions"),
    },
    {
      key: "debt",
      value: equityBuilt,
      label:
        equityBuilt < 0
          ? t("insights:networth.velocity.debt_added")
          : t("insights:networth.velocity.debt_paid_down"),
    },
  ]
    .filter((driver) => Math.abs(driver.value) >= 0.005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const largest = Math.abs(drivers[0]?.value ?? 0);

  return (
    <DashboardCard title={t("insights:networth.velocity.monthly_pace")} meta={periodLabel}>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold tabular-nums ${toneClass(perMonth)}`}>
          {signOf(perMonth)}
          <CompactAmount value={Math.abs(perMonth)} currency={currency} />
        </span>
        <span className="text-muted-foreground text-sm">
          {t("insights:networth.velocity.per_month")}
        </span>
      </div>
      <p className="text-muted-foreground mt-1 text-xs tabular-nums">
        {signOf(netChange)}
        <CompactAmount value={Math.abs(netChange)} currency={currency} />{" "}
        {t("insights:networth.velocity.since", {
          date: formatCalendarDate(startDate, { dateStyle: "medium" }),
        })}
        {multiple != null &&
          t("insights:networth.velocity.trailing_pace", {
            multiple: formatDecimal(multiple, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }),
          })}
      </p>

      {drivers.length > 0 && (
        <>
          <p className={`${CARD_LABEL} mb-3 mt-5`}>
            {t("insights:networth.velocity.drivers_of_change")}
          </p>
          {drivers.length === 1 ? (
            // A sole driver is the whole change; repeating the headline adds nothing.
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-foreground/80 text-xs">{drivers[0].label}</span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatPercent(1, { digits: 0 })}
              </span>
            </div>
          ) : (
            <div className="space-y-3.5">
              {drivers.map((driver) => (
                <DriverRow
                  key={driver.key}
                  label={driver.label}
                  perMonth={months > 0 ? driver.value / months : driver.value}
                  width={(Math.abs(driver.value) / largest) * 100}
                  currency={currency}
                />
              ))}
            </div>
          )}
        </>
      )}
    </DashboardCard>
  );
}
