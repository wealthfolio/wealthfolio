import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-translations.mjs", import.meta.url));

function check(t, catalogs) {
  const root = mkdtempSync(path.join(tmpdir(), "wealthfolio-i18n-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [language, namespaces] of Object.entries(catalogs)) {
    mkdirSync(path.join(root, language));
    for (const [name, messages] of Object.entries(namespaces)) {
      writeFileSync(path.join(root, language, `${name}.json`), JSON.stringify(messages));
    }
  }
  const result = spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  assert.ifError(result.error);
  return result;
}

test("rejects missing nested keys", (t) => {
  const result = check(t, {
    en: { common: { scanner: { cancel: "Cancel", error: "Camera failed" } } },
    fr: { common: { scanner: { cancel: "Annuler" } } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:scanner.error: missing/);
});

test("rejects missing namespaces", (t) => {
  const result = check(t, { en: { sync: { cancel: "Cancel" } }, fr: {} });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /sync.json: missing namespace/);
});

test("rejects missing and unexpected interpolation variables", (t) => {
  const result = check(t, {
    en: { common: { greeting: "Hello {{name}}", count: "{{count}} imported" } },
    fr: { common: { greeting: "Bonjour", count: "{{count}} importée{{s}}" } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:greeting: empty text or interpolation mismatch/);
  assert.match(result.stdout, /common.json:count: empty text or interpolation mismatch/);
});

test("accepts Japanese without singular forms and French with many forms", (t) => {
  const result = check(t, {
    en: { common: { items_one: "{{count}} item", items_other: "{{count}} items" } },
    ja: { common: { items_other: "{{count}} 件" } },
    fr: {
      common: {
        items_one: "{{count}} élément",
        items_many: "{{count}} éléments",
        items_other: "{{count}} éléments",
      },
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("requires plural forms used by the target language", (t) => {
  const result = check(t, {
    en: { common: { items_one: "{{count}} item", items_other: "{{count}} items" } },
    fr: { common: { items_one: "{{count}} élément", items_other: "{{count}} éléments" } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:items_many: missing/);
});

test("treats a standalone other suffix as a normal key", (t) => {
  const result = check(t, {
    en: { common: { type_other: "Other" } },
    ja: { common: { type_other: "その他" } },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("rejects extra keys, empty strings and incompatible value types", (t) => {
  const result = check(t, {
    en: { common: { cancel: "Cancel", message: "Message" } },
    fr: { common: { cancel: " ", message: 42, obsolete: "Ancien" } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:cancel: empty text or interpolation mismatch/);
  assert.match(result.stdout, /common.json:message: type mismatch/);
  assert.match(result.stdout, /common.json:obsolete: extra key/);
});
