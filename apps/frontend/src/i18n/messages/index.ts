import { DEFAULT_LANGUAGE, type AppLanguage } from "../languages";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type TranslationKey = keyof typeof en;

export const messages: Record<AppLanguage, Record<TranslationKey, string>> = {
  en,
  "zh-CN": zhCN,
};

export function getMessage(language: AppLanguage, key: TranslationKey): string {
  return messages[language]?.[key] ?? messages[DEFAULT_LANGUAGE][key] ?? key;
}
