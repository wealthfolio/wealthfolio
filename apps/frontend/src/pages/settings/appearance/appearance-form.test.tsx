import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppearanceForm } from "./appearance-form";

const platform = vi.hoisted(() => ({ isMobile: false, isMacOS: false, isTauri: true }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => platform }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { theme: "light", font: "font-mono", menuBarVisible: true },
    updateSettings: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock("@/pages/layouts/navigation/navigation-mode-context", () => ({
  useNavigationMode: () => ({ mode: "sidebar", setMode: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  platform.isMobile = false;
  platform.isMacOS = false;
  platform.isTauri = true;
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

it("leaves the web app's menu bar setting alone on macOS", () => {
  platform.isMacOS = true;
  platform.isTauri = false;
  render(<AppearanceForm />);
  expect(screen.getByText("settings:appearance_menu_bar")).toBeInTheDocument();
});
