import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { act, render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import enCommon from "@/i18n/locales/en/common.json";
import enCommonTaxonomies from "@/i18n/locales/en/taxonomies.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhCommonTaxonomies from "@/i18n/locales/zh/taxonomies.json";
import enSpending from "@/i18n/locales/en/spending.json";
import zhSpending from "@/i18n/locales/zh/spending.json";
import { QuickCategorizePopover } from "./quick-categorize-popover";

vi.mock("@/hooks/use-taxonomies", () => {
  const categories = [
    { id: "cat_food", name: "Food & Dining", parentId: null, sortOrder: 0 },
    { id: "cat_groceries", name: "Groceries", parentId: "cat_food", sortOrder: 0 },
    { id: "my_coffee", name: "My coffee", parentId: "cat_food", sortOrder: 1 },
  ];
  return {
    useTaxonomy: (id: string) => ({
      data: { categories: id === "spending_categories" ? categories : [] },
    }),
  };
});

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

it("searches translated and raw category names while preserving tree context and submitted IDs", async () => {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    resources: {
      en: { common: enCommon, taxonomies: enCommonTaxonomies, spending: enSpending },
      zh: { common: zhCommon, taxonomies: zhCommonTaxonomies, spending: zhSpending },
    },
  });
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <QuickCategorizePopover
        scope="expense"
        onSelect={onSelect}
        trigger={<button type="button">Pick</button>}
      />
    </I18nextProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Pick" }));
  const food = zhCommonTaxonomies.categoryNames.spending_categories.cat_food;
  const groceries = zhCommonTaxonomies.categoryNames.spending_categories.cat_groceries;
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    food,
    groceries,
    "My coffee",
  ]);

  await user.type(screen.getByRole("combobox"), groceries);
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([food, groceries]);
  expect(screen.getByRole("option", { name: food })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("option", { name: groceries })).toHaveAttribute("aria-selected", "true");

  await act(() => i18n.changeLanguage("en"));
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  await user.clear(screen.getByRole("combobox"));
  await act(() => i18n.changeLanguage("zh"));
  await user.type(screen.getByRole("combobox"), "Groceries");
  expect(screen.getByRole("option", { name: groceries })).toBeVisible();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("spending_categories", "cat_groceries");
});
