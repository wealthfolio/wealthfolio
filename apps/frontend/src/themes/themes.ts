import { themes, type ThemeDefinition } from "@/themes/generated/registry";

export { themes, type ThemeDefinition };

/** Classic is the base theme: the CSS shows it for any ID it doesn't know. */
export const DEFAULT_THEME_ID = "classic";

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && themes.some(({ id }) => id === value);
}

/** The saved theme, or Classic when it is missing or unknown to this version. */
export function resolveThemeId(value: unknown): string {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}
