import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import { getBudgetGroupLabel, getEventTypeLabel } from "./labels";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "zh",
    fallbackLng: "en",
    resources: { en: { spending: enSpending }, zh: { spending: zhSpending } },
  });
});

describe("built-in budget group labels", () => {
  it("preserves renamed budget groups", () => {
    const t = i18n.getFixedT("zh");
    const id = "032ecb02-5912-42e8-9724-2cd566fc08d5";
    expect(getBudgetGroupLabel(t, id, "Needs")).toBe("必要支出");
    expect(getBudgetGroupLabel(t, id, "My needs")).toBe("My needs");
    expect(getBudgetGroupLabel(t, "custom", "Needs")).toBe("Needs");
  });

  it("translates all unchanged seeds in the requested language without translating custom names", () => {
    for (const [id, name] of Object.entries(enSpending.budgetGroupNames)) {
      expect(getBudgetGroupLabel(i18n.getFixedT("zh"), id, name)).toBe(
        zhSpending.budgetGroupNames[id as keyof typeof zhSpending.budgetGroupNames],
      );
      expect(getBudgetGroupLabel(i18n.getFixedT("en"), id, name)).toBe(name);
      expect(getBudgetGroupLabel(i18n.getFixedT("zh"), id, `My ${name}`)).toBe(`My ${name}`);
      expect(getBudgetGroupLabel(i18n.getFixedT("zh"), `custom-${id}`, name)).toBe(name);
    }
  });
});

describe("built-in event type labels", () => {
  it("translates all unchanged seeded types and preserves renamed or custom types", () => {
    const t = i18n.getFixedT("zh");
    for (const [id, name] of Object.entries(enSpending.eventTypeNames)) {
      expect(getEventTypeLabel(t, id, name)).toBe(
        zhSpending.eventTypeNames[id as keyof typeof zhSpending.eventTypeNames],
      );
      expect(getEventTypeLabel(t, id, `My ${name}`)).toBe(`My ${name}`);
      expect(getEventTypeLabel(t, `custom-${id}`, name)).toBe(name);
      expect(getEventTypeLabel(i18n.getFixedT("en"), id, name)).toBe(name);
    }
  });
});
