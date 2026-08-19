import { de, enCA, enGB, enUS, es, fr, frCA, ja, ko, zhCN, type Locale } from "date-fns/locale";
import { useLocalizationSettings } from "../components/formatting-provider";

const DATE_FNS_LOCALES: Record<string, Locale> = {
  "en-CA": enCA,
  "en-US": enUS,
  "en-GB": enGB,
  "fr-CA": frCA,
  "fr-FR": fr,
  "de-DE": de,
  "es-ES": es,
  "zh-CN": zhCN,
  "ja-JP": ja,
  "ko-KR": ko,
};

const LANGUAGE_LOCALES: Record<string, Locale> = {
  en: enUS,
  fr,
  de,
  es,
  zh: zhCN,
  ja,
  ko,
};

const REGION_LOCALES: Record<string, Locale> = {
  CA: enCA,
  US: enUS,
  GB: enGB,
  FR: fr,
  DE: de,
  ES: es,
  MX: es,
  CN: zhCN,
  JP: ja,
  KR: ko,
};

const generatedLocales = new Map<string, Locale>();

function intlWidth(width: string | undefined) {
  if (width === "narrow") return "narrow" as const;
  if (width === "short" || width === "abbreviated") return "short" as const;
  return "long" as const;
}

function createIntlLocale(locale: string, options: Locale["options"]): Locale {
  const cached = generatedLocales.get(locale);
  if (cached) return cached;

  const generated: Locale = {
    ...enUS,
    code: locale,
    options,
    localize: {
      ...enUS.localize,
      month: (month, localizeOptions) =>
        new Intl.DateTimeFormat(locale, {
          calendar: "gregory",
          month: intlWidth(localizeOptions?.width),
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2020, Number(month), 1))),
      day: (day, localizeOptions) =>
        new Intl.DateTimeFormat(locale, {
          weekday: intlWidth(localizeOptions?.width),
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2020, 7, 2 + Number(day)))),
    },
  };
  generatedLocales.set(locale, generated);
  return generated;
}

export function dateFnsLocaleFor(locale: string | undefined): Locale {
  if (!locale) throw new Error("A resolved formatting locale is required for date-fns");
  const exact = DATE_FNS_LOCALES[locale];
  if (exact) return exact;

  const resolved = new Intl.Locale(locale);
  const languageLocale = LANGUAGE_LOCALES[resolved.language];
  const regionLocale = resolved.region ? REGION_LOCALES[resolved.region] : undefined;
  const localeWithWeekInfo = resolved as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number; minimalDays: number };
    weekInfo?: { firstDay: number; minimalDays: number };
  };
  const weekInfo = localeWithWeekInfo.getWeekInfo?.() ?? localeWithWeekInfo.weekInfo;
  const options: Locale["options"] = weekInfo
    ? {
        weekStartsOn: (weekInfo.firstDay % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        firstWeekContainsDate: weekInfo.minimalDays === 4 ? 4 : 1,
      }
    : regionLocale?.options;
  if (!languageLocale) return createIntlLocale(locale, options);
  if (!options) return languageLocale;

  // date-fns owns calendar text while the selected region owns week conventions.
  return { ...languageLocale, code: locale, options };
}

export function useDateFnsLocale(): Locale {
  const { locale } = useLocalizationSettings();
  return dateFnsLocaleFor(locale);
}
