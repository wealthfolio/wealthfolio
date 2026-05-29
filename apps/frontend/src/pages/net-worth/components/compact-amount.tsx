import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { formatCompactAmount } from "@wealthfolio/ui";

interface CompactAmountProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  currency: string;
  displayCurrency?: boolean;
}

/** Privacy-aware compact currency amount (e.g. $17K, $1.5M). */
export function CompactAmount({
  value,
  currency,
  displayCurrency = true,
  className,
  ...props
}: CompactAmountProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  return (
    <span className={className} {...props}>
      {isBalanceHidden ? "••••" : formatCompactAmount(value, currency, displayCurrency)}
    </span>
  );
}
