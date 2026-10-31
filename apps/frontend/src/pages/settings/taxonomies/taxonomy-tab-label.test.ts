import { createInstance } from "i18next";
import { expect, it } from "vitest";
import english from "@/i18n/locales/en/taxonomies.json";
import { getTaxonomyLabel } from "@/lib/taxonomy-labels";
import { taxonomyTabLabel } from "./taxonomy-tab-label";

const catalogs = import.meta.glob<typeof english>("../../../i18n/locales/*/taxonomies.json", {
  eager: true,
  import: "default",
});

it.each(Object.entries(catalogs))(
  "shortens only the unchanged built-in GICS tab in %s",
  async (_, catalog) => {
    const i18n = createInstance();
    await i18n.init({ lng: "test", resources: { test: { taxonomies: catalog } } });
    const seedName = english.taxonomyNames.industries_gics;
    const label = taxonomyTabLabel(i18n.t, "industries_gics", seedName);
    expect(label).not.toContain("GICS");
    expect(label.length).toBeGreaterThan(0);
    expect(getTaxonomyLabel(i18n.t, "industries_gics", seedName)).toBe(
      catalog.taxonomyNames.industries_gics,
    );
    for (const name of [
      "My industries (GICS)",
      "My industries（GICS）",
      "My industries(GICS)",
      "Industries (GICS) custom",
      " (GICS)",
    ]) {
      expect(taxonomyTabLabel(i18n.t, "industries_gics", name)).toBe(name);
      expect(taxonomyTabLabel(i18n.t, "custom", name)).toBe(name);
    }
    expect(taxonomyTabLabel(i18n.t, "custom", seedName)).toBe(seedName);
    expect(taxonomyTabLabel(i18n.t, "asset_classes", seedName)).toBe(seedName);
    expect(taxonomyTabLabel(i18n.t, "asset_classes", english.taxonomyNames.asset_classes)).toBe(
      catalog.taxonomyNames.asset_classes,
    );
  },
);

it.each([
  ["行业（GICS）", "行业"],
  ["行業（GICS）", "行業"],
  ["業種（GICS）", "業種"],
  ["산업(GICS)", "산업"],
  ["Industries (GICS)", "Industries"],
  ["Industries （GICS）", "Industries"],
])("supports translated suffix punctuation in %s", async (label, expected) => {
  const i18n = createInstance();
  await i18n.init({
    lng: "test",
    resources: { test: { taxonomies: { taxonomyNames: { industries_gics: label } } } },
  });
  expect(taxonomyTabLabel(i18n.t, "industries_gics", english.taxonomyNames.industries_gics)).toBe(
    expected,
  );
});
