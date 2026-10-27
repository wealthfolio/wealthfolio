import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsProvider } from "@/lib/settings-provider";
import type { Settings } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  dynamicType: vi.fn<() => number | undefined>(),
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
// jsdom has no Dynamic Type: the iOS tests set the measured scale.
vi.mock("@/themes/text-size", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/themes/text-size")>()),
  measureDynamicTypeScale: () => mocks.dynamicType(),
}));
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
  settings.textSize = undefined;
  settings.gainColors = undefined;
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-text-size");
  document.documentElement.removeAttribute("data-gain-colors");
  delete (window as unknown as { wealthfolioSystemTextScale?: number }).wealthfolioSystemTextScale;
  mocks.dynamicType.mockReturnValue(undefined);
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

it("applies the saved gain and loss colours and caches them for the next start", async () => {
  settings.gainColors = "red-up-blue-down";
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });

  render(<SettingsProvider>content</SettingsProvider>);

  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute("data-gain-colors", "red-up-blue-down"),
  );
  expect(localStorage.getItem("wealthfolio-gain-colors")).toBe("red-up-blue-down");
});

it("shows green up for missing or unknown gain and loss colours", async () => {
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });
  for (const gainColors of [undefined, "blue-up-orange-down"]) {
    settings.gainColors = gainColors;
    const { unmount } = render(<SettingsProvider>content</SettingsProvider>);
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-gain-colors", "green-up"),
    );
    unmount();
    document.documentElement.removeAttribute("data-gain-colors");
  }
});

it("applies the saved text size and caches it for the next start", async () => {
  settings.textSize = "extra-large";
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });

  render(<SettingsProvider>content</SettingsProvider>);

  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute("data-text-size", "extra-large"),
  );
  expect(localStorage.getItem("wealthfolio-text-size")).toBe("extra-large");
});

it("shows the default text size for a missing or unknown size", async () => {
  mocks.platform.mockResolvedValue({ os: "linux", is_mobile: false, is_desktop: true });
  for (const textSize of [undefined, "from-a-newer-version"]) {
    settings.textSize = textSize;
    const { unmount } = render(<SettingsProvider>content</SettingsProvider>);
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-text-size", "default"),
    );
    expect(localStorage.getItem("wealthfolio-text-size")).toBe("default");
    unmount();
    document.documentElement.removeAttribute("data-text-size");
  }
});

it("starts from the system's font scale until a text size is picked", async () => {
  mocks.platform.mockResolvedValue({ os: "android", is_mobile: true, is_desktop: false });
  const scaleGlobal = window as unknown as { wealthfolioSystemTextScale?: number };
  scaleGlobal.wealthfolioSystemTextScale = 1.3;
  try {
    settings.textSize = undefined;
    const { unmount } = render(<SettingsProvider>content</SettingsProvider>);
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-text-size", "extra-large"),
    );
    expect(localStorage.getItem("wealthfolio-text-size")).toBe("extra-large");
    unmount();

    // Once picked, the saved size wins over the system's.
    settings.textSize = "default";
    render(<SettingsProvider>content</SettingsProvider>);
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-text-size", "default"),
    );
  } finally {
    delete scaleGlobal.wealthfolioSystemTextScale;
  }
});

it("starts from iOS's Dynamic Type until a text size is picked", async () => {
  mocks.platform.mockResolvedValue({ os: "ios", is_mobile: true, is_desktop: false });
  mocks.dynamicType.mockReturnValue(21 / 17); // the "Extra Extra Large" text size
  settings.textSize = undefined;
  const { unmount } = render(<SettingsProvider>content</SettingsProvider>);
  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute("data-text-size", "extra-large"),
  );
  unmount();

  // A picked size wins: one scaling, never Dynamic Type's on top.
  settings.textSize = "large";
  render(<SettingsProvider>content</SettingsProvider>);
  await waitFor(() => expect(document.documentElement).toHaveAttribute("data-text-size", "large"));
});

it("measures Dynamic Type only in the iOS app", async () => {
  mocks.platform.mockResolvedValue({ os: "macos", is_mobile: false, is_desktop: true });
  mocks.dynamicType.mockReturnValue(21 / 17);
  settings.textSize = undefined;
  render(<SettingsProvider>content</SettingsProvider>);
  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute("data-text-size", "default"),
  );
  expect(mocks.dynamicType).not.toHaveBeenCalled();
});

it("applies a Dynamic Type change when the app comes back to the foreground", async () => {
  mocks.platform.mockResolvedValue({ os: "ios", is_mobile: true, is_desktop: false });
  mocks.dynamicType.mockReturnValue(1);
  settings.textSize = undefined;
  render(<SettingsProvider>content</SettingsProvider>);
  await waitFor(() =>
    expect(document.documentElement).toHaveAttribute("data-text-size", "default"),
  );

  mocks.dynamicType.mockReturnValue(19 / 17); // "Extra Large" in iOS Settings
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    // Going to the background changes nothing; coming back re-reads the size.
    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(document.documentElement).toHaveAttribute("data-text-size", "default");

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-text-size", "large"),
    );
    expect(localStorage.getItem("wealthfolio-text-size")).toBe("large");
  } finally {
    visibility.mockRestore();
  }
});
