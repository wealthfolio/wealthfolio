import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { CategoryNode } from "@/features/spending/components/category-item";
import SpendingCategoriesPage from "./spending-categories-page";

const mocks = vi.hoisted(() => ({
  create: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false, excludedCategoryIds: [] }),
  useSpendingSettingsMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/features/spending/hooks/use-budget", () => ({
  useBudget: () => ({ data: undefined }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: (taxonomyId: string) => ({
    data: {
      categories:
        taxonomyId === "spending_categories"
          ? [{ id: "food", taxonomyId, name: "Food", parentId: null, sortOrder: 0 }]
          : [],
    },
    isLoading: false,
  }),
  useCreateCategory: () => useMutation({ mutationFn: mocks.create }),
  useUpdateCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteCategory: () => useMutation({ mutationFn: mocks.remove }),
}));
// The modal's form and the row's confirmed delete, reduced to their actions.
vi.mock("@/features/spending/components/category-edit-modal", () => ({
  CategoryEditModal: ({ open, onSave }: { open: boolean; onSave: (values: object) => void }) =>
    open ? (
      <div role="dialog">
        <button type="button" onClick={() => onSave({ name: "Travel" })}>
          Save category
        </button>
      </div>
    ) : null,
}));
vi.mock("@/features/spending/components/category-item", () => ({
  CategoryItem: ({
    category,
    onDelete,
  }: {
    category: CategoryNode;
    onDelete: (category: CategoryNode) => void;
  }) => (
    <button type="button" onClick={() => onDelete(category)}>
      Delete {category.name}
    </button>
  ),
}));

beforeEach(() => vi.clearAllMocks());

// On a phone, a screen kept under another one is a hidden <Activity>.
function renderKept() {
  const client = new QueryClient();
  const page = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <SpendingCategoriesPage />
        </Activity>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(page(false));
  return {
    status: () => client.getMutationCache().getAll()[0]?.state.status,
    hide: () => view.rerender(page(true)),
    show: () => view.rerender(page(false)),
  };
}

it("closes a new category once its save ends while the screen is out of sight", async () => {
  // Left open, the same form would create the category again.
  let finish: () => void = () => undefined;
  mocks.create.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const kept = renderKept();
  fireEvent.click(screen.getAllByRole("button", { name: "Add category" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Save category" }));
  await waitFor(() => expect(kept.status()).toBe("pending"));

  kept.hide();
  act(() => finish());
  await waitFor(() => expect(kept.status()).toBe("success"));
  kept.show();

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(mocks.toast.success).toHaveBeenCalledWith("Category created.");
});

it("reports a delete that fails while the screen is out of sight", async () => {
  let fail: () => void = () => undefined;
  mocks.remove.mockReturnValue(
    new Promise<void>((_, reject) => (fail = () => reject(new Error()))),
  );
  const kept = renderKept();
  fireEvent.click(screen.getByRole("button", { name: "Delete Food" }));
  await waitFor(() => expect(kept.status()).toBe("pending"));

  kept.hide();
  act(() => fail());
  await waitFor(() => expect(kept.status()).toBe("error"));
  kept.show();

  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Failed to delete category."));
});

it.each([
  [
    "web adapter",
    new Error(
      "Unique constraint violation: A category with this key already exists in the taxonomy",
    ),
  ],
  [
    "Tauri adapter",
    "Failed to create category: A category with this key already exists in the taxonomy",
  ],
])("shows the duplicate-key reason for the %s", async (_runtime, error) => {
  mocks.create.mockRejectedValue(error);
  renderKept();
  fireEvent.click(screen.getAllByRole("button", { name: "Add category" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Save category" }));
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Another category uses this key. Try a different name.",
    ),
  );
});

it("keeps the generic toast for other create failures", async () => {
  mocks.create.mockRejectedValue(new Error("Unexpected storage error"));
  renderKept();
  fireEvent.click(screen.getAllByRole("button", { name: "Add category" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Save category" }));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Failed to create category."));
});
