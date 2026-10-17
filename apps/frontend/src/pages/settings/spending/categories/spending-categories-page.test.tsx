import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SpendingCategoriesPage from "./spending-categories-page";

const mocks = vi.hoisted(() => ({
  createCategory: { mutate: vi.fn(), isPending: false },
  updateCategory: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  deleteCategory: { mutate: vi.fn(), isPending: false },
  settingsMutation: { mutateAsync: vi.fn(), isPending: false },
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock("@/hooks/use-taxonomies", () => ({
  useCreateCategory: () => mocks.createCategory,
  useDeleteCategory: () => mocks.deleteCategory,
  useTaxonomy: () => ({ data: { categories: [] }, isLoading: false }),
  useUpdateCategory: () => mocks.updateCategory,
}));

vi.mock("@/features/spending/hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false, excludedCategoryIds: [] }),
  useSpendingSettingsMutation: () => mocks.settingsMutation,
}));

vi.mock("@/features/spending/components/category-edit-modal", () => ({
  CategoryEditModal: ({
    open,
    onSave,
  }: {
    open: boolean;
    onSave: (values: { name: string; color: string }) => void;
  }) =>
    open ? (
      <button onClick={() => onSave({ name: "Coffee", color: "#808080" })}>Submit category</button>
    ) : null,
}));

describe("SpendingCategoriesPage category creation errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "web adapter error",
      new Error(
        "Database operation failed: Unique constraint violation: A category with this key already exists in the taxonomy",
      ),
    ],
    [
      "Tauri adapter error",
      "Failed to create category: Database operation failed: Unique constraint violation: A category with this key already exists in the taxonomy",
    ],
  ])("shows the duplicate-key reason for a %s", (_runtime, error) => {
    mocks.createCategory.mutate.mockImplementation(
      (_category: unknown, callbacks: { onError: (error: unknown) => void }) => {
        callbacks.onError(error);
      },
    );

    render(
      <MemoryRouter>
        <SpendingCategoriesPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add category" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Submit category" }));

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Another category uses this key. Try a different name.",
    );
  });

  it("keeps the generic toast for other create failures", () => {
    mocks.createCategory.mutate.mockImplementation(
      (_category: unknown, callbacks: { onError: (error: unknown) => void }) => {
        callbacks.onError(new Error("Unexpected storage error"));
      },
    );

    render(
      <MemoryRouter>
        <SpendingCategoriesPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add category" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Submit category" }));

    expect(mocks.toastError).toHaveBeenCalledWith("Failed to create category.");
  });
});
