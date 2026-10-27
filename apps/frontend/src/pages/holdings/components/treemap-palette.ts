export type ReturnType = "daily" | "pnl" | "return";

function noop() {
  return undefined;
}

// Treemap heatmap palette, from the theme's --heatmap-* roles: gains blend from
// --heatmap-gain-low through -mid to -high, losses from --heatmap-loss-low through
// -mid to -high (the theme's positive and negative ramps, swapped by the Gain and
// loss colours setting in globals.css), and labels use --heatmap-label-dark or
// -light. The fallback is Classic's (classic.css).
export interface TreemapPalette {
  positiveLow: number[];
  positiveMid: number[];
  positiveHigh: number[];
  negativeLow: number[];
  negativeMid: number[];
  negativeHigh: number[];
  labelDark: number[];
  labelLight: number[];
  isDark: boolean;
}

const paletteTokens = {
  positiveLow: "heatmap-gain-low",
  positiveMid: "heatmap-gain-mid",
  positiveHigh: "heatmap-gain-high",
  negativeLow: "heatmap-loss-low",
  negativeMid: "heatmap-loss-mid",
  negativeHigh: "heatmap-loss-high",
  labelDark: "heatmap-label-dark",
  labelLight: "heatmap-label-light",
} as const;

export const fallbackPalette: TreemapPalette = {
  positiveLow: [230, 236, 213],
  positiveMid: [184, 196, 150],
  positiveHigh: [138, 156, 87],
  negativeLow: [250, 226, 218],
  negativeMid: [220, 168, 157],
  negativeHigh: [189, 111, 96],
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

// The palette follows the mode (class), the theme (data-theme) and the gain and loss
// colours (data-gain-colors).
export function subscribeToTreemapTheme(onStoreChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return noop;
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-gain-colors"],
  });
  return () => observer.disconnect();
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

// WCAG contrast ratio between two sRGB colours.
const luminance = (rgb: number[]) =>
  rgb
    .map((v) => v / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

interface TreemapTile {
  fill: string;
  isLightTile: boolean; // the dark label contrasts more than the light one
}

// Shade by return using a saturating curve `t = m / (m + k)` that maps
// [0, ∞) → [0, 1). Unlike a hard cap, extreme winners/losers keep darkening
// instead of collapsing into a single shade. `k` is the return magnitude that
// lands on the middle stop (losses ramp ~2× faster, matching the design). Values
// are fractions: 0.5 = +50%, 0.025 = +2.5% for the smaller daily returns.
export function getTreemapColor(
  gain: number,
  returnType: ReturnType,
  palette: TreemapPalette = fallbackPalette,
): TreemapTile {
  const isGain = isNaN(gain) || gain >= 0;
  const [lo, mid, hi] = isGain
    ? [palette.positiveLow, palette.positiveMid, palette.positiveHigh]
    : [palette.negativeLow, palette.negativeMid, palette.negativeHigh];
  const k = isGain
    ? returnType === "daily"
      ? 0.025
      : 0.5
    : returnType === "daily"
      ? 0.0125
      : 0.25;

  const m = isNaN(gain) ? 0 : Math.abs(gain);
  const t = m / (m + k);
  // Each half of the ramp is a straight blend: low to mid, then mid to high.
  const c =
    t < 0.5
      ? lo.map((v, i) => lerp(v, mid[i], t * 2))
      : mid.map((v, i) => lerp(v, hi[i], t * 2 - 1));
  return {
    fill: `rgb(${c.join(",")})`,
    isLightTile: contrast(c, palette.labelDark) >= contrast(c, palette.labelLight),
  };
}
