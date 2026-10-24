import { createInstance } from "i18next";
import { beforeAll, expect, it } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import en from "@/i18n/locales/en/settings.json";
import zh from "@/i18n/locales/zh/settings.json";
import {
  getProviderCoverage,
  getProviderDescription,
  getProviderName,
  getProviderInstruments,
} from "./provider-labels";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "zh",
    fallbackLng: "en",
    resources: { en: { settings: en, common: enCommon }, zh: { settings: zh, common: zhCommon } },
  });
});
it("translates only the original built-in provider description", () => {
  const description = en.market_data_page.providerDescriptions.YAHOO;
  expect(getProviderDescription(i18n.t, "YAHOO", description)).not.toBe(description);
  expect(getProviderDescription(i18n.t, "custom", description)).toBe(description);
  expect(getProviderDescription(i18n.t, "YAHOO", "My description")).toBe("My description");
});
it("localizes known capabilities and preserves external values", () => {
  expect(getProviderCoverage(i18n.t, "Global")).not.toBe("Global");
  expect(getProviderCoverage(i18n.t, "XETR • XFRA")).toBe("XETR • XFRA");
  expect(getProviderCoverage(i18n.getFixedT("en"), "Global")).toBe("Global");
});

it("keeps brands and user-renamed provider names", () => {
  expect(getProviderName(i18n.t, "US_TREASURY_CALC", "US Treasury (Calculated)")).toBe(
    zh.market_data_page.us_treasury_name,
  );
  expect(getProviderName(i18n.t, "US_TREASURY_CALC", "My treasury provider")).toBe(
    "My treasury provider",
  );
  expect(getProviderName(i18n.t, "YAHOO", "Yahoo Finance")).toBe("Yahoo Finance");
});

it("translates built-in instrument capabilities while preserving future provider values", () => {
  expect(getProviderInstruments(i18n.t, "Stocks • Funds • New instrument")).toBe(
    "股票 • 基金 • New instrument",
  );
});

const settingsCatalogs = import.meta.glob<typeof en>("../i18n/locales/*/settings.json", {
  eager: true,
  import: "default",
});

it.each(Object.entries(settingsCatalogs))(
  "keeps example API identifiers literal in %s",
  (_, catalog) => {
    const descriptions = catalog.market_data_page.templateDescriptions;
    for (const description of [
      descriptions.free_crypto_use_coin_id_bitcoin_ethereum,
      descriptions.daily_crypto_history_use_coin_id_bitcoin_ethereum,
    ]) {
      expect(description).toContain("bitcoin");
      expect(description).toContain("ethereum");
    }
  },
);
