import i18next from "i18next";
import { useMemo } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import type { AddonTranslationApi, AddonTranslationResources } from "@wealthfolio/addon-sdk";
import type { TextDirection } from "@wealthfolio/ui";

import { reactInterpolation } from "@/i18n/interpolation";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALE_CODES,
  normalizeLocaleCode,
  type LocaleCode,
} from "@/i18n/locales";
import arUi from "@/i18n/locales/ar/ui.json";
import deUi from "@/i18n/locales/de/ui.json";
import enUi from "@/i18n/locales/en/ui.json";
import esUi from "@/i18n/locales/es/ui.json";
import frUi from "@/i18n/locales/fr/ui.json";
import itUi from "@/i18n/locales/it/ui.json";
import jaUi from "@/i18n/locales/ja/ui.json";
import koUi from "@/i18n/locales/ko/ui.json";
import ptUi from "@/i18n/locales/pt/ui.json";
import viUi from "@/i18n/locales/vi/ui.json";
import zhUi from "@/i18n/locales/zh/ui.json";
import zhHantUi from "@/i18n/locales/zh-Hant/ui.json";

// The sandbox iframe renders `@wealthfolio/ui` components that call
// `useTranslation()` against `ui:`-namespaced keys. The iframe is its own realm,
// so it does not inherit the host's i18next instance — without one, those
// components log `NO_I18NEXT_INSTANCE` and render raw keys ("ui:sheet.close").
//
// Only the `ui` namespace is bundled, and statically rather than through the
// host's lazy `resourcesToBackend`: the sandbox runs under a strict CSP and
// fetching locale chunks at runtime is not worth the failure mode when the
// whole namespace is a few KB per language.
//
// Typed as Record<LocaleCode, …> on purpose — adding a locale to
// SUPPORTED_LOCALES without adding it here is a type error, not a silent
// fallback to English.
const resources: Record<LocaleCode, { ui: Record<string, unknown> }> = {
  ar: { ui: arUi },
  de: { ui: deUi },
  en: { ui: enUi },
  es: { ui: esUi },
  fr: { ui: frUi },
  it: { ui: itUi },
  ja: { ui: jaUi },
  ko: { ui: koUi },
  pt: { ui: ptUi },
  vi: { ui: viUi },
  zh: { ui: zhUi },
  "zh-Hant": { ui: zhHantUi },
};

function applyDocumentLanguage(language: string) {
  // Han unification: ja/ko/zh share codepoints that render with different
  // preferred glyphs, so the iframe document needs its own lang attribute.
  document.documentElement.setAttribute("lang", language);
}

/**
 * The direction the host reports, so addons mirror with the host even when it
 * forces one in development; the UI language's direction otherwise.
 */
export function resolveSandboxDirection(localization: {
  direction?: string;
  uiLocale?: string;
}): TextDirection {
  if (localization.direction === "rtl" || localization.direction === "ltr") {
    return localization.direction;
  }
  return sandboxI18n.dir(
    localization.uiLocale ? normalizeLocaleCode(localization.uiLocale) : DEFAULT_LOCALE,
  );
}

export function applySandboxDirection(direction: TextDirection) {
  document.documentElement.setAttribute("dir", direction);
}

// A dedicated instance rather than the shared i18next default: the sandbox owns
// its own translations, and this way initialization order can never leave it
// silently piggybacking on someone else's config.
const sandboxI18n = i18next.createInstance();

export function initSandboxI18n(language?: string) {
  if (sandboxI18n.isInitialized) {
    setSandboxLanguage(language);
    return sandboxI18n;
  }

  const initialLanguage = language ? normalizeLocaleCode(language) : DEFAULT_LOCALE;

  // `initReactI18next` also registers this instance as react-i18next's default,
  // so `@wealthfolio/ui` components resolve it without an I18nextProvider.
  void sandboxI18n.use(initReactI18next).init({
    lng: initialLanguage,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALE_CODES,
    load: "currentOnly",
    ns: ["ui"],
    defaultNS: "ui",
    resources,
    // Same as the host, so `ui` strings read the same inside an add-on.
    interpolation: reactInterpolation(sandboxI18n),
    react: {
      // Resources are bundled synchronously, so there is nothing to suspend on
      // — and suspending here would land outside the route Suspense boundary.
      useSuspense: false,
    },
  });

  applyDocumentLanguage(initialLanguage);
  return sandboxI18n;
}

