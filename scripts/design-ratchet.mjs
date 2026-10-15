#!/usr/bin/env node
// Counts design-system debt per source file so it only goes down: hard-coded
// px sizes in class names. Borders, rings, outlines, shadows and offsets up to
// 4px are hairlines and stay in px. Fails when a file gains a use; `--update`
// records the current counts once uses are removed. Run on demand, not in CI.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = fileURLToPath(new URL("./design-ratchet.json", import.meta.url));
const scopes = ["packages/ui/src", "apps/frontend/src"];
const hairline = /^-?(border|divide|ring|outline|shadow|drop-shadow|stroke|inset-shadow)/;
const arbitraryPx = /([a-z][\w-]*)-\[([^\]\s]*?\d(?:\.\d+)?px[^\]\s]*)\]/g;

function pxSizes(source) {
  let count = 0;
  for (const [, utility, value] of source.matchAll(arbitraryPx)) {
    const name = utility.split(":").pop();
    if (hairline.test(name)) continue;
    const sizes = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map(([, n]) => Number(n));
    if (sizes.every((n) => n <= 4)) continue;
    count += 1;
  }
  return count;
}

const files = execFileSync("git", ["ls-files", "--", ...scopes], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(tsx?|jsx?)$/.test(file) && !/\.test\.|\/test\/|\.stories\./.test(file));

const current = {};
for (const file of files) {
  const count = pxSizes(readFileSync(new URL(file, `file://${root}/`), "utf8"));
  if (count) current[file] = count;
}
const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify({ pxSizes: current }, null, 2)}\n`);
  console.log(`Recorded ${total(current)} px sizes in ${Object.keys(current).length} files.`);
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(baselinePath, "utf8")).pxSizes;
const grew = Object.entries(current).filter(([file, n]) => n > (recorded[file] ?? 0));
const fell = Object.keys({ ...recorded, ...current }).filter(
  (file) => (current[file] ?? 0) < (recorded[file] ?? 0),
);
console.log(
  `px sizes: ${total(current)} in ${Object.keys(current).length} files (recorded ${total(recorded)}).`,
);
if (fell.length)
  console.log(`Fewer px sizes in ${fell.length} files; run with --update to record.`);
if (grew.length) {
  console.error("New px sizes; use rem or the spacing scale (w-75, not w-[300px]):");
  for (const [file, n] of grew) console.error(`  ${file}: ${recorded[file] ?? 0} -> ${n}`);
  process.exit(1);
}
