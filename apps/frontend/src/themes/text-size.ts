/**
 * Text size, saved per device. Each name scales the root font size, and with it
 * every size in rem: text, spacing and controls grow together. The percentages
 * live in globals.css under `:root[data-text-size]`, and the CSS shows the
 * default size for a name it doesn't know.
 */
export const textSizes = ["small", "default", "large", "extra-large"] as const;

export type TextSize = (typeof textSizes)[number];

export const DEFAULT_TEXT_SIZE: TextSize = "default";

/** Caches the size for index.html, which applies it before the app loads. */
export const TEXT_SIZE_STORAGE_KEY = "wealthfolio-text-size";

export const textSizeLabelKeys = {
  small: "settings:appearance_text_size_small",
  default: "settings:appearance_text_size_default",
  large: "settings:appearance_text_size_large",
  "extra-large": "settings:appearance_text_size_extra_large",
} as const satisfies Record<TextSize, string>;

export function isTextSize(value: unknown): value is TextSize {
  return typeof value === "string" && (textSizes as readonly string[]).includes(value);
}

/** The saved size, or the default when it is missing or unknown to this version. */
export function resolveTextSize(value: unknown): TextSize {
  return isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}
