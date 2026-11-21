export const CARD_LABEL = "text-muted-foreground/70 text-xs font-semibold uppercase tracking-wide";

// Category colours from the theme's chart palette, in both modes. Used for the
// composition bar, breakdown row dots, and the detail-sheet icons so they stay
// consistent. Liabilities keep the semantic red.
export const CATEGORY_CSS_COLORS: Record<string, string> = {
  properties: "var(--chart-1)",
  investments: "var(--chart-2)",
  cash: "var(--chart-3)",
  vehicles: "var(--chart-4)",
  preciousMetals: "var(--chart-5)",
  collectibles: "var(--chart-6)",
  otherAssets: "var(--chart-stone)",
  liabilities: "var(--destructive)",
};
