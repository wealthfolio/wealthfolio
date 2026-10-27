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
