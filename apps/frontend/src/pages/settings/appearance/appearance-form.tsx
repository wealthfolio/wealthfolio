import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { FontSelector } from "@/components/font-selector";
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
import { useI18n } from "@/i18n/i18n-provider";
import { useSettingsContext } from "@/lib/settings-provider";

const appearanceFormSchema = z.object({
  theme: z.enum(["light", "dark", "system"], {
    required_error: "Please select a theme.",
  }),
  font: z.enum(["font-mono", "font-sans", "font-serif"], {
    invalid_type_error: "Select a font",
    required_error: "Please select a font.",
  }),
  menuBarVisible: z.boolean(),
});

type AppearanceFormValues = z.infer<typeof appearanceFormSchema>;

export function AppearanceForm() {
  const { settings, updateSettings } = useSettingsContext();
  const { t } = useI18n();
  const { isMobile } = usePlatform();
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
                  {t("settings.appearance.font.label")}
                </FormLabel>
                <FormDescription className="text-sm">
                  {t("settings.appearance.font.description")}
                </FormDescription>
              </div>
              <FormControl>
                <FontSelector
                  value={field.value}
                  labels={{
                    "font-sans": t("settings.appearance.font.sans"),
                    "font-serif": t("settings.appearance.font.serif"),
                    "font-mono": t("settings.appearance.font.mono"),
                  }}
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
                <FormLabel className="text-base font-medium">
                  {t("settings.appearance.theme.label")}
                </FormLabel>
                <FormDescription className="text-sm">
                  {t("settings.appearance.theme.description")}
                </FormDescription>
              </div>
              <FormMessage />
              <FormControl>
                <ThemeSelector
                  value={field.value}
                  labels={{
                    light: t("settings.appearance.theme.light"),
                    dark: t("settings.appearance.theme.dark"),
                    system: t("settings.appearance.theme.system"),
                  }}
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
          <FormField
            control={form.control}
            name="menuBarVisible"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
                <div className="space-y-0.5">
                  <FormLabel>{t("settings.appearance.menuBar.label")}</FormLabel>
                  <FormDescription>{t("settings.appearance.menuBar.description")}</FormDescription>
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
