import { createFormatter } from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";
import type { AssetClassificationAssignmentPreview } from "../../types";
import {
  buildAssetClassificationApplyPlan,
  formatBasisPoints,
} from "./asset-classification-tool-utils";

function row(
  categoryId: string,
  weightBasisPoints: number,
  source = "ai",
  assignmentId: string | null = `assignment-${categoryId}`,
): AssetClassificationAssignmentPreview {
  return {
    assignmentId,
    categoryId,
    categoryName: categoryId,
    categoryKey: categoryId,
    weightBasisPoints,
    source,
  };
}

describe("buildAssetClassificationApplyPlan", () => {
  it("plans added categories", () => {
    const plan = buildAssetClassificationApplyPlan([], [row("equity", 10000, "ai", null)]);

    expect(plan.removals).toEqual([]);
    expect(plan.upserts).toEqual([{ categoryId: "equity", weightBasisPoints: 10000 }]);
    expect(plan.changes).toMatchObject({ addCount: 1, updateCount: 0, removeCount: 0 });
    expect(plan.hasChanges).toBe(true);
  });

  it("plans weight updates", () => {
    const plan = buildAssetClassificationApplyPlan([row("equity", 5000)], [row("equity", 7000)]);

    expect(plan.removals).toEqual([]);
    expect(plan.upserts).toEqual([{ categoryId: "equity", weightBasisPoints: 7000 }]);
    expect(plan.changes).toMatchObject({ addCount: 0, updateCount: 1, removeCount: 0 });
  });

  it("plans source updates so confirmed drafts write source ai", () => {
    const plan = buildAssetClassificationApplyPlan(
      [row("equity", 10000, "manual")],
      [row("equity", 10000)],
    );

    expect(plan.upserts).toEqual([{ categoryId: "equity", weightBasisPoints: 10000 }]);
    expect(plan.changes.updateCount).toBe(1);
  });

  it("plans removals", () => {
    const plan = buildAssetClassificationApplyPlan(
      [row("equity", 6000), row("cash", 4000)],
      [row("equity", 6000)],
    );

    expect(plan.removals).toEqual([{ assignmentId: "assignment-cash", categoryId: "cash" }]);
    expect(plan.upserts).toEqual([]);
    expect(plan.changes.removeCount).toBe(1);
  });

  it("treats zero-weight proposals as removals", () => {
    const plan = buildAssetClassificationApplyPlan(
      [row("equity", 6000), row("cash", 4000)],
      [row("equity", 6000), row("cash", 0)],
    );

    expect(plan.removals).toEqual([{ assignmentId: "assignment-cash", categoryId: "cash" }]);
    expect(plan.upserts).toEqual([]);
    expect(plan.changes.removeCount).toBe(1);
  });

  it("plans clear-all", () => {
    const plan = buildAssetClassificationApplyPlan([row("equity", 10000)], []);

    expect(plan.removals).toEqual([{ assignmentId: "assignment-equity", categoryId: "equity" }]);
    expect(plan.upserts).toEqual([]);
    expect(plan.hasChanges).toBe(true);
  });

  it("detects already-applied drafts", () => {
    const plan = buildAssetClassificationApplyPlan([row("equity", 10000)], [row("equity", 10000)]);

    expect(plan.removals).toEqual([]);
    expect(plan.upserts).toEqual([]);
    expect(plan.changes.unchangedCount).toBe(1);
    expect(plan.hasChanges).toBe(false);
  });
});

describe("formatBasisPoints", () => {
  it("formats whole and fractional percentages", () => {
    const formatting = createFormatter("en-US");
    expect(formatBasisPoints(10000, formatting)).toBe("100%");
    expect(formatBasisPoints(3333, formatting)).toBe("33.33%");
  });
});
