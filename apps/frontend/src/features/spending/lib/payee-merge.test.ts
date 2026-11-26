import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteCategory } from "@/adapters";

import { movePayeeActivities } from "../adapters/cash-activities";
import { listCategorizationRules, updateCategorizationRule } from "../adapters/rules";
import { mergePayee } from "./payee-merge";

vi.mock("@/adapters", () => ({ deleteCategory: vi.fn(() => Promise.resolve()) }));
vi.mock("../adapters/cash-activities", () => ({
  movePayeeActivities: vi.fn(() => Promise.resolve(3)),
}));
vi.mock("../adapters/rules", () => ({
  listCategorizationRules: vi.fn(),
  updateCategorizationRule: vi.fn(() => Promise.resolve()),
}));

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

describe("mergePayee", () => {
  it("moves the transactions, then the rules, then deletes the payee", async () => {
    const steps: string[] = [];
    vi.mocked(movePayeeActivities).mockImplementationOnce(async () => {
      steps.push("transactions");
      return 3;
    });
    vi.mocked(updateCategorizationRule).mockImplementationOnce(async () => {
      steps.push("rules");
      return undefined as never;
    });
    vi.mocked(deleteCategory).mockImplementationOnce(async () => {
      steps.push("delete");
      return undefined as never;
    });

    await mergePayee("old", "new");

    // Not a search of the Spending accounts: a transaction outside them would
    // be left behind and the delete refused.
    expect(movePayeeActivities).toHaveBeenCalledWith("old", "new");
    expect(updateCategorizationRule).toHaveBeenCalledTimes(1);
    expect(updateCategorizationRule).toHaveBeenCalledWith("r-old", { categoryId: "new" });
    expect(deleteCategory).toHaveBeenCalledWith("payees", "old");
    expect(steps).toEqual(["transactions", "rules", "delete"]);
  });

  it("does not delete the payee when its transactions could not be moved", async () => {
    vi.mocked(movePayeeActivities).mockRejectedValueOnce(new Error("offline"));

    await expect(mergePayee("old", "new")).rejects.toThrow("offline");

    expect(updateCategorizationRule).not.toHaveBeenCalled();
    expect(deleteCategory).not.toHaveBeenCalled();
  });

  it("refuses to merge a payee into itself", async () => {
    await expect(mergePayee("old", "old")).rejects.toThrow();

    expect(movePayeeActivities).not.toHaveBeenCalled();
    expect(deleteCategory).not.toHaveBeenCalled();
  });
});
