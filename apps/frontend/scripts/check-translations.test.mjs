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

function arabicItems(overrides = {}) {
  return {
    items_zero: "لا توجد أصول في {{account}}",
    items_one: "أصل واحد في {{account}}",
    items_two: "أصلان في {{account}}",
    items_few: "{{count}} أصول في {{account}}",
    items_many: "{{count}} أصلًا في {{account}}",
    items_other: "{{count}} أصل في {{account}}",
    ...overrides,
  };
}

function checkArabicItems(t, messages) {
  return check(t, {
    en: {
      common: {
        items_one: "{{count}} asset in {{account}}",
        items_other: "{{count}} assets in {{account}}",
      },
    },
    ar: { common: messages },
  });
}

test("accepts implicit Arabic counts only in zero, one and two plural forms", (t) => {
  const result = checkArabicItems(t, arabicItems());
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("still accepts explicit counts in Arabic zero, one and two forms", (t) => {
  const result = checkArabicItems(
    t,
    arabicItems({
      items_zero: "عدد الأصول في {{account}}: {{count}}",
      items_one: "عدد الأصول في {{account}}: {{count}}",
      items_two: "عدد الأصول في {{account}}: {{count}}",
    }),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("rejects missing Arabic counts in few, many and other forms", (t) => {
  const result = checkArabicItems(
    t,
    arabicItems({
      items_few: "أصول في {{account}}",
      items_many: "أصول في {{account}}",
      items_other: "أصول في {{account}}",
    }),
  );
  assert.equal(result.status, 1);
  for (const category of ["few", "many", "other"]) {
    assert.ok(
      result.stdout.includes(`common.json:items_${category}: empty text or interpolation mismatch`),
    );
  }
});

test("keeps other Arabic placeholders mandatory and rejects invented placeholders", (t) => {
  const result = checkArabicItems(
    t,
    arabicItems({ items_one: "أصل واحد", items_two: "أصلان في {{account}} {{unexpected}}" }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:items_one: empty text or interpolation mismatch/);
  assert.match(result.stdout, /common.json:items_two: empty text or interpolation mismatch/);
});

test("does not allow implicit counts in non-plural Arabic keys", (t) => {
  const result = check(t, {
    en: { common: { balance: "{{count}}", label_two: "{{count}} assets" } },
    ar: { common: { balance: "الرصيد", label_two: "أصلان" } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:balance: empty text or interpolation mismatch/);
  assert.match(result.stdout, /common.json:label_two: empty text or interpolation mismatch/);
});

test("does not allow implicit Arabic counts to weaken other languages", (t) => {
  const result = check(t, {
    en: { common: { items_one: "{{count}} item", items_other: "{{count}} items" } },
    de: { common: { items_one: "Ein Element", items_other: "{{count}} Elemente" } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:items_one: empty text or interpolation mismatch/);
});

test("rejects a new count placeholder when English has no displayed count", (t) => {
  const result = check(t, {
    en: { common: { items_one: "Item", items_other: "Items" } },
    ar: { common: arabicItems({ items_two: "{{count}} أصل" }) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:items_two: empty text or interpolation mismatch/);
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

const countlessOne = {
  en: { common: { items_one: "Item", items_other: "{{count}} items" } },
};

test("requires the count in a one form that also serves 21, 31 (Russian)", (t) => {
  const result = check(t, {
    ...countlessOne,
    ru: {
      common: {
        items_one: "Позиция",
        items_few: "{{count}} позиции",
        items_many: "{{count}} позиций",
        items_other: "{{count}} позиции",
      },
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /common.json:items_one: empty text or interpolation mismatch/);
  assert.doesNotMatch(result.stdout, /items_few|items_many|items_other/);
});

test("accepts a Russian one form that keeps the count", (t) => {
  const result = check(t, {
    ...countlessOne,
    ru: {
      common: {
        items_one: "{{count}} позиция",
        items_few: "{{count}} позиции",
        items_many: "{{count}} позиций",
        items_other: "{{count}} позиции",
      },
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("keeps a countless one form valid where one means only 1 (French)", (t) => {
  const result = check(t, {
    ...countlessOne,
    fr: {
      common: {
        items_one: "Élément",
        items_many: "{{count}} éléments",
        items_other: "{{count}} éléments",
      },
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
