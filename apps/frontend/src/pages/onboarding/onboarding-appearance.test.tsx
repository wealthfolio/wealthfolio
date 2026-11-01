import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { OnboardingAppearance, type OnboardingAppearanceHandle } from "./onboarding-appearance";

const platform = vi.hoisted(() => ({ isMobile: false }));
const context = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }));
vi.mock("@/lib/settings-provider", () => ({ useSettingsContext: () => context }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

// A new profile, as step 2 leaves it.
beforeEach(() => {
  platform.isMobile = false;
  context.settings = {
    themeId: "signature",
    theme: "light",
    font: "font-sans",
    language: "en",
    formattingRegion: "system",
    baseCurrency: "USD",
    gainColors: "green-up",
  };
  context.updateSettings.mockClear();
});

function renderStep() {
  const onNext = vi.fn();
  const ref = createRef<OnboardingAppearanceHandle>();
  render(<OnboardingAppearance ref={ref} onNext={onNext} onValidityChange={vi.fn()} />);
  return { onNext, ref };
}

it("starts on Signature and saves a picked theme with the font it suggests", () => {
  renderStep();
  expect(screen.getByRole("radio", { name: "Signature" })).toBeChecked();

  fireEvent.click(screen.getByRole("radio", { name: "Classic" }));
  expect(context.updateSettings).toHaveBeenCalledWith({ themeId: "classic", font: "font-mono" });
});

it("saves the mode, and keeps e2e's light mode button", () => {
  renderStep();
  fireEvent.click(screen.getByTestId("theme-dark-button"));
  expect(context.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
  expect(screen.getByTestId("theme-light-button")).toHaveAttribute("aria-pressed", "true");
});

it("offers dark for a theme designed for it", () => {
  context.settings.themeId = "terminal";
  renderStep();
  fireEvent.click(screen.getByRole("button", { name: "settings:appearance_switch_to_dark" }));
  expect(context.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
});

it("asks for the text size on desktop and the web", () => {
  renderStep();
  expect(
    screen.getByRole("group", { name: "settings:appearance_text_size_title" }),
  ).toBeInTheDocument();
});

it("leaves the text size to the system on phones", () => {
  platform.isMobile = true;
  renderStep();
  expect(
    screen.queryByRole("group", { name: "settings:appearance_text_size_title" }),
  ).not.toBeInTheDocument();
});

it("asks for gain and loss colours only where red may mean up", () => {
  renderStep();
  expect(
    screen.queryByRole("group", { name: "settings:appearance_gain_colors_title" }),
  ).not.toBeInTheDocument();
});

it("asks for gain and loss colours after a language where red means up", () => {
  context.settings.language = "zh";
  renderStep();
  fireEvent.click(screen.getByRole("button", { name: "settings:appearance_gain_colors_red_up" }));
  expect(context.updateSettings).toHaveBeenCalledWith({ gainColors: "red-up" });
});

it("has nothing left to save when continuing", () => {
  const { onNext, ref } = renderStep();
  ref.current?.submitForm();
  expect(onNext).toHaveBeenCalledOnce();
  expect(context.updateSettings).not.toHaveBeenCalled();
});

it("leaves navigation to Settings", () => {
  renderStep();
  expect(screen.queryByTestId("nav-sidebar-button")).not.toBeInTheDocument();
});
