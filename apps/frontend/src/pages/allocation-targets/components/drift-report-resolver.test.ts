import { describe, expect, it } from "vitest";

import type { DriftHoldingRow, DriftReport, DriftRow, TaxonomyCategory } from "@/lib/types";
import { resolveDriftReportCategories } from "./drift-report-resolver";

function driftRow(overrides: Partial<DriftRow> & Pick<DriftRow, "categoryId">): DriftRow {
  const { categoryId, ...rest } = overrides;
  return {
    categoryId,
    categoryName: "Old name",
    color: "#000000",
    currentBps: 5000,
    targetBps: 5000,
    driftBps: 0,
    currentValue: 50_000,
    targetValue: 50_000,
    valueDelta: 0,
    effectiveBandBps: 0,
    status: "in_band",
    isRequired: true,
    isZeroCurrent: false,
    isCash: false,
    ...rest,
  };
}

function holdingRow(
  overrides: Partial<DriftHoldingRow> & Pick<DriftHoldingRow, "categoryId">,
): DriftHoldingRow {
  const { categoryId, ...rest } = overrides;
  return {
    id: "holding-row-1",
    holdingId: "holding-1",
    assetId: "asset-1",
    accountId: "account-1",
    symbol: "AAA",
    name: "Holding",
    categoryId,
    categoryName: "Old name",
    categoryColor: "#000000",
    value: 50_000,
    currentPct: 50,
    targetPct: 50,
    driftBps: 0,
    isUnknownCategory: false,
    isCash: false,
    ...rest,
  };
}

describe("resolveDriftReportCategories", () => {
  it("updates top-level and holding category labels from the live taxonomy", () => {
    const report: DriftReport = {
      targetId: "target-1",
      scopeType: "all",
      scopeId: null,
      totalValue: 100_000,
      baseCurrency: "USD",
      maxDriftBps: 0,
      outOfBandCount: 0,
      rows: [driftRow({ categoryId: "region-a" })],
      holdings: {
        targetId: "target-1",
        totalValue: 100_000,
        baseCurrency: "USD",
        rows: [holdingRow({ categoryId: "region-a" })],
      },
      deployableCash: 5000,
    };
    const categories: TaxonomyCategory[] = [
      {
        id: "region-a",
        taxonomyId: "regions",
        parentId: null,
        name: "Region A",
        key: "region-a",
        color: "#123456",
        description: null,
        sortOrder: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        icon: null,
      },
    ];

    const resolved = resolveDriftReportCategories(report, categories);

    expect(resolved.rows[0]).toMatchObject({
      categoryName: "Region A",
      color: "#123456",
    });
    expect(resolved.holdings?.rows[0]).toMatchObject({
      categoryName: "Region A",
      categoryColor: "#123456",
    });
  });
});
