import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import NumberFlow from "@number-flow/react";
import { useMemo } from "react";

const isValidCurrencyCode = (code: string) => /^[A-Za-z]{3}$/.test(code);

interface BalanceProps {
  targetValue: number;
  currency: string;
  displayCurrency?: boolean;
  displayDecimal?: boolean;
  /** Compact notation (e.g. $1.1M) — useful for large values on narrow screens. */
  compact?: boolean;
  isLoading?: boolean;
  isUnavailable?: boolean;
}

const Balance: React.FC<BalanceProps> = ({
  targetValue,
  currency = "USD",
  displayCurrency = false,
  displayDecimal = true,
  compact = false,
  isLoading = false,
  isUnavailable = false,
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const validCurrency = isValidCurrencyCode(currency);

  const currencySymbol = useMemo(() => {
    if (!validCurrency) return currency;
    try {
      const formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      const parts = formatter.formatToParts(0);
      return parts.find((part) => part.type === "currency")?.value ?? currency;
    } catch {
      return currency;
    }
  }, [currency, validCurrency]);

  const formattedValue = useMemo(() => {
    const useCurrencyStyle = displayCurrency && validCurrency;
    try {
      const formatter = new Intl.NumberFormat(undefined, {
        ...(useCurrencyStyle ? { currency, currencyDisplay: "narrowSymbol" } : {}),
        style: useCurrencyStyle ? "currency" : "decimal",
        notation: compact ? "compact" : "standard",
        minimumFractionDigits: compact ? 0 : displayDecimal ? 2 : 0,
        maximumFractionDigits: compact ? 1 : displayDecimal ? 2 : 0,
      });
      return formatter.format(targetValue);
    } catch {
      return targetValue.toFixed(displayDecimal ? 2 : 0);
    }
  }, [currency, validCurrency, displayCurrency, displayDecimal, compact, targetValue]);

  if (isLoading) {
    return <Skeleton className="h-9 w-48" />;
  }

  if (isUnavailable) {
    return (
      <h1
        className="font-heading text-muted-foreground text-3xl font-bold tracking-tight"
        data-testid="portfolio-balance"
      >
        N/A
      </h1>
    );
  }

  return (
    <h1 className="font-heading text-3xl font-bold tracking-tight" data-testid="portfolio-balance">
      {isBalanceHidden ? (
        <span className="text-4x">
          {displayCurrency ? currencySymbol : ""}
          •••••••
        </span>
      ) : (
        <>
          <NumberFlow
            className="muted-fraction"
            value={targetValue}
            isolate={false}
            style={{
              // @ts-expect-error https://number-flow.barvian.me/ - but it's not in TS object
              "--number-flow-mask-height": "0px",
              "--number-flow-mask-width": "0px",
            }}
            format={{
              ...(displayCurrency && validCurrency
                ? { currency, currencyDisplay: "narrowSymbol" as const }
                : {}),
              style: displayCurrency && validCurrency ? "currency" : "decimal",
              notation: compact ? ("compact" as const) : ("standard" as const),
              minimumFractionDigits: compact ? 0 : displayDecimal ? 2 : 0,
              maximumFractionDigits: compact ? 1 : displayDecimal ? 2 : 0,
            }}
          />
          <span className="sr-only" data-testid="portfolio-balance-value">
            {formattedValue}
          </span>
        </>
      )}
    </h1>
  );
};

export default Balance;
