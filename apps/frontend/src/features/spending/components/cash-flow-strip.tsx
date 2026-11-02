/**
 * KPI strip rendered above the spending-tab chart: income / spending / saving / net.
 */
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";
import { Skeleton, useAmountFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export interface CashFlowStripProps {
  income: number;
  spending: number;
  /** Money set aside into the Savings taxonomy (transfers to investing accounts). */
  saving?: number;
  /** Money brought back from those accounts. The Saving figure shows the net. */
  fromSavings?: number;
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
  fromSavings = 0,
  currency,
  isLoading,
  incomeHref,
  spendingHref,
  savingHref,
}: CashFlowStripProps) {
  const { t } = useTranslation();
  const net = income - spending - saving + fromSavings;
  const netPositive = net >= 0;
  // Net saving goes negative when more came back from savings than went in;
  // it shows with its sign rather than clamped, so the strip still adds up.
  const netSaving = saving - fromSavings;
  const showSaving = saving > 0 || fromSavings > 0;

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
          label={t("spending:cashFlow.netSaved")}
          value={Math.abs(netSaving)}
          sign={netSaving < 0 ? "−" : undefined}
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
  const formatting = useAmountFormatting();
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
      <span className="text-muted-foreground text-2xs font-light tracking-wide">{label}</span>
      <span className={cn("text-sm font-medium tabular-nums", toneClass)}>
        {sign}
        {isBalanceHidden ? "••••" : formatting.formatCompactAmount(value, currency)}
      </span>
    </>
  );

  if (href) {
    return (
      <Link
        to={href}
        className="hover:bg-foreground/5 focus-visible:ring-ring -m-1 flex flex-col rounded-md p-1 transition-colors focus-visible:ring-1 focus-visible:outline-none"
      >
        {content}
      </Link>
    );
  }

  return <div className="flex flex-col">{content}</div>;
}
