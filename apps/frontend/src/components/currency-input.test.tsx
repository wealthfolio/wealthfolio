import { fireEvent, render, screen, within } from "@testing-library/react";
import deUi from "@/i18n/locales/de/ui.json";
import { CurrencyInput } from "@wealthfolio/ui";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("CurrencyInput", () => {
  it.each(["desktop", "mobile"] as const)(
    "falls back to a neutral placeholder on %s",
    (displayMode) => {
      const { rerender } = render(<CurrencyInput onChange={vi.fn()} displayMode={displayMode} />);
      expect(screen.getByRole("combobox")).toHaveTextContent("Select currency");

      rerender(
        <CurrencyInput onChange={vi.fn()} displayMode={displayMode} placeholder="Pick one" />,
      );
      expect(screen.getByRole("combobox")).toHaveTextContent("Pick one");
    },
  );

  it("describes the mobile sheet without assuming an activity", () => {
    render(<CurrencyInput onChange={vi.fn()} displayMode="mobile" />);

    fireEvent.click(screen.getByRole("combobox"));

    const sheet = screen.getByRole("dialog", { name: "Select Currency" });
    expect(sheet).toHaveAccessibleDescription("Choose a currency");
    expect(within(sheet).getByRole("heading", { name: "Popular" })).toBeInTheDocument();
  });

  // FX pairs are stored upper-cased, so `eur` must not become a custom code (#2188).
  it("offers custom codes on mobile in upper case, but not listed codes", () => {
    const onChange = vi.fn();
    render(<CurrencyInput onChange={onChange} displayMode="mobile" />);
    fireEvent.click(screen.getByRole("combobox"));
    const search = screen.getByPlaceholderText("Search all currencies...");

    fireEvent.change(search, { target: { value: " eur " } });
    expect(screen.getByRole("button", { name: /EUR European Euro/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /custom currency/ })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "usdt" } });
    fireEvent.click(screen.getByRole("button", { name: 'Use "USDT" as custom currency' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("USDT");
  });

  // English matches the inline fallbacks, so another locale shows the catalog keys are used.
  it("takes its default text from the ui catalog", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "de",
      fallbackLng: false,
      resources: { de: { ui: deUi } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <CurrencyInput onChange={vi.fn()} displayMode="mobile" />
      </I18nextProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Währung auswählen");
    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Währung auswählen" });
    expect(sheet).toHaveAccessibleDescription("Wählen Sie eine Währung aus");
    expect(within(sheet).getByRole("heading", { name: "Beliebt" })).toBeInTheDocument();
  });
});

// Enter takes the first match in list order, and earlier currencies fuzzy-match
// codes through their names: USD matches "EUR" (#2431).
describe("CurrencyInput desktop search", () => {
  class ResizeObserverStub {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it.each(["EUR", "AUD", "INR", "SEK", "SGD", "USD"])(
    "selects %s typed and entered",
    async (code) => {
      const onChange = vi.fn();
      render(<CurrencyInput onChange={onChange} displayMode="desktop" />);
      fireEvent.click(screen.getByRole("combobox"));
      const search = await screen.findByPlaceholderText("Search currency...");

      fireEvent.change(search, { target: { value: code } });
      fireEvent.keyDown(search, { key: "Enter" });

      expect(onChange).toHaveBeenCalledExactlyOnceWith(code);
    },
  );

  // FX pairs are stored upper-cased, so a code typed as `eur` must select EUR, not
  // become a custom code that misses the EUR pair (#2188). Quote units keep their case.
  it.each([
    ["eur", "EUR"],
    ["Eur", "EUR"],
    [" eur ", "EUR"],
    ["gbp", "GBP"],
    ["usdt", "USDT"],
    ["GBp", "GBp"],
    ["zac", "ZAc"],
    ["gbx", "GBX"],
    ["ila", "ILA"],
    ["usx", "USX"],
    ["kwf", "KWF"],
  ])("selects %s typed and entered as %s", async (query, code) => {
    const onChange = vi.fn();
    render(<CurrencyInput onChange={onChange} displayMode="desktop" />);
    fireEvent.click(screen.getByRole("combobox"));
    const search = await screen.findByPlaceholderText("Search currency...");

    fireEvent.change(search, { target: { value: query } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onChange).toHaveBeenCalledExactlyOnceWith(code);
  });
});
