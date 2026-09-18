import type { Layout, LayoutItem } from "react-grid-layout";

export const WIDGET_IDS = [
  "value",
  "cash",
  "invested",
  "bookCost",
  "pnl",
  "accounts",
  "classes",
  "regions",
  "sectors",
  "composition",
  "targets",
  "breakdown",
  "movers",
  "concentration",
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export const GRID_COLUMNS = { desktop: 12, tablet: 6, mobile: 2 };
export type LayoutBreakpoint = keyof typeof GRID_COLUMNS;
export interface InsightsLayout {
  version: 6;
  hiddenWidgets: WidgetId[];
  layouts: Record<LayoutBreakpoint, LayoutItem[]>;
}

export const SUMMARY_WIDGET_IDS: readonly WidgetId[] = [
  "value",
  "cash",
  "invested",
  "bookCost",
  "pnl",
];
const PREVIOUS_WIDGET_IDS = WIDGET_IDS.filter((id) => id !== "movers" && id !== "concentration");
const LEGACY_WIDGET_IDS = PREVIOUS_WIDGET_IDS.filter(
  (id) => !["cash", "invested", "bookCost", "pnl"].includes(id),
);

function mobileWidth(id: string): number {
  return id !== "value" && SUMMARY_WIDGET_IDS.includes(id as WidgetId) ? 1 : 2;
}

export function repackMobile(items: LayoutItem[]): LayoutItem[] {
  let x = 0,
    y = 0,
    rowHeight = 0;
  return [...items]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => {
      const w = mobileWidth(item.i);
      if (x + w > GRID_COLUMNS.mobile) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      const next = { ...item, x, y, w };
      x += w;
      rowHeight = Math.max(rowHeight, item.h);
      return next;
    });
}

function splitSummary(items: LayoutItem[], breakpoint: LayoutBreakpoint): LayoutItem[] {
  const summary = items.find((item) => item.i === "value")!;
  const rows = breakpoint === "mobile" ? 5 : breakpoint === "tablet" ? 3 : 1;
  const extraHeight = (rows - 1) * summary.h;
  return items.flatMap<LayoutItem>((item) => {
    if (item.i !== "value") {
      return [{ ...item, y: item.y >= summary.y + summary.h ? item.y + extraHeight : item.y }];
    }
    return SUMMARY_WIDGET_IDS.map((id, index) => ({
      i: id,
      x:
        breakpoint === "desktop"
          ? [0, 4, 6, 8, 10][index]
          : breakpoint === "tablet"
            ? (index % 2) * 3
            : 0,
      y:
        summary.y +
        (breakpoint === "mobile" ? index : breakpoint === "tablet" ? Math.floor(index / 2) : 0) *
          summary.h,
      w: breakpoint === "desktop" ? [4, 2, 2, 2, 2][index] : breakpoint === "tablet" ? 3 : 1,
      h: summary.h,
    }));
  });
}

