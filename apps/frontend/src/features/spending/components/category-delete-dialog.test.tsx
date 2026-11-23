import { act, render, screen, waitFor, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaxonomyCategory } from "@/lib/types";
import type { CategoryMergeReview } from "../adapters/category-merge";
import { CategoryDeleteDialog } from "./category-delete-dialog";

const mocks = vi.hoisted(() => ({ review: vi.fn(), merge: vi.fn(), remove: vi.fn() }));
vi.mock("../adapters/category-merge", () => ({
  reviewCategoryMerge: mocks.review,
  mergeCategory: mocks.merge,
}));
vi.mock("@/hooks/use-taxonomies", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return { useDeleteCategory: () => useMutation({ mutationFn: mocks.remove }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const category = (id: string, name: string): TaxonomyCategory => ({
  id,
  name,
  taxonomyId: "spending_categories",
  key: id,
  parentId: null,
  color: "#808080",
  icon: null,
  description: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});
const source = category("source", "Source");
const destination = category("destination", "Destination");
const blocked = category("blocked", "Excluded category");
function review(destinationId?: string): CategoryMergeReview {
  return {
    source,
    destinationId: destinationId ?? null,
    revision: `revision-${destinationId ?? "base"}`,
    references: {
      children: 0,
      assetAssignments: 0,
      spendingAssignments: 4,
      splits: 2,
      rules: 1,
      budgetTargets: 2,
      budgetRollovers: 0,
      budgetGroupAssignments: 1,
      allocationTargets: 0,
      automaticBudgetLinks: 0,
      mergedCategories: 0,
    },
    destinations: [
      { category: destination, blocked: null },
      { category: blocked, blocked: "exclusions" },
    ],
    budgetChanges: destinationId
      ? [
          { periodKey: "default", currentAmount: "200", movedAmount: "100", newAmount: "300" },
          { periodKey: "2026-03", currentAmount: "200", movedAmount: "50", newAmount: "250" },
        ]
      : [],
    targets: destinationId
      ? [
          {
            periodKey: "default",
            targetType: "category",
            taxonomyId: source.taxonomyId,
            categoryId: destination.id,
            amount: "300",
          },
          {
            periodKey: "2026-03",
            targetType: "category",
            taxonomyId: source.taxonomyId,
            categoryId: destination.id,
            amount: "250",
          },
        ]
      : [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.review.mockImplementation(async (request: { destinationId?: string }) =>
    review(request.destinationId),
  );
  mocks.merge.mockResolvedValue(undefined);
});
function setup(direction: "ltr" | "rtl" = "ltr") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DirectionProvider direction={direction}>
        <CategoryDeleteDialog category={source} onClose={close} />
      </DirectionProvider>
    </QueryClientProvider>,
  );
  return { client, close, user: userEvent.setup() };
}

it("cancels without changing data", async () => {
  const { user, close } = setup();
  await screen.findByLabelText("Move into…");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.merge).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it.each(["ltr", "rtl"] as const)(
  "reviews and commits only eligible destinations with pending protection (%s)",
  async (direction) => {
    let finish: () => void = () => undefined;
    mocks.merge.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { user, close, client } = setup(direction);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const confirm = await screen.findByRole("button", { name: "Move and delete" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/Past reports/)).toBeInTheDocument();
    expect(screen.queryByText(/Exclude from spending/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Move into…" }));
    expect(screen.queryByRole("option", { name: "Source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Excluded category" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Destination" }));
    await screen.findByText("250");
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    expect(mocks.merge).toHaveBeenCalledWith(
      {
        taxonomyId: source.taxonomyId,
        categoryId: source.id,
        destinationId: destination.id,
        revision: "revision-destination",
      },
      expect.anything(),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(mocks.merge).toHaveBeenCalledOnce();
    await act(async () => finish());
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["spending_rules"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["spending_settings"] });
    expect(mocks.remove).not.toHaveBeenCalled();
  },
);

it("keeps failure visible and requires a refreshed review before retry", async () => {
  mocks.merge.mockRejectedValueOnce(new Error("state changed"));
  const { user, close } = setup();
  await user.click(await screen.findByRole("combobox", { name: "Move into…" }));
  await user.click(await screen.findByRole("option", { name: "Destination" }));
  const confirm = screen.getByRole("button", { name: "Move and delete" });
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  expect(await screen.findByRole("alert")).toHaveTextContent(/data changed/);
  expect(confirm).toBeDisabled();
  expect(close).not.toHaveBeenCalled();
  mocks.review.mockImplementation(async () => ({
    ...review(destination.id),
    revision: "fresh-revision",
  }));
  await user.click(screen.getByRole("button", { name: "Refresh preview" }));
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mocks.merge.mock.lastCall?.[0].revision).toBe("fresh-revision");
});

it("retains the unused-category delete path, including automatic budget links", async () => {
  mocks.review.mockResolvedValue({ ...review(), references: { automaticBudgetLinks: 1 } });
  const { user, close } = setup();
  const confirm = screen.getByRole("button", { name: "Delete" });
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(mocks.remove.mock.calls[0][0]).toEqual({
    taxonomyId: source.taxonomyId,
    categoryId: source.id,
  });
  expect(mocks.merge).not.toHaveBeenCalled();
});

it("keeps the picker available when a destination becomes invalid during preview", async () => {
  const alternate = category("alternate", "Alternate destination");
  mocks.review.mockImplementation(async (request: { destinationId?: string }) => {
    if (request.destinationId === destination.id) throw new Error("category_merge:exclusions");
    return {
      ...review(request.destinationId),
      destinations: [...review().destinations, { category: alternate, blocked: null }],
    };
  });
  const { user } = setup();
  await user.click(await screen.findByRole("combobox", { name: "Move into…" }));
  await user.click(await screen.findByRole("option", { name: "Destination" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Move and delete" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Move into…" }));
  await user.click(await screen.findByRole("option", { name: "Alternate destination" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Move and delete" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Move and delete" }));
  expect(mocks.merge.mock.lastCall?.[0].destinationId).toBe(alternate.id);
});

it.each(["ltr", "rtl"] as const)(
  "shows destination budgets before, added and after (%s)",
  async (direction) => {
    const { user } = setup(direction);
    await user.click(await screen.findByRole("combobox", { name: "Move into…" }));
    await user.click(await screen.findByRole("option", { name: "Destination" }));
    const table = await screen.findByRole("table", { name: "Budgets · Destination" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Month", "Current", "Added", "New total"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent("Monthly default");
    expect(
      within(rows[0])
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["200", "+100", "300"]);
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent(/Mar.*2026/);
    expect(
      within(rows[1])
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["200", "+50", "250"]);
  },
);

it("explains restrictions when no eligible destination is available", async () => {
  mocks.review.mockResolvedValue({
    ...review(),
    destinations: [{ category: blocked, blocked: "exclusions" }],
  });
  setup();
  expect(await screen.findByText(/No eligible destination/)).toBeVisible();
  expect(screen.getByText(/Exclude from spending/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Move and delete" })).toBeDisabled();
});
