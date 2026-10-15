#!/usr/bin/env node
// Counts design-system debt per source file so it only goes down: font sizes
// off the type scale (text-[11px], text-[0.8125rem]), other hard-coded px
// sizes in class names, and raw colours that bypass the theme's roles (palette
// classes like text-amber-600, hex literals, rgb()/hsl() values), and pale
// tints of a status colour (bg-warning/10), which status text on them can't
// read against; those surfaces use bg-warning-subtle and its pair. Borders, rings, outlines, shadows and offsets up to 4px
// are hairlines and stay in px. Fails when a file gains a use; `--update`
// records the current counts once uses are removed. Run on demand, not in CI.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = fileURLToPath(new URL("./design-ratchet.json", import.meta.url));
const scopes = ["packages/ui/src", "apps/frontend/src"];
const hairline = /^-?(border|divide|ring|outline|shadow|drop-shadow|stroke|inset-shadow)/;
const arbitraryPx = /([a-z][\w-]*)-\[([^\]\s]*?\d(?:\.\d+)?px[^\]\s]*)\]/g;
const arbitraryFontSize = /(?<![\w-])text-\[(?:length:)?(?:-?[\d.]+(?:px|rem|em)|calc\(|clamp\()/g;

const palette =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|magenta|slate|gray|zinc|neutral|stone|base";
const rawColor = new RegExp(
  `(?<![\\w-])[a-z-]+-(?:${palette})-\\d{2,3}(?![\\w-])|#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b|\\b(?:rgba?|hsla?|oklch)\\(`,
  "g",
);

function rawColors(source) {
  return [...source.matchAll(rawColor)].length;
}

const statusTint = /(?<![\w-])bg-(?:success|warning|destructive|info)\/(\d+)(?![\w-])/g;

function statusTints(source) {
  return [...source.matchAll(statusTint)].filter(([, alpha]) => Number(alpha) <= 30).length;
}

function fontSizes(source) {
  return [...source.matchAll(arbitraryFontSize)].length;
}

function pxSizes(source) {
  let count = 0;
  for (const [, utility, value] of source.matchAll(arbitraryPx)) {
    const name = utility.split(":").pop();
    if (hairline.test(name) || name === "text") continue;
    const sizes = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map(([, n]) => Number(n));
    if (sizes.every((n) => n <= 4)) continue;
    count += 1;
  }
  return count;
}

const measures = {
  fontSizes: {
    count: fontSizes,
    label: "font sizes off the scale",
    fix: "use text-2xs to text-3xl",
  },
  rawColors: {
    count: rawColors,
    label: "raw colours",
    fix: "use a theme role (text-success, bg-muted, var(--chart-1))",
  },
  statusTints: {
    count: statusTints,
    label: "status tints",
    fix: "use bg-warning-subtle text-warning-subtle-foreground border-warning-subtle-border",
  },
  pxSizes: {
    count: pxSizes,
    label: "px sizes",
    fix: "use rem or the spacing scale (w-75, not w-[300px])",
  },
};

const files = execFileSync("git", ["ls-files", "--", ...scopes], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(tsx?|jsx?)$/.test(file) && !/\.test\.|\/test\/|\.stories\./.test(file));

const current = Object.fromEntries(Object.keys(measures).map((name) => [name, {}]));
for (const file of files) {
  const source = readFileSync(new URL(file, `file://${root}/`), "utf8");
  for (const [name, { count }] of Object.entries(measures)) {
    const n = count(source);
    if (n) current[name][file] = n;
  }
}
const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  for (const [name, { label }] of Object.entries(measures)) {
    const counts = current[name];
    console.log(`Recorded ${total(counts)} ${label} in ${Object.keys(counts).length} files.`);
  }
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
let failed = false;
for (const [name, { label, fix }] of Object.entries(measures)) {
  const counts = current[name];
  const recorded = baseline[name] ?? {};
  const grew = Object.entries(counts).filter(([file, n]) => n > (recorded[file] ?? 0));
  const fell = Object.keys({ ...recorded, ...counts }).filter(
    (file) => (counts[file] ?? 0) < (recorded[file] ?? 0),
  );
  console.log(
    `${label}: ${total(counts)} in ${Object.keys(counts).length} files (recorded ${total(recorded)}).`,
  );
  if (fell.length) console.log(`  Fewer in ${fell.length} files; run with --update to record.`);
  if (grew.length) {
    failed = true;
    console.error(`  New ${label}; ${fix}:`);
    for (const [file, n] of grew) console.error(`    ${file}: ${recorded[file] ?? 0} -> ${n}`);
  }
}
if (failed) process.exit(1);
