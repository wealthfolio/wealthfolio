import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { useI18n } from "@/i18n/i18n-provider";
import {
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  type AppLanguage,
} from "@/i18n/languages";
import { useSettingsContext } from "@/lib/settings-provider";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";

const languageFormSchema = z.object({
  language: z.enum(["en", "zh-CN"], {
    required_error: "Please select a language.",
  }),
});

type LanguageFormValues = z.infer<typeof languageFormSchema>;

export function LanguageSettings() {
  const { settings, updateSettings } = useSettingsContext();
  const { t } = useI18n();
  const currentLanguage = normalizeLanguage(settings?.language);

  const form = useForm<LanguageFormValues>({
    resolver: zodResolver(languageFormSchema),
    defaultValues: {
      language: currentLanguage,
    },
    values: {
      language: currentLanguage,
    },
  });

  async function onSubmit(data: LanguageFormValues) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, data.language);
    } catch {
      // localStorage may be unavailable in restricted browser contexts.
    }
    await updateSettings({ language: data.language as AppLanguage });
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-lg">{t("settings.language.title")}</CardTitle>
          <CardDescription>{t("settings.language.description")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="language"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>{t("settings.language.label")}</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full max-w-[300px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map((language) => (
                          <SelectItem key={language.value} value={language.value}>
                            {language.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit">{t("settings.language.save")}</Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