function addPnl(items: LayoutItem[], breakpoint: LayoutBreakpoint): LayoutItem[] {
  const summaries = SUMMARY_WIDGET_IDS.filter((id) => id !== "pnl").map(
    (id) => items.find((item) => item.i === id)!,
  );
  const first = summaries[0];
  const bottom = Math.max(...summaries.map((item) => item.y + item.h));
  const height = Math.max(...summaries.map((item) => item.h));
  const atStart =
    first.y === 0 &&
    items
      .filter((item) => !SUMMARY_WIDGET_IDS.includes(item.i as WidgetId))
      .every((item) => item.y >= bottom);
  const standardDesktop =
    atStart &&
    breakpoint === "desktop" &&
    summaries.every(
      (item, index) =>
        item.y === first.y && item.x === [0, 5, 8, 10][index] && item.w === [5, 3, 2, 2][index],
    );
  const standardTablet =
    atStart &&
    breakpoint === "tablet" &&
    summaries.every(
      (item, index) =>
        item.x === (index % 2) * 3 &&
        item.w === 3 &&
        item.y === summaries[Math.floor(index / 2) * 2].y,
    ) &&
    summaries[2].y >= first.y + first.h;
  const standardMobile =
    atStart &&
    breakpoint === "mobile" &&
    summaries.every(
      (item, index) => index === 0 || item.y >= summaries[index - 1].y + summaries[index - 1].h,
    );
  let migrated = items.map((item) => ({ ...item }));
  const pnl: LayoutItem = {
    i: "pnl",
    x: standardDesktop ? 10 : 0,
    y: standardDesktop ? first.y : bottom,
    w: breakpoint === "mobile" ? 1 : breakpoint === "tablet" ? 3 : 2,
    h: height,
  };
  if (standardDesktop) {
    migrated = migrated.map((item) => {
      const index = summaries.findIndex((summary) => summary.i === item.i);
      return index < 0 ? item : { ...item, x: [0, 4, 6, 8][index], w: [4, 2, 2, 2][index] };
    });
  } else if (standardTablet || standardMobile) {
    migrated = migrated.map((item) => (item.y >= bottom ? { ...item, y: item.y + height } : item));
  }
  // Customized arrangements retain their coordinates; use the first free spot
  // below the summary group, skipping any chart that occupies that space.
  let collision = migrated.find(
    (item) =>
      pnl.x < item.x + item.w &&
      pnl.x + pnl.w > item.x &&
      pnl.y < item.y + item.h &&
      pnl.y + pnl.h > item.y,
  );
  while (collision) {
    pnl.y = collision.y + collision.h;
    collision = migrated.find(
      (item) =>
        pnl.x < item.x + item.w &&
        pnl.x + pnl.w > item.x &&
        pnl.y < item.y + item.h &&
        pnl.y + pnl.h > item.y,
    );
  }
  const insertion =
    Math.max(
      ...migrated.map((item, index) =>
        SUMMARY_WIDGET_IDS.includes(item.i as WidgetId) ? index : -1,
      ),
    ) + 1;
  migrated.splice(insertion, 0, pnl);
  return migrated;
}

function appendInsightWidgets(items: LayoutItem[], breakpoint: LayoutBreakpoint): LayoutItem[] {
  const bottom = Math.max(0, ...items.map((item) => item.y + item.h));
  const height = 360;
  return [
    ...items,
    { i: "movers", x: 0, y: bottom, w: breakpoint === "mobile" ? 2 : 6, h: height },
    {
      i: "concentration",
      x: breakpoint === "desktop" ? 6 : 0,
      y: bottom + (breakpoint === "desktop" ? 0 : height),
      w: breakpoint === "mobile" ? 2 : 6,
      h: height,
    },
  ];
}

export function defaultInsightsLayout(): InsightsLayout {
  const desktop: LayoutItem[] = [
    { i: "value", x: 0, y: 0, w: 12, h: 100 },
    ...["accounts", "classes", "regions", "sectors"].map((i, index) => ({
      i,
      x: index * 3,
      y: 100,
      w: 3,
      h: 234,
    })),
    { i: "composition", x: 0, y: 334, w: 9, h: 622 },
    { i: "targets", x: 9, y: 334, w: 3, h: 622 },
    { i: "breakdown", x: 0, y: 956, w: 12, h: 552 },
  ];
  const layouts = {
    desktop: splitSummary(desktop, "desktop"),
    tablet: splitSummary(
      desktop.map((item, index) => ({
        ...item,
        x: index >= 1 && index <= 4 ? ((index - 1) % 2) * 3 : 0,
        y:
          index == 0
            ? 0
            : index <= 4
              ? 100 + Math.floor((index - 1) / 2) * 234
              : 568 + (index - 5) * 622,
        w: index >= 1 && index <= 4 ? 3 : 6,
      })),
      "tablet",
    ),
    mobile: repackMobile(
      splitSummary(
        desktop.map((item, index) => ({ ...item, x: 0, y: index * 622, w: 1 })),
        "mobile",
      ),
    ),
  };
  return {
    version: 6,
    hiddenWidgets: [],
    layouts: Object.fromEntries(
      (Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]).map((key) => [
        key,
        appendInsightWidgets(layouts[key], key),
      ]),
    ) as InsightsLayout["layouts"],
  };
}

// Persist only layout data, never library callbacks or interaction flags.
export function normalizeLayout(items: Layout, breakpoint: LayoutBreakpoint): LayoutItem[] {
  const cols = GRID_COLUMNS[breakpoint];
  return items.map(({ i, x, y, w, h }) => {
    const minW =
      breakpoint === "mobile"
        ? mobileWidth(i)
        : ["cash", "invested", "bookCost", "pnl"].includes(i)
          ? 2
          : ["composition", "breakdown", "movers", "concentration"].includes(i)
            ? 6
            : 3;
    const minH = 1;
    const maxW = breakpoint === "mobile" ? minW : cols;
    const nextWidth = Math.min(maxW, Math.max(minW, w));
    return {
      i,
      x: Math.min(x, cols - nextWidth),
      y,
      w: nextWidth,
      h: Math.max(minH, h),
      minW,
      minH,
      maxW,
      maxH: 100_000,
    };
  });
}

