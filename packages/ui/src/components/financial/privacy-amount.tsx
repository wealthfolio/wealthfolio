import { cn } from "../../lib/utils";
import { useBalancePrivacy } from "../../hooks/use-balance-privacy";
import { useAmountFormatting } from "../formatting-provider";

interface PrivacyAmountProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  currency: string;
}

export function PrivacyAmount({ value, currency, className, ...props }: PrivacyAmountProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { formatAmount } = useAmountFormatting();

  return (
    <span className={cn(className)} {...props}>
      {isBalanceHidden ? "••••" : formatAmount(value, currency)}
    </span>
  );
}
