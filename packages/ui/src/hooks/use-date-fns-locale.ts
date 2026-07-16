import { de, enUS, es, fr, zhCN, type Locale } from "date-fns/locale";
import { useTranslation } from "react-i18next";

// Maps the active i18next language to a date-fns locale so calendars and date
// formatting follow the user's chosen app language. Falls back to English.
const DATE_FNS_LOCALES: Record<string, Locale> = { en: enUS, fr, de, es, zh: zhCN };

export function dateFnsLocaleFor(language: string | undefined): Locale {
  return DATE_FNS_LOCALES[(language ?? "en").split("-")[0]] ?? enUS;
}

export function useDateFnsLocale(): Locale {
  const { i18n } = useTranslation();
  return dateFnsLocaleFor(i18n.language);
}
