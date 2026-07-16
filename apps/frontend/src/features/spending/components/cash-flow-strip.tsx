/**
 * KPI strip rendered above the spending-tab chart: income / spending / saving / net.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

export interface CashFlowStripProps {
  income: number;
  spending: number;
  /** Money set aside into the Savings taxonomy (transfers to investing accounts). */
  saving?: number;
  currency: string;
  isLoading?: boolean;
  incomeHref?: string;
  spendingHref?: string;
  savingHref?: string;
}

export function CashFlowStrip({
  income,
  spending,
  saving = 0,
  currency,
  isLoading,
  incomeHref,
  spendingHref,
  savingHref,
}: CashFlowStripProps) {
  const { t } = useTranslation();
  const net = income - spending - saving;
  const netPositive = net >= 0;
  const showSaving = saving > 0;

  if (isLoading) {
    return (
      <div className="flex items-end gap-6 sm:gap-8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-end gap-6 sm:gap-8">
      <KpiStat
        label={t("spending:cashFlow.income")}
        value={income}
        sign="+"
        currency={currency}
        tone="success"
        href={incomeHref}
      />
      <KpiStat
        label={t("spending:cashFlow.spending")}
        value={spending}
        currency={currency}
        tone="muted"
        href={spendingHref}
      />
      {showSaving && (
        <KpiStat
          label={t("spending:cashFlow.saving")}
          value={saving}
          currency={currency}
          tone="saving"
          href={savingHref}
        />
      )}
      <KpiStat
        label={t("spending:cashFlow.net")}
        value={Math.abs(net)}
        sign={netPositive ? "+" : "−"}
        currency={currency}
        tone={netPositive ? "success" : "destructive"}
      />
    </div>
  );
}

function KpiStat({
  label,
  value,
  sign,
  currency,
  tone,
  href,
}: {
  label: string;
  value: number;
  sign?: "+" | "−";
  currency: string;
  tone: "success" | "destructive" | "muted" | "saving";
  href?: string;
}) {
  const { isBalanceHidden } = useBalancePrivacy();
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "saving"
          ? "text-[#6B8E54]"
          : "text-foreground";
  const content = (
    <>
      <span className="text-muted-foreground text-[11px] font-light tracking-wide">{label}</span>
      <span className={cn("text-sm font-medium tabular-nums", toneClass)}>
        {sign}
        {isBalanceHidden ? "••••" : formatCompactAmount(value, currency)}
      </span>
    </>
  );

  if (href) {
    return (
      <Link
        to={href}
        className="hover:bg-foreground/5 focus-visible:ring-ring -m-1 flex flex-col rounded-md p-1 transition-colors focus-visible:outline-none focus-visible:ring-1"
      >
        {content}
      </Link>
    );
  }

  return <div className="flex flex-col">{content}</div>;
}
