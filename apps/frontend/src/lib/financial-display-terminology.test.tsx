import { act, render, screen } from "@/test/render";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import enAi from "@/i18n/locales/en/ai.json";
import arAi from "@/i18n/locales/ar/ai.json";
import itAi from "@/i18n/locales/it/ai.json";
import ptAi from "@/i18n/locales/pt/ai.json";
import enSettings from "@/i18n/locales/en/settings.json";
import ptSettings from "@/i18n/locales/pt/settings.json";
import { IncomeContentImpl } from "@/features/ai-assistant/components/tool-uis/income-tool-ui";
import {
  HISTORICAL_TEMPLATES,
  LATEST_TEMPLATES,
} from "@/pages/settings/market-data/provider-templates";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

// YoY is a comparison with the preceding year, not an annual frequency:
// https://stats.gov.sa/ar/w/methodology-and-quality-report-for-annual-national-accounts
// https://www.istat.it/comunicato-stampa/indicatori-demografici-anno-2025/
// https://www.bcb.gov.br/content/ri/relatorioinflacao/202503/rpm202503b1p.pdf
it.each([
  ["ar", arAi, "على أساس سنوي"],
  ["it", itAi, "Anno su anno"],
  ["pt", ptAi, "Interanual"],
] as const)(
  "keeps the income YoY value unchanged when its %s label changes language",
  async (locale, catalog, label) => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      resources: { en: { ai: enAi }, [locale]: { ai: catalog } },
    });
    type Props = ComponentProps<typeof IncomeContentImpl>;
    const result = {
      totalIncome: 2500,
      currency: "USD",
      monthlyAverage: 250,
      yoyGrowth: 0.125,
      byType: {},
      topAssets: [],
      byMonth: {},
      period: "ALL",
    };
    const original = JSON.stringify(result);
    render(
      <I18nextProvider i18n={i18n}>
        <IncomeContentImpl
          args={{ period: "ALL" }}
          argsText=""
          result={result as unknown as Props["result"]}
          status={{ type: "complete" } as Props["status"]}
          toolName="get_income"
          toolCallId="income-glossary"
          type="tool-call"
          addResult={vi.fn()}
          resume={vi.fn()}
        />
      </I18nextProvider>,
    );
    const numericText = (text: string) =>
      screen.getByText(text).parentElement?.textContent?.replace(text, "");
    const englishValue = numericText("YoY");
    expect(englishValue).toContain("12.50%");
    await act(() => i18n.changeLanguage(locale));
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText("YoY")).not.toBeInTheDocument();
    expect(numericText(label)).toBe(englishValue);
    expect(JSON.stringify(result)).toBe(original);
    await act(() => i18n.changeLanguage("en"));
    expect(numericText("YoY")).toBe(englishValue);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  },
);

// Cryptocurrency is not encryption:
// https://www12.senado.leg.br/manualdecomunicacao/guia-legislativo/criptomoeda
it("uses Portuguese cryptocurrency terminology without translating template identifiers", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "pt",
    fallbackLng: "en",
    resources: {
      en: { settings: enSettings },
      pt: { settings: ptSettings },
    },
  });
  const templates = [...LATEST_TEMPLATES, ...HISTORICAL_TEMPLATES];
  const original = JSON.stringify(templates);
  const keys = [
    "free_crypto_use_coin_id_bitcoin_ethereum",
    "stocks_crypto_fx_set_api_key_in_headers",
    "daily_crypto_history_use_coin_id_bitcoin_ethereum",
  ];
  for (const key of keys) {
    const matching = templates.filter((template) => template.descriptionKey === key);
    expect(matching.length).toBeGreaterThan(0);
    const label = i18n.t(`settings:market_data_page.templateDescriptions.${key}`);
    expect(label).toContain("criptomoedas");
    expect(label).not.toContain("criptografia");
    if (key.includes("coin_id")) {
      expect(label).toContain("bitcoin, ethereum");
      expect(matching[0].name).toBe("CoinGecko");
      expect(matching[0].testSymbol).toBe("bitcoin");
      expect(matching[0].url).toContain("{SYMBOL}");
    } else {
      expect(label).toContain("FX");
      expect(label).toContain("API");
      expect(matching[0].name).toBe("Twelve Data");
      expect(matching[0].headers).toContain("apikey YOUR_API_KEY");
    }
    await i18n.changeLanguage("en");
    expect(i18n.t(`settings:market_data_page.templateDescriptions.${key}`)).toBe(
      matching[0].description,
    );
    await i18n.changeLanguage("pt");
  }
  expect(JSON.stringify(templates)).toBe(original);
});
