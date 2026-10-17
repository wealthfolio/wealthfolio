import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { quoteUnitCurrencies, worldCurrencies, type CurrencyOption } from "../lib/currencies";

type QuoteUnitCode = (typeof quoteUnitCurrencies)[number]["value"];

const worldOptionsByLocale = new Map<string, CurrencyOption[]>();

function toOption(
  currency: { value: string; label: string },
  localName: string | undefined,
  locale: string,
): CurrencyOption {
  // French, Spanish and Italian names are lowercase ("franc suisse"), but they
  // start list items here. Without a local name, show the English one.
  const name = localName
    ? localName.charAt(0).toLocaleUpperCase(locale) + localName.slice(1)
    : currency.label.replace(` (${currency.value})`, "");
  return {
    value: currency.value,
    name,
    label: `${name} (${currency.value})`,
    englishLabel: currency.label,
  };
}

// Data grids render a currency cell per row, so build each language's list once.
function getWorldOptions(locale: string) {
  let options = worldOptionsByLocale.get(locale);
  if (!options) {
    const names = new Intl.DisplayNames(locale, { type: "currency", fallback: "none" });
    options = worldCurrencies.map((currency) =>
      toOption(currency, names.of(currency.value), locale),
    );
    worldOptionsByLocale.set(locale, options);
  }
  return options;
}

/**
 * The currency lists with names in the app language. ISO currencies are named
 * by the runtime's CLDR data; quote units come from the `ui` catalog.
 */
export function useCurrencyOptions() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";

  return useMemo(() => {
    // Quote units aren't ISO 4217 codes: Intl reads "GBp" as the pound and has
    // no name for the others.
    const quoteUnitNames: Record<QuoteUnitCode, string> = {
      GBp: t("ui:currency.quoteUnitNames.britishPence", "British pence"),
      GBX: t("ui:currency.quoteUnitNames.britishPence", "British pence"),
      ILA: t("ui:currency.quoteUnitNames.israeliAgorot", "Israeli agorot"),
      USX: t("ui:currency.quoteUnitNames.usCents", "US cents"),
      ZAc: t("ui:currency.quoteUnitNames.southAfricanCents", "South African cents"),
      KWF: t("ui:currency.quoteUnitNames.kuwaitiFils", "Kuwaiti fils"),
    };
    const world = getWorldOptions(locale);
    const quoteUnits = quoteUnitCurrencies.map((currency) =>
      toOption(currency, quoteUnitNames[currency.value], locale),
    );
    return {
      worldCurrencies: world,
      quoteUnitCurrencies: quoteUnits,
      quoteCurrencies: [...world, ...quoteUnits],
    };
  }, [locale, t]);
}
