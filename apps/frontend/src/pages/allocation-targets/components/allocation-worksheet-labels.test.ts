import { createInstance } from "i18next";
import { expect, it } from "vitest";
import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enAllocation from "@/i18n/locales/en/allocation.json";
import zhAllocation from "@/i18n/locales/zh/allocation.json";
import { worksheetCategoryLabel } from "./allocation-worksheet-labels";

it("preserves the upstream sentinel distinctions across language changes without renaming custom categories", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: {
      en: { common: enCommon, taxonomies: enCommonTaxonomies, allocation: enAllocation },
      zh: { common: zhCommon, taxonomies: zhCommonTaxonomies, allocation: zhAllocation },
    },
  });
  const names = ["Unknown", "Unclassified", "Unclassified exposure"];
  const original = JSON.stringify(names);
  const labels = () =>
    names.map((name) => worksheetCategoryLabel(i18n.t, "asset_classes", "__UNKNOWN__", name));
  expect(labels()).toEqual(names);
  await i18n.changeLanguage("zh");
  expect(labels()).toEqual([
    zhCommonTaxonomies.unknown,
    zhAllocation.worksheet.unclassified,
    zhAllocation.worksheet.unclassifiedExposure,
  ]);
  for (const name of names) {
    expect(worksheetCategoryLabel(i18n.t, "asset_classes", "custom", name)).toBe(name);
    expect(worksheetCategoryLabel(i18n.t, "asset_classes", "EQUITY", name)).toBe(name);
  }
  expect(worksheetCategoryLabel(i18n.t, "asset_classes", "__UNKNOWN__", "My exposure")).toBe(
    "My exposure",
  );
  expect(worksheetCategoryLabel(i18n.t, "asset_classes", "EQUITY", "Equity")).toBe(
    zhCommonTaxonomies.categoryNames.asset_classes.EQUITY,
  );
  await i18n.changeLanguage("en");
  expect(labels()).toEqual(names);
  expect(JSON.stringify(names)).toBe(original);
});
