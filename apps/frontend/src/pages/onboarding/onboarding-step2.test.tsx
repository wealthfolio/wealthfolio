import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import deCommon from "@/i18n/locales/de/common.json";
import deOnboarding from "@/i18n/locales/de/onboarding.json";
import deUi from "@/i18n/locales/de/ui.json";
import { SUPPORTED_LOCALES } from "@/i18n/locales";
import { OnboardingStep2 } from "./onboarding-step2";

const mocks = vi.hoisted(() => ({
  settings: { language: "en" } as { language: string },
  updateSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: mocks.settings,
    updateSettings: mocks.updateSettings,
  }),
}));

function renderStep2(language = "en") {
  mocks.settings = { language };
  return render(<OnboardingStep2 onNext={vi.fn()} onValidityChange={vi.fn()} />);
}

describe("OnboardingStep2 language picker", () => {
  it("shows only the popular languages as chips", () => {
    renderStep2();

    for (const code of ["en", "fr", "de", "es", "zh", "ja", "ko"]) {
      expect(screen.getByTestId(`language-${code}-button`)).toBeInTheDocument();
    }
    // Everything else lives behind the "Other" chip.
    expect(screen.queryByTestId("language-pt-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("language-it-button")).not.toBeInTheDocument();
  });

  it("lists every supported locale in the overlay", async () => {
    const user = userEvent.setup();
    renderStep2();

    await user.click(screen.getAllByRole("button", { name: /other/i })[0]);

    for (const locale of SUPPORTED_LOCALES) {
      expect(screen.getAllByTestId(`language-${locale.code}-button`).length).toBeGreaterThan(0);
    }
    // A popular language now appears both as a chip and as an overlay row.
    expect(screen.getAllByTestId("language-en-button")).toHaveLength(2);
  });

  it("filters the overlay and reports when nothing matches", async () => {
    const user = userEvent.setup();
    renderStep2();

    await user.click(screen.getAllByRole("button", { name: /other/i })[0]);
    const search = screen.getByPlaceholderText("Search languages...");

    await user.type(search, "portug");
    expect(screen.getByTestId("language-pt-button")).toBeInTheDocument();
    expect(screen.queryByTestId("language-it-button")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzzz");
    expect(screen.getByText("No languages found")).toBeInTheDocument();
  });

  it("substitutes the selected language into the chips when it is not popular", () => {
    renderStep2("pt");

    expect(screen.getByTestId("language-pt-button")).toBeInTheDocument();
    // It takes the last popular slot rather than growing the row.
    expect(screen.queryByTestId("language-ko-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("language-en-button")).toBeInTheDocument();
  });
});

describe("OnboardingStep2 currency picker", () => {
  it("names and finds currencies in the app language", async () => {
    const user = userEvent.setup();
    const i18n = createInstance();
    await i18n.init({
      lng: "de",
      resources: { de: { common: deCommon, onboarding: deOnboarding, ui: deUi } },
      interpolation: { escapeValue: false },
    });
    mocks.settings = { language: "de" };
    render(
      <I18nextProvider i18n={i18n}>
        <OnboardingStep2 onNext={vi.fn()} onValidityChange={vi.fn()} />
      </I18nextProvider>,
    );

    const currencyChips = screen.getByTestId("currency-usd-button").parentElement!;
    await user.click(within(currencyChips).getByRole("button", { name: /Andere/ }));
    await user.type(screen.getByPlaceholderText("Währungen suchen..."), "Franken");

    expect(screen.getByRole("button", { name: /Schweizer Franken \(CHF\)/ })).toBeInTheDocument();
  });
});
