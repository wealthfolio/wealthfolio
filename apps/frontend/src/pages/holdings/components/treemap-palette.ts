export type ReturnType = "daily" | "pnl" | "return";

function noop() {
  return undefined;
}

// Treemap heatmap palette, from the theme's --heatmap-* roles: gains lerp from
// --heatmap-positive-low to -high, losses from --heatmap-negative-low to -high,
// and labels use --heatmap-label-dark or -light. The fallback is Classic's (classic.css).
export interface TreemapPalette {
  positiveLow: number[];
  positiveHigh: number[];
  negativeLow: number[];
  negativeHigh: number[];
  labelDark: number[];
  labelLight: number[];
  isDark: boolean;
}

const paletteTokens = {
  positiveLow: "heatmap-positive-low",
  positiveHigh: "heatmap-positive-high",
  negativeLow: "heatmap-negative-low",
  negativeHigh: "heatmap-negative-high",
  labelDark: "heatmap-label-dark",
  labelLight: "heatmap-label-light",
} as const;

export const fallbackPalette: TreemapPalette = {
  positiveLow: [237, 238, 207],
  positiveHigh: [102, 128, 11],
  negativeLow: [255, 225, 213],
  negativeHigh: [175, 48, 41],
  labelDark: [16, 15, 15],
  labelLight: [255, 252, 240],
  isDark: false,
};

let paletteKey = "";
let paletteSnapshot = fallbackPalette;

export function getTreemapPaletteSnapshot(): TreemapPalette {
  if (typeof document === "undefined") return fallbackPalette;
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const colors = Object.values(paletteTokens).map((token) =>
    style.getPropertyValue(`--${token}`).trim(),
  );
  const isDark = root.classList.contains("dark");
  const key = JSON.stringify([isDark, colors]);
  if (key === paletteKey) return paletteSnapshot;

  // A canvas resolves any CSS colour syntax (hex, hsl, oklch) to sRGB for the ramp.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const next: TreemapPalette = { ...fallbackPalette, isDark };
  if (context) {
    (Object.keys(paletteTokens) as (keyof typeof paletteTokens)[]).forEach((name, index) => {
      if (!colors[index]) return;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colors[index];
      context.fillRect(0, 0, 1, 1);
      next[name] = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
  }
  paletteKey = key;
  paletteSnapshot = next;
  return paletteSnapshot;
}

// The palette follows the mode (class) and the theme (data-theme).
export function subscribeToTreemapTheme(onStoreChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return noop;
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  return () => observer.disconnect();
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

interface TreemapTile {
  fill: string;
  isLightTile: boolean; // bright fill → use dark text
}

// Shade by return using a saturating curve `t = m / (m + k)` that maps
// [0, ∞) → [0, 1). Unlike a hard cap, extreme winners/losers keep darkening
// instead of collapsing into a single shade. `k` is the return magnitude that
// maps to the mid-tone (losses ramp ~2× faster, matching the design). Values
// are fractions: 0.5 = +50%, 0.025 = +2.5% for the smaller daily returns.
export function getTreemapColor(
  gain: number,
  returnType: ReturnType,
  palette: TreemapPalette = fallbackPalette,
): TreemapTile {
  const isGain = isNaN(gain) || gain >= 0;
  const [lo, hi] = isGain
    ? [palette.positiveLow, palette.positiveHigh]
    : [palette.negativeLow, palette.negativeHigh];
  const k = isGain
    ? returnType === "daily"
      ? 0.025
      : 0.5
    : returnType === "daily"
      ? 0.0125
      : 0.25;

  const m = isNaN(gain) ? 0 : Math.abs(gain);
  const t = m / (m + k);
  const c = lo.map((v, i) => lerp(v, hi[i], t));
  // Perceived luminance (ITU-R BT.601); >150 reads as a light tile.
  const luminance = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return { fill: `rgb(${c.join(",")})`, isLightTile: luminance > 150 };
}
