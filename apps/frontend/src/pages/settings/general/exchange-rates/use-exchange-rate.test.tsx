import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import enUi from "@/i18n/locales/en/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import { useExchangeRates } from "./use-exchange-rate";

const mocks = vi.hoisted(() => ({ getExchangeRates: vi.fn() }));
vi.mock("@/adapters", () => ({
  getExchangeRates: mocks.getExchangeRates,
  addExchangeRate: vi.fn(),
  updateExchangeRate: vi.fn(),
  deleteExchangeRate: vi.fn(),
  logger: { error: vi.fn() },
}));

it("updates currency names from cached rates on language change without refetching or changing codes", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { ui: enUi }, zh: { ui: zhUi } },
  });
  const rate = {
    id: "rate",
    fromCurrency: "CNY",
    toCurrency: "USD",
    source: "MANUAL",
    rate: 0.14,
    timestamp: "2026-10-26T00:00:00Z",
  };
  mocks.getExchangeRates.mockResolvedValue([rate]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
  const { result } = renderHook(() => useExchangeRates(), { wrapper });
  await waitFor(() =>
    expect(result.current.exchangeRates?.[0].fromCurrencyName).toBe("Chinese/Yuan renminbi"),
  );
  await act(() => i18n.changeLanguage("zh"));
  await waitFor(() => expect(result.current.exchangeRates?.[0].fromCurrencyName).toBe("人民币"));
  expect(result.current.exchangeRates?.[0].toCurrencyName).toBe("美元");
  expect(result.current.exchangeRates?.[0]).toMatchObject(rate);
  expect(mocks.getExchangeRates).toHaveBeenCalledTimes(1);
  expect(rate).not.toHaveProperty("fromCurrencyName");
});
