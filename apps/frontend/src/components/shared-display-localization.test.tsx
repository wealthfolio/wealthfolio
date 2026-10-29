import { act, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionConfirm,
  DeleteConfirm,
  DataTable,
  CurrencyInput,
  getCurrencyDisplayLabel,
  getCurrencyDisplayName,
  quoteCurrencies,
  SearchableSelect,
  ProgressIndicator,
} from "@wealthfolio/ui";
import { newAccountSchema } from "@/lib/schemas";
import enUi from "@/i18n/locales/en/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import arUi from "@/i18n/locales/ar/ui.json";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import arCommon from "@/i18n/locales/ar/common.json";

async function language(lng = "zh") {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "en",
    resources: {
      en: { ui: enUi, common: enCommon },
      zh: { ui: zhUi, common: zhCommon },
      ar: { ui: arUi, common: arCommon },
    },
  });
  return i18n;
}

describe("shared display localization", () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalScrollIntoView)
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
  it.each(["desktop", "mobile"] as const)(
    "updates selected currency without changing its value on %s",
    async (displayMode) => {
      const i18n = await language();
      const onChange = vi.fn();
      const view = render(
        <I18nextProvider i18n={i18n}>
          <CurrencyInput value="CNY" onChange={onChange} displayMode={displayMode} />
        </I18nextProvider>,
      );
      expect(screen.getByRole("combobox")).toHaveTextContent("人民币 (CNY)");
      await act(() => i18n.changeLanguage("en"));
      expect(screen.getByRole("combobox")).toHaveTextContent("Chinese/Yuan renminbi (CNY)");
      await act(() => i18n.changeLanguage("ar"));
      expect(screen.getByRole("combobox")).toHaveTextContent("CNY");
      expect(screen.getByRole("combobox")).not.toHaveTextContent("Chinese/Yuan");
      expect(onChange).not.toHaveBeenCalled();
      view.rerender(
        <I18nextProvider i18n={i18n}>
          <CurrencyInput value="MY_COIN" onChange={onChange} displayMode={displayMode} />
        </I18nextProvider>,
      );
      expect(screen.getByRole("combobox")).toHaveTextContent("MY_COIN");
    },
  );

  it.each(["人民币", "Chinese/Yuan", "CNY"])(
    "finds currency by localized, English or code search: %s",
    async (query) => {
      const i18n = await language();
      const onChange = vi.fn();
      render(
        <I18nextProvider i18n={i18n}>
          <CurrencyInput onChange={onChange} displayMode="desktop" allowCustom={false} />
        </I18nextProvider>,
      );
      fireEvent.click(screen.getByRole("combobox"));
      fireEvent.change(screen.getByPlaceholderText(zhUi.currency.search), {
        target: { value: query },
      });
      const option = await screen.findByRole("option", { name: "人民币 (CNY)" });
      fireEvent.click(option);
      expect(onChange).toHaveBeenCalledWith("CNY");
    },
  );

  it("localizes quote subunits but preserves their case-sensitive codes and unknown values", async () => {
    const i18n = await language();
    for (const code of ["GBp", "GBX"]) {
      const item = quoteCurrencies.find((currency) => currency.value === code)!;
      expect(getCurrencyDisplayLabel(item, "zh", i18n.t)).toBe(`英国便士 (${code})`);
    }
    expect(getCurrencyDisplayName("USX", "zh", i18n.t)).toBe("美分");
    expect(getCurrencyDisplayName("MY_COIN", "zh", i18n.t)).toBe("MY_COIN");
    expect(getCurrencyDisplayName("EUR", "en", i18n.t)).toBe("European Euro");
  });

  it("starts a currency label with a capital where the language writes names in lowercase", () => {
    const franc = { value: "CHF", label: "Swiss franc (CHF)" };
    expect(getCurrencyDisplayLabel(franc, "fr")).toBe("Franc suisse (CHF)");
    expect(getCurrencyDisplayName("CHF", "fr")).toBe("franc suisse");
    expect(getCurrencyDisplayLabel(franc, "zh")).toBe("瑞士法郎 (CHF)");
  });

  it("localizes shared select defaults and progress details", async () => {
    const i18n = await language();
    render(
      <I18nextProvider i18n={i18n}>
        <SearchableSelect options={[]} onValueChange={vi.fn()} />
        <ProgressIndicator />
      </I18nextProvider>,
    );
    expect(screen.getByRole("combobox")).toHaveTextContent(zhUi.select.placeholder);
    fireEvent.click(screen.getByRole("combobox"));
    expect(await screen.findByText(zhCommon.no_results_found)).toBeInTheDocument();
    expect(screen.getByText(zhUi.progress.description)).toBeInTheDocument();
  });

  it("localizes default confirmation buttons and pending state", async () => {
    const i18n = await language();
    const confirm = vi.fn();
    const view = render(
      <I18nextProvider i18n={i18n}>
        <ActionConfirm
          confirmTitle="确认操作"
          confirmMessage="说明"
          handleConfirm={confirm}
          isPending={false}
        />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认操作" }));
    expect(screen.getByRole("button", { name: zhCommon.cancel })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: zhCommon.confirm }));
    expect(confirm).toHaveBeenCalledOnce();
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <ActionConfirm
          confirmTitle="确认操作"
          confirmMessage="说明"
          handleConfirm={confirm}
          isPending={true}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole("button", { name: zhUi.actionConfirm.pending })).toBeDisabled();
    view.unmount();
    render(
      <I18nextProvider i18n={i18n}>
        <DeleteConfirm
          deleteConfirmTitle="卸载插件"
          deleteConfirmMessage="说明"
          handleDeleteConfirm={confirm}
          isPending={false}
        />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "卸载插件" }));
    expect(screen.getByRole("button", { name: zhCommon.delete })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zhCommon.cancel })).toBeInTheDocument();
  });

  it("localizes shared empty tables", async () => {
    const i18n = await language();
    render(
      <I18nextProvider i18n={i18n}>
        <DataTable columns={[{ accessorKey: "name", header: "Name" }]} data={[]} />
      </I18nextProvider>,
    );
    expect(screen.getByText(zhCommon.no_results_found)).toBeInTheDocument();
  });

  it("returns account message keys without changing constraints or valid output", () => {
    const input = { name: "A", currency: "USD", accountType: "SECURITIES" };
    const localized = newAccountSchema;
    const invalid = localized.safeParse(input);
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues[0]?.message).toBe("common:validation.accountNameMin");
    const valid = { ...input, name: "My Account", meta: '{"custom":"Unchanged"}' };
    expect(localized.parse(valid)).toEqual({
      ...valid,
      isArchived: false,
      trackingMode: "NOT_SET",
    });
    expect(localized.safeParse({ ...valid, name: "AB" }).success).toBe(true);
    expect(localized.safeParse({ ...valid, name: "A".repeat(50) }).success).toBe(true);
    const tooLong = localized.safeParse({ ...valid, name: "A".repeat(51) });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success)
      expect(tooLong.error.issues[0]?.message).toBe("common:validation.accountNameMax");
    const missingCurrency = localized.safeParse({ ...valid, currency: undefined });
    expect(missingCurrency.success).toBe(false);
    if (!missingCurrency.success)
      expect(missingCurrency.error.issues[0]?.message).toBe("common:validation.accountCurrency");
    const creditCard = localized.safeParse({
      ...valid,
      accountType: "CREDIT_CARD",
      trackingMode: "HOLDINGS",
    });
    expect(
      localized.parse({ ...valid, accountType: "CREDIT_CARD", trackingMode: "TRANSACTIONS" }),
    ).toEqual({
      ...valid,
      accountType: "CREDIT_CARD",
      trackingMode: "TRANSACTIONS",
      isArchived: false,
    });
    expect(creditCard.success).toBe(false);
    if (!creditCard.success)
      expect(creditCard.error.issues.at(-1)?.message).toBe("common:validation.creditCardTracking");
  });
  it("preserves account-number trimming, clearing, omission and the 64-character limit", () => {
    const base = {
      name: "My account",
      accountType: "SECURITIES",
      currency: "USD",
      meta: '{"custom":"Unchanged"}',
    };
    const output = { ...base, isArchived: false, trackingMode: "NOT_SET" };
    expect(newAccountSchema.parse(base)).toEqual(output);
    expect(newAccountSchema.parse(base)).not.toHaveProperty("accountNumber");
    expect(newAccountSchema.parse({ ...base, accountNumber: "  4100  " })).toEqual({
      ...output,
      accountNumber: "4100",
    });
    expect(newAccountSchema.parse({ ...base, accountNumber: "   " })).toEqual({
      ...output,
      accountNumber: "",
    });
    expect(newAccountSchema.parse({ ...base, accountNumber: `  ${"9".repeat(64)}  ` })).toEqual({
      ...output,
      accountNumber: "9".repeat(64),
    });
    const invalid = newAccountSchema.safeParse({ ...base, accountNumber: "9".repeat(65) });
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.error.issues).toEqual([
        expect.objectContaining({
          path: ["accountNumber"],
          message: "common:validation.accountNumberMax",
        }),
      ]);
  });
});
