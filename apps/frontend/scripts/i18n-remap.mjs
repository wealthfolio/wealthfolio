#!/usr/bin/env node
/**
 * i18n translation remap / value-join.
 *
 * Re-attaches human translations from a differently-keyed source (e.g. another
 * PR or an older locale set) onto the current English keys by matching on the
 * ENGLISH SOURCE STRING rather than the key name. Used to seed fr/de without
 * requiring the source to share our key scheme.
 *
 * Usage:
 *   node scripts/i18n-remap.mjs <targetLng> <sourceEnFile> <sourceTargetFile>
 *
 *   targetLng         locale to write, e.g. "de"
 *   sourceEnFile      source English JSON (flat or nested) - the join column
 *   sourceTargetFile  source translated JSON in targetLng, same shape as sourceEnFile
 *
 * Writes matched translations into src/i18n/locales/<targetLng>/<ns>.json for
 * every namespace, keyed by our current English keys. Unmatched keys are left
 * absent so i18next falls back to English. Prints a coverage report.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "../src/i18n/locales");
const NS = [
  "account",
  "activity",
  "common",
  "dashboard",
  "goals",
  "holdings",
  "income",
  "performance",
  "settings",
];

const [targetLng, sourceEnFile, sourceTargetFile] = process.argv.slice(2);
if (!targetLng || !sourceEnFile || !sourceTargetFile) {
  console.error("Usage: node scripts/i18n-remap.mjs <targetLng> <sourceEnFile> <sourceTargetFile>");
  process.exit(1);
}

const norm = (s) =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.:;!?…]+$/, "");
const flat = (o, p = "", out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const kk = p ? `${p}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, kk, out);
    else out[kk] = v;
  }
  return out;
};
const unflat = (o) => {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    const ps = k.split(".");
    let c = r;
    for (let i = 0; i < ps.length - 1; i++) ((c[ps[i]] ??= {}), (c = c[ps[i]]));
    c[ps[ps.length - 1]] = v;
  }
  return r;
};

const srcEn = flat(JSON.parse(fs.readFileSync(sourceEnFile, "utf8")));
const srcTr = flat(JSON.parse(fs.readFileSync(sourceTargetFile, "utf8")));
const en2tr = new Map();
for (const k of Object.keys(srcEn)) {
  const en = srcEn[k],
    tr = srcTr[k];
  if (en && tr && tr !== en) en2tr.set(norm(en), tr);
}

let total = 0,
  hit = 0;
for (const ns of NS) {
  const enPath = path.join(LOCALES_DIR, "en", `${ns}.json`);
  if (!fs.existsSync(enPath)) continue;
  const en = flat(JSON.parse(fs.readFileSync(enPath, "utf8")));
  const out = {};
  let t = 0,
    h = 0;
  for (const [key, val] of Object.entries(en)) {
    if (typeof val !== "string") continue;
    t++;
    const m = en2tr.get(norm(val));
    if (m) ((out[key] = m), h++);
  }
  fs.mkdirSync(path.join(LOCALES_DIR, targetLng), { recursive: true });
  fs.writeFileSync(
    path.join(LOCALES_DIR, targetLng, `${ns}.json`),
    JSON.stringify(unflat(out), null, 2) + "\n",
  );
  console.log(`${ns.padEnd(12)} ${h}/${t} (${Math.round((100 * h) / t)}%)`);
  total += t;
  hit += h;
}
console.log(`TOTAL ${targetLng}: ${hit}/${total} (${Math.round((100 * hit) / total)}%)`);
