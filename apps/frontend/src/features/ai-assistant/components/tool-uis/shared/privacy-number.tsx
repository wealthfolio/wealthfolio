import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import { useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";

export interface PrivacyNumberProps {
  value: number;
  currency?: string;
  type?: "currency" | "percent";
  className?: string;
}

const HIDDEN_PLACEHOLDER = "\u2022\u2022\u2022\u2022\u2022";

export function PrivacyNumber({
  value,
  currency,
  type = "currency",
  className,
}: PrivacyNumberProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { settings } = useSettingsContext();
  const amountFormatting = useAmountFormatting();
  const numberFormatting = useNumberFormatting();

  const baseCurrency = settings?.baseCurrency ?? "USD";
  const effectiveCurrency = currency ?? baseCurrency;

  if (isBalanceHidden) {
    return <span className={cn(className)}>{HIDDEN_PLACEHOLDER}</span>;
  }

  const formatted =
    type === "percent"
      ? numberFormatting.formatPercent(value)
      : amountFormatting.formatAmount(value, effectiveCurrency);

  return <span className={cn(className)}>{formatted}</span>;
}
