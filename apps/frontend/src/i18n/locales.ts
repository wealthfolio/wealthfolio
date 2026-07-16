// Single source of truth for supported languages.
// Add a locale folder under ./locales/<code>/ and an entry here to ship a new language.
export const SUPPORTED_LOCALES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "zh", label: "简体中文" },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]["code"];

export const DEFAULT_LOCALE: LocaleCode = "en";

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LOCALES.map((l) => l.code);

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
