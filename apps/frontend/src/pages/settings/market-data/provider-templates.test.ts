import { describe, expect, it } from "vitest";
import english from "@/i18n/locales/en/settings.json";

import { HISTORICAL_TEMPLATES, LATEST_TEMPLATES } from "./provider-templates";

describe("provider templates", () => {
  it("send a JSON request body exactly when they post", () => {
    for (const template of [...LATEST_TEMPLATES, ...HISTORICAL_TEMPLATES]) {
      expect(template.body !== undefined, template.name).toBe(template.method === "POST");
      if (template.body !== undefined) {
        expect(template.format, template.name).toBe("json");
        expect(() => JSON.parse(template.body ?? ""), template.name).not.toThrow();
      }
    }
  });
});

const settingsCatalogs = import.meta.glob<typeof english>("../../../i18n/locales/*/settings.json", {
  eager: true,
  import: "default",
});

it.each(Object.entries(settingsCatalogs))(
  "provides every template description in %s",
  (_, catalog) => {
    const descriptions: Record<string, string> = catalog.market_data_page.templateDescriptions;
    for (const template of [...LATEST_TEMPLATES, ...HISTORICAL_TEMPLATES]) {
      expect(
        descriptions[template.descriptionKey],
        `${template.name}: ${template.descriptionKey}`,
      ).toBeTruthy();
    }
  },
);

it("uses exact original English descriptions for every template", () => {
  const descriptions: Record<string, string> = english.market_data_page.templateDescriptions;
  for (const template of [...LATEST_TEMPLATES, ...HISTORICAL_TEMPLATES]) {
    expect(descriptions[template.descriptionKey]).toBe(template.description);
  }
});
