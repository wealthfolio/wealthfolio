import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import deActivity from "@/i18n/locales/de/activity.json";
import deUi from "@/i18n/locales/de/ui.json";
import { ImportToolbar } from "./import-toolbar";

vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));

describe("ImportToolbar currency menu", () => {
  it("names and finds currencies in the app language", async () => {
    const user = userEvent.setup();
    const i18n = createInstance();
    await i18n.init({
      lng: "de",
      resources: { de: { activity: deActivity, ui: deUi } },
      interpolation: { escapeValue: false },
    });
    const onSetCurrency = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ImportToolbar
          selectedCount={1}
          onSkip={vi.fn()}
          onUnskip={vi.fn()}
          onSetCurrency={onSetCurrency}
          onSetAccount={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </I18nextProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Währung" }));
    // GBp and GBX are both British pence.
    expect(await screen.findAllByRole("menuitem", { name: /Britische Pence/ })).toHaveLength(2);

    fireEvent.change(screen.getByPlaceholderText("Währungen suchen…"), {
      target: { value: "Franken" },
    });
    await user.click(await screen.findByRole("menuitem", { name: /Schweizer Franken/ }));

    expect(onSetCurrency).toHaveBeenCalledWith("CHF");
  });
});
