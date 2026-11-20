import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteCategory } from "@/adapters";

import { bulkAssignCategories, searchCashActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import { getPayeeReferences, mergePayee } from "./payee-merge";

vi.mock("@/adapters", () => ({ deleteCategory: vi.fn(() => Promise.resolve()) }));
vi.mock("../adapters/cash-activities", () => ({
  searchCashActivities: vi.fn(),
  bulkAssignCategories: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../adapters/rules", () => ({
  listCategorizationRules: vi.fn(),
  updateCategorizationRule: vi.fn(() => Promise.resolve()),
}));

const page = (ids: string[], totalCount: number) =>
  ({ items: ids.map((id) => ({ id })), totalCount }) as never;
const rule = (id: string, taxonomyId: string, categoryId: string) =>
  ({ id, taxonomyId, categoryId }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCategorizationRules).mockResolvedValue([
    rule("r-old", "payees", "old"),
    rule("r-other-payee", "payees", "other"),
    // A category that happens to share the payee's id is not a payee rule.
    rule("r-category", "spending_categories", "old"),
  ]);
});

describe("getPayeeReferences", () => {
  it("counts the payee's transactions and lists the rules that set it", async () => {
    vi.mocked(searchCashActivities).mockResolvedValue(page(["a1"], 7));

    const usage = await getPayeeReferences("old");

    expect(searchCashActivities).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ["old"] }),
    );
    expect(usage.transactions).toBe(7);
    expect(usage.rules.map((r) => r.id)).toEqual(["r-old"]);
  });
});

describe("mergePayee", () => {
  it("moves every page of transactions, then the rules, then deletes the payee", async () => {
    vi.mocked(searchCashActivities)
      .mockResolvedValueOnce(page(["a1", "a2"], 3))
      .mockResolvedValueOnce(page(["a3"], 1))
      .mockResolvedValueOnce(page([], 0));

    await mergePayee("old", "new");

    expect(vi.mocked(bulkAssignCategories).mock.calls.map(([items]) => items)).toEqual([
      [
        { activityId: "a1", taxonomyId: "payees", categoryId: "new" },
        { activityId: "a2", taxonomyId: "payees", categoryId: "new" },
      ],
      [{ activityId: "a3", taxonomyId: "payees", categoryId: "new" }],
    ]);
    expect(updateCategorizationRule).toHaveBeenCalledTimes(1);
    expect(updateCategorizationRule).toHaveBeenCalledWith("r-old", { categoryId: "new" });
    expect(deleteCategory).toHaveBeenCalledWith("payees", "old");
  });

  it("stops without deleting when a page does not shrink the total", async () => {
    vi.mocked(searchCashActivities).mockResolvedValue(page(["a1"], 5));

    await expect(mergePayee("old", "new")).rejects.toThrow("not making progress");

    expect(deleteCategory).not.toHaveBeenCalled();
  });

  it("refuses to merge a payee into itself", async () => {
    await expect(mergePayee("old", "old")).rejects.toThrow();

    expect(searchCashActivities).not.toHaveBeenCalled();
    expect(deleteCategory).not.toHaveBeenCalled();
  });
});
