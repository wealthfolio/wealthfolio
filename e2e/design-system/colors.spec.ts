import { expect, test, type Page } from "@playwright/test";
import { modes, openGallery } from "./gallery";

// The colour contract: the roles every theme defines, and the pairs that must stay
// readable in each mode. Text needs 4.5:1 (WCAG 1.4.3); the focus indicator 3:1
// against what it sits on (WCAG 1.4.11).

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
  "border",
  "input",
  "input-bg",
  "ring",
  ...Array.from({ length: 9 }, (_, index) => `chart-${index + 1}`),
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
  // Status colours are also text: gains, losses, errors and warnings.
  ...["destructive", "success", "warning"].flatMap((text) =>
    ["background", "card"].map((surface) => [text, surface]),
  ),
  ["sidebar-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
  ...["", "-success", "-error", "-warning", "-info"].map((kind) => [
    `toast${kind}-fg`,
    `toast${kind}-bg`,
  ]),
] as const;

const indicatorPairs = [
  ["ring", "background"],
  ["ring", "card"],
] as const;

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

for (const mode of modes) {
  test(`colour contract, ${mode}`, async ({ page }) => {
    await openGallery(page, { mode });
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
      const minimum = index < textPairs.length ? 4.5 : 3;
      return results[index] < minimum
        ? [`${text} on ${surface}: ${results[index].toFixed(2)} < ${minimum}`]
        : [];
    });
    expect(failures).toEqual([]);
  });

  test(`status text on its own tint, ${mode}`, async ({ page }) => {
    // Known gap: callouts put status text on a 10-15% tint of the same colour
    // (text-warning on bg-warning/10), which no status colour can pass in both modes
    // without leaving Classic's look. Callouts move to the toast notice pairs
    // (--toast-warning-bg/-fg), which pass, in the patterns step; drop this marker then.
    test.fail(true, "status text on its own tint is below 4.5:1");
    await openGallery(page, { mode });
    const cases = ["warning", "destructive", "success"].flatMap((role) =>
      [10, 15].flatMap((percent) =>
        ["background", "card"].map((surface) => ({ role, percent, surface })),
      ),
    );
    const results = await ratios(
      page,
      cases.map(({ role, percent, surface }) => ({
        text: `var(--${role})`,
        layers: [
          `var(--${surface})`,
          `color-mix(in oklab, var(--${role}) ${percent}%, transparent)`,
        ],
      })),
    );
    const failures = cases.flatMap(({ role, percent, surface }, index) =>
      results[index] < 4.5
        ? [`${role} on ${role}/${percent} over ${surface}: ${results[index].toFixed(2)}`]
        : [],
    );
    expect(failures).toEqual([]);
  });
}
