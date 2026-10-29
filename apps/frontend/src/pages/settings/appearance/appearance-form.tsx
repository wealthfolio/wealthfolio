import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import {
  controlRowControlClassName,
  FontRow,
  GainColorsRow,
  TextSizeRow,
} from "@/components/appearance-rows";
import { NavigationStyleSelector } from "@/components/navigation-style-selector";
import { ThemeModeNote } from "@/components/theme-mode-note";
import { ThemePicker } from "@/components/theme-picker";
import { ThemeSelector } from "@/components/theme-selector";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
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
  ItemSeparator,
  ItemTitle,
} from "@wealthfolio/ui/components/ui/item";
import { usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { requiredError } from "@/lib/zod-errors";
import { useNavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";
import { themeSelectionUpdate } from "@/themes/selection";
import { isThemeId, resolveThemeId, themes } from "@/themes/themes";

interface AppearanceFormValues {
  theme: "light" | "dark" | "system";
  font: "font-mono" | "font-sans" | "font-serif";
  menuBarVisible: boolean;
}

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
      <div className="max-w-4xl space-y-6">
        <Card>
          {/* The mode belongs with the theme: every theme has a light and a dark
              appearance. On a phone the header is one column and the mode spans it,
              under the text; the header is the container the mode names check. */}
          <CardHeader className="@container max-sm:has-data-[slot=card-action]:grid-cols-1">
            <CardTitle role="heading" aria-level={2} className="text-lg">
              {t("settings:appearance_theme_title")}
            </CardTitle>
            <CardDescription>{t("settings:appearance_theme_description")}</CardDescription>
            <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-1.5">
              <FormField
                control={form.control}
                name="theme"
                render={({ field }) => (
                  <ThemeSelector
                    aria-label={t("settings:appearance_mode_title")}
                    className={controlRowControlClassName}
                    value={field.value}
                    onChange={(value) => {
                      field.onChange(value);
                      handlePartialUpdate({ theme: value });
                    }}
                  />
                )}
              />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            <ThemePicker value={settings?.themeId} font={settings?.font} onChange={selectTheme} />
            <ThemeModeNote
              theme={activeTheme}
              onSwitch={(mode) => handlePartialUpdate({ theme: mode })}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="text-lg">
              {t("settings:appearance_text_numbers_title")}
            </CardTitle>
            <CardDescription>{t("settings:appearance_text_numbers_description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="font"
              render={({ field }) => (
                <FontRow
                  value={field.value}
                  theme={activeTheme}
                  onChange={(value) => {
                    field.onChange(value);
                    handlePartialUpdate({ font: value });
                  }}
                  onUseThemeDefaults={() => {
                    if (activeTheme) handlePartialUpdate(themeSelectionUpdate(activeTheme.id));
                  }}
                />
              )}
            />
            <ItemSeparator />
            <TextSizeRow
              value={settings?.textSize}
              onChange={(textSize) => handlePartialUpdate({ textSize })}
            />
            <ItemSeparator />
            <GainColorsRow
              value={settings?.gainColors}
              onChange={(gainColors) => handlePartialUpdate({ gainColors })}
            />
          </CardContent>
        </Card>

        {!isMobile && (
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2} className="text-lg">
                {t("settings:appearance_navigation_title")}
              </CardTitle>
              <CardDescription>{t("settings:appearance_navigation_description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* The same grid, card width and about the same height as the themes above. */}
              <NavigationStyleSelector
                value={navigationMode}
                onChange={setNavigationMode}
                className="sm:gap-3 lg:grid-cols-4"
                compact
              />
              {!(isTauri && isMacOS) && (
                <>
                  <ItemSeparator className="mt-4" />
                  <FormField
                    control={form.control}
                    name="menuBarVisible"
                    render={({ field }) => (
                      <FormItem>
                        <Item size="sm" className="px-0 pb-0">
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
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </Form>
  );
}
