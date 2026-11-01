import type { Settings } from "@/lib/types";
import { themes } from "@/themes/themes";

/** Labels for the font roles a theme can suggest. */
export const fontLabelKeys = {
  "font-sans": "common:component.font_sans",
  "font-serif": "common:component.font_serif",
  "font-mono": "common:component.font_mono",
} as const;

export type FontRole = keyof typeof fontLabelKeys;

/** Notes for the mode a theme is designed for. */
export const designedForKeys = {
  dark: "settings:appearance_theme_designed_for_dark",
  light: "settings:appearance_theme_designed_for_light",
} as const;

type ThemeSelection = Pick<Settings, "themeId"> & Partial<Pick<Settings, "font">>;

/**
 * Settings to save when the user picks a theme: the theme, plus the font it
 * suggests, which stays the user's to change afterwards. The appearance mode is
 * never changed; Settings offers the mode a theme is designed for instead.
 */
export function themeSelectionUpdate(themeId: string): ThemeSelection {
  const theme = themes.find(({ id }) => id === themeId);
  return { themeId, ...(theme?.font ? { font: theme.font } : {}) };
}
