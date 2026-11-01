// Gain and loss colours (Settings → Appearance), set on <html> as data-gain-colors;
// globals.css swaps the gain and loss roles for each option. The setting syncs
// across devices.
export const gainColorOptions = ["green-up", "red-up", "red-up-blue-down"] as const;

export type GainColors = (typeof gainColorOptions)[number];

export const DEFAULT_GAIN_COLORS: GainColors = "green-up";

export function isGainColors(value: unknown): value is GainColors {
  return gainColorOptions.some((option) => option === value);
}

/** The saved option, or green up when it is missing or unknown to this version. */
export function resolveGainColors(value: unknown): GainColors {
  return isGainColors(value) ? value : DEFAULT_GAIN_COLORS;
}

// Where red means up: mainland China, Taiwan, Korea and often Japan (Hong Kong is
// green up). Onboarding asks about the colours when the language, formatting region
// or base currency points to one of these markets; it never changes them itself.
const RED_UP_LANGUAGES = ["zh", "zh-Hant", "ja", "ko"];
const RED_UP_REGIONS = ["CN", "TW", "JP", "KR"];
const RED_UP_CURRENCIES = ["CNY", "TWD", "JPY", "KRW"];

interface MarketHints {
  language?: string;
  formattingRegion?: string;
  baseCurrency?: string;
  gainColors?: string;
}

/**
 * Whether the user may follow a market where red means up, or already picked other
 * gain and loss colours: onboarding then offers the setting.
 */
export function mayUseRedForGains(hints: MarketHints | null | undefined): boolean {
  if (!hints) return false;
  return (
    RED_UP_LANGUAGES.includes(hints.language ?? "") ||
    RED_UP_REGIONS.includes(hints.formattingRegion ?? "") ||
    RED_UP_CURRENCIES.includes(hints.baseCurrency ?? "") ||
    resolveGainColors(hints.gainColors) !== DEFAULT_GAIN_COLORS
  );
}
