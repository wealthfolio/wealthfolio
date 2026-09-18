import { describe, expect, it } from "vitest";
import {
  defaultInsightsLayout,
  mergeVisibleLayout,
  moveWidget,
  normalizeLayout,
  readInsightsLayout,
  WIDGET_IDS,
  GRID_COLUMNS,
  type LayoutBreakpoint,
} from "./insights-layout";

describe("insights layout preferences", () => {
  it.each([undefined, null, {}, { version: 7 }, { version: 1, hiddenWidgets: [], layouts: {} }])(
    "falls back for unsupported or missing settings: %j",
    (value) => {
      expect(readInsightsLayout(value)).toEqual(defaultInsightsLayout());
    },
  );

  const withoutNewWidgets = (
    items: ReturnType<typeof defaultInsightsLayout>["layouts"]["desktop"],
  ) => items.filter((item) => item.i !== "movers" && item.i !== "concentration");
  function previousDefaults() {
    const defaults = defaultInsightsLayout();
    for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[])
      defaults.layouts[key] = withoutNewWidgets(defaults.layouts[key]);
    return defaults;
  }

  function legacyLayout(version: 1 | 2) {
    const ids = [
      "accounts",
      "value",
      "classes",
      "regions",
      "sectors",
      "composition",
      "targets",
      "breakdown",
    ];
    const unit = version === 1 ? 1 : 46;
    return {
      version,
      hiddenWidgets: ["value", "regions"],
      layouts: Object.fromEntries(
        Object.entries(GRID_COLUMNS).map(([key, cols]) => [
          key,
          ids.map((i, index) => ({
            i,
            x: 0,
            y: index * 7 * unit,
            w: key === "mobile" ? 1 : cols,
            h: 7 * unit,
          })),
        ]),
      ),
    };
  }

  it.each([1, 2] as const)(
    "migrates v%s summary in place, preserving other widgets and hiding all summary cards",
    (version) => {
      const legacy = legacyLayout(version);
      const snapshot = structuredClone(legacy);
      const migrated = readInsightsLayout(legacy);
      expect(migrated.version).toBe(6);
      expect(migrated.hiddenWidgets).toEqual([
        "value",
        "cash",
        "invested",
        "bookCost",
        "pnl",
        "regions",
      ]);
      for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
        const layout = migrated.layouts[key];
        expect(layout.map((item) => item.i)).toEqual([
          "accounts",
          "value",
          "cash",
          "invested",
          "bookCost",
          "pnl",
          "classes",
          "regions",
          "sectors",
          "composition",
          "targets",
          "breakdown",
          "movers",
          "concentration",
        ]);
        expect(layout.find((item) => item.i === "value")?.y).toBe(322);
        const extraRows = key === "mobile" || key === "tablet" ? 2 : 0;
        expect(layout.find((item) => item.i === "classes")?.y).toBe(644 + extraRows * 322);
        expect(layout.find((item) => item.i === "classes")?.w).toBe(GRID_COLUMNS[key]);
        for (const [index, item] of layout.entries()) {
          for (const next of layout.slice(index + 1)) {
            const overlap =
              item.x < next.x + next.w &&
              item.x + item.w > next.x &&
              item.y < next.y + next.h &&
              item.y + item.h > next.y;
            expect(overlap).toBe(false);
          }
        }
      }
      expect(legacy).toEqual(snapshot);
    },
  );

  it("round trips v6 with independently hidden and positioned summary cards", () => {
    const input = defaultInsightsLayout();
    input.hiddenWidgets = ["cash", "bookCost"];
    input.layouts.desktop.find((item) => item.i === "invested")!.y = 4000;
    const result = readInsightsLayout(input);
    expect(result.hiddenWidgets).toEqual(["cash", "bookCost"]);
    expect(result.layouts.desktop.find((item) => item.i === "invested")?.y).toBe(4000);
    expect(readInsightsLayout(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("gives summaries independent widths at every breakpoint", () => {
    const defaults = defaultInsightsLayout();
    expect(defaults.layouts.desktop.slice(0, 5).map(({ x, w }) => [x, w])).toEqual([
      [0, 4],
      [4, 2],
      [6, 2],
      [8, 2],
      [10, 2],
    ]);
    expect(defaults.layouts.tablet.slice(0, 5).map(({ x, y, w }) => [x, y, w])).toEqual([
      [0, 0, 3],
      [3, 0, 3],
      [0, 100, 3],
      [3, 100, 3],
      [0, 200, 3],
    ]);
    expect(defaults.layouts.mobile.slice(0, 5).map(({ x, y, w }) => [x, y, w])).toEqual([
      [0, 0, 2],
      [0, 100, 1],
      [1, 100, 1],
      [0, 200, 1],
      [1, 200, 1],
    ]);
    expect(
      normalizeLayout(defaults.layouts.desktop, "desktop")
        .slice(0, 5)
        .map((item) => item.minW),
    ).toEqual([3, 2, 2, 2, 2]);
  });

  it("migrates the v3 default summary strip to five adjacent cards", () => {
    const previous = previousDefaults();
    for (const [key, layout] of Object.entries(previous.layouts)) {
      previous.layouts[key as LayoutBreakpoint] = layout
        .filter((item) => item.i !== "pnl")
        .map((item, index) => (key === "mobile" ? { ...item, x: 0, y: index * 1000, w: 1 } : item));
      if (key === "desktop") {
        previous.layouts.desktop.slice(0, 4).forEach((item, index) => {
          item.x = [0, 5, 8, 10][index];
          item.w = [5, 3, 2, 2][index];
        });
      }
    }
    previous.hiddenWidgets = ["cash", "regions"];
    const migrated = readInsightsLayout({ ...previous, version: 3 });
    expect(migrated.version).toBe(6);
    expect(migrated.hiddenWidgets).toEqual(["cash", "regions"]);
    expect(migrated.layouts.desktop.slice(0, 5).map(({ i, x, w }) => [i, x, w])).toEqual([
      ["value", 0, 4],
      ["cash", 4, 2],
      ["invested", 6, 2],
      ["bookCost", 8, 2],
      ["pnl", 10, 2],
    ]);
    expect(migrated.layouts.desktop.find((item) => item.i === "accounts")?.y).toBe(100);
  });

  it("preserves custom v3 positions while adding pnl without a collision and carries fully hidden summaries forward", () => {
    const previous = previousDefaults();
    for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
      previous.layouts[key] = previous.layouts[key]
        .filter((item) => item.i !== "pnl")
        .map((item, index) => ({
          ...item,
          x: 0,
          y: 1000 + index * 1000,
          w: key === "mobile" ? 1 : item.w,
        }));
    }
    previous.hiddenWidgets = ["value", "cash", "invested", "bookCost"];
    const migrated = readInsightsLayout({ ...previous, version: 3 });
    expect(migrated.hiddenWidgets).toEqual(["value", "cash", "invested", "bookCost", "pnl"]);
    for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
      if (key === "mobile") {
        expect(
          withoutNewWidgets(migrated.layouts.mobile)
            .filter((item) => item.i !== "pnl")
            .map((item) => item.i),
        ).toEqual(previous.layouts.mobile.map((item) => item.i));
        continue;
      }
      for (const original of previous.layouts[key]) {
        expect(migrated.layouts[key].find((item) => item.i === original.i)).toMatchObject(original);
      }
      const pnl = migrated.layouts[key].find((item) => item.i === "pnl")!;
      expect(pnl.y).toBeGreaterThanOrEqual(4100);
      expect(
        previous.layouts[key].some(
          (item) =>
            item.x < pnl.x + pnl.w &&
            item.x + item.w > pnl.x &&
            item.y < pnl.y + pnl.h &&
            item.y + item.h > pnl.y,
        ),
      ).toBe(false);
    }
  });

  it("migrates v5 by appending both insights without changing existing positions or hidden preferences", () => {
    const previous = previousDefaults();
    previous.hiddenWidgets = ["regions", "cash"];
    previous.layouts.desktop.find((item) => item.i === "breakdown")!.y = 4000;
    const snapshot = structuredClone(previous);
    const migrated = readInsightsLayout({ ...previous, version: 5 });
    expect(migrated.version).toBe(6);
    expect(migrated.hiddenWidgets).toEqual(["cash", "regions"]);
    for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
      expect(withoutNewWidgets(migrated.layouts[key])).toEqual(
        normalizeLayout(previous.layouts[key], key),
      );
      const bottom = Math.max(...previous.layouts[key].map((item) => item.y + item.h));
      const movers = migrated.layouts[key].find((item) => item.i === "movers")!;
      const concentration = migrated.layouts[key].find((item) => item.i === "concentration")!;
      expect(movers).toMatchObject({ x: 0, y: bottom, w: key === "mobile" ? 2 : 6 });
      expect(concentration).toMatchObject({
        x: key === "desktop" ? 6 : 0,
        y: key === "desktop" ? bottom : bottom + movers.h,
        w: key === "mobile" ? 2 : 6,
      });
      expect(movers.minW).toBe(key === "mobile" ? 2 : 6);
      expect(concentration.minW).toBe(key === "mobile" ? 2 : 6);
    }
    expect(previous).toEqual(snapshot);
  });

  it("shows the new insights by default after the existing cards", () => {
    const defaults = defaultInsightsLayout();
    expect(defaults.hiddenWidgets).toEqual([]);
    for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
      expect(defaults.layouts[key].slice(-2).map((item) => item.i)).toEqual([
        "movers",
        "concentration",
      ]);
      const previousBottom = Math.max(
        ...withoutNewWidgets(defaults.layouts[key]).map((item) => item.y + item.h),
      );
      expect(defaults.layouts[key].find((item) => item.i === "movers")?.y).toBe(previousBottom);
    }
  });

  it("rejects duplicate widgets and invalid geometry", () => {
    for (const patch of [
      { i: "accounts" },
      { x: -1 },
      { w: 13 },
      { h: Infinity },
      { y: 1_000_001 },
    ]) {
      const input = defaultInsightsLayout();
      Object.assign(input.layouts.desktop[0], patch);
      expect(readInsightsLayout(input)).toEqual(defaultInsightsLayout());
    }
  });

  it("preserves valid visibility and positions, stripping unknown widgets and interaction flags", () => {
    const input = defaultInsightsLayout();
    input.hiddenWidgets = ["regions", "regions", "removed" as never];
    input.layouts.desktop[0] = { ...input.layouts.desktop[0], y: 20, isDraggable: false };
    const result = readInsightsLayout(input);
    expect(result.hiddenWidgets).toEqual(["regions"]);
    expect(result.layouts.desktop[0].y).toBe(20);
    expect(result.layouts.desktop[0]).not.toHaveProperty("isDraggable");
    expect(result.layouts.desktop[0].minW).toBe(3);
  });

  it("clamps undersized saved charts to readable dimensions and keeps them in bounds", () => {
    const saved = defaultInsightsLayout();
    const chart = saved.layouts.desktop.find((item) => item.i === "composition")!;
    Object.assign(chart, { x: 11, w: 1, h: 1 });
    const restored = readInsightsLayout(saved).layouts.desktop.find(
      (item) => item.i === "composition",
    )!;
    expect(restored.w).toBeGreaterThanOrEqual(6);
    expect(restored.h).toBeGreaterThanOrEqual(1);
    expect(restored.x + restored.w).toBeLessThanOrEqual(12);
  });

  it("retains hidden widget positions when the grid emits only visible widgets", () => {
    const initial = defaultInsightsLayout().layouts.desktop;
    const visible = initial
      .filter((item) => item.i !== "regions")
      .map((item) => ({ ...item, y: item.y + 7 }));
    const merged = mergeVisibleLayout(initial, visible);
    expect(merged).toHaveLength(WIDGET_IDS.length);
    expect(merged.find((item) => item.i === "regions")).toEqual(
      initial.find((item) => item.i === "regions"),
    );
    expect(merged[0].y).toBe(7);
  });

  it("reorders via keyboard controls across breakpoints without mutating saved preferences", () => {
    const saved = defaultInsightsLayout();
    const snapshot = structuredClone(saved);
    const moved = moveWidget(saved, "classes", -1);
    for (const layout of Object.values(moved.layouts)) {
      const ids = [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((item) => item.i);
      expect(ids.indexOf("classes")).toBeLessThan(ids.indexOf("accounts"));
    }
    expect(saved).toEqual(snapshot);
  });

  it("keeps mobile charts full width and small metrics half width", () => {
    const items = normalizeLayout(defaultInsightsLayout().layouts.mobile, "mobile");
    expect(
      items
        .filter((item) => ["cash", "invested", "bookCost", "pnl"].includes(item.i))
        .every((item) => item.w === 1 && item.minW === 1 && item.maxW === 1),
    ).toBe(true);
    expect(
      items
        .filter((item) => !["cash", "invested", "bookCost", "pnl"].includes(item.i))
        .every((item) => item.w === 2 && item.minW === 2 && item.maxW === 2),
    ).toBe(true);
    expect(items.find((item) => item.i === "composition")?.minH).toBe(1);
  });

  it("migrates v4 custom mobile order into paired metrics without altering desktop/tablet or visibility", () => {
    const old = previousDefaults();
    const ids = [
      "accounts",
      "cash",
      "bookCost",
      "value",
      "pnl",
      "invested",
      "regions",
      "classes",
      "sectors",
      "composition",
      "targets",
      "breakdown",
    ];
    old.layouts.mobile = ids.map((id, index) => ({
      ...old.layouts.mobile.find((item) => item.i === id)!,
      x: 0,
      y: index * 1000,
      w: 1,
    }));
    old.hiddenWidgets = ["cash", "sectors"];
    const next = readInsightsLayout({ ...old, version: 4 });
    expect(withoutNewWidgets(next.layouts.mobile).map((item) => item.i)).toEqual(ids);
    expect(next.hiddenWidgets).toEqual(["cash", "sectors"]);
    expect(withoutNewWidgets(next.layouts.desktop)).toEqual(
      normalizeLayout(old.layouts.desktop, "desktop"),
    );
    expect(withoutNewWidgets(next.layouts.tablet)).toEqual(
      normalizeLayout(old.layouts.tablet, "tablet"),
    );
    const cash = next.layouts.mobile.find((item) => item.i === "cash")!;
    const cost = next.layouts.mobile.find((item) => item.i === "bookCost")!;
    expect([cash.x, cost.x, cash.y === cost.y]).toEqual([0, 1, true]);
    for (const [index, item] of next.layouts.mobile.entries()) {
      for (const other of next.layouts.mobile.slice(index + 1)) {
        expect(
          item.x < other.x + other.w &&
            item.x + item.w > other.x &&
            item.y < other.y + other.h &&
            item.y + item.h > other.y,
        ).toBe(false);
      }
    }
  });

  it("keeps reading order when moving a metric across the full-width mobile hero", () => {
    const moved = moveWidget(defaultInsightsLayout(), "cash", -1);
    expect(moved.layouts.mobile.slice(0, 3).map(({ i, x, w }) => [i, x, w])).toEqual([
      ["cash", 0, 1],
      ["value", 0, 2],
      ["invested", 0, 1],
    ]);
    expect(moved.layouts.mobile[1].y).toBeGreaterThanOrEqual(
      moved.layouts.mobile[0].y + moved.layouts.mobile[0].h,
    );
  });
});
