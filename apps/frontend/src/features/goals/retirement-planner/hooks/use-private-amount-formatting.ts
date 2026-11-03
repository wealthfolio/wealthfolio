import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useAmountFormatting, type AmountFormatting } from "@wealthfolio/ui";
import { useMemo } from "react";

const HIDDEN_AMOUNT = "••••";
const hidden = () => HIDDEN_AMOUNT;

/** Amount formatting for the planner: every amount reads "••••" while balances are hidden. */
export function usePrivateAmountFormatting(): AmountFormatting {
  const formatting = useAmountFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  return useMemo(
    () =>
      isBalanceHidden
        ? {
            ...formatting,
            formatAmount: hidden,
            formatCompactAmount: hidden,
            formatPrice: hidden,
            formatRoundedAmount: hidden,
            formatDecimalAmount: hidden,
          }
        : formatting,
    [formatting, isBalanceHidden],
  );
}
