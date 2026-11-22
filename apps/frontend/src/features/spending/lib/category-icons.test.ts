import { Icons } from "@wealthfolio/ui";

import { CATEGORY_ICON_NAMES, resolveCategoryIcon } from "./category-icons";

describe("resolveCategoryIcon", () => {
  it("resolves every pickable icon name without falling back to Tag", () => {
    const fallbacks = CATEGORY_ICON_NAMES.filter(
      (name) => name !== "Tag" && resolveCategoryIcon(name) === Icons.Tag,
    );

    expect(fallbacks).toEqual([]);
  });

  it("falls back to Tag for unknown names", () => {
    expect(resolveCategoryIcon("NotAnIcon")).toBe(Icons.Tag);
    expect(resolveCategoryIcon(null)).toBe(Icons.Tag);
  });
});
