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

  // The hidden balance keeps the symbol and its place from the visible format, so "$"
  // stays "$" (not "US$") and "€" stays after the number where the locale puts it there.
  const hiddenValue = useMemo(() => {
    const dots = "•••••••";
    if (!displayCurrency || !validCurrency) return dots;
    let placed = false;
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .map((part) => {
        if (part.type === "currency" || part.type === "literal") return part.value;
        if (placed) return "";
        placed = true;
        return dots;
      })
      .join("");
  }, [currency, locale, validCurrency, displayCurrency]);

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
    // The height of one display line (line height 1.1).
    return <Skeleton className="h-8 w-48 md:h-9" />;
  }

  if (isUnavailable) {
    return (
      <h1
        className="font-heading text-muted-foreground text-display font-normal"
        data-testid="portfolio-balance"
      >
        {t("performance:not_available")}
      </h1>
    );
  }

  // The hero figure: the type scale's display step at regular weight, so the number
  // reads large but quiet.
  return (
    <h1 className="font-heading text-display font-normal" data-testid="portfolio-balance">
      {isBalanceHidden ? (
        <span className="text-4x">{hiddenValue}</span>
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
