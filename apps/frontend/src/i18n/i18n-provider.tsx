import { useSettingsContext } from "@/lib/settings-provider";
import { createContext, ReactNode, useContext, useEffect, useMemo } from "react";
import {
  getPreferredLanguage,
  languageToHtmlLang,
  normalizeLanguage,
  type AppLanguage,
} from "./languages";
import { getMessage, type TranslationKey } from "./messages";
import { localizeDomText } from "./ui-text";

type TranslationParams = Record<string, string | number>;

interface I18nContextValue {
  language: AppLanguage;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function interpolate(message: string, params?: TranslationParams): string {
  if (!params) {
    return message;
  }

  return message.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettingsContext();
  const language = settings?.language
    ? normalizeLanguage(settings.language)
    : getPreferredLanguage();

  useEffect(() => {
    document.documentElement.lang = languageToHtmlLang(language);
  }, [language]);

  useEffect(() => {
    localizeDomText(document.body, language);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData" && mutation.target instanceof Text) {
          localizeDomText(mutation.target.parentElement ?? document.body, language);
          continue;
        }

        if (mutation.type === "attributes" && mutation.target instanceof Element) {
          localizeDomText(mutation.target, language);
          continue;
        }

        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element || node instanceof DocumentFragment) {
            localizeDomText(node, language);
          } else if (node instanceof Text) {
            localizeDomText(node.parentElement ?? document.body, language);
          }
        });
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-label", "aria-description", "placeholder", "title"],
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      t: (key, params) => interpolate(getMessage(language, key), params),
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}
