import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import english from "@/i18n/locales/en/common.json";
import englishTaxonomies from "@/i18n/locales/en/taxonomies.json";
import italian from "@/i18n/locales/it/common.json";
import italianTaxonomies from "@/i18n/locales/it/taxonomies.json";
import { getCategoryLabel } from "./taxonomy-labels";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "it",
    fallbackLng: "en",
    resources: {
      en: { common: english, taxonomies: englishTaxonomies },
      it: { common: italian, taxonomies: italianTaxonomies },
    },
  });
});

// Terminology sources (not literal word-for-word translations):
// https://www.borsaitaliana.it/borsa/glossario/private-equity.html
// https://www.invesco.com/it/it/financial-products/etfs/invesco-variable-rate-preferred-shares-ucits-etf-acc.html
// Preferred securities include hybrid instruments: keep "titoli", not only "azioni".
describe("Italian financial glossary", () => {
  it.each([
    ["EQUITY_PRIVATE", "Private Equity", "Private equity"],
    ["ALT_PRIVATE_EQUITY", "Private Equity", "Private equity"],
    ["FI_PREFERRED", "Preferred Securities", "Titoli privilegiati"],
  ] as const)(
    "uses the financial meaning of %s without renaming custom records",
    (id, seedName, label) => {
      expect(englishTaxonomies.categoryNames.asset_classes[id]).toBe(seedName);
      expect(italianTaxonomies.categoryNames.asset_classes[id]).toBe(label);
      expect(getCategoryLabel(i18n.t, "asset_classes", id, seedName)).toBe(label);
      expect(getCategoryLabel(i18n.t, "asset_classes", id, `My ${seedName}`)).toBe(
        `My ${seedName}`,
      );
      expect(getCategoryLabel(i18n.t, "asset_classes", "custom", seedName)).toBe(seedName);
      expect(getCategoryLabel(i18n.t, "custom", id, seedName)).toBe(seedName);
    },
  );
});
