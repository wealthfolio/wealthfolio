import * as React from "react";
import type { Format } from "@number-flow/react";
import { useBalancePrivacy } from "../../hooks/use-balance-privacy";
import { getQuoteUnitCurrency } from "../../lib/currencies";
import { cn } from "../../lib/utils";
import { useAmountFormatting } from "../formatting-provider";

const isValidCurrencyCode = (code: string) => /^[A-Za-z]{3}$/.test(code);

function normalizeDisplayAmount(value: number, fractionDigits: number) {
  const threshold = 0.5 * 10 ** -fractionDigits;
  return Math.abs(value) < threshold ? 0 : value;
}

interface GainAmountProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  displayCurrency?: boolean;
  currency: string;
  displayDecimal?: boolean;
  showSign?: boolean;
  /** Swap gain/loss coloring — useful for spending where "up" is bad. */
  invertColor?: boolean;
}

export function GainAmount({
  value,
  currency,
  displayCurrency = true,
  className,
  displayDecimal = true,
  showSign = true,
  invertColor = false,
  ...props
}: GainAmountProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const amountFormatting = useAmountFormatting();
  const locale = amountFormatting.currencyLocale(currency);
  const quoteUnit = getQuoteUnitCurrency(currency);
  const validCurrency = !quoteUnit && isValidCurrencyCode(currency);
  const useCurrencyStyle = displayCurrency && validCurrency;
  // Match formatAmount: quote units keep two decimals, currencies use their minor units.
  const fractionDigits = !displayDecimal ? 0 : quoteUnit ? 2 : amountFormatting.currencyFractionDigits(currency);
  const displayValue = normalizeDisplayAmount(value, fractionDigits);

  // Dynamic import for NumberFlow to avoid SSR issues
  const [NumberFlow, setNumberFlow] = React.useState<typeof import("@number-flow/react").default | null>(null);

  React.useEffect(() => {
    import("@number-flow/react").then((module) => {
      setNumberFlow(module.default);
    });
  }, []);

  const formatOptions: Format = {
    ...(useCurrencyStyle ? { currency, currencyDisplay: "narrowSymbol" as const } : {}),
    style: useCurrencyStyle ? "currency" : "decimal",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay: showSign ? "exceptZero" : "never",
  };
  const suffix = displayCurrency && quoteUnit ? quoteUnit.symbol : "";

  return (
    <div className={cn("flex flex-col items-end text-end text-sm", className)} {...props}>
      <div
        className={cn(
          "flex items-center",
          displayValue > 0
            ? invertColor
              ? "text-loss"
              : "text-gain"
            : displayValue < 0
              ? invertColor
                ? "text-gain"
                : "text-loss"
              : "text-foreground",
        )}
      >
        {isBalanceHidden ? (
          <span>••••</span>
        ) : NumberFlow ? (
          <>
            <NumberFlow value={displayValue} isolate={true} format={formatOptions} locales={locale} />
            {suffix}
          </>
        ) : (
          // Fallback when NumberFlow is not loaded
          <span>
            {new Intl.NumberFormat(locale, formatOptions).format(displayValue)}
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
