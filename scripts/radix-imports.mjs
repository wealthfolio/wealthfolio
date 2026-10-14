#!/usr/bin/env node
// Lists the source files that import Radix primitives: the measure of the Base UI
// migration. Fails when a file outside the recorded list starts importing Radix;
// `--update` records the current list once files move off it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = fileURLToPath(new URL("./radix-imports.json", import.meta.url));
const scopes = ["packages/ui/src", "apps/frontend/src", "addons"];

let current = [];
try {
  current = execFileSync("git", ["grep", "-l", "@radix-ui/", "--", ...scopes], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
} catch (error) {
  // git grep exits 1 when nothing matches: the migration is complete.
  if (error.status !== 1) throw error;
}

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify({ files: current }, null, 2)}\n`);
  console.log(`Recorded ${current.length} files that import Radix.`);
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(baselinePath, "utf8")).files;
const added = current.filter((file) => !recorded.includes(file));
const removed = recorded.filter((file) => !current.includes(file));
console.log(`Radix imports: ${current.length} files (recorded ${recorded.length}).`);
if (removed.length) {
  console.log(
    `No longer importing Radix (run with --update to record):\n  ${removed.join("\n  ")}`,
  );
}
if (added.length) {
  console.error(`New Radix imports; use Base UI instead:\n  ${added.join("\n  ")}`);
  process.exit(1);
}
