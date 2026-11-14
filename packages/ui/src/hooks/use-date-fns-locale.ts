import {
  bg,
  de,
  enCA,
  enGB,
  enUS,
  es,
  fr,
  frCA,
  ja,
  ko,
  pt,
  ptBR,
  ro,
  vi,
  zhCN,
  zhTW,
  type Locale,
} from "date-fns/locale";
import { useLocalizationSettings } from "../components/formatting-provider";

const DATE_FNS_LOCALES: Record<string, Locale> = {
  "en-CA": enCA,
  "en-US": enUS,
  "en-GB": enGB,
  "fr-CA": frCA,
  "fr-FR": fr,
  "de-DE": de,
  "es-ES": es,
  "pt-BR": ptBR,
  "pt-PT": pt,
  "zh-CN": zhCN,
  "ja-JP": ja,
  "ko-KR": ko,
  "vi-VN": vi,
};

const LANGUAGE_LOCALES: Record<string, Locale> = {
  bg,
  en: enUS,
  fr,
  de,
  es,
  pt: ptBR,
  ro,
  vi,
  zh: zhCN,
  ja,
  ko,
};

const REGION_LOCALES: Record<string, Locale> = {
  BG: bg,
  CA: enCA,
  US: enUS,
  GB: enGB,
  FR: fr,
  DE: de,
  ES: es,
  MX: es,
  BR: ptBR,
  PT: pt,
  RO: ro,
  VN: vi,
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

  // Traditional script needs zhTW's calendar text (大約 3 小時, not 大约 3 小时), but
  // date-fns ships Taiwan with a Monday week start while CLDR says Sunday. Take the
  // text from zhTW and let the week-info path below own the conventions, exactly as
  // every other non-exact locale does. Hong Kong and Macau write Traditional too.
  const traditionalChinese =
    resolved.language === "zh" &&
    (resolved.script === "Hant" || ["TW", "HK", "MO"].includes(resolved.region ?? ""));

  const languageLocale = traditionalChinese ? zhTW : LANGUAGE_LOCALES[resolved.language];
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