export function readInsightsLayout(value: unknown): InsightsLayout {
  const fallback = defaultInsightsLayout();
  if (!value || typeof value !== "object") return fallback;
  const stored = value as Omit<Partial<InsightsLayout>, "version"> & { version?: number };
  if (
    ![1, 2, 3, 4, 5, 6].includes(stored.version ?? 0) ||
    !Array.isArray(stored.hiddenWidgets) ||
    !stored.layouts
  )
    return fallback;
  const expectedIds: readonly WidgetId[] =
    stored.version === 6
      ? WIDGET_IDS
      : stored.version! >= 4
        ? PREVIOUS_WIDGET_IDS
        : stored.version === 3
          ? PREVIOUS_WIDGET_IDS.filter((id) => id !== "pnl")
          : LEGACY_WIDGET_IDS;
  for (const breakpoint of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
    const items = stored.layouts[breakpoint];
    const cols = breakpoint === "mobile" && stored.version! < 5 ? 1 : GRID_COLUMNS[breakpoint];
    if (
      !Array.isArray(items) ||
      items.length !== expectedIds.length ||
      new Set(items.map((item) => item?.i)).size !== expectedIds.length ||
      items.some(
        (item) =>
          !item ||
          !expectedIds.includes(item.i as WidgetId) ||
          ![item.x, item.y, item.w, item.h].every(Number.isInteger) ||
          item.x < 0 ||
          item.y < 0 ||
          item.y > (stored.version === 1 ? 1000 : 1_000_000) ||
          item.w < 1 ||
          item.h < 1 ||
          item.h > (stored.version === 1 ? 30 : 100_000) ||
          item.x + item.w > cols,
      )
    )
      return fallback;
  }
  return {
    version: 6,
    hiddenWidgets: WIDGET_IDS.filter(
      (id) =>
        stored.hiddenWidgets!.includes(id) ||
        (stored.version! < 3 &&
          stored.hiddenWidgets!.includes("value") &&
          SUMMARY_WIDGET_IDS.includes(id)) ||
        (stored.version === 3 &&
          id === "pnl" &&
          SUMMARY_WIDGET_IDS.filter((id) => id !== "pnl").every((id) =>
            stored.hiddenWidgets!.includes(id),
          )),
    ),
    layouts: Object.fromEntries(
      (Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]).map((key) => {
        const items = stored.layouts![key].map((item) =>
          stored.version === 1 ? { ...item, y: item.y * 46, h: item.h * 46 } : item,
        );
        const migrated =
          stored.version! >= 4
            ? items
            : stored.version === 3
              ? addPnl(items, key)
              : splitSummary(items, key);
        const layout = normalizeLayout(
          key === "mobile" && stored.version! < 5 ? repackMobile(migrated) : migrated,
          key,
        );
        return [
          key,
          stored.version! < 6 ? normalizeLayout(appendInsightWidgets(layout, key), key) : layout,
        ];
      }),
    ) as InsightsLayout["layouts"],
  };
}

export function mergeVisibleLayout(saved: LayoutItem[], visible: Layout): LayoutItem[] {
  return saved.map((item) => visible.find((next) => next.i === item.i) ?? item);
}

export function moveWidget(
  layout: InsightsLayout,
  id: WidgetId,
  direction: -1 | 1,
): InsightsLayout {
  const ids = [...layout.layouts.mobile]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => item.i);
  const index = ids.indexOf(id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= ids.length) return layout;
  [ids[index], ids[next]] = [ids[next], ids[index]];
  const layouts = { ...layout.layouts };
  for (const breakpoint of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
    const ordered = ids.map((widgetId) => layouts[breakpoint].find((item) => item.i === widgetId)!);
    // Repack in reading order, preserving each widget's size.
    let x = 0,
      y = 0,
      rowHeight = 0;
    layouts[breakpoint] = ordered.map((item) => {
      if (x + item.w > GRID_COLUMNS[breakpoint]) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      const moved = { ...item, x, y };
      x += item.w;
      rowHeight = Math.max(rowHeight, item.h);
      return moved;
    });
  }
  return { ...layout, layouts };
}
