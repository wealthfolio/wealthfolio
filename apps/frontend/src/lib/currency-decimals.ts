import { getQuoteUnitCurrency } from "@wealthfolio/ui/lib/currencies";

/**
 * Crypto quote currencies priced at 8 fraction digits. Keep in lockstep with
 * the crypto arm of `currency_fraction_digits` in
 * crates/core/src/fx/currency.rs (dollar-pegged stablecoins deliberately keep
 * the two-decimal fiat default there and here).
 */
const CRYPTO_QUOTE_CURRENCIES = new Set([
  "BTC",
  "ETH",
  "XRP",
  "LTC",
  "BCH",
  "ADA",
  "DOT",
  "LINK",
  "XLM",
  "DOGE",
  "UNI",
  "SOL",
  "AVAX",
  "MATIC",
  "ATOM",
  "ALGO",
  "VET",
  "FIL",
  "TRX",
  "ETC",
  "XMR",
  "AAVE",
  "MKR",
  "COMP",
  "SNX",
  "YFI",
  "SUSHI",
  "CRV",
]);

/**
 * Fraction digits of the currency's minor unit, for accounting: rounding a
 * calculated total, sizing amount inputs, judging tolerances. Keep in lockstep
 * with `currency_fraction_digits` in crates/core/src/fx/currency.rs, including
 * minor-unit aliases. This is not display precision: Intl/CLDR differs from
 * core for currencies such as HUF, IDR and IQD.
 */
export function currencyFractionDigits(currency: string | undefined): number {
  if (!currency) return 2;
  const upper = (getQuoteUnitCurrency(currency)?.major ?? currency).toUpperCase();
  if (CRYPTO_QUOTE_CURRENCIES.has(upper)) return 8;
  switch (upper) {
    case "BIF":
    case "CLP":
    case "DJF":
    case "GNF":
    case "ISK":
    case "JPY":
    case "KMF":
    case "KRW":
    case "PYG":
    case "RWF":
    case "UGX":
    case "UYI":
    case "VND":
    case "VUV":
    case "XAF":
    case "XOF":
    case "XPF":
      return 0;
    case "BHD":
    case "IQD":
    case "JOD":
    case "KWD":
    case "LYD":
    case "OMR":
    case "TND":
      return 3;
    case "CLF":
    case "UYW":
      return 4;
    default:
      return 2;
  }
}

/** One minor unit of the currency. Mirrors `currency_minor_unit` in core. */
export function currencyMinorUnit(currency: string | undefined): number {
  return 10 ** -currencyFractionDigits(currency);
}
