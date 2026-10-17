import { describe, expect, it } from "vitest";

import {
  activeTarget,
  categoryEmphasis,
  changeInCategory,
  partialShareBps,
  partitionAmountsRows,
  rowEmphasis,
  rowStaysOpen,
  rowStatus,
  sameTarget,
  stepByUnits,
  trackHalfWindowBps,
  trackPosition,
  unitsFor,
  type HighlightTarget,
  type OpenRowFacts,
  type RowStatusFacts,
} from "./allocation-worksheet-amounts";
import { createHighlightStore } from "./allocation-worksheet-highlight";

const balanced = [
  { categoryId: "us", weightBps: 6_000 },
  { categoryId: "bond", weightBps: 4_000 },
];
const usOnly = [{ categoryId: "us", weightBps: 10_000 }];
const row = (assetId: string): HighlightTarget => ({ kind: "row", assetId });
const category = (categoryId: string): HighlightTarget => ({ kind: "category", categoryId });

function facts(overrides: Partial<OpenRowFacts> = {}): OpenRowFacts {
  return {
    changedAssetIds: new Set(),
    flaggedAssetIds: new Set(),
    unresolvedCategoryIds: new Set(),
    touchedAssetIds: new Set(),
    addedAssetIds: new Set(),
    ...overrides,
  };
}

describe("Amounts highlight", () => {
  it("previews what is pointed at while the selection waits underneath", () => {
    expect(activeTarget({ pointed: null, selected: row("vt") })).toEqual(row("vt"));
    expect(activeTarget({ pointed: category("bond"), selected: row("vt") })).toEqual(
      category("bond"),
    );
  });

  it("compares targets by what they point at, not by identity", () => {
    expect(sameTarget(row("vt"), row("vt"))).toBe(true);
    expect(sameTarget(row("vt"), category("vt"))).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(row("vt"), null)).toBe(false);
  });

  it("lights every class a mixed fund touches, and only those", () => {
    const active = row("vbiax");
    expect(categoryEmphasis(active, "us", balanced)).toBe("lit");
    expect(categoryEmphasis(active, "bond", balanced)).toBe("lit");
    expect(categoryEmphasis(active, "gold", balanced)).toBe("dim");
    expect(categoryEmphasis(null, "gold", undefined)).toBe("none");
  });

  it("lights the rows touching a class, whatever their share of it", () => {
    const active = category("bond");
    expect(rowEmphasis(active, "vbiax", balanced)).toBe("lit");
    expect(rowEmphasis(active, "voo", usOnly)).toBe("dim");
    expect(rowEmphasis(row("voo"), "voo", usOnly)).toBe("active");
    expect(rowEmphasis(row("voo"), "vbiax", balanced)).toBe("dim");
  });

  it("shows a share only for a row partly in the active class", () => {
    expect(partialShareBps(category("bond"), balanced)).toBe(4_000);
    expect(partialShareBps(category("us"), usOnly)).toBeNull();
    expect(partialShareBps(category("bond"), usOnly)).toBeNull();
    expect(partialShareBps(row("vbiax"), balanced)).toBeNull();
  });

  it("splits a row's change by its share of each class", () => {
    expect(changeInCategory(1_200, 6_000)).toBe(720);
    expect(changeInCategory(1_200, 4_000)).toBe(480);
    expect(changeInCategory(-500, 10_000)).toBe(-500);
  });
});

describe("stepping by units", () => {
  it("adds one whole unit as an exact amount the core floors back to the same units", () => {
    // 3 units at 59.31 typed as 177.93, then one more.
    const next = stepByUnits(177.93, 59.31, 1, true, 2);
    expect(next).toBe(237.24);
    expect(unitsFor(next, 59.31, true)).toBe(4);
  });

  it("rounds up to the cent, so a price with more decimals keeps the unit just added", () => {
    const price = 59.311234;
    const next = stepByUnits(0, price, 1, true, 2);
    expect(next).toBe(59.32);
    expect(unitsFor(next, price, true)).toBe(1);
  });

  it("snaps a typed amount to whole units before stepping", () => {
    // 200 at 59.31 is 3.37 units: one more is 4, not 4.37.
    expect(stepByUnits(200, 59.31, 1, true, 2)).toBe(237.24);
    expect(stepByUnits(200, 59.31, -1, true, 2)).toBe(118.62);
  });

  it("steps into a reduction, still in whole units", () => {
    const next = stepByUnits(0, 59.31, -1, true, 2);
    expect(next).toBe(-59.31);
    expect(unitsFor(next, 59.31, true)).toBe(1);
  });

  it("adds a unit's price as it is when fractions are allowed", () => {
    expect(stepByUnits(100, 59.31, 1, false, 2)).toBe(159.31);
    expect(unitsFor(159.31, 59.31, false)).toBeCloseTo(2.686, 3);
  });

  it("follows the currency's smallest unit", () => {
    expect(stepByUnits(0, 1234.4, 1, true, 0)).toBe(1235);
  });
});

