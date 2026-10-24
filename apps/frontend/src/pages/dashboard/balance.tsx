import { useTranslation } from "react-i18next";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import NumberFlow from "@number-flow/react";
import { useAmountFormatting } from "@wealthfolio/ui";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
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
  const amountFormatting = useAmountFormatting();
  const { t } = useTranslation();
  const locale = amountFormatting.currencyLocale(currency);

  const { isBalanceHidden } = useBalancePrivacy();
  const validCurrency = isValidCurrencyCode(currency);
  const fractionDigits = displayDecimal ? amountFormatting.currencyFractionDigits(currency) : 0;
  const displayValue =
    !compact && Math.abs(targetValue) < 0.5 * 10 ** -fractionDigits ? 0 : targetValue;

  const currencySymbol = useMemo(() => {
    if (!validCurrency) return currency;
    return amountFormatting.formatCurrencySymbol(currency);
  }, [currency, amountFormatting, validCurrency]);

  const formattedValue = useMemo(() => {
    const useCurrencyStyle = displayCurrency && validCurrency;
    if (compact && useCurrencyStyle)
      return amountFormatting.formatCompactAmount(displayValue, currency);
    return new Intl.NumberFormat(locale, {
      ...(useCurrencyStyle ? { currency, currencyDisplay: "narrowSymbol" as const } : {}),
      style: useCurrencyStyle ? "currency" : "decimal",
      notation: compact ? "compact" : "standard",
      minimumFractionDigits: compact ? 0 : fractionDigits,
      maximumFractionDigits: compact ? 1 : fractionDigits,
    }).format(displayValue);
  }, [
    currency,
    amountFormatting,
    locale,
    validCurrency,
    displayCurrency,
    fractionDigits,
    compact,
    displayValue,
  ]);

  if (isLoading) {
    return <Skeleton className="h-9 w-48" />;
  }

  if (isUnavailable) {
    return (
      <h1
        className="font-heading text-muted-foreground text-3xl font-bold tracking-tight"
        data-testid="portfolio-balance"
      >
        {t("performance:not_available")}
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
            value={displayValue}
            isolate={false}
            locales={locale}
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
              minimumFractionDigits: compact ? 0 : fractionDigits,
              maximumFractionDigits: compact ? 1 : fractionDigits,
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
