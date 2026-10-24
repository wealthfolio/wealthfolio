import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import en from "@/i18n/locales/en/common.json";
import zh from "@/i18n/locales/zh/common.json";
import type { TaxonomyAllocation } from "./types";
import {
  getBudgetGroupLabel,
  getEventTypeLabel,
  getCategoryLabel,
  getCategoryPathLabel,
  getTaxonomyLabel,
  localizeAllocation,
} from "./taxonomy-labels";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "zh",
    fallbackLng: "en",
    resources: { en: { common: en }, zh: { common: zh } },
  });
});

describe("built-in taxonomy labels", () => {
  it("localizes unchanged built-ins, including nested categories and countries", () => {
    const t = i18n.getFixedT("zh");
    expect(getTaxonomyLabel(t, "instrument_type", "Instrument Type")).toBe("证券类型");
    expect(getCategoryLabel(t, "asset_classes", "EQUITY", "Equity")).toBe("股票");
    expect(getCategoryLabel(t, "regions", "country_CN", "China")).toBe("中国");
    expect(getCategoryLabel(t, "industries_gics", "451030", "Software")).not.toBe("Software");
  });

  it.each([
    ["asset_classes", "EQUITY", "My equity"],
    ["asset_classes", "my-equity", "Equity"],
    ["custom_groups", "EQUITY", "Equity"],
    ["risk_category", "CASH", "Cash"],
    ["regions", "country_CN", "Mainland holdings"],
    ["future", "LOW", "Low"],
  ])("preserves custom or renamed records in %s: %s", (taxonomyId, id, name) => {
    expect(getCategoryLabel(i18n.getFixedT("zh"), taxonomyId, id, name)).toBe(name);
  });

  it("preserves renamed budget groups and financial terminology", () => {
    const t = i18n.getFixedT("zh");
    const id = "032ecb02-5912-42e8-9724-2cd566fc08d5";
    expect(getBudgetGroupLabel(t, id, "Needs")).toBe("必要支出");
    expect(getBudgetGroupLabel(t, id, "My needs")).toBe("My needs");
    expect(getBudgetGroupLabel(t, "custom", "Needs")).toBe("Needs");
    expect(getCategoryLabel(t, "instrument_type", "FUND", "Funds")).toBe("基金");
    expect(getCategoryLabel(t, "instrument_type", "STRUCTURED", "Structured Notes")).toBe(
      "结构化票据",
    );
  });

  it("preserves renamed and unknown taxonomy titles", () => {
    expect(getTaxonomyLabel(i18n.getFixedT("zh"), "asset_classes", "My classes")).toBe(
      "My classes",
    );
    expect(getTaxonomyLabel(i18n.getFixedT("zh"), "my-taxonomy", "Regions")).toBe("Regions");
  });

  it("uses synthetic identity, rather than a name, for unknown allocations", () => {
    const t = i18n.getFixedT("zh");
    expect(getCategoryLabel(t, "regions", "__UNKNOWN__", "Unknown")).toBe("未知");
    expect(getCategoryLabel(t, "custom_groups", "my-category", "Unknown")).toBe("Unknown");
  });

  it("creates a localized view without changing nested data, IDs, colors, or amounts", () => {
    const allocation: TaxonomyAllocation = {
      taxonomyId: "asset_classes",
      taxonomyName: "Asset Classes",
      color: "#123456",
      categories: [
        {
          categoryId: "EQUITY",
          categoryName: "Equity",
          color: "#123456",
          value: 100,
          percentage: 100,
          children: [
            {
              categoryId: "residual",
              categoryName: "Other in Equity",
              color: "#123456",
              value: 100,
              percentage: 100,
              isResidual: true,
            },
          ],
        },
      ],
    };
    const original = structuredClone(allocation);
    const view = localizeAllocation(i18n.getFixedT("zh"), allocation);
    expect(view.categories[0].categoryName).toBe("股票");
    expect(view.categories[0].children?.[0].categoryName).toContain("股票");
    expect(view.categories[0]).toMatchObject({
      categoryId: "EQUITY",
      color: "#123456",
      value: 100,
      percentage: 100,
    });
    expect(allocation).toEqual(original);
    expect(localizeAllocation(i18n.getFixedT("en"), allocation).categories[0].categoryName).toBe(
      "Equity",
    );
  });
});

describe("built-in event type labels", () => {
  it("translates all unchanged seeded types and preserves renamed or custom types", () => {
    const t = i18n.getFixedT("zh");
    for (const [id, name] of Object.entries(en.eventTypeNames)) {
      expect(getEventTypeLabel(t, id, name)).toBe(
        zh.eventTypeNames[id as keyof typeof zh.eventTypeNames],
      );
      expect(getEventTypeLabel(t, id, `My ${name}`)).toBe(`My ${name}`);
      expect(getEventTypeLabel(t, `custom-${id}`, name)).toBe(name);
      expect(getEventTypeLabel(i18n.getFixedT("en"), id, name)).toBe(name);
    }
  });
});

describe("category paths with stable identities", () => {
  const categories = [
    { categoryId: "cat_food", name: "Food & Dining", path: "Food & Dining" },
    { categoryId: "cat_groceries", name: "Groceries", path: "Food & Dining / Groceries" },
  ];
  it("localizes known ancestors and leaves without changing raw paths", () => {
    const t = i18n.getFixedT("zh");
    expect(
      getCategoryPathLabel(
        t,
        "spending_categories",
        "cat_groceries",
        categories[1].path,
        categories,
      ),
    ).toBe(
      `${getCategoryLabel(t, "spending_categories", "cat_food", "Food & Dining")} / ${getCategoryLabel(t, "spending_categories", "cat_groceries", "Groceries")}`,
    );
    expect(categories[1].path).toBe("Food & Dining / Groceries");
  });
  it("preserves renamed ancestors, slash-containing names and unknown paths", () => {
    const t = i18n.getFixedT("zh");
    const renamed = [
      { categoryId: "cat_food", name: "My / food", path: "My / food" },
      { categoryId: "cat_groceries", name: "Groceries", path: "My / food / Groceries" },
    ];
    expect(
      getCategoryPathLabel(t, "spending_categories", "cat_groceries", renamed[1].path, renamed),
    ).toBe(
      `My / food / ${getCategoryLabel(t, "spending_categories", "cat_groceries", "Groceries")}`,
    );
    expect(getCategoryPathLabel(t, "custom", "cat_groceries", categories[1].path, categories)).toBe(
      categories[1].path,
    );
    expect(
      getCategoryPathLabel(t, "spending_categories", "missing", categories[1].path, categories),
    ).toBe(categories[1].path);
    expect(
      getCategoryPathLabel(
        t,
        "spending_categories",
        "cat_groceries",
        "Different / Groceries",
        categories,
      ),
    ).toBe("Different / Groceries");
  });
});
