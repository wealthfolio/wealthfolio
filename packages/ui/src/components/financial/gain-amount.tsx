import * as React from "react";
import { useBalancePrivacy } from "../../hooks/use-balance-privacy";
import { cn } from "../../lib/utils";

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
  /** Swap success/destructive coloring — useful for spending where "up" is bad. */
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
  const validCurrency = isValidCurrencyCode(currency);
  const useCurrencyStyle = displayCurrency && validCurrency;
  const fractionDigits = displayDecimal ? 2 : 0;
  const displayValue = normalizeDisplayAmount(value, fractionDigits);

  // Dynamic import for NumberFlow to avoid SSR issues
  const [NumberFlow, setNumberFlow] = React.useState<React.ComponentType<any> | null>(null);

  React.useEffect(() => {
    import("@number-flow/react").then((module) => {
      setNumberFlow(module.default);
    });
  }, []);

  const formatOptions: Intl.NumberFormatOptions = {
    ...(useCurrencyStyle ? { currency, currencyDisplay: "narrowSymbol" as const } : {}),
    style: useCurrencyStyle ? "currency" : "decimal",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };

  return (
    <div className={cn("flex flex-col items-end text-right text-sm", className)} {...props}>
      <div
        className={cn(
          "flex items-center",
          displayValue > 0
            ? invertColor
              ? "text-destructive"
              : "text-success"
            : displayValue < 0
              ? invertColor
                ? "text-success"
                : "text-destructive"
              : "text-foreground",
        )}
      >
        {isBalanceHidden ? (
          <span>••••</span>
        ) : NumberFlow ? (
          <>
            {showSign && (displayValue > 0 ? "+" : displayValue < 0 ? "-" : null)}
            <NumberFlow
              value={Math.abs(displayValue)}
              isolate={true}
              format={formatOptions}
              locales={typeof navigator !== "undefined" ? navigator.language : "en-US"}
            />
          </>
        ) : (
          // Fallback when NumberFlow is not loaded
          <span>
            {showSign && (displayValue > 0 ? "+" : displayValue < 0 ? "-" : null)}
            {(() => {
              try {
                return new Intl.NumberFormat(
                  typeof navigator !== "undefined" ? navigator.language : "en-US",
                  formatOptions,
                ).format(Math.abs(displayValue));
              } catch {
                return Math.abs(displayValue).toFixed(fractionDigits);
              }
            })()}
          </span>
        )}
      </div>
    </div>
  );
}
