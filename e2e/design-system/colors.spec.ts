import { expect, test, type Page } from "@playwright/test";
import { modes, openGallery, themes } from "./gallery";

// The colour contract: the roles every theme defines, and the pairs that must stay
// readable in each theme and mode. Text needs 4.5:1 (WCAG 1.4.3); the focus indicator 3:1
// against what it sits on (WCAG 1.4.11).

// Callouts, banners and pills on a status use its subtle surface, never status text on
// a tint of itself (text-warning on bg-warning/10), which can't reach 4.5:1.
const statuses = ["success", "warning", "destructive", "info"];

const roles = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
  ...statuses.flatMap((status) => [
    `${status}-subtle`,
    `${status}-subtle-foreground`,
    `${status}-subtle-border`,
  ]),
  "border",
  "input",
  "input-bg",
  "ring",
  ...Array.from({ length: 9 }, (_, index) => `chart-${index + 1}`),
  "allocation-over",
  "allocation-under",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  ...["", "-success", "-error", "-warning", "-info"].flatMap((kind) =>
    ["bg", "fg", "border"].map((part) => `toast${kind}-${part}`),
  ),
];

const textPairs = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  // Primary is also text (links, link buttons and badges, accents: 129 uses), and
  // status colours are text for gains, losses, errors and warnings.
  ...["primary", "destructive", "success", "warning"].flatMap((text) =>
    ["background", "card"].map((surface) => [text, surface]),
  ),
  // Target allocation drift, as text on cards.
  ["allocation-over", "card"],
  ["allocation-under", "card"],
  ...statuses.map((status) => [`${status}-subtle-foreground`, `${status}-subtle`]),
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ...["", "-success", "-error", "-warning", "-info"].map((kind) => [
    `toast${kind}-fg`,
    `toast${kind}-bg`,
  ]),
] as const;

// Documented exceptions: a lower floor, still enforced, for one theme and mode.
// Cupertino dark draws white labels on iOS systemBlue (#0a84ff), as iOS does: 3.65:1,
// below 4.5:1 for 14px text. A blue dark enough for a white label would fail as
// link text on the card, and primary is both (maintainer's choice, 2026-10-19).
const exceptions: {
  theme: string;
  mode: string;
  text: string;
  surface: string;
  minimum: number;
}[] = [
  ...["primary", "sidebar-primary"].map((role) => ({
    theme: "cupertino",
    mode: "dark",
    text: `${role}-foreground`,
    surface: role,
    minimum: 3.6,
  })),
];

const indicatorPairs = [
  ["ring", "background"],
  ["ring", "card"],
] as const;

// OKLab [L, a, b] of an sRGB colour (channels 0..255).
function oklab([r, g, b]: number[]) {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [r, g, b].map(linear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function luminance([r, g, b]: number[]) {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(first: number[], second: number[]) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

// Paints each surface's layers bottom-up, then the text, on a 1px canvas, so any colour
// syntax and translucent layers resolve to the sRGB pixels a reader sees.
async function ratios(page: Page, pairs: { text: string; layers: string[] }[]) {
  const pixels = await page.evaluate((pairs) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const probe = document.createElement("div");
    document.body.append(probe);
    const paint = (color: string) => {
      probe.style.color = color;
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const result = pairs.map(({ text, layers }) => {
      context.clearRect(0, 0, 1, 1);
      const below = layers.map(paint).at(-1)!;
      return [below, paint(text)];
    });
    probe.remove();
    return result;
  }, pairs);
  return pixels.map(([below, above]) => contrast(above, below));
}

for (const theme of themes) {
  for (const mode of modes) {
    test(`colour contract, ${theme}, ${mode}`, async ({ page }) => {
      await openGallery(page, { mode, theme });
      const missing = await page.evaluate(
        (names) =>
          names.filter(
            (name) =>
              !getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(),
          ),
        roles,
      );
      expect(missing, "roles the theme does not define").toEqual([]);

      const pairs = [...textPairs, ...indicatorPairs];
      const results = await ratios(
        page,
        pairs.map(([text, surface]) => ({ text: `var(--${text})`, layers: [`var(--${surface})`] })),
      );
      const failures = pairs.flatMap(([text, surface], index) => {
        const exception = exceptions.find(
          (entry) =>
            entry.theme === theme &&
            entry.mode === mode &&
            entry.text === text &&
            entry.surface === surface,
        );
        const minimum = exception?.minimum ?? (index < textPairs.length ? 4.5 : 3);
        return results[index] < minimum
          ? [`${text} on ${surface}: ${results[index].toFixed(2)} < ${minimum}`]
          : [];
      });
      expect(failures).toEqual([]);
    });

    test(`treemap gains and losses read apart and off the card, ${theme}, ${mode}`, async ({
      page,
    }) => {
      // composition-chart draws each tile on the ramp from --heatmap-*-low to -high,
      // at 0.45 opacity over the card in dark mode. Mid-tone gain and loss tiles must
      // differ in hue and chroma, not only in lightness (OKLab a/b distance), and
      // stand off the card. The minimums are the reference branch's, set between
      // the themes whose tiles failed and every theme whose tiles read well.
      await openGallery(page, { mode, theme });
      const tokens = [
        "heatmap-positive-low",
        "heatmap-positive-high",
        "heatmap-negative-low",
        "heatmap-negative-high",
        "card",
      ];
      const colors = await page.evaluate((names) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const probe = document.createElement("div");
        document.body.append(probe);
        const result = names.map((name) => {
          probe.style.color = `var(--${name})`;
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(probe).color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        });
        probe.remove();
        return result;
      }, tokens);
      const [positiveLow, positiveHigh, negativeLow, negativeHigh, card] = colors;
      const opacity = mode === "dark" ? 0.45 : 1;
      const midTile = (low: number[], high: number[]) =>
        low.map((value, i) => ((value + high[i]) / 2) * opacity + card[i] * (1 - opacity));
      const [positive, negative, surface] = [
        midTile(positiveLow, positiveHigh),
        midTile(negativeLow, negativeHigh),
        card,
      ].map(oklab);
      const distance = (a: number[], b: number[], from = 0) =>
        Math.hypot(...a.slice(from).map((value, i) => value - b[from + i]));
      const failures = [
        ["gain and loss hue", distance(positive, negative, 1), 0.06],
        ["gain off the card", distance(positive, surface), 0.1],
        ["loss off the card", distance(negative, surface), 0.1],
      ].flatMap(([name, value, minimum]) =>
        (value as number) < (minimum as number)
          ? [`${name}: ${(value as number).toFixed(3)} < ${minimum}`]
          : [],
      );
      expect(failures).toEqual([]);
    });

    test(`status text on glass alerts, ${theme}, ${mode}`, async ({ page }) => {
      // Alert's status variants show the subtle surface at 60% over whatever is below.
      await openGallery(page, { mode, theme });
      const cases = statuses.flatMap((status) =>
        ["background", "card"].map((surface) => ({ status, surface })),
      );
      const results = await ratios(
        page,
        cases.map(({ status, surface }) => ({
          text: `var(--${status}-subtle-foreground)`,
          layers: [
            `var(--${surface})`,
            `color-mix(in oklab, var(--${status}-subtle) 60%, transparent)`,
          ],
        })),
      );
      const failures = cases.flatMap(({ status, surface }, index) =>
        results[index] < 4.5
          ? [`${status} glass over ${surface}: ${results[index].toFixed(2)} < 4.5`]
          : [],
      );
      expect(failures).toEqual([]);
    });
  }
}
