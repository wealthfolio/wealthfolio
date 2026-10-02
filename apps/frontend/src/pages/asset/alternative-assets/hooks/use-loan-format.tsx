import { useTranslation } from "react-i18next";
import {
  AmountDisplay,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";

/** Shared formatting for the loan overview and history; amounts follow balance privacy. */
export function useLoanFormat(currency: string) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const numbers = useNumberFormatting();
  const dates = useDateFormatting();
  const { formatAmount } = useAmountFormatting();
  return {
    t,
    isBalanceHidden,
    numbers,
    money: (amount: number | null | undefined) =>
      amount == null ? (
        <span className="text-muted-foreground">{t("asset:loanOverview.unavailable")}</span>
      ) : (
        <AmountDisplay value={amount} currency={currency} isHidden={isBalanceHidden} />
      ),
    moneyText: (amount: number) => (isBalanceHidden ? "••••" : formatAmount(amount, currency)),
    date: (value: string) =>
      dates.formatCalendarDate(value, { day: "numeric", month: "short", year: "numeric" }),
    shortDate: (value: string) =>
      dates.formatCalendarDate(value, { day: "numeric", month: "short" }),
    month: (value: string) => dates.formatCalendarDate(value, { month: "short", year: "numeric" }),
    rate: (value: number) => `${numbers.formatDecimal(value, { maximumFractionDigits: 2 })}%`,
    duration: (months: number) =>
      [
        months >= 12
          ? t("asset:loanActions.duration_year", { count: Math.floor(months / 12) })
          : null,
        months % 12 || months === 0
          ? t("asset:loanActions.duration_month", { count: months % 12 })
          : null,
      ]
        .filter(Boolean)
        .join(" "),
  };
}
