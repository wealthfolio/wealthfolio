import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { getNetWorthCategoryLabel } from "./net-worth-category-label";

describe("getNetWorthCategoryLabel", () => {
  it.each([
    ["cash", "holdings:group_cash"],
    ["investments", "holdings:group_investments"],
    ["properties", "holdings:group_properties"],
    ["vehicles", "holdings:group_vehicles"],
    ["collectibles", "holdings:group_collectibles"],
    ["preciousMetals", "holdings:group_precious_metals"],
    ["otherAssets", "holdings:group_other_assets"],
  ])("translates the %s category using %s", (category, key) => {
    const t = vi.fn(
      (translationKey: string) => `translated:${translationKey}`,
    ) as unknown as TFunction;

    expect(getNetWorthCategoryLabel(t, category, "Backend name")).toBe(`translated:${key}`);
    expect(t).toHaveBeenCalledWith(key, "Backend name");
  });

  it("preserves the backend name for an unknown category", () => {
    const t = vi.fn() as unknown as TFunction;

    expect(getNetWorthCategoryLabel(t, "futureCategory", "Future category")).toBe(
      "Future category",
    );
    expect(t).not.toHaveBeenCalled();
  });
});
