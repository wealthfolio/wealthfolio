// Single source of truth for supported languages.
// Add a locale folder under ./locales/<code>/ and an entry here to ship a new language.
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português (Brasil)" },
  // `zh` carries no script subtag and means Simplified, per CLDR likely-subtags
  // (`zh` -> `zh-Hans-CN`). Traditional is named by script so one catalog serves
  // Taiwan, Hong Kong and Macau; region differences live in `formattingRegion`.
  { code: "zh", label: "简体中文" },
  { code: "zh-Hant", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "it", label: "Italiano" },
  { code: "ar", label: "العربية" },
  { code: "vi", label: "Tiếng Việt" },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]["code"];

export const DEFAULT_LOCALE: LocaleCode = "en";

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LOCALES.map((l) => l.code);

// Traditional Chinese is written in Taiwan, Hong Kong and Macau, with or without
// an explicit `Hant` subtag. Mirrors `is_traditional_chinese_alias` in
// crates/core/src/settings/settings_service.rs.
const TRADITIONAL_CHINESE_SUBTAGS = ["hant", "tw", "hk", "mo"];

/**
 * Map an arbitrary language tag onto a supported locale code.
 *
 * The settings service already normalizes the persisted UI language, so this is
 * not needed for anything the host hands us. It exists for codes written by
 * hand outside the app — notably add-on `registerTranslations` bundles, where
 * authors will reasonably write `zh-TW` and expect Traditional readers to see
 * it. Returns the base language for unknown regional variants (`fr-CA` -> `fr`),
 * which may itself be unsupported; callers validate.
 */
export function normalizeLocaleCode(language: string): string {
  const parts = language.toLowerCase().split(/[-_]/);
  if (parts[0] === "zh" && !parts.includes("hans")) {
    // An explicit `Hans` script wins over a Traditional region, so `zh-Hans-TW`
    // stays Simplified.
    if (parts.slice(1).some((part) => TRADITIONAL_CHINESE_SUBTAGS.includes(part))) {
      return "zh-Hant";
    }
  }

  const supported = SUPPORTED_LOCALE_CODES.find(
    (locale) => locale.toLowerCase() === language.toLowerCase(),
  );
  return supported ?? parts[0];
}

// Translation namespaces (one JSON file per namespace per locale).
export const NAMESPACES = [
  "common",
  "dashboard",
  "holdings",
  "activity",
  "performance",
  "account",
  "settings",
  "goals",
  "income",
  "insights",
  "asset",
  "spending",
  "ui",
  "ai",
  "allocation",
  "onboarding",
  "auth",
  "health",
  "sync",
  "connect",
] as const;

export const DEFAULT_NAMESPACE = "common";
