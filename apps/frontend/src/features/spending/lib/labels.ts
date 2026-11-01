import type { TFunction } from "i18next";
import english from "@/i18n/locales/en/spending.json";

/** Seeded budget groups are editable too; never translate a user rename. */
export function getBudgetGroupLabel(t: TFunction, id: string, name: string): string {
  const names: Record<string, string> = english.budgetGroupNames;
  return names[id] === name ? t(`spending:budgetGroupNames.${id}`, { defaultValue: name }) : name;
}

/** Translate only unchanged seeded event types, never user-created types or event names. */
export function getEventTypeLabel(t: TFunction, id: string, name: string): string {
  const names: Record<string, string> = english.eventTypeNames;
  return names[id] === name ? t(`spending:eventTypeNames.${id}`, { defaultValue: name }) : name;
}
