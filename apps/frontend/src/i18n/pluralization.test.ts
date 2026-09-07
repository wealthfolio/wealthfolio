import deActivity from "./locales/de/activity.json";
import enActivity from "./locales/en/activity.json";
import esActivity from "./locales/es/activity.json";
import frActivity from "./locales/fr/activity.json";
import itActivity from "./locales/it/activity.json";
import ptActivity from "./locales/pt/activity.json";
import zhHantActivity from "./locales/zh-Hant/activity.json";
import zhHantAi from "./locales/zh-Hant/ai.json";
import deCommon from "./locales/de/common.json";
import enCommon from "./locales/en/common.json";
import esCommon from "./locales/es/common.json";
import frCommon from "./locales/fr/common.json";
import itCommon from "./locales/it/common.json";
import jaCommon from "./locales/ja/common.json";
import koCommon from "./locales/ko/common.json";
import ptCommon from "./locales/pt/common.json";
import zhHantSettings from "./locales/zh-Hant/settings.json";
import zhCommon from "./locales/zh/common.json";
import zhHantCommon from "./locales/zh-Hant/common.json";
import { NAMESPACES } from "./locales";
import i18next from "i18next";
import { describe, expect, it } from "vitest";

const resources = {
  de: { activity: deActivity },
  en: { activity: enActivity },
  es: { activity: esActivity },
  fr: { activity: frActivity },
  it: { activity: itActivity },
  pt: { activity: ptActivity },
};

describe("singular translations", () => {
  it.each([
    ["en", "There are issues with 1 activity entry."],
    ["fr", "Il y a des problèmes avec 1 entrée d'activité."],
    ["de", "Es gibt Probleme mit 1 Aktivitätseintrag."],
    ["es", "Hay problemas con 1 entrada de actividad."],
    ["it", "È presente un problema con 1 voce di movimento."],
    ["pt", "Há problemas com 1 entrada de atividade."],
  ])("uses the singular activity form for %s", async (locale, expected) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "activity",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      lng: locale,
      ns: ["activity"],
      resources,
    });

    expect(i18n.t("activity:import.validationAlert.issuesTitle", { count: 1 })).toBe(expected);
  });
});

describe("global event translations", () => {
  it.each([
    ["en", enCommon],
    ["fr", frCommon],
    ["de", deCommon],
    ["es", esCommon],
    ["ja", jaCommon],
    ["ko", koCommon],
    ["zh", zhCommon],
    ["zh-Hant", zhHantCommon],
    ["it", itCommon],
    ["pt", ptCommon],
  ])("resolves asset-count messages for %s", async (locale, common) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "common",
      fallbackLng: false,
      interpolation: { escapeValue: false },
      lng: locale,
      ns: ["common"],
      resources: { [locale]: { common } },
    });

    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 1 })).not.toContain(
      "globalEvents",
    );
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 2 })).not.toContain(
      "globalEvents",
    );
    // `it` resolves the CLDR `many` category at exact millions; a missing or
    // empty `_many` form would render an empty string here.
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 1_000_000 })).not.toBe("");
  });
});

describe("CLDR `many` category", () => {
  // fr/es/pt/it resolve `many` at exact millions. Without a `_many` form
  // i18next resolves nothing and echoes the raw key back.
  it.each([
    ["fr", frCommon],
    ["es", esCommon],
    ["it", itCommon],
    ["pt", ptCommon],
  ])("resolves the many form for %s", async (locale, common) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "common",
      fallbackLng: false,
      interpolation: { escapeValue: false },
      lng: locale,
      ns: ["common"],
      resources: { [locale]: { common } },
    });

    expect(new Intl.PluralRules(locale).select(1_000_000)).toBe("many");
    expect(i18n.t("common:globalEvents.priceUpdateFailed", { count: 1_000_000 })).not.toContain(
      "globalEvents",
    );
  });
});

