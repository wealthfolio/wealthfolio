import { createInstance } from "i18next";
import { expect, it } from "vitest";
import { categoryNoun } from "./drift-copy";

const catalogs = import.meta.glob<Record<string, unknown>>("@/i18n/locales/*/allocation.json", {
  eager: true,
  import: "default",
});

async function translate(locale: string) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    resources: {
      [locale]: { allocation: catalogs[`/src/i18n/locales/${locale}/allocation.json`] },
    },
  });
  return i18n.t;
}

it.each([
  ["en", "asset class", "asset classes"],
  ["de", "Anlageklasse", "Anlageklassen"],
  ["fr", "classe d'actifs", "classes d'actifs"],
  ["es", "clase de activos", "clases de activos"],
  ["it", "classe di attività", "classi di attività"],
  ["pt", "classe de ativos", "classes de ativos"],
])("uses singular and general plural asset-class nouns in %s", async (locale, one, plural) => {
  const t = await translate(locale);
  expect(categoryNoun(t, "asset_classes", "Asset Classes", 1)).toBe(one);
  expect(categoryNoun(t, "asset_classes", "Asset Classes", 2)).toBe(plural);
  expect(categoryNoun(t, "asset_classes", "Asset Classes")).toBe(plural);
});

it.each([
  ["zh", "2 个 地区 超出目标"],
  ["zh-Hant", "2 個 地區 超出目標"],
])("does not duplicate the Chinese classifier in %s", async (locale, sentence) => {
  const t = await translate(locale);
  expect(
    t("allocation:overview.outsideTarget", {
      n: 2,
      categories: categoryNoun(t, "regions", "Regions", 2),
    }),
  ).toBe(sentence);
});

it("distinguishes Arabic dual forms from an unnumbered plural", async () => {
  const t = await translate("ar");
  expect(categoryNoun(t, "regions", "Regions", 1)).toBe("منطقة");
  expect(categoryNoun(t, "regions", "Regions", 2)).toBe("منطقتان");
  expect(categoryNoun(t, "regions", "Regions", 3)).toBe("مناطق");
  expect(categoryNoun(t, "regions", "Regions", 11)).toBe("منطقة");
  expect(categoryNoun(t, "regions", "Regions")).toBe("المناطق");
});
