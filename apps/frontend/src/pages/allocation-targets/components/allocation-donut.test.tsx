import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DriftRow } from "@/lib/types";
import { AllocationDonut } from "./allocation-donut";
import { allocationTargetColor, buildAllocationTargetColorMap } from "./allocation-target-colors";

function row(
  overrides: Partial<DriftRow> & Pick<DriftRow, "categoryId" | "categoryName">,
): DriftRow {
  const { categoryId, categoryName, ...rest } = overrides;
  return {
    categoryId,
    categoryName,
    color: "#000000",
    currentBps: 0,
    targetBps: 0,
    driftBps: 0,
    currentValue: 0,
    targetValue: 0,
    valueDelta: 0,
    effectiveBandBps: 0,
    status: "in_band",
    isRequired: true,
    isZeroCurrent: false,
    isCash: false,
    ...rest,
  };
}

describe("AllocationDonut", () => {
  it("uses canonical report row colors after filtering out target-only segments", () => {
    const rows = [
      row({
        categoryId: "target-only",
        categoryName: "Target Only",
        targetBps: 1000,
        targetValue: 10_000,
      }),
      row({
        categoryId: "region-b",
        categoryName: "Region B",
        currentBps: 6000,
        currentValue: 60_000,
      }),
      row({
        categoryId: "region-c",
        categoryName: "Region C",
        currentBps: 4000,
        currentValue: 40_000,
      }),
    ];

    const colorByCategory = buildAllocationTargetColorMap(rows);
    const { container } = render(
      <AllocationDonut
        rows={rows}
        colorByCategory={colorByCategory}
        totalValue={100_000}
        currency="USD"
      />,
    );

    const segment = container.querySelector('[data-category-id="region-b"]');

    expect(segment).toHaveAttribute("fill", allocationTargetColor("region-b", "Region B", 1));
    expect(segment).not.toHaveAttribute("fill", allocationTargetColor("region-b", "Region B", 0));
  });
});
