import * as React from "react";
import { useBalancePrivacy } from "../../hooks/use-balance-privacy";
import { cn, formatAmount } from "../../lib/utils";

interface GainAmountProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  displayCurrency?: boolean;
  currency: string;
  showSign?: boolean;
}

export function GainAmount({
  value,
  currency,
  displayCurrency = true,
  className,
  showSign = true,
  ...props
}: GainAmountProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const formattedValue = formatAmount(Math.abs(value), currency, displayCurrency);
  const sign = showSign && value > 0 ? "+" : showSign && value < 0 ? "-" : "";

  return (
    <div className={cn("flex flex-col items-end text-right text-sm", className)} {...props}>
      <div
        className={cn(
          "flex items-center",
          value > 0 ? "text-success" : value < 0 ? "text-destructive" : "text-foreground",
        )}
      >
        {isBalanceHidden ? (
          <span>••••</span>
        ) : (
          <span>
            {sign}{formattedValue}
          </span>
        )}
      </div>
    </div>
  );
}
