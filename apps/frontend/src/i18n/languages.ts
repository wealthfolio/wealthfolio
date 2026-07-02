export const DEFAULT_LANGUAGE = "en";

export const SUPPORTED_LANGUAGES = [
  { value: "en", label: "English", htmlLang: "en" },
  { value: "zh-CN", label: "简体中文", htmlLang: "zh-CN" },
] as const;

export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]["value"];

export const LANGUAGE_STORAGE_KEY = "wealthfolio-language";

export function normalizeLanguage(value: unknown): AppLanguage {
  return SUPPORTED_LANGUAGES.some((language) => language.value === value)
    ? (value as AppLanguage)
    : DEFAULT_LANGUAGE;
}

export function getPreferredLanguage(): AppLanguage {
  try {
    const cachedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (cachedLanguage) {
      return normalizeLanguage(cachedLanguage);
    }
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }

  const browserLanguages =
    typeof navigator === "undefined" ? [] : [navigator.language, ...(navigator.languages ?? [])];
  return browserLanguages.some((language) => language?.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : DEFAULT_LANGUAGE;
}

export function languageToHtmlLang(value: unknown): string {
  const language = normalizeLanguage(value);
  return SUPPORTED_LANGUAGES.find((option) => option.value === language)?.htmlLang ?? "en";
}
