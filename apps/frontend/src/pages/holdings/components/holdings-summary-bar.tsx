import { AmountDisplay } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

interface HoldingsSummaryBarProps {
  totalAssets: number;
  totalLiabilities: number;
  currency: string;
  className?: string;
}

/**
 * Summary bar showing Assets, Debts, and Net Worth.
 * - Assets: Sum of all non-liability holdings (displayed positive)
 * - Debts: Sum of all liability holdings (displayed positive)
 * - Net Worth: Assets - Debts
 */
export function HoldingsSummaryBar({
  totalAssets,
  totalLiabilities,
  currency,
  className,
}: HoldingsSummaryBarProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const netWorth = totalAssets - totalLiabilities;

  return (
    <div
      className={cn(
        "bg-muted/30 flex flex-wrap items-center justify-center gap-4 rounded-lg border p-3 sm:gap-8 md:justify-start",
        className,
      )}
    >
      <SummaryItem
        label={t("holdings:summary_assets")}
        value={totalAssets}
        currency={currency}
        isHidden={isBalanceHidden}
      />
      <div className="bg-border hidden h-8 w-px sm:block" />
      <SummaryItem
        label={t("holdings:summary_debts")}
        value={totalLiabilities}
        currency={currency}
        isHidden={isBalanceHidden}
        className="text-destructive"
      />
      <div className="bg-border hidden h-8 w-px sm:block" />
      <SummaryItem
        label={t("holdings:summary_net_worth")}
        value={netWorth}
        currency={currency}
        isHidden={isBalanceHidden}
        colorFormat={true}
        isBold={true}
      />
    </div>
  );
}

interface SummaryItemProps {
  label: string;
  value: number;
  currency: string;
  isHidden: boolean;
  className?: string;
  colorFormat?: boolean;
  isBold?: boolean;
}

function SummaryItem({
  label,
  value,
  currency,
  isHidden,
  className,
  colorFormat = false,
  isBold = false,
}: SummaryItemProps) {
  return (
    <div className="flex flex-col items-center sm:items-start">
      <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
        {label}
      </span>
      <AmountDisplay
        value={value}
        currency={currency}
        isHidden={isHidden}
        colorFormat={colorFormat}
        className={cn("text-base", isBold && "font-semibold", className)}
      />
    </div>
  );
}

export default HoldingsSummaryBar;
