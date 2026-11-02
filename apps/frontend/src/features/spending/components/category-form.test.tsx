import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { CategoryForm } from "./category-form";
import type { CategoryNode } from "./category-item";

const node = (id: string, name: string, parentId: string | null = null): CategoryNode => ({
  id,
  taxonomyId: "spending_categories",
  parentId,
  name,
  key: id,
  color: "#22c55e",
  icon: null,
  description: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});

const food = node("food", "Food & Dining");
const home = node("home", "Home");
const coffee = node("coffee", "Coffee", "food");

it("moves a category under another parent or to the top level", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(
    <CategoryForm
      category={coffee}
      parentOptions={[food, home]}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );

  await user.click(screen.getByRole("combobox", { name: "Parent category" }));
  await user.click(await screen.findByRole("option", { name: "Home" }));
  await user.click(screen.getByRole("button", { name: /save changes/i }));
  expect(onSubmit.mock.lastCall?.[0]).toMatchObject({ parentId: "home" });

  await user.click(screen.getByRole("combobox", { name: "Parent category" }));
  await user.click(await screen.findByRole("option", { name: "None (top level)" }));
  await user.click(screen.getByRole("button", { name: /save changes/i }));
  expect(onSubmit.mock.lastCall?.[0]).toMatchObject({ parentId: null });
});

it("hides the parent picker without parent options", () => {
  render(<CategoryForm category={coffee} onSubmit={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.queryByRole("combobox", { name: "Parent category" })).toBeNull();
});

it("locks the parent picker for a category with a budget target", () => {
  render(
    <CategoryForm
      category={home}
      parentOptions={[food]}
      parentLocked
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Parent category" })).toBeDisabled();
  expect(screen.getByText(/budget targets/i)).toBeInTheDocument();
});
