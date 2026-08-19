import { NavigationStyleSelector } from "@/components/navigation-style-selector";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import {
  NAVIGATION_MODE_STORAGE_KEY,
  type NavigationMode,
} from "@/pages/layouts/navigation/navigation-mode-context";
import { Icons } from "@wealthfolio/ui";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export interface OnboardingAppearanceHandle {
  submitForm: () => void;
}

interface OnboardingAppearanceProps {
  onNext: () => void;
  onValidityChange: (isValid: boolean) => void;
}

export const OnboardingAppearance = forwardRef<
  OnboardingAppearanceHandle,
  OnboardingAppearanceProps
>(({ onNext, onValidityChange }, ref) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();
  const fonts = useMemo(
    () => [
      {
        value: "font-mono",
        label: t("onboarding:appearance.fonts.monoLabel"),
        description: t("onboarding:appearance.fonts.monoDescription"),
      },
      {
        value: "font-sans",
        label: t("onboarding:appearance.fonts.sansLabel"),
        description: t("onboarding:appearance.fonts.sansDescription"),
      },
      {
        value: "font-serif",
        label: t("onboarding:appearance.fonts.serifLabel"),
        description: t("onboarding:appearance.fonts.serifDescription"),
      },
    ],
    [t],
  );
  const [theme, setTheme] = useState<string>(settings?.theme ?? "system");
  const [font, setFont] = useState<string>(settings?.font ?? "font-mono");
  const { isMobile } = usePlatform();
  // Navigation style lives in localStorage (read by NavigationModeProvider on app
  // load); it only applies on large screens, so the picker is desktop-only.
  const [navMode, setNavMode] = usePersistentState<NavigationMode>(
    NAVIGATION_MODE_STORAGE_KEY,
    "sidebar",
  );

  useEffect(() => {
    // Always valid since we have defaults
    onValidityChange(true);
  }, [onValidityChange]);

  useImperativeHandle(ref, () => ({
    submitForm() {
      updateSettings({ theme, font })
        .then(() => onNext())
        .catch((error) => console.error("Failed to save appearance settings:", error));
    },
  }));

  // Apply theme/font preview when user selects them
  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    updateSettings({ theme: newTheme }).catch(console.error);
  };

  const handleFontChange = (newFont: string) => {
    setFont(newFont);
    updateSettings({ font: newFont }).catch(console.error);
  };

  return (
    <div className="w-full max-w-2xl space-y-4">
      <div className="text-center">
        <p className="text-muted-foreground">{t("onboarding:appearance.subtitle")}</p>
      </div>

      <Card className="border-none bg-transparent shadow-none">
        <CardContent className="space-y-3 p-0 sm:p-4">
          {/* Theme Selection */}
          <div>
            <div className="mb-3 flex items-center gap-2.5">
              <div className="bg-muted rounded-md p-1.5">
                <Icons.Palette className="text-muted-foreground size-4" />
              </div>
              <span className="text-base font-semibold">
                {t("onboarding:appearance.themeLabel")}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              {/* Light Theme */}
              <button
                type="button"
                data-testid="theme-light-button"
                onClick={() => handleThemeChange("light")}
                className={cn(
                  "group relative overflow-hidden rounded-xl border-2 transition-all duration-200",
                  theme === "light"
                    ? "border-primary ring-primary/20 ring-2"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="h-20 overflow-hidden rounded-t-lg sm:h-24">
                  <img
                    src="/themes/theme-light.webp"
                    srcSet="/themes/theme-light.webp 1x, /themes/theme-light@2x.webp 2x"
                    alt={t("onboarding:appearance.themeLightPreviewAlt")}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div
                  className={cn(
                    "flex items-center justify-center gap-2 py-2.5",
                    theme === "light" ? "bg-primary/10" : "bg-muted/50",
                  )}
                >
                  <Icons.Sun
                    className={cn(
                      "h-4 w-4",
                      theme === "light" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm font-medium">
                    {t("onboarding:appearance.themeLight")}
                  </span>
                </div>
                {theme === "light" && (
                  <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
                    <Icons.Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>

              {/* Dark Theme */}
              <button
                type="button"
                onClick={() => handleThemeChange("dark")}
                className={cn(
                  "group relative overflow-hidden rounded-xl border-2 transition-all duration-200",
                  theme === "dark"
                    ? "border-primary ring-primary/20 ring-2"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="h-20 overflow-hidden rounded-t-lg sm:h-24">
                  <img
                    src="/themes/theme-dark.webp"
                    srcSet="/themes/theme-dark.webp 1x, /themes/theme-dark@2x.webp 2x"
                    alt={t("onboarding:appearance.themeDarkPreviewAlt")}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div
                  className={cn(
                    "flex items-center justify-center gap-2 py-2.5",
                    theme === "dark" ? "bg-primary/10" : "bg-muted/50",
                  )}
                >
                  <Icons.Moon
                    className={cn(
                      "h-4 w-4",
                      theme === "dark" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm font-medium">
                    {t("onboarding:appearance.themeDark")}
                  </span>
                </div>
                {theme === "dark" && (
                  <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
                    <Icons.Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>

              {/* System Theme */}
              <button
                type="button"
                onClick={() => handleThemeChange("system")}
                className={cn(
                  "group relative overflow-hidden rounded-xl border-2 transition-all duration-200",
                  theme === "system"
                    ? "border-primary ring-primary/20 ring-2"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="h-20 overflow-hidden rounded-t-lg sm:h-24">
                  <img
                    src="/themes/theme-system.webp"
                    srcSet="/themes/theme-system.webp 1x, /themes/theme-system@2x.webp 2x"
                    alt={t("onboarding:appearance.themeSystemPreviewAlt")}
                    className="h-full w-full object-cover object-top"
                  />
                </div>
                <div
                  className={cn(
                    "flex items-center justify-center gap-2 py-2.5",
                    theme === "system" ? "bg-primary/10" : "bg-muted/50",
                  )}
                >
                  <Icons.Monitor
                    className={cn(
                      "h-4 w-4",
                      theme === "system" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm font-medium">
                    {t("onboarding:appearance.themeSystem")}
                  </span>
                </div>
                {theme === "system" && (
                  <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
                    <Icons.Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* Font Selection */}
          <div>
            <div className="mb-3 flex items-center gap-2.5">
              <div className="bg-muted rounded-md p-1.5">
                <Icons.Type className="text-muted-foreground size-4" />
              </div>
              <span className="text-base font-semibold">
                {t("onboarding:appearance.fontLabel")}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              {fonts.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => handleFontChange(f.value)}
                  className={cn(
                    "group relative flex flex-col overflow-hidden rounded-xl border-2 transition-all duration-200",
                    font === f.value
                      ? "border-primary ring-primary/20 ring-2"
                      : "border-border hover:border-primary/50",
                    f.value,
                  )}
                >
                  {/* Font preview area */}
                  <div className="bg-muted/30 flex flex-1 flex-col items-center justify-center px-3 py-3 text-center">
                    <div className="w-full space-y-1.5">
                      {/* Font name as hero */}
                      <div className="text-lg font-medium tracking-tight sm:text-xl">{f.label}</div>
                      {/* Sample text paragraph */}
                      <div className="text-muted-foreground text-[11px] leading-snug sm:text-xs">
                        {t("onboarding:appearance.fontSample")}
                      </div>
                      {/* Secondary: numbers sample */}
                      <div className="text-muted-foreground/60 whitespace-nowrap text-[11px] sm:text-xs">
                        12345 · $1,234
                      </div>
                    </div>
                  </div>
                  {/* Label area */}
                  <div
                    className={cn(
                      "flex min-h-10 w-full items-center justify-center px-3 py-2.5 text-center",
                      font === f.value ? "bg-primary/10" : "bg-muted/50",
                    )}
                  >
                    <div className="text-muted-foreground text-xs leading-tight">
                      {f.description}
                    </div>
                  </div>
                  {font === f.value && (
                    <div className="bg-primary absolute right-2 top-2 rounded-full p-0.5">
                      <Icons.Check className="h-3 w-3 text-white" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Navigation Style — desktop only (mobile always uses the mobile nav) */}
          {!isMobile && (
            <div>
              <div className="mb-3 flex items-center gap-2.5">
                <div className="bg-muted rounded-md p-1.5">
                  <Icons.PanelLeft className="text-muted-foreground size-4" />
                </div>
                <span className="text-base font-semibold">
                  {t("onboarding:appearance.navigationLabel")}
                </span>
              </div>

              <NavigationStyleSelector
                value={navMode}
                onChange={setNavMode}
                className="grid-cols-3 gap-3 sm:gap-4"
                compact
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
});

OnboardingAppearance.displayName = "OnboardingAppearance";
