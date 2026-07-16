import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { LanguageSelector } from "@/components/language-selector";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  detectBrowserTimezone,
  getSupportedTimezones,
  resolveInitialTimezone,
} from "./timezone-settings";
import { TimezoneInput } from "./timezone-input";

export function LanguageRegionSettings() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();

  const language = settings?.language || DEFAULT_LOCALE;
  const timezone = resolveInitialTimezone(settings?.timezone);

  const browserTimezone = useMemo(() => detectBrowserTimezone(), []);
  const timezones = useMemo(() => {
    const supported = getSupportedTimezones();
    // Put the detected browser timezone first for easy access.
    return [browserTimezone, ...supported.filter((tz) => tz !== browserTimezone)];
  }, [browserTimezone]);

  const handleLanguageChange = async (nextLanguage: string) => {
    await updateSettings({ language: nextLanguage });
  };

  const handleTimezoneChange = async (nextTimezone: string) => {
    await updateSettings({ timezone: nextTimezone });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("settings:language_region_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("settings:languageSettings.title")}</h3>
            <p className="text-muted-foreground text-sm">
              {t("settings:languageSettings.description")}
            </p>
          </div>
          <LanguageSelector
            value={language}
            onChange={handleLanguageChange}
            className="w-full max-w-[360px]"
          />
        </section>

        <Separator />

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("settings:timezone_title")}</h3>
            <p className="text-muted-foreground text-sm">{t("settings:timezone_description")}</p>
          </div>
          <div className="w-full max-w-[360px]">
            <TimezoneInput value={timezone} onChange={handleTimezoneChange} timezones={timezones} />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
