import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import deSettings from "@/i18n/locales/de/settings.json";
import deUi from "@/i18n/locales/de/ui.json";
import { AddExchangeRateForm } from "./add-exchange-rate-form";

vi.mock("@/hooks/use-market-data-providers", () => ({
  useMarketDataProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({ data: [] }),
}));

beforeAll(() => {
  // cmdk scrolls the selected item into view and measures the list, which jsdom does not implement.
  Element.prototype.scrollIntoView ??= vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("AddExchangeRateForm currency fields", () => {
  it("names and finds currencies in the app language", async () => {
    const user = userEvent.setup();
    const i18n = createInstance();
    await i18n.init({
      lng: "de",
      resources: { de: { settings: deSettings, ui: deUi } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <Dialog open>
          <DialogContent>
            <AddExchangeRateForm onSubmit={vi.fn()} onCancel={vi.fn()} />
          </DialogContent>
        </Dialog>
      </I18nextProvider>,
    );

    const fromCurrency = screen.getByRole("combobox", { name: "Ausgangswährung" });
    await user.click(fromCurrency);
    await user.type(screen.getByPlaceholderText("Währung suchen..."), "Franken");
    // A search that matches no currency becomes a custom code.
    expect(fromCurrency).not.toHaveTextContent("FRANKEN");
    await user.click(screen.getByRole("option", { name: "Schweizer Franken (CHF)" }));

    expect(fromCurrency).toHaveTextContent("Schweizer Franken (CHF)");
  });
});
