import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { QuickCategorizePopover } from "./quick-categorize-popover";

vi.mock("@/hooks/use-taxonomies", () => {
  const categories = {
    // Children's sortOrder restarts per parent, so a flat sort would put
    // "Restaurants" (0) and "Coffee" (1) ahead of "Groceries" (1).
    spending_categories: [
      { id: "food", name: "Food & Dining", parentId: null, sortOrder: 2 },
      { id: "coffee", name: "Coffee", parentId: "food", sortOrder: 1 },
      { id: "restaurants", name: "Restaurants", parentId: "food", sortOrder: 0 },
      { id: "groceries", name: "Groceries", parentId: null, sortOrder: 1 },
      { id: "orphan", name: "Orphan", parentId: "deleted", sortOrder: 0 },
    ],
    income_sources: [],
    savings_categories: [],
  };
  return {
    useTaxonomy: (id: keyof typeof categories) => ({ data: { categories: categories[id] } }),
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

function renderPicker() {
  render(
    <QuickCategorizePopover
      scope="expense"
      selectedCategoryId={null}
      onSelect={vi.fn()}
      trigger={<button type="button">Pick</button>}
    />,
  );
}

it("lists each parent followed by its children in sibling order", async () => {
  const user = userEvent.setup();
  renderPicker();

  await user.click(screen.getByRole("button", { name: "Pick" }));

  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Orphan",
    "Groceries",
    "Food & Dining",
    "Restaurants",
    "Coffee",
  ]);
});

it("keeps the parent above a matching child and highlights the match", async () => {
  const user = userEvent.setup();
  renderPicker();

  await user.click(screen.getByRole("button", { name: "Pick" }));
  await user.type(screen.getByRole("combobox"), "co");

  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Food & Dining",
    "Coffee",
  ]);
  expect(screen.getByRole("option", { name: "Food & Dining" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("option", { name: "Coffee" })).toHaveAttribute("aria-selected", "true");
});
