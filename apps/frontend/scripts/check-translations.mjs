import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// An optional locale directory lets fixture tests exercise the same CLI as CI.
const root = process.argv[2] ?? fileURLToPath(new URL("../src/i18n/locales/", import.meta.url));
const flatten = (value, prefix = "") => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key)),
      ),
    );
  }
  return { [prefix]: value };
};
const read = (language, file) =>
  flatten(JSON.parse(readFileSync(path.join(root, language, file), "utf8")));
const placeholders = (text) =>
  [...new Set([...text.matchAll(/{{\s*-?\s*([^},\s]+)[^}]*}}/g)].map((m) => m[1]))]
    .sort()
    .join(",");
const plural = /_(zero|one|two|few|many|other)$/;
const namespaces = readdirSync(path.join(root, "en")).filter((f) => f.endsWith(".json"));
let total = 0;
for (const language of readdirSync(root).filter((l) => l !== "en")) {
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
  const errors = [];
  const files = readdirSync(path.join(root, language)).filter((f) => f.endsWith(".json"));
  for (const file of namespaces) {
    if (!files.includes(file)) {
      errors.push(`${file}: missing namespace`);
      continue;
    }
    const source = read("en", file),
      target = read(language, file);
    const expected = new Map();
    for (const [key, value] of Object.entries(source)) {
      const match = key.match(plural);
      // A suffix alone can be a label such as type_other, not a plural family.
      if (
        match &&
        `${key.replace(plural, "")}_one` in source &&
        `${key.replace(plural, "")}_other` in source
      ) {
        const base = key.replace(plural, "");
        // Validate retained English plural forms too, without requiring them.
        if (key in target) expected.set(key, value);
        for (const category of categories) {
          expected.set(
            `${base}_${category}`,
            source[`${base}_${category}`] ?? source[`${base}_other`],
          );
        }
      } else expected.set(key, value);
    }
    for (const [key, value] of expected) {
      if (!(key in target)) errors.push(`${file}:${key}: missing`);
      else if (
        typeof value !== typeof target[key] ||
        Array.isArray(value) !== Array.isArray(target[key])
      )
        errors.push(`${file}:${key}: type mismatch`);
      else if (
        typeof value === "string" &&
        ((!target[key].trim() && value.trim()) || placeholders(value) !== placeholders(target[key]))
      )
        errors.push(`${file}:${key}: empty text or interpolation mismatch`);
    }
    for (const key of Object.keys(target)) {
      if (!(key in source) && !expected.has(key)) errors.push(`${file}:${key}: extra key`);
    }
  }
  for (const file of files) if (!namespaces.includes(file)) errors.push(`${file}: extra namespace`);
  total += errors.length;
  console.log(`${language}: ${errors.length ? `${errors.length} issue(s)` : "PASS"}`);
  errors.forEach((e) => console.log(`  ${e}`));
}
console.log(`${namespaces.length} namespaces checked; ${total} issue(s).`);
process.exitCode = total ? 1 : 0;
