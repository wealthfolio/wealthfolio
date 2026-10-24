import { render } from "@/test/render";
import { describe, expect, it } from "vitest";

import type { DriftRow } from "@/lib/types";
import { AllocationDonut } from "./allocation-donut";
import { buildAllocationTargetColorMap } from "./allocation-target-colors";

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
  it("colours segments by current size, as the Insights donuts do, after filtering out target-only rows", () => {
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

    // Region B is the largest held, though the report lists the target-only row first.
    expect(container.querySelector('[data-category-id="region-b"]')).toHaveAttribute(
      "fill",
      "var(--chart-1)",
    );
    expect(container.querySelector('[data-category-id="region-c"]')).toHaveAttribute(
      "fill",
      "var(--chart-2)",
    );
  });
});
