/**
 * KPI strip rendered above the spending-tab chart: income / spending / net.
 */
import { Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

export interface CashFlowStripProps {
  income: number;
  spending: number;
  currency: string;
  isLoading?: boolean;
}

export function CashFlowStrip({ income, spending, currency, isLoading }: CashFlowStripProps) {
  const net = income - spending;
  const netPositive = net >= 0;

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
      <KpiStat label="Income" value={income} sign="+" currency={currency} tone="success" />
      <KpiStat label="Spending" value={spending} currency={currency} tone="muted" />
      <KpiStat
        label="Net"
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
}: {
  label: string;
  value: number;
  sign?: "+" | "−";
  currency: string;
  tone: "success" | "destructive" | "muted";
}) {
  const { isBalanceHidden } = useBalancePrivacy();
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-[11px] font-light tracking-wide">{label}</span>
      <span className={cn("text-sm font-medium tabular-nums", toneClass)}>
        {sign}
        {isBalanceHidden ? "••••" : formatCompactAmount(value, currency)}
      </span>
    </div>
  );
}
