import type { ActivityDetails } from "@/lib/types";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { AmountDisplay } from "@wealthfolio/ui/components/financial/amount-display";

/** Both sides are final cash amounts, not a single-currency transaction total. */
export function FxExchangeAmount({
  activity,
  isHidden,
}: {
  activity: Pick<
    ActivityDetails,
    "amount" | "currency" | "destinationAmount" | "destinationCurrency"
  >;
  isHidden?: boolean;
}) {
  const { isBalanceHidden } = useBalancePrivacy();
  return (
    <span
      className="inline-flex flex-wrap items-center justify-end gap-1 tabular-nums"
      data-testid="fx-exchange-amount"
    >
      <AmountDisplay
        value={Number(activity.amount)}
        currency={activity.currency}
        isHidden={isHidden ?? isBalanceHidden}
      />
      <span aria-hidden="true">→</span>
      <AmountDisplay
        value={Number(activity.destinationAmount)}
        currency={activity.destinationCurrency ?? ""}
        isHidden={isHidden ?? isBalanceHidden}
      />
    </span>
  );
}
