import { themes, type ThemeDefinition } from "@/themes/generated/registry";

export { themes, type ThemeDefinition };

/**
 * New profiles start on Signature (the backend's default too). Classic stays the base
 * theme the others build on, which the CSS shows for an ID it doesn't know.
 */
export const DEFAULT_THEME_ID = "signature";

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && themes.some(({ id }) => id === value);
}

/** The saved theme, or the default when it is missing or unknown to this version. */
export function resolveThemeId(value: unknown): string {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}
