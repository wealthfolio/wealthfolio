import { createInstance } from "i18next";
import { beforeAll, expect, it } from "vitest";
import en from "@/i18n/locales/en/settings.json";
import zh from "@/i18n/locales/zh/settings.json";
import es from "@/i18n/locales/es/settings.json";
import enAsset from "@/i18n/locales/en/asset.json";
import zhAsset from "@/i18n/locales/zh/asset.json";
import enHoldings from "@/i18n/locales/en/holdings.json";
import zhHoldings from "@/i18n/locales/zh/holdings.json";
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
    resources: {
      en: { settings: en, asset: enAsset, holdings: enHoldings },
      zh: { settings: zh, asset: zhAsset, holdings: zhHoldings },
    },
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

it("resolves instrument capabilities from settings alone, without taxonomy resources", () => {
  const labels = ["Stocks", "Crypto", "ETFs", "Funds", "Bonds"];
  const keys = ["stocks", "crypto", "etfs", "funds", "bonds"] as const;
  for (const [index, label] of labels.entries()) {
    expect(getProviderInstruments(i18n.getFixedT("zh"), label)).toBe(
      zh.market_data_page.instrumentLabels[keys[index]],
    );
    expect(getProviderInstruments(i18n.getFixedT("en"), label)).toBe(
      en.market_data_page.instrumentLabels[keys[index]],
    );
  }
});

it("keeps all mapped instruments localized across language changes without taxonomy resources", async () => {
  const raw =
    "Stocks • Crypto • Forex • Metals • ETFs • Funds • Bonds • US Treasuries • Any • Future instrument";
  for (const [language, settings, asset, holdings] of [
    ["zh", zh, zhAsset, zhHoldings],
    ["en", en, enAsset, enHoldings],
  ] as const) {
    await i18n.changeLanguage(language);
    const labels = settings.market_data_page.instrumentLabels;
    expect(getProviderInstruments(i18n.t, raw)).toBe(
      [
        labels.stocks,
        labels.crypto,
        asset.createSecurity.instrumentType.fx,
        asset.createSecurity.instrumentType.metal,
        labels.etfs,
        labels.funds,
        labels.bonds,
        settings.market_data_page.coverageLabels["US Treasury"],
        holdings.all_types,
        "Future instrument",
      ].join(" • "),
    );
  }
});

// BME uses “Acciones” for financial stocks, not the unrelated noun “cepo”.
// https://www.bolsasymercados.es/es/bme-exchange/mercados-y-cotizaciones/acciones.html
it("uses the Spanish finance term for stocks without taxonomy resources", async () => {
  const language = createInstance();
  await language.init({
    lng: "es",
    fallbackLng: "en",
    resources: { es: { settings: es }, en: { settings: en } },
  });
  expect(getProviderInstruments(language.t, "Stocks • Future instrument")).toBe(
    "Acciones • Future instrument",
  );
  expect(getProviderName(language.t, "YAHOO", "Yahoo Finance")).toBe("Yahoo Finance");
  await language.changeLanguage("en");
  expect(getProviderInstruments(language.t, "Stocks • Future instrument")).toBe(
    "Stocks • Future instrument",
  );
});

it.each(Object.entries(settingsCatalogs))(
  "localizes MOEX descriptions and receipt capabilities in %s",
  (_, catalog) => {
    expect(catalog.market_data_page.providerDescriptions.MOEX).toBeTruthy();
    expect(catalog.market_data_page.instrumentLabels.depositary_receipts).toBeTruthy();
  },
);

it("translates MOEX descriptions and receipt capabilities", () => {
  expect(
    getProviderDescription(
      i18n.getFixedT("zh"),
      "MOEX",
      en.market_data_page.providerDescriptions.MOEX,
    ),
  ).toBe(zh.market_data_page.providerDescriptions.MOEX);
  expect(getProviderInstruments(i18n.getFixedT("zh"), "Stocks • ETFs • DRs")).toBe(
    "股票 • ETF • 存托凭证",
  );
});
