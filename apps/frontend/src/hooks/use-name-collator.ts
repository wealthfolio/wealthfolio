import { useLocalizationSettings } from "@wealthfolio/ui";
import { useMemo } from "react";

/** Comparator for sorting human-readable names in the app's UI language. */
export function useNameCollator() {
  const { uiLocale } = useLocalizationSettings();
  return useMemo(() => new Intl.Collator(uiLocale).compare, [uiLocale]);
}
