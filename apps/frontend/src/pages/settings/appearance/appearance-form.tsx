import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import { FontSelector } from "@/components/font-selector";
import { NavigationStyleSelector } from "@/components/navigation-style-selector";
import { ThemeSelector } from "@/components/theme-selector";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { usePlatform } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import { useNavigationMode } from "@/pages/layouts/navigation/navigation-mode-context";

interface AppearanceFormValues {
  theme: "light" | "dark" | "system";
  font: "font-mono" | "font-sans" | "font-serif";
  menuBarVisible: boolean;
}

export function AppearanceForm() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();
  const { isMobile } = usePlatform();
  const { mode: navigationMode, setMode: setNavigationMode } = useNavigationMode();
  const appearanceFormSchema = z.object({
    theme: z.enum(["light", "dark", "system"], {
      required_error: t("settings:appearance_theme_required"),
    }),
    font: z.enum(["font-mono", "font-sans", "font-serif"], {
      invalid_type_error: t("settings:appearance_font_error"),
      required_error: t("settings:appearance_font_required"),
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
    defaultValues,
  });

  function handlePartialUpdate(data: Partial<AppearanceFormValues>) {
    updateSettings(data).catch((error) => {
      console.error("Failed to update appearance settings:", error);
    });
  }

  return (
    <Form {...form}>
      <div className="max-w-4xl space-y-6">
        <FormField
          control={form.control}
          name="font"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <div className="space-y-1">
                <FormLabel className="text-base font-medium">
                  {t("settings:appearance_font_title")}
                </FormLabel>
                <FormDescription className="text-sm">
                  {t("settings:appearance_font_description")}
                </FormDescription>
              </div>
              <FormControl>
                <FontSelector
                  value={field.value}
                  onChange={(value) => {
                    field.onChange(value);
                    handlePartialUpdate({ font: value as AppearanceFormValues["font"] });
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="theme"
          render={({ field }) => (
            <FormItem className="space-y-3">
              <div className="space-y-1">
                <FormLabel className="text-base font-medium">{t("settings:theme")}</FormLabel>
                <FormDescription className="text-sm">
                  {t("settings:appearance_theme_description")}
                </FormDescription>
              </div>
              <FormMessage />
              <FormControl>
                <ThemeSelector
                  value={field.value}
                  onChange={(value) => {
                    field.onChange(value);
                    handlePartialUpdate({ theme: value as AppearanceFormValues["theme"] });
                  }}
                  className="pt-2"
                />
              </FormControl>
            </FormItem>
          )}
        />

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

        {!isMobile && (
          <FormField
            control={form.control}
            name="menuBarVisible"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
                <div className="space-y-0.5">
                  <FormLabel>{t("settings:appearance_menu_bar")}</FormLabel>
                  <FormDescription>{t("settings:appearance_menu_bar_description")}</FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={(value) => {
                      field.onChange(value);
                      handlePartialUpdate({ menuBarVisible: value });
                    }}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        )}
      </div>
    </Form>
  );
}
