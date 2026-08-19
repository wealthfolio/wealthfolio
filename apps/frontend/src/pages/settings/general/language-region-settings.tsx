import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { LanguageSelector } from "@/components/language-selector";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { useSettingsContext } from "@/lib/settings-provider";
import { createFormatter, resolveFormattingLocale } from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { TimezoneInput } from "./timezone-input";
import {
  detectBrowserTimezone,
  getSupportedTimezones,
  resolveInitialTimezone,
} from "./timezone-settings";

const FORMATTING_REGION_OPTIONS = [
  ["system", "system"],
  ["CA", "canada"],
  ["US", "unitedStates"],
  ["GB", "unitedKingdom"],
  ["FR", "france"],
  ["DE", "germany"],
  ["ES", "spain"],
  ["MX", "mexico"],
  ["CN", "china"],
  ["JP", "japan"],
  ["KR", "southKorea"],
] as const;

export function LanguageRegionSettings() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();

  const language = settings?.language || DEFAULT_LOCALE;
  const timezone = resolveInitialTimezone(settings?.timezone);
  const formattingRegion = settings?.formattingRegion || "system";

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

  const preview = useMemo(() => {
    const formatter = createFormatter(resolveFormattingLocale(formattingRegion), timezone);
    const sample = new Date(2026, 6, 10, 14, 30);
    return [
      formatter.formatDate(sample, { dateStyle: "short" }),
      formatter.formatDecimal(1234.56, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      formatter.formatAmount(1234.56, "CAD"),
      formatter.formatTime(sample, { timeStyle: "short" }),
    ].join(" · ");
  }, [formattingRegion, timezone]);

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
            <h3 className="text-sm font-medium">
              {t("settings:formattingRegion.title", "Region & formats")}
            </h3>
            <p className="text-muted-foreground text-sm">
              {t(
                "settings:formattingRegion.description",
                "Controls dates, times, number separators, percentages, and currency presentation.",
              )}
            </p>
          </div>
          <Select
            value={formattingRegion}
            onValueChange={(value) => updateSettings({ formattingRegion: value })}
          >
            <SelectTrigger className="w-full max-w-[360px]" data-testid="formatting-locale-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATTING_REGION_OPTIONS.map(([value, labelKey]) => (
                <SelectItem key={value} value={value}>
                  {value === "system"
                    ? `${t(`settings:formattingRegion.options.${labelKey}`)} (${resolveFormattingLocale(value)})`
                    : t(`settings:formattingRegion.options.${labelKey}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p
            className="text-muted-foreground text-sm tabular-nums"
            data-testid="formatting-locale-preview"
          >
            {preview}
          </p>
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
