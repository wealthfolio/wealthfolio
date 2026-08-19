import type { FormattingApi } from "@wealthfolio/ui";
import type { AssetClassificationAssignmentPreview, AssetClassificationChanges } from "../../types";

export interface AssetClassificationRemoveOperation {
  assignmentId: string;
  categoryId: string;
}

export interface AssetClassificationUpsertOperation {
  categoryId: string;
  weightBasisPoints: number;
}

export interface AssetClassificationApplyPlan {
  removals: AssetClassificationRemoveOperation[];
  upserts: AssetClassificationUpsertOperation[];
  changes: AssetClassificationChanges;
  hasChanges: boolean;
}

export function buildAssetClassificationApplyPlan(
  current: AssetClassificationAssignmentPreview[],
  proposed: AssetClassificationAssignmentPreview[],
): AssetClassificationApplyPlan {
  const effectiveProposed = proposed.filter((row) => row.weightBasisPoints > 0);
  const currentByCategory = new Map(current.map((row) => [row.categoryId, row]));
  const proposedByCategory = new Map(effectiveProposed.map((row) => [row.categoryId, row]));

  const removals = current
    .filter((row) => !proposedByCategory.has(row.categoryId))
    .map((row) => ({
      assignmentId: row.assignmentId ?? "",
      categoryId: row.categoryId,
    }))
    .filter((row) => row.assignmentId.length > 0);

  const upserts = effectiveProposed
    .filter((row) => {
      const existing = currentByCategory.get(row.categoryId);
      return existing?.weightBasisPoints !== row.weightBasisPoints || existing?.source !== "ai";
    })
    .map((row) => ({
      categoryId: row.categoryId,
      weightBasisPoints: row.weightBasisPoints,
    }));

  const changes: AssetClassificationChanges = {
    addCount: 0,
    updateCount: 0,
    removeCount: removals.length,
    unchangedCount: 0,
  };

  for (const row of effectiveProposed) {
    const existing = currentByCategory.get(row.categoryId);
    if (!existing) {
      changes.addCount += 1;
    } else if (existing.weightBasisPoints !== row.weightBasisPoints || existing.source !== "ai") {
      changes.updateCount += 1;
    } else {
      changes.unchangedCount += 1;
    }
  }

  return {
    removals,
    upserts,
    changes,
    hasChanges: removals.length > 0 || upserts.length > 0,
  };
}

export function formatBasisPoints(
  weightBasisPoints: number,
  formatting: Pick<FormattingApi, "formatDecimal">,
): string {
  const percent = weightBasisPoints / 100;
  return `${formatting.formatDecimal(percent, {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(percent) ? 0 : 2,
  })}%`;
}
