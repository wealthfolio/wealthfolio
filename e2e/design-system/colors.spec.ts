import { expect, test, type Page } from "@playwright/test";
import { gainColorOptions, modes, openGallery, themes } from "./gallery";

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
  ...Array.from({ length: 8 }, (_, index) => `series-${index + 1}`),
  "net-worth",
  "spending-accent",
  "spending-deep",
  "spending-mid",
  "allocation-over",
  "allocation-under",
  // Gains and losses (globals.css), and the true blue for losses in red up, blue down.
  ...["gain", "loss", "loss-blue"].flatMap((role) => [
    role,
    `${role}-subtle`,
    `${role}-subtle-foreground`,
    `${role}-subtle-border`,
  ]),
  ...["positive", "negative", "blue", "gain", "loss"].flatMap((ramp) =>
    ["low", "mid", "high"].map((stop) => `heatmap-${ramp}-${stop}`),
  ),
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
  // Losses in red up, blue down: text on the page and cards, and on their badge.
  ["loss-blue", "background"],
  ["loss-blue", "card"],
  ["loss-blue-subtle-foreground", "loss-blue-subtle"],
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

// Non-text graphics at 3:1 (WCAG 1.4.11): the focus ring; the series colours that
// tell compared lines and markers apart; the Net Worth line; Spending's icons,
// labels and bars; each on the page and on cards.
const indicatorPairs = [
  ["ring", "background"],
  ["ring", "card"],
  ...[
    ...Array.from({ length: 8 }, (_, index) => `series-${index + 1}`),
    "net-worth",
    "spending-deep",
  ].flatMap((role) => ["background", "card"].map((surface) => [role, surface] as const)),
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

// The roles each option draws gains and losses in.
const gainColorRoles: Record<(typeof gainColorOptions)[number], [string, string]> = {
  "green-up": ["success", "destructive"],
  "red-up": ["destructive", "success"],
  "red-up-blue-down": ["destructive", "loss-blue"],
};

// Treemap labels, 13px text on the tiles, keep what the green up ramps already reach:
// 4.2:1 at their lowest (Classic dark's gain tiles), under the 4.5:1 for text. The
// swapped and blue ramps must not go lower.
const treemapLabelFloor = 4.1;

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

    test(`feature status banner stays readable, ${theme}, ${mode}`, async ({ page }) => {
      // FeatureStatusBanner (Settings → AI agent access, Spending) draws on the text colour
      // with background-coloured text: its headline, its secondary lines at 75%, and the
      // switch's focus ring and thumb in the background colour.
      await openGallery(page, { mode, theme });
      const checks = [
        { name: "headline", text: "var(--background)", minimum: 4.5 },
        {
          name: "secondary text at 75%",
          text: "color-mix(in oklab, var(--background) 75%, transparent)",
          minimum: 4.5,
        },
        { name: "focus ring and switch", text: "var(--background)", minimum: 3 },
      ];
      const results = await ratios(
        page,
        checks.map(({ text }) => ({ text, layers: ["var(--foreground)"] })),
      );
      const failures = checks.flatMap(({ name, minimum }, index) =>
        results[index] < minimum
          ? [`${name} on the banner: ${results[index].toFixed(2)} < ${minimum}`]
          : [],
      );
      expect(failures).toEqual([]);
    });

    for (const gainColors of gainColorOptions) {
      test(`gain and loss colours, ${gainColors}, ${theme}, ${mode}`, async ({ page }) => {
        // data-gain-colors picks the roles (globals.css), and every option stays readable:
        // gains and losses as text on the page and cards, and on their badges.
        await openGallery(page, { mode, theme, gainColors });
        const [gain, loss] = gainColorRoles[gainColors];
        const parts = ["", "-subtle", "-subtle-foreground", "-subtle-border"];
        const pairs = parts.flatMap((part) => [
          [`gain${part}`, `${gain}${part}`],
          [`loss${part}`, `${loss}${part}`],
        ]);
        const resolved = await page.evaluate((names) => {
          const probe = document.createElement("div");
          document.body.append(probe);
          const colors = names.map((name) => {
            probe.style.color = `var(--${name})`;
            return getComputedStyle(probe).color;
          });
          probe.remove();
          return colors;
        }, pairs.flat());
        const wrong = pairs.flatMap(([role, expected], index) =>
          resolved[index * 2] === resolved[index * 2 + 1]
            ? []
            : [
                `--${role} is ${resolved[index * 2]}, not --${expected} (${resolved[index * 2 + 1]})`,
              ],
        );
        expect(wrong).toEqual([]);

        const readable = [
          ...["gain", "loss"].flatMap((role) =>
            ["background", "card"].map((surface) => [role, surface]),
          ),
          ["gain-subtle-foreground", "gain-subtle"],
          ["loss-subtle-foreground", "loss-subtle"],
        ];
        const results = await ratios(
          page,
          readable.map(([text, surface]) => ({
            text: `var(--${text})`,
            layers: [`var(--${surface})`],
          })),
        );
        const failures = readable.flatMap(([text, surface], index) =>
          results[index] < 4.5 ? [`${text} on ${surface}: ${results[index].toFixed(2)} < 4.5`] : [],
        );
        expect(failures).toEqual([]);
      });

      test(`treemap gains and losses read apart and off the card, ${theme}, ${mode}, ${gainColors}`, async ({
        page,
      }) => {
        // composition-chart draws each tile on the ramp from --heatmap-gain-low (or -loss-)
        // through -mid to -high, at 0.45 opacity over the card in dark mode. The mid-tone
        // gain and loss tiles, the -mid stops, must differ in hue and chroma, not only in
        // lightness (OKLab a/b distance), and stand off the card. The minimums are the
        // reference branch's, set between the themes whose tiles failed and every theme
        // whose tiles read well. Labels take whichever of --heatmap-label-dark and -light
        // contrasts more (always -light in dark mode); along each ramp they keep the
        // floor the green up ramps reach.
        await openGallery(page, { mode, theme, gainColors });
        const ramps = ["gain", "loss"].flatMap((ramp) =>
          ["low", "mid", "high"].map((stop) => `heatmap-${ramp}-${stop}`),
        );
        const tokens = [...ramps, "heatmap-label-dark", "heatmap-label-light", "card"];
        // Read each token as treemap-palette.ts does, straight into a canvas: through
        // a computed color(srgb …) value, a color-mix() middle stop can land a step lower.
        const colors = await page.evaluate((names) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d", { willReadFrequently: true })!;
          const style = getComputedStyle(document.documentElement);
          return names.map((name) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = style.getPropertyValue(`--${name}`).trim();
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
          });
        }, tokens);
        const [
          gainLow,
          gainMid,
          gainHigh,
          lossLow,
          lossMid,
          lossHigh,
          labelDark,
          labelLight,
          card,
        ] = colors;
        const opacity = mode === "dark" ? 0.45 : 1;
        const tile = (fill: number[]) =>
          fill.map((value, i) => value * opacity + card[i] * (1 - opacity));
        const [positive, negative, surface] = [tile(gainMid), tile(lossMid), card].map(oklab);
        const distance = (a: number[], b: number[], from = 0) =>
          Math.hypot(...a.slice(from).map((value, i) => value - b[from + i]));
        // Every 5% along low → mid → high, as getTreemapColor blends it.
        const along = (low: number[], mid: number[], high: number[]) =>
          Array.from({ length: 21 }, (_, step) => {
            const t = step / 20;
            const [from, to, u] = t < 0.5 ? [low, mid, t * 2] : [mid, high, t * 2 - 1];
            return tile(from.map((value, i) => value + (to[i] - value) * u));
          });
        const label = (fill: number[]) =>
          mode === "dark"
            ? contrast(labelLight, fill)
            : Math.max(contrast(labelDark, fill), contrast(labelLight, fill));
        const lowest = (fills: number[][]) => Math.min(...fills.map(label));
        const failures = [
          ["gain and loss hue", distance(positive, negative, 1), 0.06],
          ["gain off the card", distance(positive, surface), 0.1],
          ["loss off the card", distance(negative, surface), 0.1],
          ["gain labels", lowest(along(gainLow, gainMid, gainHigh)), treemapLabelFloor],
          ["loss labels", lowest(along(lossLow, lossMid, lossHigh)), treemapLabelFloor],
        ].flatMap(([name, value, minimum]) =>
          (value as number) < (minimum as number)
            ? [`${name}: ${(value as number).toFixed(3)} < ${minimum}`]
            : [],
        );
        expect(failures).toEqual([]);
      });
    }

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
