import { StartupScreen } from "@/components/startup-screen";
import { useProfile } from "@/features/profiles/profile-context";
import { Button } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { isTauri, logger } from "@/adapters";
import { setAddonLocalizationSnapshot } from "@/addons/iframe/addon-sandbox-localization";
import { createContext, ReactNode, useContext, useEffect, useState } from "react";

import { getPlatform } from "@/hooks/use-platform";
import { useSettings } from "@/hooks/use-settings";
import { useSettingsMutation } from "@/hooks/use-settings-mutation";
import i18n, { LANGUAGE_STORAGE_KEY } from "@/i18n/i18n";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { Settings, SettingsContextType } from "@/lib/types";
import { FormattingProvider, resolveFormattingLocale } from "@wealthfolio/ui";

interface ExtendedSettingsContextType extends SettingsContextType {
  updateSettings: (
    updates: Partial<
      Pick<
        Settings,
        | "theme"
        | "font"
        | "language"
        | "formattingRegion"
        | "currencyFormattingRegions"
        | "baseCurrency"
        | "defaultReturnMetric"
        | "timezone"
        | "onboardingCompleted"
        | "menuBarVisible"
        | "syncEnabled"
        | "insightsOverviewLayout"
      >
    >,
  ) => Promise<void>;
  refetch: () => Promise<void>;
}

const SettingsContext = createContext<ExtendedSettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { data, error, isLoading, isError, refetch } = useSettings();
  const profile = useProfile();
  const { t } = useTranslation("common", { useSuspense: false });
  const [appearanceReady, setAppearanceReady] = useState(false);
  const [appearanceError, setAppearanceError] = useState<string>();
  const [appearanceAttempt, setAppearanceAttempt] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accountsGrouped, setAccountsGrouped] = useState(true);

  const updateMutation = useSettingsMutation(setSettings, applySettingsToDocument);

  const updateBaseCurrency = async (baseCurrency: Settings["baseCurrency"]) => {
    if (!settings) throw new Error("Settings not loaded");
    await updateMutation.mutateAsync({ baseCurrency });
  };

  // Batch update function
  const updateSettings = async (
    updates: Partial<
      Pick<
        Settings,
        | "theme"
        | "font"
        | "language"
        | "formattingRegion"
        | "currencyFormattingRegions"
        | "baseCurrency"
        | "defaultReturnMetric"
        | "timezone"
        | "onboardingCompleted"
        | "menuBarVisible"
        | "syncEnabled"
        | "insightsOverviewLayout"
      >
    >,
  ) => {
    if (!settings) throw new Error("Settings not loaded");
    await updateMutation.mutateAsync(updates);
  };

  useEffect(() => {
    let cancelled = false;
    if (data) {
      void applySettingsToDocument(data)
        .then(() => {
          if (!cancelled) {
            setSettings(data);
            setAppearanceReady(true);
            setAppearanceError(undefined);
          }
        })
        .catch(() => {
          if (!cancelled)
            setAppearanceError(
              t("profiles.appearanceFailed", {
                defaultValue: "Couldn’t load appearance settings.",
              }),
            );
        });
    }
    return () => {
      cancelled = true;
    };
  }, [data, appearanceAttempt, t]);

  // Cleanup any lingering listeners when provider unmounts
  useEffect(() => {
    return () => {
      try {
        appearanceGeneration += 1;
        cleanupSystemThemeListeners();
      } catch {
        // noop
      }
    };
  }, []);

  const contextValue: ExtendedSettingsContextType = {
    settings,
    isLoading,
    isError,
    updateBaseCurrency,
    updateSettings,
    refetch: async () => {
      await refetch();
    },
    accountsGrouped,
    setAccountsGrouped,
  };
  const formattingRegion = settings ? settings.formattingRegion : "system";
  const uiLocale = settings ? settings.language : DEFAULT_LOCALE;
  const resolvedFormattingLocale = resolveFormattingLocale(formattingRegion);
  const formattingTimezone = settings?.timezone || undefined;
  const currencyFormattingRegions = settings?.currencyFormattingRegions;

  useEffect(() => {
    setAddonLocalizationSnapshot({
      locale: resolvedFormattingLocale,
      uiLocale,
      timezone: formattingTimezone,
      currencyFormattingRegions,
    });
  }, [resolvedFormattingLocale, uiLocale, formattingTimezone, currencyFormattingRegions]);

  if (settings && !formattingRegion) {
    throw new Error("Loaded settings are missing the required formatting region");
  }
  if (settings && !uiLocale) {
    throw new Error("Loaded settings are missing the required UI language");
  }

  if (!appearanceReady)
    return (
      <StartupScreen error={appearanceError ?? (isError ? String(error) : undefined)}>
        {(isError || appearanceError) && (
          <>
            <Button
              onClick={() => {
                setAppearanceError(undefined);
                setAppearanceAttempt((n) => n + 1);
                void refetch();
              }}
            >
              {t("retry")}
            </Button>
            {profile && (
              <Button variant="ghost" onClick={profile.switchProfile}>
                {t("profiles.switch", { defaultValue: "Switch profile" })}
              </Button>
            )}
          </>
        )}
      </StartupScreen>
    );

  return (
    <SettingsContext.Provider value={contextValue}>
      <FormattingProvider
        locale={formattingRegion}
        uiLocale={uiLocale}
        timezone={formattingTimezone}
        currencyFormattingRegions={settings?.currencyFormattingRegions}
      >
        {children}
      </FormattingProvider>
    </SettingsContext.Provider>
  );
}