describe("class tracks", () => {
  // The figures of a real portfolio: equity far under target, fixed income far over.
  const classes = [
    { currentBps: 4710, projectedBps: 4680, targetBps: 6500, effectiveBandBps: 500 },
    { currentBps: 3920, projectedBps: 3810, targetBps: 1500, effectiveBandBps: 500 },
    { currentBps: 380, projectedBps: 420, targetBps: 1000, effectiveBandBps: 500 },
  ];

  it("shares one scale wide enough that no weight sits pinned at an edge", () => {
    const halfWindow = trackHalfWindowBps(classes);
    const positions = classes.flatMap((item) => [
      trackPosition(item.currentBps, item.targetBps, halfWindow),
      trackPosition(item.projectedBps, item.targetBps, halfWindow),
    ]);
    expect(Math.max(...positions)).toBeLessThan(97);
    expect(Math.min(...positions)).toBeGreaterThan(3);
    // Fixed income, 24 points over, sits further right than equity, 18 under, sits left.
    expect(trackPosition(3920, 1500, halfWindow) - 50).toBeGreaterThan(
      50 - trackPosition(4710, 6500, halfWindow),
    );
  });

  it("keeps at least 8 points, or twice a band, when every class sits close", () => {
    expect(
      trackHalfWindowBps([
        { currentBps: 1000, projectedBps: 1010, targetBps: 1000, effectiveBandBps: 200 },
      ]),
    ).toBe(800);
    expect(
      trackHalfWindowBps([
        { currentBps: 1000, projectedBps: 1010, targetBps: 1000, effectiveBandBps: 600 },
      ]),
    ).toBe(1200);
  });
});

describe("Amounts highlight store", () => {
  it("keeps a newer pointer when the previous one leaves late", () => {
    const store = createHighlightStore();
    store.getState().point(row("a"));
    store.getState().point(row("b"));
    store.getState().unpoint(row("a"));
    expect(store.getState().pointed).toEqual(row("b"));
    store.getState().unpoint(row("b"));
    expect(store.getState().pointed).toBeNull();
  });

  it("toggles a selection, and a tap on the amount field selects without toggling", () => {
    const store = createHighlightStore();
    store.getState().toggleSelected(row("vt"));
    expect(store.getState().selected).toEqual(row("vt"));
    store.getState().select(row("vt"));
    expect(store.getState().selected).toEqual(row("vt"));
    store.getState().toggleSelected(row("vt"));
    expect(store.getState().selected).toBeNull();
  });

  it("forgets a row that left the worksheet", () => {
    const store = createHighlightStore();
    store.getState().select(row("vt"));
    store.getState().point(row("vt"));
    store.getState().forgetRow("vt");
    expect(store.getState()).toMatchObject({ pointed: null, selected: null });
  });
});

describe("Amounts row status", () => {
  const quiet: RowStatusFacts = {
    needsPrice: false,
    warnings: [],
    isExcluded: false,
    placedAccountIds: [],
  };

  it("states nothing for a row with nothing to say", () => {
    expect(rowStatus(quiet)).toBeNull();
  });

  it("puts what blocks the worksheet before anything the preview says", () => {
    const facts: RowStatusFacts = {
      ...quiet,
      needsPrice: true,
      warnings: ["Dated quote"],
      isExcluded: true,
      placedAccountIds: ["acc-1"],
    };
    expect(
      rowStatus({ ...facts, issue: { kind: "allocation", message: "Allocate the full change" } }),
    ).toEqual({ kind: "needs_account" });
    expect(
      rowStatus({ ...facts, issue: { kind: "position", message: "Enter a valid change" } }),
    ).toEqual({ kind: "check_amount", message: "Enter a valid change" });
    expect(rowStatus(facts)).toEqual({ kind: "price_required" });
  });

  it("then the preview's warnings, rounding and dated prices, in that order", () => {
    expect(rowStatus({ ...quiet, warnings: ["a", "b"], roundedAmount: 1180 })).toEqual({
      kind: "warnings",
      messages: ["a", "b"],
    });
    expect(rowStatus({ ...quiet, roundedAmount: 1180, stalePriceDate: "2026-09-03" })).toEqual({
      kind: "rounded",
      amount: 1180,
    });
    expect(rowStatus({ ...quiet, stalePriceDate: "2026-09-03", isExcluded: true })).toEqual({
      kind: "stale_price",
      date: "2026-09-03",
    });
  });

  it("says where a change sits only after everything else", () => {
    expect(rowStatus({ ...quiet, isExcluded: true, placedAccountIds: ["acc-1"] })).toEqual({
      kind: "not_eligible",
    });
    expect(rowStatus({ ...quiet, placedAccountIds: ["acc-1", "acc-2"] })).toEqual({
      kind: "placed",
      accountIds: ["acc-1", "acc-2"],
    });
  });
});

describe("Amounts collapsed rows", () => {
  const vti = { assetId: "vti", value: 900, categoryIds: ["us"] };
  const iau = { assetId: "iau", value: 300, categoryIds: ["gold"] };
  const bnd = { assetId: "bnd", value: 200, categoryIds: ["bond"] };

  it("keeps out a row with a change, a warning, an unresolved class, a touch or an addition", () => {
    expect(rowStaysOpen(vti, facts())).toBe(false);
    expect(rowStaysOpen(vti, facts({ changedAssetIds: new Set(["vti"]) }))).toBe(true);
    expect(rowStaysOpen(vti, facts({ flaggedAssetIds: new Set(["vti"]) }))).toBe(true);
    expect(rowStaysOpen(iau, facts({ unresolvedCategoryIds: new Set(["gold"]) }))).toBe(true);
    // Cleared back to zero during the visit: still out until the panel is left.
    expect(rowStaysOpen(vti, facts({ touchedAssetIds: new Set(["vti"]) }))).toBe(true);
    // Added by hand and not sized yet: it would otherwise vanish as it is added.
    expect(rowStaysOpen(vti, facts({ addedAssetIds: new Set(["vti"]) }))).toBe(true);
  });

  it("collapses the rest without reordering either part, and totals its value", () => {
    const partition = partitionAmountsRows(
      [vti, iau, bnd],
      facts({ changedAssetIds: new Set(["bnd"]), unresolvedCategoryIds: new Set(["gold"]) }),
    );
    expect(partition.open.map((item) => item.assetId)).toEqual(["iau", "bnd"]);
    expect(partition.collapsed.map((item) => item.assetId)).toEqual(["vti"]);
    expect(partition.collapsedValue).toBe(900);
  });
});
