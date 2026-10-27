import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { FontSelector } from "@/components/font-selector";
import { gainColorLabelKeys, GainColorsSelector } from "@/components/gain-colors-selector";
import { NavigationStyleSelector } from "@/components/navigation-style-selector";
import { TextSizeSelector } from "@/components/text-size-selector";
import { ThemePicker } from "@/components/theme-picker";
import { ThemeSelector } from "@/components/theme-selector";
import { Button, Icons } from "@wealthfolio/ui";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@wealthfolio/ui/components/ui/form";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import { requiredError } from "@/lib/zod-errors";
import { useNavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";
import { resolveGainColors } from "@/themes/gain-colors";
import { designedForKeys, fontLabelKeys, themeSelectionUpdate } from "@/themes/selection";
import { isThemeId, resolveThemeId, themes } from "@/themes/themes";

interface AppearanceFormValues {
  theme: "light" | "dark" | "system";
  font: "font-mono" | "font-sans" | "font-serif";
  menuBarVisible: boolean;
}

// A row's text keeps this width, so on a phone its control wraps below it
// rather than squeezing the title.
const controlRowContentClassName = "min-w-48";

const switchModeKeys = {
  dark: "settings:appearance_switch_to_dark",
  light: "settings:appearance_switch_to_light",
} as const;

export function AppearanceForm() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();
  const { isMobile, isMacOS, isTauri } = usePlatform();
  const { mode: navigationMode, setMode: setNavigationMode } = useNavigationMode();
  const appearanceFormSchema = z.object({
    theme: z.enum(["light", "dark", "system"], {
      error: requiredError(t("settings:appearance_theme_required")),
    }),
    font: z.enum(["font-mono", "font-sans", "font-serif"], {
      // An unknown font name keeps the default message.
      error: (issue) =>
        issue.input === undefined
          ? t("settings:appearance_font_required")
          : typeof issue.input === "string"
            ? undefined
            : t("settings:appearance_font_error"),
    }),
    menuBarVisible: z.boolean(),
  });
  const defaultValues: Partial<AppearanceFormValues> = {
    theme: settings?.theme as AppearanceFormValues["theme"],
    font: settings?.font as AppearanceFormValues["font"],
    menuBarVisible: settings?.menuBarVisible ?? true,
  };
  const form = useForm<AppearanceFormValues>({
    resolver: zodResolver(appearanceFormSchema),
    values: defaultValues as AppearanceFormValues,
  });
  const activeTheme = themes.find(({ id }) => id === resolveThemeId(settings?.themeId));
  const ModeIcon = activeTheme?.mode === "dark" ? Icons.Moon : Icons.Sun;
  const fontDiffersFromTheme = !!activeTheme?.font && settings?.font !== activeTheme.font;

  function handlePartialUpdate(data: Parameters<typeof updateSettings>[0]) {
    updateSettings(data).catch((error) => {
      console.error("Failed to update appearance settings:", error);
    });
  }

  // Picking a theme also applies the font it suggests; the mode stays the user's.
  function selectTheme(themeId: string) {
    if (isThemeId(themeId)) handlePartialUpdate(themeSelectionUpdate(themeId));
  }

  return (
    <Form {...form}>
      <div className="max-w-4xl space-y-8">
        <FormField
          control={form.control}
          name="theme"
          render={({ field }) => (
            <Item variant="outline" size="sm">
              <ItemContent className={controlRowContentClassName}>
                <ItemTitle>{t("settings:appearance_mode_title")}</ItemTitle>
                <ItemDescription>{t("settings:appearance_mode_description")}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <ThemeSelector
                  aria-label={t("settings:appearance_mode_title")}
                  value={field.value}
                  onChange={(value) => {
                    field.onChange(value);
                    handlePartialUpdate({ theme: value });
                  }}
                />
              </ItemActions>
            </Item>
          )}
        />

        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-medium">{t("settings:appearance_theme_title")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("settings:appearance_theme_description")}
            </p>
          </div>
          <ThemePicker value={settings?.themeId} font={settings?.font} onChange={selectTheme} />
          {activeTheme?.mode && (
            // Shown only while the other mode is in effect, including through System.
            <div
              className={cn(
                "bg-muted/40 items-center gap-3 rounded-lg border px-4 py-3",
                activeTheme.mode === "dark" ? "flex dark:hidden" : "hidden dark:flex",
              )}
            >
              <ModeIcon className="text-muted-foreground size-4 shrink-0" />
              <p className="min-w-0 flex-1 text-sm">
                {t(designedForKeys[activeTheme.mode], { theme: activeTheme.name })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  const mode = activeTheme.mode;
                  if (mode) handlePartialUpdate({ theme: mode });
                }}
              >
                {t(switchModeKeys[activeTheme.mode])}
              </Button>
            </div>
          )}
          <div className="rounded-md border">
            <FormField
              control={form.control}
              name="font"
              render={({ field }) => (
                <Item size="sm">
                  <ItemContent className={controlRowContentClassName}>
                    <ItemTitle>{t("settings:appearance_font_title")}</ItemTitle>
                    <ItemDescription>
                      {activeTheme?.font
                        ? t("settings:appearance_theme_suggests", {
                            theme: activeTheme.name,
                            value: t(fontLabelKeys[activeTheme.font]),
                          })
                        : t("settings:appearance_font_description")}
                    </ItemDescription>
                    {fontDiffersFromTheme && activeTheme && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto self-start px-0"
                        onClick={() => handlePartialUpdate(themeSelectionUpdate(activeTheme.id))}
                      >
                        {t("settings:appearance_use_theme_defaults")}
                      </Button>
                    )}
                  </ItemContent>
                  <ItemActions>
                    <FontSelector
                      aria-label={t("settings:appearance_font_title")}
                      value={field.value}
                      onChange={(value) => {
                        field.onChange(value);
                        handlePartialUpdate({ font: value });
                      }}
                    />
                  </ItemActions>
                </Item>
              )}
            />
            <ItemSeparator />
            {/* A container: the size names show when this row has room for them. */}
            <Item size="sm" className="@container">
              <ItemContent className={controlRowContentClassName}>
                <ItemTitle>{t("settings:appearance_text_size_title")}</ItemTitle>
                <ItemDescription>{t("settings:appearance_text_size_description")}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <TextSizeSelector
                  aria-label={t("settings:appearance_text_size_title")}
                  value={settings?.textSize}
                  onChange={(textSize) => handlePartialUpdate({ textSize })}
                />
              </ItemActions>
            </Item>
            <ItemSeparator />
            {/* The control shows each option's arrows only, so the selected option's
                name sits under the description, which wraps rather than clamps. */}
            <Item size="sm">
              <ItemContent className={controlRowContentClassName}>
                <ItemTitle>{t("settings:appearance_gain_colors_title")}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {t("settings:appearance_gain_colors_description")}
                </ItemDescription>
                <p className="text-sm font-medium">
                  {t(gainColorLabelKeys[resolveGainColors(settings?.gainColors)])}
                </p>
              </ItemContent>
              <ItemActions>
                <GainColorsSelector
                  aria-label={t("settings:appearance_gain_colors_title")}
                  value={settings?.gainColors}
                  onChange={(gainColors) => handlePartialUpdate({ gainColors })}
                />
              </ItemActions>
            </Item>
          </div>
        </section>

        {!isMobile && (
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-base font-medium">{t("settings:appearance_navigation_title")}</p>
              <p className="text-muted-foreground text-sm">
                {t("settings:appearance_navigation_description")}
              </p>
            </div>
            <NavigationStyleSelector
              value={navigationMode}
              onChange={setNavigationMode}
              className="max-w-md"
            />
          </div>
        )}

        {!isMobile && !(isTauri && isMacOS) && (
          <FormField
            control={form.control}
            name="menuBarVisible"
            render={({ field }) => (
              <FormItem>
                <Item variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      <FormLabel>{t("settings:appearance_menu_bar")}</FormLabel>
                    </ItemTitle>
                    <FormDescription>
                      {t("settings:appearance_menu_bar_description")}
                    </FormDescription>
                  </ItemContent>
                  <ItemActions>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={(value) => {
                          field.onChange(value);
                          handlePartialUpdate({ menuBarVisible: value });
                        }}
                      />
                    </FormControl>
                  </ItemActions>
                </Item>
              </FormItem>
            )}
          />
        )}
      </div>
    </Form>
  );
}