export function useSettingsContext() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettingsContext must be used within a SettingsProvider");
  }
  return context;
}
// Keep references to system theme listeners so we can clean up when switching modes
let appearanceGeneration = 0;
let tauriThemeUnlisten: (() => void) | null = null;
let mediaQueryList: MediaQueryList | null = null;
let mediaQueryUnsubscribe: (() => void) | null = null;

// Apply the resolved theme (light or dark) to the DOM
function applyResolvedTheme(resolved: "light" | "dark") {
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);
  document.documentElement.style.colorScheme = resolved;
}

// Cleanup any existing system listeners
function cleanupSystemThemeListeners() {
  if (tauriThemeUnlisten) {
    try {
      tauriThemeUnlisten();
    } catch {
      // noop
    }
    tauriThemeUnlisten = null;
  }
  if (mediaQueryUnsubscribe) {
    try {
      mediaQueryUnsubscribe();
    } catch {
      // noop
    }
    mediaQueryUnsubscribe = null;
  }
  mediaQueryList = null;
}

// Only desktop windows follow the OS theme; tao's iOS and Android windows
// always report light.
async function getDesktopWindow() {
  if (!isTauri) return null;
  const platform = await getPlatform();
  if (!platform.is_desktop) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

// Helper function to apply settings to the document
const applySettingsToDocument = async (newSettings: Settings) => {
  const application = ++appearanceGeneration;
  // Apply the stored language. This is the single source of truth for the UI
  // language — on initial load and on every change (including device-synced ones).
  const language = newSettings.language || DEFAULT_LOCALE;
  if (i18n.language !== language || !i18n.isInitialized) {
    await i18n.changeLanguage(language).catch(() => i18n.changeLanguage(DEFAULT_LOCALE));
  }
  if (application !== appearanceGeneration) return;
  document.documentElement.setAttribute("lang", language);
  document.documentElement.setAttribute("dir", i18n.dir(language));

  // Font classes
  document.body.classList.remove("font-mono", "font-sans", "font-serif");
  document.body.classList.add(newSettings.font);

  // Cache pre-auth presentation settings so bootstrap UI does not flash defaults.
  try {
    localStorage.setItem("wealthfolio-theme", newSettings.theme);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // noop – localStorage may be unavailable
  }

  // Always clean up previous listeners before applying a new theme mode
  cleanupSystemThemeListeners();

  // Handle theme mode
  if (newSettings.theme === "system") {
    // Resolve initial theme from media query (immediate), fallback to light
    let initial: "light" | "dark" = "dark";
    if (typeof window !== "undefined" && window.matchMedia) {
      mediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
      initial = mediaQueryList.matches ? "dark" : "light";
      const handler = (e: MediaQueryListEvent) => applyResolvedTheme(e.matches ? "dark" : "light");
      if (mediaQueryList.addEventListener) {
        mediaQueryList.addEventListener("change", handler);
        mediaQueryUnsubscribe = () => mediaQueryList?.removeEventListener("change", handler);
      } else {
        // Legacy API support - addListener is deprecated but needed for older browsers
        mediaQueryList.addListener(handler);
        mediaQueryUnsubscribe = () => {
          try {
            mediaQueryList?.removeListener(handler);
          } catch {
            // noop
          }
        };
      }
    }

    // On desktop, also sync with the window theme + listen to OS changes
    (async () => {
      try {
        const currentWindow = await getDesktopWindow();
        if (!currentWindow || application !== appearanceGeneration) return;
        await currentWindow.setTheme(null);
        const current = await currentWindow.theme();
        if (application !== appearanceGeneration) return;
        if (current === "dark" || current === "light") {
          applyResolvedTheme(current);
        }
        const unlisten = await currentWindow.onThemeChanged(({ payload }) => {
          if (application !== appearanceGeneration) return;
          const next = payload === "dark" ? "dark" : "light";
          applyResolvedTheme(next);
        });
        if (application !== appearanceGeneration) unlisten();
        else tauriThemeUnlisten = unlisten;
      } catch {
        logger.error("Error setting window theme.");
      }
    })();

    applyResolvedTheme(initial);
    return;
  }

  // Explicit light/dark mode
  const explicit = newSettings.theme === "dark" ? "dark" : "light";
  applyResolvedTheme(explicit);

  // On desktop, match the window theme to the explicit mode
  (async () => {
    try {
      const currentWindow = await getDesktopWindow();
      if (!currentWindow || application !== appearanceGeneration) return;
      await currentWindow.setTheme(explicit);
    } catch {
      logger.error("Error setting window theme.");
    }
  })();
};