export function setSandboxLanguage(language?: string) {
  if (!language) {
    return;
  }

  const normalized = normalizeLocaleCode(language);
  // Each instance is synced independently and idempotently — returning early
  // because one of them already matches could leave the other out of sync.
  if (sandboxI18n.language !== normalized) {
    void sandboxI18n.changeLanguage(normalized);
  }
  if (addonI18n.isInitialized && addonI18n.language !== normalized) {
    void addonI18n.changeLanguage(normalized);
  }
  applyDocumentLanguage(normalized);
}

// Addon translations live on their OWN i18next instance. The host `ui`
// catalog exists only on `sandboxI18n`, so no t() option, key shape, or
// registered value can read or write host strings — there is no path to
// them, rather than a list of blocked paths. Deliberately NOT registered as
// the react-i18next default (that stays `sandboxI18n` for `@wealthfolio/ui`);
// the hook passes it explicitly via `useTranslation(ns, { i18n })`.
const addonI18n = i18next.createInstance();

/**
 * Install the `@wealthfolio/addon-sdk` translation runtime for this iframe's
 * addon. One iframe hosts exactly one addon; its resources live on the
 * dedicated `addonI18n` instance (the host "ui" catalog is not present there
 * at all), and the language always follows the host — the runtime exposes no
 * way to change it.
 */
export function installAddonTranslationRuntime(addonId: string) {
  const namespace = `addon/${addonId}`;

  if (!addonI18n.isInitialized) {
    void addonI18n.init({
      lng: sandboxI18n.language || DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      load: "currentOnly",
      ns: [namespace],
      defaultNS: namespace,
      resources: {},
      // Synchronous init — registerTranslations and t may run in the same tick.
      initImmediate: false,
      interpolation: {
        // React already escapes values.
        escapeValue: false,
      },
      // Read by the stock react-i18next hook (passed this instance via its
      // `i18n` option) even though the instance is not the react-i18next
      // default: resources are synchronous, and consumers re-render on
      // language changes and on (late) registerTranslations calls.
      react: {
        useSuspense: false,
        bindI18n: "languageChanged",
        bindI18nStore: "added removed",
      },
    });
  }

  function registerTranslations(resources: AddonTranslationResources) {
    for (const [language, bundle] of Object.entries(resources ?? {})) {
      if (!bundle) {
        continue;
      }
      const normalized = normalizeLocaleCode(language);
      // Only plain base codes may reach i18next: addResourceBundle
      // reinterprets a dotted lng argument as a resource path, and anything
      // else would be stored under a key that never resolves.
      if (
        !/^[a-z]{2,3}$/.test(normalized) &&
        !SUPPORTED_LOCALE_CODES.includes(normalized as LocaleCode)
      ) {
        console.warn(
          `[addon-sandbox] ignoring translations for invalid language code "${language}"`,
        );
        continue;
      }
      addonI18n.addResourceBundle(
        normalized,
        namespace,
        bundle,
        /* deep */ true,
        /* overwrite */ true,
      );
    }
  }

  function useAddonTranslation(): AddonTranslationApi {
    // Stock react-i18next hook bound to the dedicated instance; re-render
    // wiring comes from the instance's react options above. `t` changes
    // identity when the language or the registered resources change.
    const { t } = useTranslation(namespace, { i18n: addonI18n });
    const language = addonI18n.language || DEFAULT_LOCALE;
    // Memoized so the returned `t` keeps a stable identity across unrelated
    // renders (safe in effect deps / React.memo props).
    return useMemo(
      () => ({
        t: (key, options) => {
          const translated: unknown = t(key, {
            ...(options ?? {}),
            // Defense in depth and a stable contract on top of the instance
            // isolation: lookups stay in the addon namespace ("ui:key" keys
            // are literal, `ns` overrides are ignored), `$t()` nesting in
            // registered values is disabled, and language resolution always
            // follows the host setting.
            ns: namespace,
            nsSeparator: false,
            nest: false,
            lng: undefined,
            lngs: undefined,
            fallbackLng: undefined,
          } as unknown as Record<string, never>);
          // The SDK contract is string-only; non-string results (returnObjects)
          // fall back to the key rather than stringifying an object.
          return typeof translated === "string" ? translated : key;
        },
        language,
      }),
      [t, language],
    );
  }

  globalThis.__wealthfolioAddonI18n = { registerTranslations, useAddonTranslation };
}
