import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import deUi from "@/i18n/locales/de/ui.json";
import { CurrencyInput, matchesCurrencySearch, useCurrencyOptions } from "@wealthfolio/ui";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Each language's list is cached for the module, so a test that stubs Intl
// needs a language no other test uses.
async function wrapperFor(lng: string, ui: object = {}) {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: false,
    resources: { [lng]: { ui } },
    interpolation: { escapeValue: false },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
  };
}

beforeAll(() => {
  // cmdk scrolls the selected item into view, which jsdom does not implement.
  Element.prototype.scrollIntoView ??= vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCurrencyOptions", () => {
  it("names currencies in the app language and keeps the English label", async () => {
    const { result } = renderHook(() => useCurrencyOptions(), {
      wrapper: await wrapperFor("de", deUi),
    });

    expect(result.current.worldCurrencies.find((c) => c.value === "CHF")).toEqual({
      value: "CHF",
      name: "Schweizer Franken",
      label: "Schweizer Franken (CHF)",
      englishLabel: "Swiss franc (CHF)",
    });
    // Quote units come from the catalog: Intl would call GBp the pound.
    const pence = result.current.quoteCurrencies.filter((c) => ["GBp", "GBX"].includes(c.value));
    expect(pence.map((c) => c.label)).toEqual(["Britische Pence (GBp)", "Britische Pence (GBX)"]);
    expect(result.current.quoteUnitCurrencies.find((c) => c.value === "KWF")?.name).toBe(
      "Kuwaitische Fils",
    );
  });

  it("capitalizes names that the runtime gives in lowercase", async () => {
    const { result } = renderHook(() => useCurrencyOptions(), { wrapper: await wrapperFor("fr") });

    expect(result.current.worldCurrencies.find((c) => c.value === "CHF")?.label).toBe(
      "Franc suisse (CHF)",
    );
  });

  it("falls back to the English name when the runtime has none", async () => {
    vi.spyOn(Intl.DisplayNames.prototype, "of").mockReturnValue(undefined);
    const { result } = renderHook(() => useCurrencyOptions(), { wrapper: await wrapperFor("it") });

    expect(result.current.worldCurrencies.find((c) => c.value === "CHF")).toMatchObject({
      name: "Swiss franc",
      label: "Swiss franc (CHF)",
    });
    // Without a catalog, quote units keep their English defaults.
    expect(result.current.quoteUnitCurrencies.find((c) => c.value === "USX")?.name).toBe(
      "US cents",
    );
  });
});

describe("matchesCurrencySearch", () => {
  it("matches the code, the local name and the English name", async () => {
    const { result } = renderHook(() => useCurrencyOptions(), {
      wrapper: await wrapperFor("de", deUi),
    });
    const chf = result.current.worldCurrencies.find((c) => c.value === "CHF")!;

    for (const query of ["chf", "Franken", "franc", "SWISS"]) {
      expect(matchesCurrencySearch(chf, query)).toBe(true);
    }
    expect(matchesCurrencySearch(chf, "Yen")).toBe(false);
  });
});

describe("CurrencyInput in German", () => {
  it("shows the selected currency's German name", async () => {
    render(<CurrencyInput value="CHF" onChange={vi.fn()} displayMode="desktop" />, {
      wrapper: await wrapperFor("de", deUi),
    });

    expect(screen.getByRole("combobox")).toHaveTextContent("Schweizer Franken (CHF)");
  });

  it.each(["Franken", "Swiss"])("finds CHF by %s on desktop", async (query) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CurrencyInput onChange={onChange} displayMode="desktop" />, {
      wrapper: await wrapperFor("de", deUi),
    });

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Währung suchen..."), query);
    await user.click(screen.getByRole("option", { name: "Schweizer Franken (CHF)" }));

    expect(onChange).toHaveBeenCalledWith("CHF");
  });

  it.each(["Franken", "Swiss"])("finds CHF by %s on mobile", async (query) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CurrencyInput onChange={onChange} displayMode="mobile" />, {
      wrapper: await wrapperFor("de", deUi),
    });

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Alle Währungen durchsuchen..."), query);
    await user.click(screen.getByRole("button", { name: /Schweizer Franken/ }));

    expect(onChange).toHaveBeenCalledWith("CHF");
  });
});
