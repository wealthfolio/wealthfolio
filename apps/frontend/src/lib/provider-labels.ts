import type { TFunction } from "i18next";
import english from "@/i18n/locales/en/settings.json";

const descriptions: Record<string, string> = english.market_data_page.providerDescriptions;
const coverage: Record<string, string> = english.market_data_page.coverageLabels;

export function getProviderDescription(t: TFunction, id: string, description: string): string {
  return descriptions[id] === description
    ? t(`settings:market_data_page.providerDescriptions.${id}`, { defaultValue: description })
    : description;
}

export function getProviderCoverage(t: TFunction, value: string): string {
  return coverage[value] === value
    ? t(`settings:market_data_page.coverageLabels.${value}`, { defaultValue: value })
    : value;
}

export function getProviderName(t: TFunction, id: string, name: string): string {
  if (id === "US_TREASURY_CALC" && name === english.market_data_page.us_treasury_name) {
    return t("settings:market_data_page.us_treasury_name");
  }
  return name;
}

export function getProviderInstruments(t: TFunction, value: string): string {
  const keys: Record<string, string> = {
    Stocks: "common:categoryNames.instrument_type.EQUITY_SECURITY",
    Crypto: "common:categoryNames.instrument_type.DIGITAL_ASSET",
    Forex: "asset:createSecurity.instrumentType.fx",
    Metals: "asset:createSecurity.instrumentType.metal",
    ETFs: "common:categoryNames.instrument_type.ETP",
    Funds: "common:categoryNames.instrument_type.FUND",
    Bonds: "common:categoryNames.instrument_type.DEBT_SECURITY",
    "US Treasuries": "settings:market_data_page.coverageLabels.US Treasury",
    Any: "holdings:all_types",
  };
  return value
    .split(" • ")
    .map((label) => (keys[label] ? t(keys[label], { defaultValue: label }) : label))
    .join(" • ");
}
