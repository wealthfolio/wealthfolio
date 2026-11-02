export type Palette = {
  key: string;
  label: string;
  hsl: string;
  deep: string;
  mid: string;
};

// Spending's main chart colours, from the theme (--spending-accent / -deep / -mid).
// Classic's are forest greens.
export const SPENDING_THEME: Palette = {
  key: "spending",
  label: "Spending",
  hsl: "var(--spending-accent)",
  deep: "var(--spending-deep)",
  mid: "var(--spending-mid)",
};

/** A colour (hex or `var(...)`) at the given strength over transparent, for tints. */
export const tint = (color: string, alpha: number): string =>
  `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;

/** The accent at the given strength over transparent, for backgrounds and tints. */
export const themeBg = (p: Palette, alpha: number): string => tint(p.hsl, alpha);
