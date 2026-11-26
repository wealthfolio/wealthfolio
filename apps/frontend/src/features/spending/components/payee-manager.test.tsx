import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";
import { render, screen, within } from "@/test/render";

import { PayeeManager } from "./payee-manager";

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  references: vi.fn(),
  merge: vi.fn(),
  ensure: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../adapters/cash-activities", () => ({
  getPayeeUsage: mocks.usage,
  getPayeeReferences: mocks.references,
}));
vi.mock("../lib/payee-merge", () => ({ mergePayee: mocks.merge }));
vi.mock("../lib/payee", () => ({
  PAYEES_TAXONOMY_ID: "payees",
  ensurePayee: mocks.ensure,
  findPayee: (payees: TaxonomyCategory[], name: string) =>
    payees.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()),
}));
vi.mock("@/hooks/use-taxonomies", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    useUpdateCategory: () => useMutation({ mutationFn: mocks.update }),
    useDeleteCategory: () => useMutation({ mutationFn: mocks.remove }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const payee = (id: string, name: string) =>
  ({ id, name, taxonomyId: "payees" }) as TaxonomyCategory;
const water = payee("p-water", "City Water");
const bakery = payee("p-bakery", "Corner Bakery");

function setup(payees = [water, bakery]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PayeeManager payees={payees} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.usage.mockResolvedValue({ "p-bakery": 3 });
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.ensure.mockResolvedValue(payee("p-new", "New Dentist"));
});

describe("list", () => {
  it("shows the payees by name, each with its transaction count", async () => {
    setup([bakery, water]);

    await screen.findByText("3");
    const rows = within(screen.getByTestId("payee-list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["City Water0", "Corner Bakery3"]);
  });

  it("offers to add a payee even when there are none", async () => {
    const user = setup([]);

    await user.click(screen.getByRole("button", { name: "Add payee" }));
    await user.type(screen.getByLabelText("Name"), "New Dentist");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.ensure).toHaveBeenCalledWith("New Dentist", []);
  });
});

describe("rename", () => {
  it("saves the new name", async () => {
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Rename City Water" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Water Board");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-water", name: "Water Board" }),
      expect.anything(),
    );
  });

  it("refuses a name another payee already has", async () => {
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Rename City Water" }));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "corner bakery");

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("delete", () => {
  it("deletes a payee nothing uses", async () => {
    mocks.references.mockResolvedValue({ transactions: 0, rules: 0 });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete City Water" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(mocks.remove).toHaveBeenCalledWith(
      { taxonomyId: "payees", categoryId: "p-water" },
      expect.anything(),
    );
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("asks where a payee in use should go before it can be deleted", async () => {
    mocks.references.mockResolvedValue({ transactions: 4, rules: 1 });
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete Corner Bakery" }));

    const confirm = await screen.findByRole("button", { name: "Merge and delete" });
    expect(screen.getByText(/transactions: 4, rules: 1/)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("merges a payee whose only transactions are on accounts outside Spending", async () => {
    // The list counts the Spending accounts only: none there, two elsewhere.
    mocks.references.mockResolvedValue({ transactions: 2, rules: 0 });
    mocks.merge.mockResolvedValue(undefined);
    const user = setup();

    await user.click(screen.getByRole("button", { name: "Delete City Water" }));
    expect(await screen.findByText(/transactions: 2, rules: 0/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Corner Bakery" }));
    await user.click(screen.getByRole("button", { name: "Merge and delete" }));

    expect(mocks.merge).toHaveBeenCalledWith("p-water", "p-bakery");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
