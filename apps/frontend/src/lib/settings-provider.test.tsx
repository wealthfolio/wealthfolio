import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsProvider } from "@/lib/settings-provider";
import type { Settings } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(),
  setTheme: vi.fn(),
  windowTheme: vi.fn(),
}));
vi.mock("@/adapters", () => ({
  isTauri: true,
  logger: { error: vi.fn() },
}));
vi.mock("@/hooks/use-platform", () => ({ getPlatform: () => mocks.platform() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTheme: (theme: string | null) => mocks.setTheme(theme),
    theme: () => mocks.windowTheme(),
    onThemeChanged: async () => () => {},
  }),
}));
vi.mock("@/features/profiles/profile-context", () => ({ useProfile: () => null }));
vi.mock("@/hooks/use-settings-mutation", () => ({
  useSettingsMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: settings,
    error: null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/i18n/i18n", () => ({
  LANGUAGE_STORAGE_KEY: "test-language",
  default: { language: "en", isInitialized: true, changeLanguage: vi.fn(), dir: () => "ltr" },
}));

const settings = {
  theme: "system",
  font: "font-mono",
  language: "en",
  formattingRegion: "system",
  timezone: "UTC",
  onboardingCompleted: true,
} as Settings;

// Lets the async window theme sync finish before checking its outcome.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  vi.clearAllMocks();
  settings.theme = "system";
  settings.themeId = undefined;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  // The OS prefers dark; native window themes report light, as tao does on mobile.
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: query === "(prefers-color-scheme: dark)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  mocks.windowTheme.mockResolvedValue("light");
});

it("keeps the system media query theme on mobile instead of the native window theme", async () => {
  mocks.platform.mockResolvedValue({ os: "android", is_mobile: true, is_desktop: false });

  render(<SettingsProvider>content</SettingsProvider>);

  await settle();
  expect(document.documentElement).toHaveClass("dark");
  expect(document.documentElement).not.toHaveClass("light");
  expect(mocks.windowTheme).not.toHaveBeenCalled();
});

it("follows the native window theme for system mode on desktop", async () => {
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });

  render(<SettingsProvider>content</SettingsProvider>);

  await waitFor(() => expect(document.documentElement).toHaveClass("light"));
  expect(mocks.windowTheme).toHaveBeenCalled();
});

it("leaves the window theme alone for explicit modes on mobile", async () => {
  settings.theme = "dark";
  mocks.platform.mockResolvedValue({ os: "android", is_mobile: true, is_desktop: false });

  render(<SettingsProvider>content</SettingsProvider>);

  await settle();
  expect(document.documentElement).toHaveClass("dark");
  expect(mocks.setTheme).not.toHaveBeenCalled();
});

it("sets the window theme for explicit modes on desktop", async () => {
  settings.theme = "dark";
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });

  render(<SettingsProvider>content</SettingsProvider>);

  await waitFor(() => expect(mocks.setTheme).toHaveBeenCalledWith("dark"));
});

it("applies the saved theme and caches it for the next start", async () => {
  settings.themeId = "ember";
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });

  render(<SettingsProvider>content</SettingsProvider>);

  await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "ember"));
  expect(localStorage.getItem("wealthfolio-theme-id")).toBe("ember");
});

it("shows Classic for a missing or unknown theme", async () => {
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });
  for (const themeId of [undefined, "from-a-newer-version"]) {
    settings.themeId = themeId;
    const { unmount } = render(<SettingsProvider>content</SettingsProvider>);
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "classic"));
    unmount();
    document.documentElement.removeAttribute("data-theme");
  }
});
