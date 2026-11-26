import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";

const createCategory = vi.fn();
const assignActivityCategory = vi.fn();
const unassignActivityCategory = vi.fn();
const bulkAssignCategories = vi.fn();
/** The payees the server has, which the caller's list may be behind. */
let storedPayees: TaxonomyCategory[] = [];
vi.mock("@/adapters", () => ({
  createCategory: (c: unknown) => createCategory(c),
  getTaxonomy: () =>
    Promise.resolve({ taxonomy: { color: "taxonomy-colour" }, categories: storedPayees }),
}));
vi.mock("../adapters/cash-activities", () => ({
  assignActivityCategory: (...args: unknown[]) => assignActivityCategory(...args),
  unassignActivityCategory: (...args: unknown[]) => unassignActivityCategory(...args),
  bulkAssignCategories: (...args: unknown[]) => bulkAssignCategories(...args),
}));

import { ensurePayee, findPayee, setActivitiesPayee, setActivityPayee } from "./payee";

const payee = (id: string, name: string) => ({ id, name }) as TaxonomyCategory;
const payees = [payee("p1", "Corner Bakery"), payee("p2", "City Water")];

beforeEach(() => {
  createCategory.mockReset();
  assignActivityCategory.mockReset();
  unassignActivityCategory.mockReset();
  bulkAssignCategories.mockReset();
  storedPayees = [];
});

describe("findPayee", () => {
  it("matches a name whatever its case or surrounding spaces", () => {
    expect(findPayee(payees, "  corner bakery ")?.id).toBe("p1");
    expect(findPayee(payees, "Corner")).toBeUndefined();
    expect(findPayee(payees, "   ")).toBeUndefined();
  });
});

describe("setActivityPayee", () => {
  it("files the activity under an existing payee without creating one", async () => {
    await setActivityPayee("act-1", "CITY WATER", payees);

    expect(createCategory).not.toHaveBeenCalled();
    expect(assignActivityCategory).toHaveBeenCalledWith("act-1", "payees", "p2");
  });

  it("creates the payee the first time a name is used", async () => {
    createCategory.mockResolvedValue(payee("p3", "New Dentist"));

    await setActivityPayee("act-1", "  New Dentist ", payees);

    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ taxonomyId: "payees", name: "New Dentist", parentId: null }),
    );
    expect(assignActivityCategory).toHaveBeenCalledWith("act-1", "payees", "p3");
  });

  it("clears the payee when the name is empty", async () => {
    await setActivityPayee("act-1", "  ", payees);

    expect(unassignActivityCategory).toHaveBeenCalledWith("act-1", "payees");
    expect(assignActivityCategory).not.toHaveBeenCalled();
    expect(createCategory).not.toHaveBeenCalled();
  });
});

describe("setActivitiesPayee", () => {
  it("files every activity under the payee in one write", async () => {
    await setActivitiesPayee(["act-1", "act-2"], "City Water", payees);

    expect(bulkAssignCategories).toHaveBeenCalledWith([
      { activityId: "act-1", taxonomyId: "payees", categoryId: "p2" },
      { activityId: "act-2", taxonomyId: "payees", categoryId: "p2" },
    ]);
    expect(unassignActivityCategory).not.toHaveBeenCalled();
  });

  it("clears the payee of every activity when the name is empty", async () => {
    await setActivitiesPayee(["act-1", "act-2"], "", payees);

    expect(unassignActivityCategory).toHaveBeenCalledTimes(2);
    expect(unassignActivityCategory).toHaveBeenCalledWith("act-1", "payees");
    expect(unassignActivityCategory).toHaveBeenCalledWith("act-2", "payees");
    expect(bulkAssignCategories).not.toHaveBeenCalled();
    expect(createCategory).not.toHaveBeenCalled();
  });
});

describe("ensurePayee", () => {
  it("reuses a payee added since the caller's list was read", async () => {
    storedPayees = [...payees, payee("p3", "New Dentist")];

    const found = await ensurePayee(" new dentist ", payees);

    expect(found.id).toBe("p3");
    expect(createCategory).not.toHaveBeenCalled();
  });

  it("creates a payee under its trimmed name", async () => {
    createCategory.mockResolvedValue(payee("p3", "New Dentist"));

    await ensurePayee("  New Dentist ", payees);

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: "New Dentist" }));
  });

  it("sorts a new payee after the payees the server has, not the caller's list", async () => {
    storedPayees = [...payees, payee("p3", "Gym")];
    createCategory.mockResolvedValue(payee("p4", "New Dentist"));

    await ensurePayee("New Dentist", payees);

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 3 }));
  });
});
