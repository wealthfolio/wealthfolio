import { describe, expect, it } from "vitest";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";

describe("allocation target colours", () => {
  it("colours the categories held largest first, then the rest by id", () => {
    const colors = buildAllocationTargetColorMap([
      { categoryId: "europe", currentValue: 12 },
      { categoryId: "oceania", currentValue: 0 },
      { categoryId: "americas", currentValue: 72 },
      { categoryId: "africa", currentValue: 0 },
      { categoryId: "__UNKNOWN__", currentValue: 3 },
    ]);
    expect([...colors]).toEqual([
      ["americas", "var(--chart-1)"],
      ["europe", "var(--chart-2)"],
      ["__UNKNOWN__", "var(--chart-3)"],
      ["africa", "var(--chart-4)"],
      ["oceania", "var(--chart-5)"],
    ]);
  });

  it("gives a category the same colour whatever order the view lists it in", () => {
    // The target card lists rows by drift, the editor by taxonomy order.
    const byDrift = buildAllocationTargetColorMap([
      { categoryId: "asia", currentValue: 10 },
      { categoryId: "americas", currentValue: 70 },
      { categoryId: "oceania", currentValue: 0 },
    ]);
    const byTaxonomy = buildAllocationTargetColorMap([
      { categoryId: "americas", currentValue: 70 },
      { categoryId: "asia", currentValue: 10 },
      { categoryId: "oceania", currentValue: 0 },
    ]);
    expect(byDrift).toEqual(byTaxonomy);
  });

  it("keeps the larger value of a category listed twice", () => {
    // The editor lists the held categories and then every taxonomy category at 0.
    const colors = buildAllocationTargetColorMap([
      { categoryId: "b", currentValue: 5 },
      { categoryId: "a", currentValue: 1 },
      { categoryId: "b", currentValue: 0 },
    ]);
    expect(colors.get("b")).toBe("var(--chart-1)");
    expect(colors.get("a")).toBe("var(--chart-2)");
  });

  it("falls back to the row's position for a category missing from the map", () => {
    expect(allocationTargetColorForRow({ categoryId: "x" }, new Map(), 2)).toBe("var(--chart-3)");
    expect(allocationTargetColorForRow({ categoryId: "x" }, undefined, 8)).toBe(
      "color-mix(in oklab, var(--chart-2) 50%, var(--card))",
    );
  });
});
