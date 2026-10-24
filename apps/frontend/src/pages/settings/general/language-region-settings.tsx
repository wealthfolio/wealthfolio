import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { LanguageSelector } from "@/components/language-selector";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  createAmountFormatting,
  createFormatter,
  CurrencyInput,
  resolveFormattingLocale,
  SearchableSelect,
} from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { cn } from "@wealthfolio/ui/lib/utils";
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
  ["IN", "india"],
  ["FR", "france"],
  ["DE", "germany"],
  ["AT", "austria"],
  ["CH", "switzerland"],
  ["ES", "spain"],
  ["MX", "mexico"],
  ["BR", "brazil"],
  ["PT", "portugal"],
  ["CN", "china"],
  ["TW", "taiwan"],
  ["JP", "japan"],
  ["KR", "southKorea"],
  ["IT", "italy"],
  ["RO", "romania"],
  ["BG", "bulgaria"],
  ["VN", "vietnam"],
] as const;

// A currency override names a concrete region; "system" is the global default.
const CURRENCY_REGION_OPTIONS = FORMATTING_REGION_OPTIONS.filter(([value]) => value !== "system");
const CURRENCY_FORMAT_SAMPLE = 1234567.89;

function CurrencyRegionSelect({
  id,
  value,
  onValueChange,
  label,
  placeholder,
  disabled,
  className,
  testId,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled: boolean;
  className: string;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={value}
      items={CURRENCY_REGION_OPTIONS.map(([region, labelKey]) => ({
        value: region,
        label: t(`settings:formattingRegion.options.${labelKey}`),
      }))}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={className} aria-label={label} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {CURRENCY_REGION_OPTIONS.map(([region, labelKey]) => (
          <SelectItem key={region} value={region}>
            {t(`settings:formattingRegion.options.${labelKey}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CurrencyFormatSettings() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettingsContext();
  const overrides = settings?.currencyFormattingRegions ?? {};
  const [newCurrency, setNewCurrency] = useState("");
  const [newRegion, setNewRegion] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const overrideCount = Object.keys(overrides).length;
  const idPrefix = useId();
  const controlId = (control: string) => `${idPrefix}${control}`;
  const focusAfterSave = useRef<string | null>(null);

  // Disabling the editor during a save drops keyboard focus to the page. Return
  // it to the control that started the save, or to the currency picker when that
  // control is gone or disabled.
  useEffect(() => {
    const control = focusAfterSave.current;
    if (saving || !control) return;
    focusAfterSave.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const target = document.getElementById(`${idPrefix}${control}`);
    const fallback = document.getElementById(`${idPrefix}new-currency`);
    (target && !target.matches(":disabled") ? target : fallback)?.focus();
  }, [saving, idPrefix]);

  // Each save replaces the whole map, so editing waits until the previous save
  // has updated the settings it builds on.
  const saveOverrides = async (
    currencyFormattingRegions: Record<string, string>,
    focusControl: string,
  ) => {
    focusAfterSave.current = focusControl;
    setSaving(true);
    try {
      await updateSettings({ currencyFormattingRegions });
      return true;
    } catch {
      // The settings mutation already reports the failure.
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeOverride = (currency: string) => {
    const { [currency]: _removed, ...rest } = overrides;
    void saveOverrides(rest, `remove-${currency}`);
  };

  const addOverride = async () => {
    if (!newCurrency || !newRegion) return;
    if (await saveOverrides({ ...overrides, [newCurrency]: newRegion }, "add")) {
      setNewCurrency("");
      setNewRegion("");
    }
  };

  const preview = (currency: string, region: string) => {
    const formatting = createAmountFormatting(region);
    return [
      formatting.formatAmount(CURRENCY_FORMAT_SAMPLE, currency),
      formatting.formatCompactAmount(CURRENCY_FORMAT_SAMPLE * 100, currency),
    ].join(" · ");
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<section className="space-y-3" />}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto w-full justify-between whitespace-normal px-0 py-1 text-start hover:bg-transparent has-[>svg]:px-0"
            data-testid="currency-formats-toggle"
          />
        }
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t("settings:currencyFormats.title")}</span>
          {overrideCount > 0 && (
            <Badge variant="secondary">
              {t("settings:currencyFormats.customCount", { count: overrideCount })}
            </Badge>
          )}
        </span>
        <Icons.ChevronDown
          className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{t("settings:currencyFormats.description")}</p>
        {Object.entries(overrides).map(([currency, region]) => (
          <div
            key={currency}
            className="flex flex-wrap items-center gap-2"
            data-testid={`currency-format-${currency}`}
          >
            <span className="w-12 text-sm font-medium">{currency}</span>
            <CurrencyRegionSelect
              id={controlId(`region-${currency}`)}
              value={region}
              onValueChange={(value) =>
                void saveOverrides({ ...overrides, [currency]: value }, `region-${currency}`)
              }
              label={t("settings:currencyFormats.regionFor", { currency })}
              disabled={saving}
              className="min-w-0 flex-1 sm:w-60 sm:flex-none"
              testId={`currency-format-region-${currency}`}
            />
            <span className="text-muted-foreground order-last basis-full text-sm tabular-nums sm:order-none sm:basis-auto">
              {preview(currency, region)}
            </span>
            <Button
              id={controlId(`remove-${currency}`)}
              variant="ghost"
              size="icon"
              aria-label={t("settings:currencyFormats.remove", { currency })}
              disabled={saving}
              onClick={() => removeOverride(currency)}
            >
              <Icons.Close className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <CurrencyInput
            id={controlId("new-currency")}
            value={newCurrency}
            onChange={setNewCurrency}
            placeholder={t("settings:currencyFormats.currencyPlaceholder")}
            valueDisplay="code-label"
            allowCustom={false}
            className="w-full sm:w-60"
            aria-label={t("settings:currencyFormats.currencyPlaceholder")}
            disabled={saving}
            data-testid="currency-format-new-currency"
          />
          <CurrencyRegionSelect
            id={controlId("new-region")}
            value={newRegion}
            onValueChange={setNewRegion}
            label={t("settings:currencyFormats.regionPlaceholder")}
            placeholder={t("settings:currencyFormats.regionPlaceholder")}
            disabled={saving}
            className="w-full sm:w-60"
            testId="currency-format-new-region"
          />
          <Button
            id={controlId("add")}
            variant="outline"
            disabled={saving || !newCurrency || !newRegion}
            onClick={addOverride}
            data-testid="currency-format-add"
          >
            {t("common:add")}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

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
            className="max-w-90 w-full"
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
          {/* Searchable: the regions are too many to scan. */}
          <SearchableSelect
            value={formattingRegion}
            options={FORMATTING_REGION_OPTIONS.map(([value, labelKey]) => ({
              value,
              label:
                value === "system"
                  ? `${t(`settings:formattingRegion.options.${labelKey}`)} (${resolveFormattingLocale(value)})`
                  : t(`settings:formattingRegion.options.${labelKey}`),
            }))}
            onValueChange={(value) => updateSettings({ formattingRegion: value })}
            searchPlaceholder={t("common:search_placeholder")}
            emptyMessage={t("common:no_results_found")}
            className="max-w-90 h-input-height"
            data-testid="formatting-locale-select"
            aria-label={t("settings:formattingRegion.title", "Region & formats")}
          />
          <p
            className="text-muted-foreground text-sm tabular-nums"
            data-testid="formatting-locale-preview"
          >
            {preview}
          </p>
        </section>

        <Separator />

        <CurrencyFormatSettings />

        <Separator />

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t("settings:timezone_title")}</h3>
            <p className="text-muted-foreground text-sm">{t("settings:timezone_description")}</p>
          </div>
          <div className="max-w-90 w-full">
            <TimezoneInput value={timezone} onChange={handleTimezoneChange} timezones={timezones} />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
