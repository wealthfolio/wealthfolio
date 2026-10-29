import {
  controlRowControlClassName,
  FontRow,
  GainColorsRow,
  TextSizeRow,
} from "@/components/appearance-rows";
import { ThemeModeNote } from "@/components/theme-mode-note";
import { ThemePicker } from "@/components/theme-picker";
import { ThemeSelector } from "@/components/theme-selector";
import { usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import { mayUseRedForGains } from "@/themes/gain-colors";
import { themeSelectionUpdate } from "@/themes/selection";
import { isThemeId, resolveThemeId, themes } from "@/themes/themes";
import { Icons } from "@wealthfolio/ui";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";
import { ItemSeparator } from "@wealthfolio/ui/components/ui/item";
import { forwardRef, useEffect, useId, useImperativeHandle } from "react";
import { useTranslation } from "react-i18next";

export interface OnboardingAppearanceHandle {
  submitForm: () => void;
}

interface OnboardingAppearanceProps {
  onNext: () => void;
  onValidityChange: (isValid: boolean) => void;
}

/**
 * The theme and how text and numbers look, from Settings → Appearance's own parts.
 * Each choice is saved, and restyles the page, as it is made.
 */
export const OnboardingAppearance = forwardRef<
  OnboardingAppearanceHandle,
  OnboardingAppearanceProps
>(({ onNext, onValidityChange }, ref) => {
  const { t } = useTranslation();
  const headingId = useId();
  const { settings, updateSettings } = useSettingsContext();
  const { isMobile } = usePlatform();
  const activeTheme = themes.find(({ id }) => id === resolveThemeId(settings?.themeId));

  useEffect(() => {
    onValidityChange(true);
  }, [onValidityChange]);

  // Every choice is already saved, so continuing has nothing left to save.
  useImperativeHandle(ref, () => ({ submitForm: onNext }));

  function save(data: Parameters<typeof updateSettings>[0]) {
    updateSettings(data).catch((error) => {
      console.error("Failed to save appearance settings:", error);
    });
  }

  // Picking a theme also applies the font it suggests; the mode stays the user's.
  function selectTheme(themeId: string) {
    if (isThemeId(themeId)) save(themeSelectionUpdate(themeId));
  }

  return (
    <div className="w-full max-w-4xl space-y-4">
      <p className="text-muted-foreground text-center">{t("onboarding:appearance.subtitle")}</p>

      <section aria-labelledby={headingId} className="space-y-3">
        {/* The mode sits beside the heading, as in Settings; on a phone it spans the
            row under it. The row is the container the mode names check. */}
        <div className="@container flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-muted rounded-md p-1.5">
              <Icons.Palette className="text-muted-foreground size-4" />
            </div>
            <h2 id={headingId} className="text-base font-semibold">
              {t("settings:appearance_theme_title")}
            </h2>
          </div>
          <ThemeSelector
            aria-label={t("settings:appearance_mode_title")}
            className={controlRowControlClassName}
            value={settings?.theme}
            testIdPrefix="theme"
            onChange={(theme) => save({ theme })}
          />
        </div>
        {/* A new user hasn't settled on a mode yet: show the themes designed for dark
            at their best, and the note offers dark once one is picked. */}
        <ThemePicker
          value={settings?.themeId}
          font={settings?.font}
          onChange={selectTheme}
          drawDesignedMode
        />
        <ThemeModeNote theme={activeTheme} onSwitch={(theme) => save({ theme })} />
      </section>

      <div className={cn(cardSurfaceClassName, "px-4 py-1")}>
        <FontRow
          value={settings?.font}
          theme={activeTheme}
          onChange={(font) => save({ font })}
          onUseThemeDefaults={() => {
            if (activeTheme) save(themeSelectionUpdate(activeTheme.id));
          }}
        />
        {/* iOS and Android start from the system's text size. */}
        {!isMobile && (
          <>
            <ItemSeparator />
            <TextSizeRow value={settings?.textSize} onChange={(textSize) => save({ textSize })} />
          </>
        )}
        {/* Asked only where red may mean up, from the previous step's choices. */}
        {mayUseRedForGains(settings) && (
          <>
            <ItemSeparator />
            <GainColorsRow
              value={settings?.gainColors}
              onChange={(gainColors) => save({ gainColors })}
            />
          </>
        )}
      </div>

      <p className="text-muted-foreground text-center text-xs">
        {t("onboarding:appearance.changeLater")}
      </p>
    </div>
  );
});

OnboardingAppearance.displayName = "OnboardingAppearance";
