import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DirectionProvider } from "@wealthfolio/ui";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import enSettings from "@/i18n/locales/en/settings.json";
import zhSettings from "@/i18n/locales/zh/settings.json";
import enUi from "@/i18n/locales/en/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import { AddExchangeRateForm } from "./add-exchange-rate-form";

vi.mock("@/hooks/use-market-data-providers", () => ({
  useMarketDataProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-custom-providers", () => ({ useCustomProviders: () => ({ data: [] }) }));

// Keep form interactions cheap under CI shard concurrency while using the real label helper.
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  return {
    ...actual,
    worldCurrencies: actual.worldCurrencies.filter((currency) =>
      ["CNY", "USD", "CAD"].includes(currency.value),
    ),
  };
});

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function exchangeForm(direction: "ltr" | "rtl" = "ltr") {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    resources: {
      en: { common: enCommon, settings: enSettings, ui: enUi },
      zh: { common: zhCommon, settings: zhSettings, ui: zhUi },
    },
  });
  const onSubmit = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <DirectionProvider direction={direction}>
        <Dialog open>
          <DialogContent>
            <AddExchangeRateForm onSubmit={onSubmit} onCancel={vi.fn()} />
          </DialogContent>
        </Dialog>
      </DirectionProvider>
    </I18nextProvider>,
  );
  return { i18n, onSubmit, user: userEvent.setup() };
}

it.each(["人民币", "Chinese/Yuan", "cny"])(
  "finds localized currency options and submits codes for search %s",
  async (query) => {
    const { onSubmit, user } = await exchangeForm();
    await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
    fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
      target: { value: query },
    });
    await user.click(await screen.findByRole("option", { name: "人民币 (CNY)" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("combobox", { name: zhSettings.fx_to_currency }));
    await user.click(await screen.findByRole("option", { name: "美元 (USD)" }));
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByRole("textbox", { name: zhSettings.fx_rate_label }), {
      target: { value: "0.14" },
    });
    await user.click(screen.getByRole("button", { name: zhSettings.fx_add_title }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        fromCurrency: "CNY",
        toCurrency: "USD",
        source: "MANUAL",
        rate: 0.14,
        timestamp: expect.any(String),
      }),
    );
  },
);

it.each(["ltr", "rtl"] as const)(
  "updates selected and open labels without resetting values in %s",
  async (direction) => {
    const { i18n, onSubmit, user } = await exchangeForm(direction);
    await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
    await user.click(await screen.findByRole("option", { name: "人民币 (CNY)" }));
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByRole("textbox", { name: zhSettings.fx_rate_label }), {
      target: { value: "2" },
    });
    await user.click(screen.getByRole("combobox", { name: zhSettings.fx_to_currency }));
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByRole("combobox", { name: enSettings.fx_from_currency })).toHaveTextContent(
      "Chinese/Yuan renminbi (CNY)",
    );
    expect(
      await screen.findByRole("option", { name: "United States dollar (USD)" }),
    ).toBeInTheDocument();
    await act(() => i18n.changeLanguage("zh"));
    expect(screen.getByRole("combobox", { name: zhSettings.fx_from_currency })).toHaveTextContent(
      "人民币 (CNY)",
    );
    expect(await screen.findByRole("option", { name: "美元 (USD)" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: zhSettings.fx_rate_label })).toHaveValue("2");
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

it("preserves custom currency values when the language changes", async () => {
  const { i18n, user } = await exchangeForm();
  await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: "MyCoin" },
  });
  await user.click(await screen.findByRole("option", { name: /MYCOIN/ }));
  await user.keyboard("{Escape}");
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("combobox", { name: enSettings.fx_from_currency })).toHaveTextContent(
    "MYCOIN",
  );
});

// FX pairs are stored upper-cased, so a lower-case code would miss its pair (#2188).
it.each(["cny", " cny "])("offers and submits %j in upper case", async (query) => {
  const { onSubmit, user } = await exchangeForm();
  await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: query },
  });
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "人民币 (CNY)",
  ]);
  await user.click(screen.getByRole("option", { name: "人民币 (CNY)" }));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("combobox", { name: zhSettings.fx_to_currency }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: "usdt" },
  });
  await user.click(
    await screen.findByRole("option", {
      name: zhSettings.fx_custom_search.replace("{{value}}", "USDT"),
    }),
  );
  await user.keyboard("{Escape}");
  fireEvent.change(screen.getByRole("textbox", { name: zhSettings.fx_rate_label }), {
    target: { value: "7" },
  });
  await user.click(screen.getByRole("button", { name: zhSettings.fx_add_title }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      fromCurrency: "CNY",
      toCurrency: "USDT",
      source: "MANUAL",
      rate: 7,
      timestamp: expect.any(String),
    }),
  );
});

// FX pairs are stored upper-cased: South African cents are saved as ZAC, the same
// unit as ZAc, but pence (GBp) must not become pounds (GBP).
it.each([
  [" zac ", "ZAC"],
  ["ZAC", "ZAC"],
])("fills in %j as %s when no currency matches", async (query, code) => {
  const { user } = await exchangeForm();
  await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: query },
  });
  await user.keyboard("{Escape}");
  expect(screen.getByRole("combobox", { name: zhSettings.fx_from_currency })).toHaveTextContent(
    code,
  );
});

it.each([
  ["ZAc", "ZAC"],
  ["GBp", "GBp"],
])("offers %s as the custom code %s", async (query, code) => {
  const { user } = await exchangeForm();
  await user.click(screen.getByRole("combobox", { name: zhSettings.fx_from_currency }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: query },
  });
  await user.click(
    await screen.findByRole("option", {
      name: zhSettings.fx_custom_search.replace("{{value}}", code),
    }),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("combobox", { name: zhSettings.fx_from_currency })).toHaveTextContent(
    code,
  );
});

// Conversions look quote units up through their major currency's pair, so a
// manual GBp or ZAC rate would be saved but never used directly (#2460).
it.each([
  ["fromCurrency", "GBp", "GBP"],
  ["fromCurrency", "zac", "ZAR"],
  ["toCurrency", "GBX", "GBP"],
] as const)("rejects the quote unit in %s for search %j", async (field, query, major) => {
  const { onSubmit, user } = await exchangeForm();
  const other = field === "fromCurrency" ? "toCurrency" : "fromCurrency";
  const name = (path: "fromCurrency" | "toCurrency") =>
    path === "fromCurrency" ? zhSettings.fx_from_currency : zhSettings.fx_to_currency;
  await user.click(screen.getByRole("combobox", { name: name(field) }));
  fireEvent.change(screen.getByPlaceholderText(zhSettings.fx_search_currency), {
    target: { value: query },
  });
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("combobox", { name: name(other) }));
  await user.click(await screen.findByRole("option", { name: "美元 (USD)" }));
  await user.keyboard("{Escape}");
  fireEvent.change(screen.getByRole("textbox", { name: zhSettings.fx_rate_label }), {
    target: { value: "0.0125" },
  });
  await user.click(screen.getByRole("button", { name: zhSettings.fx_add_title }));
  const code = screen.getByRole("combobox", { name: name(field) }).textContent;
  expect(
    await screen.findByText(
      zhSettings.fx_err_quote_unit.replace("{{code}}", code ?? "").replaceAll("{{major}}", major),
    ),
  ).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});