describe("plural form coverage", () => {
  // Globbed rather than imported one by one so a newly added locale is covered
  // the moment its folder lands.
  const files = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json", {
    eager: true,
  });

  const byLocale = new Map<string, Map<string, Set<string>>>();
  for (const [path, mod] of Object.entries(files)) {
    const [, , locale, file] = path.split("/");
    const namespace = file.replace(/\.json$/, "");
    const keys = new Set<string>();
    collectKeys(mod.default, "", keys);
    if (!byLocale.has(locale)) byLocale.set(locale, new Map());
    byLocale.get(locale)!.set(namespace, keys);
  }

  // English is the source of truth for which keys are plurals at all. A stem
  // qualifies only when it has both `_one` and `_other`, which rules out names
  // that merely end in `_other` (the "Other" account type) or `_one`
  // (`err_shares_gt_one`, i.e. "greater than 1").
  const pluralStems = new Map<string, Set<string>>();
  for (const [namespace, keys] of byLocale.get("en")!) {
    const stems = new Set(
      [...keys]
        .filter((k) => k.endsWith("_other") && keys.has(`${k.slice(0, -"_other".length)}_one`))
        .map((k) => k.slice(0, -"_other".length)),
    );
    if (stems.size) pluralStems.set(namespace, stems);
  }

  it.each([...byLocale.keys()].sort())(
    "%s defines every plural category its CLDR rules can select",
    (locale) => {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      const namespaces = byLocale.get(locale)!;

      const missing: string[] = [];
      for (const [namespace, stems] of pluralStems) {
        const keys = namespaces.get(namespace);
        if (!keys) continue; // locale has not translated this namespace yet
        for (const stem of stems) {
          if (!keys.has(`${stem}_other`)) continue; // key not translated yet
          for (const category of categories) {
            // i18next returns the raw key for any count whose category has no form.
            if (!keys.has(`${stem}_${category}`)) missing.push(`${namespace}:${stem}_${category}`);
          }
        }
      }

      expect(missing.sort()).toEqual([]);
    },
  );

  // The mirror image of the check above. Without it, a bulk edit can bolt a
  // `_many` onto a key that only looks like a plural (`type_other` is the
  // account type "Other") and every test still passes.
  it.each([...byLocale.keys()].sort())("%s invents no plural forms of its own", (locale) => {
    const categories = new Set<string>(
      new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
    );

    const invented: string[] = [];
    for (const [namespace, keys] of byLocale.get(locale)!) {
      const englishKeys = byLocale.get("en")?.get(namespace);
      const stems = pluralStems.get(namespace);
      for (const key of keys) {
        const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
        if (!match) continue;
        const [, stem, category] = match;
        // Keys English also has are names that merely end in a category word,
        // like `err_amount_gt_zero`. Only forms this locale added are suspect.
        if (englishKeys?.has(key)) continue;
        if (!stems?.has(stem)) invented.push(`${namespace}:${key}`);
        else if (!categories.has(category)) invented.push(`${namespace}:${key}`);
      }
    }

    expect(invented.sort()).toEqual([]);
  });
});

function collectKeys(node: Record<string, unknown>, prefix: string, out: Set<string>) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      collectKeys(value as Record<string, unknown>, path, out);
    } else {
      out.add(path);
    }
  }
}

describe("zh-Hant plural output", () => {
  it.each([0, 1, 2])("keeps classifiers and nouns for count %s", async (count) => {
    const i18n = i18next.createInstance();
    await i18n.init({
      defaultNS: "activity",
      fallbackLng: false,
      interpolation: { escapeValue: false },
      lng: "zh-Hant",
      ns: ["activity", "ai", "settings"],
      resources: {
        "zh-Hant": {
          activity: zhHantActivity,
          ai: zhHantAi,
          settings: zhHantSettings,
        },
      },
    });

    expect(i18n.t("activity:datagrid.approve_count", { count })).toBe(`核准 ${count} 筆`);
    expect(i18n.t("ai:accounts.of", { count })).toBe(`共 ${count} 個`);
    expect(i18n.t("ai:goals.of", { count })).toBe(`共 ${count} 個`);
    expect(
      i18n.t("ai:assetTaxonomy.loadedCategoriesTotal", {
        count,
        taxonomy: "產業",
        total: 5,
      }),
    ).toBe(`已為 產業 載入 ${count} 個類別 · 共 5 個`);
    expect(i18n.t("settings:addons_updates_critical", { count })).toBe(`（${count} 項重大更新）`);
  });
});

type Catalog = Record<string, unknown>;

const englishCatalogs = import.meta.glob<Catalog>("./locales/en/*.json", {
  eager: true,
  import: "default",
});

const zhHantCatalogs = import.meta.glob<Catalog>("./locales/zh-Hant/*.json", {
  eager: true,
  import: "default",
});

function flattenCatalog(
  value: unknown,
  path: string[] = [],
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenCatalog(child, [...path, key], output);
    }
    return output;
  }

  output[path.join(".")] = value;
  return output;
}

function interpolationTokens(value: string): string[] {
  return (value.match(/\{\{[^{}]+\}\}/g) ?? []).sort();
}

describe("zh-Hant catalog contract", () => {
  it("matches English files, structure, interpolation, and non-empty values", () => {
    const expectedEnglishFiles = NAMESPACES.map(
      (namespace) => `./locales/en/${namespace}.json`,
    ).sort();
    const expectedZhHantFiles = NAMESPACES.map(
      (namespace) => `./locales/zh-Hant/${namespace}.json`,
    ).sort();

    expect(Object.keys(englishCatalogs).sort()).toEqual(expectedEnglishFiles);
    expect(Object.keys(zhHantCatalogs).sort()).toEqual(expectedZhHantFiles);

    for (const namespace of NAMESPACES) {
      const english = flattenCatalog(englishCatalogs[`./locales/en/${namespace}.json`]);
      const zhHant = flattenCatalog(zhHantCatalogs[`./locales/zh-Hant/${namespace}.json`]);

      expect(Object.keys(zhHant).sort(), `${namespace} keys`).toEqual(Object.keys(english).sort());

      for (const [key, value] of Object.entries(zhHant)) {
        const location = `${namespace}:${key}`;
        expect(typeof value, `${location} must be a string`).toBe("string");
        if (typeof value !== "string") continue;

        expect(value.trim(), `${location} must not be empty`).not.toBe("");
        expect(
          interpolationTokens(value),
          `${location} must preserve interpolation tokens`,
        ).toEqual(interpolationTokens(english[key] as string));
      }
    }
  });
});
