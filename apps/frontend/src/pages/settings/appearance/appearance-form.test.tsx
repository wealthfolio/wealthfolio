import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppearanceForm } from "./appearance-form";

const platform = vi.hoisted(() => ({ isMobile: false, isMacOS: false, isTauri: true }));
const context = vi.hoisted(() => ({
  settings: { theme: "light", font: "font-mono", menuBarVisible: true } as Record<string, unknown>,
  updateSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }));
vi.mock("@/lib/settings-provider", () => ({ useSettingsContext: () => context }));
vi.mock("@/pages/layouts/navigation/navigation-mode-context", () => ({
  useNavigationMode: () => ({ mode: "sidebar", setMode: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  platform.isMobile = false;
  platform.isMacOS = false;
  platform.isTauri = true;
  context.settings = { theme: "light", font: "font-mono", menuBarVisible: true };
  context.updateSettings.mockClear();
});

it("offers the text size on phones too and saves the picked size", () => {
  platform.isMobile = true;
  context.settings.textSize = "large";
  render(<AppearanceForm />);

  const group = screen.getByRole("group", { name: "settings:appearance_text_size_title" });
  const large = screen.getByRole("button", { name: "settings:appearance_text_size_large" });
  expect(group).toContainElement(large);
  expect(large).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(
    screen.getByRole("button", { name: "settings:appearance_text_size_extra_large" }),
  );
  expect(context.updateSettings).toHaveBeenCalledWith({ textSize: "extra-large" });
});

it("shows the default text size when none is saved", () => {
  render(<AppearanceForm />);
  expect(
    screen.getByRole("button", { name: "settings:appearance_text_size_default" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("saves the gain and loss colours, starting from green up", () => {
  platform.isMobile = true;
  render(<AppearanceForm />);

  const group = screen.getByRole("group", { name: "settings:appearance_gain_colors_title" });
  const greenUp = screen.getByRole("button", { name: "settings:appearance_gain_colors_green_up" });
  expect(group).toContainElement(greenUp);
  expect(greenUp).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(
    screen.getByRole("button", { name: "settings:appearance_gain_colors_red_up_blue_down" }),
  );
  expect(context.updateSettings).toHaveBeenCalledWith({ gainColors: "red-up-blue-down" });
});

it("offers the menu bar setting in the Windows and Linux app", () => {
  render(<AppearanceForm />);
  expect(screen.getByText("settings:appearance_menu_bar")).toBeInTheDocument();
});

it("hides the menu bar setting in the macOS app, which always keeps its menu", () => {
  platform.isMacOS = true;
  render(<AppearanceForm />);
  expect(screen.queryByText("settings:appearance_menu_bar")).not.toBeInTheDocument();
});

it.each([false, true])(
  "hides the menu bar setting in the web app, which has no menu bar (macOS: %s)",
  (isMacOS) => {
    platform.isMacOS = isMacOS;
    platform.isTauri = false;
    render(<AppearanceForm />);
    expect(screen.queryByText("settings:appearance_menu_bar")).not.toBeInTheDocument();
  },
);
