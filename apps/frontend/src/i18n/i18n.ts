import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";

import { DEFAULT_LOCALE, DEFAULT_NAMESPACE, NAMESPACES, SUPPORTED_LOCALE_CODES } from "./locales";

// Language is an explicit, stored user setting (see settings-provider). We do NOT
// auto-detect from the browser/OS. i18next initializes in the default locale and
// the settings provider calls `i18n.changeLanguage(settings.language)` once loaded.
i18n
  .use(
    // Lazy-load `locales/<lng>/<ns>.json` on demand so we don't bundle every
    // language into the initial payload.
    resourcesToBackend(
      (language: string, namespace: string) => import(`./locales/${language}/${namespace}.json`),
    ),
  )
  .use(initReactI18next)
  .init({
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALE_CODES,
    // Map regional codes (e.g. `fr-CA`) to the base language.
    load: "languageOnly",
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: {
      // React already escapes values.
      escapeValue: false,
    },
    react: {
      useSuspense: true,
    },
    debug: import.meta.env.DEV,
  });

export default i18n;
