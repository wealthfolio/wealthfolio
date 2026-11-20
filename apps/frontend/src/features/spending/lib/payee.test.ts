import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";

const createCategory = vi.fn();
const assignActivityCategory = vi.fn();
const unassignActivityCategory = vi.fn();
vi.mock("@/adapters", () => ({
  createCategory: (c: unknown) => createCategory(c),
  getTaxonomy: () => Promise.resolve({ taxonomy: { color: "taxonomy-colour" }, categories: [] }),
}));
vi.mock("../adapters/cash-activities", () => ({
  assignActivityCategory: (...args: unknown[]) => assignActivityCategory(...args),
  unassignActivityCategory: (...args: unknown[]) => unassignActivityCategory(...args),
}));

import { findPayee, setActivityPayee } from "./payee";

const payee = (id: string, name: string) => ({ id, name }) as TaxonomyCategory;
const payees = [payee("p1", "Corner Bakery"), payee("p2", "City Water")];

beforeEach(() => {
  createCategory.mockReset();
  assignActivityCategory.mockReset();
  unassignActivityCategory.mockReset();
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
