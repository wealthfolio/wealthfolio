import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsDashboard } from "./insights-dashboard";
import {
  defaultInsightsLayout,
  WIDGET_IDS,
  type WidgetId,
  type InsightsLayout,
  type LayoutBreakpoint,
} from "./insights-layout";

interface GridProps {
  children: ReactNode;
  dragConfig: { enabled: boolean };
  resizeConfig: { enabled: boolean };
  layouts: InsightsLayout["layouts"];
  onLayoutChange: (
    layout: InsightsLayout["layouts"]["desktop"],
    layouts: Partial<Record<LayoutBreakpoint, InsightsLayout["layouts"]["desktop"]>>,
  ) => void;
}

const observers: { callback: ResizeObserverCallback; element?: Element }[] = [];

const state = vi.hoisted(() => ({
  settings: { insightsOverviewLayout: undefined as unknown },
  updateSettings: vi.fn<(updates: { insightsOverviewLayout: InsightsLayout }) => Promise<void>>(),
  width: 1200,
  isLoading: false,
  isError: false,
  gridProps: {} as GridProps,
}));
vi.mock("@/lib/settings-provider", () => ({ useSettingsContext: () => state }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { widget?: string }) =>
      `${key}${options?.widget ? `:${options.widget}` : ""}`,
  }),
}));
vi.mock("react-grid-layout", async () => ({
  getBreakpointFromWidth: (
    await vi.importActual<typeof import("react-grid-layout")>("react-grid-layout")
  ).getBreakpointFromWidth,
  verticalCompactor: (
    await vi.importActual<typeof import("react-grid-layout")>("react-grid-layout")
  ).verticalCompactor,
  useContainerWidth: () => ({ width: state.width, containerRef: { current: null }, mounted: true }),
  Responsive: (props: GridProps) => {
    state.gridProps = props;
    return <div>{props.children}</div>;
  },
}));
vi.mock("@wealthfolio/ui", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
      <button {...props}>{children}</button>
    ),
    Icons: { LayoutDashboard: () => null, ArrowUp: () => null, ArrowDown: () => null },
    Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    TooltipProvider: Container,
    Tooltip: Container,
    TooltipTrigger: Container,
    TooltipContent: () => null,
    SheetContent: Container,
    SheetDescription: Container,
    SheetHeader: Container,
    SheetTitle: Container,
    Switch: ({
      onCheckedChange,
      ...props
    }: {
      onCheckedChange: () => void;
      id: string;
      checked: boolean;
      disabled: boolean;
    }) => <input type="checkbox" onChange={onCheckedChange} {...props} />,
  };
});
const widgets = Object.fromEntries(
  WIDGET_IDS.map((id) => [id, <div key={id}>{`widget:${id}`}</div>]),
) as Record<WidgetId, ReactNode>;
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: `insights:customize.${name}` }));
const hideRegions = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: "insights:customize.hide:insights:insights.chart_regions",
    }),
  );

afterEach(cleanup);
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback };
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.element = element;
      }
      disconnect = vi.fn();
    },
  );
  state.settings = { insightsOverviewLayout: undefined };
  state.width = 1200;
  state.isLoading = false;
  state.isError = false;
  state.updateSettings.mockReset();
});

describe("insights dashboard editing", () => {
  it("fits rows to their original content height and follows expanding content", () => {
    render(<InsightsDashboard widgets={widgets} />);
    const observer = observers.find(({ element }) => element?.textContent === "widget:breakdown")!;
    const bounds = vi.spyOn(observer.element!, "getBoundingClientRect");
    bounds.mockReturnValue({ height: 420 } as DOMRect);
    act(() => observer.callback([], {} as ResizeObserver));
    expect(state.gridProps.layouts.desktop.find((item) => item.i === "breakdown")?.h).toBe(436);
    bounds.mockReturnValue({ height: 810 } as DOMRect);
    act(() => observer.callback([], {} as ResizeObserver));
    expect(state.gridProps.layouts.desktop.find((item) => item.i === "breakdown")?.h).toBe(826);
  });

  it.each([
    [699, "mobile"],
    [700, "mobile"],
    [701, "tablet"],
    [1099, "tablet"],
    [1100, "tablet"],
    [1101, "desktop"],
  ] as const)("measures and edits the grid's active layout at width %s", (width, breakpoint) => {
    state.width = width;
    render(<InsightsDashboard widgets={widgets} />);
    const observer = observers.find(({ element }) => element?.textContent === "widget:breakdown")!;
    vi.spyOn(observer.element!, "getBoundingClientRect").mockReturnValue({
      height: 420,
    } as DOMRect);
    act(() => observer.callback([], {} as ResizeObserver));
    expect(state.gridProps.layouts[breakpoint].find((item) => item.i === "breakdown")?.h).toBe(436);
    click("edit");
    expect(state.gridProps.dragConfig.enabled).toBe(breakpoint !== "mobile");
    expect(state.gridProps.resizeConfig.enabled).toBe(breakpoint !== "mobile");
  });

  it("aligns summary backgrounds while allowing natural content to shrink", () => {
    render(
      <InsightsDashboard
        widgets={{
          ...widgets,
          value: (
            <div>
              <div data-value-content>value content</div>
            </div>
          ),
          cash: (
            <div>
              <div data-value-content>cash content</div>
            </div>
          ),
        }}
      />,
    );
    const valueObserver = observers.find(
      ({ element }) => element?.textContent === "value content",
    )!;
    const cashObserver = observers.find(({ element }) => element?.textContent === "cash content")!;
    const valueBounds = vi.spyOn(valueObserver.element!, "getBoundingClientRect");
    valueBounds.mockReturnValue({ height: 120 } as DOMRect);
    vi.spyOn(cashObserver.element!, "getBoundingClientRect").mockReturnValue({
      height: 80,
    } as DOMRect);
    act(() => {
      valueObserver.callback([], {} as ResizeObserver);
      cashObserver.callback([], {} as ResizeObserver);
    });
    expect(
      state.gridProps.layouts.desktop
        .filter((item) => ["value", "cash"].includes(item.i))
        .map((item) => item.h),
    ).toEqual([138, 138]);
    valueBounds.mockReturnValue({ height: 50 } as DOMRect);
    act(() => valueObserver.callback([], {} as ResizeObserver));
    expect(state.gridProps.layouts.desktop.find((item) => item.i === "value")?.h).toBe(98);
  });

  it("only enables dragging while editing and Cancel restores saved visibility without writing", () => {
    render(<InsightsDashboard widgets={widgets} />);
    expect(state.gridProps.dragConfig.enabled).toBe(false);
    click("edit");
    expect(state.gridProps.dragConfig.enabled).toBe(true);
    hideRegions();
    expect(screen.queryByText("widget:regions")).toBeNull();
    click("cancel");
    expect(screen.getByText("widget:regions")).toBeTruthy();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it.each([390, 699, 700, 701, 800, 1099, 1100, 1101, 1200])(
    "renders saved visual reading order at width %s",
    (width) => {
      state.width = width;
      const saved = defaultInsightsLayout();
      const key = width > 1100 ? "desktop" : width > 700 ? "tablet" : "mobile";
      saved.layouts[key].forEach((item, index) => {
        item.x = 0;
        item.y = (index + 1) * 200;
      });
      saved.layouts[key].find((item) => item.i === "cash")!.y = 0;
      state.settings.insightsOverviewLayout = saved;
      const { container } = render(<InsightsDashboard widgets={widgets} />);
      const ids = [...container.querySelectorAll("[data-widget-id]")].map((item) =>
        item.getAttribute("data-widget-id"),
      );
      expect(ids.slice(0, 2)).toEqual(["cash", "value"]);
    },
  );

  it("follows visual order after the real grid compacts tablet gaps", () => {
    state.width = 800;
    const { container } = render(<InsightsDashboard widgets={widgets} />);
    const ids = [...container.querySelectorAll("[data-widget-id]")].map((item) =>
      item.getAttribute("data-widget-id"),
    );
    expect(ids.indexOf("classes")).toBeLessThan(ids.indexOf("accounts"));
    expect(ids.indexOf("sectors")).toBeLessThan(ids.indexOf("regions"));
  });

  it("pairs adjacent mobile metrics even when saved on separate rows", () => {
    const saved = defaultInsightsLayout();
    saved.layouts.mobile.forEach((item, index) => {
      item.x = 0;
      item.y = index * 200;
    });
    state.settings.insightsOverviewLayout = saved;
    render(<InsightsDashboard widgets={widgets} />);
    const bookCost = state.gridProps.layouts.mobile.find((item) => item.i === "bookCost")!;
    const pnl = state.gridProps.layouts.mobile.find((item) => item.i === "pnl")!;
    expect(bookCost).toMatchObject({ x: 0, w: 1 });
    expect(pnl).toMatchObject({ x: 1, y: bookCost.y, w: 1 });
    expect(saved.layouts.mobile.find((item) => item.i === "pnl")?.x).toBe(0);
  });

  it("fills a lone mobile card's row without overwriting its saved pairing", () => {
    render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    fireEvent.click(
      screen.getByRole("button", {
        name: "insights:customize.hide:insights:insights.value_strip.book_cost",
      }),
    );
    expect(state.gridProps.layouts.mobile.find((item) => item.i === "pnl")).toMatchObject({
      x: 0,
      w: 2,
      maxW: 2,
    });
    expect(state.gridProps.layouts.mobile.find((item) => item.i === "cash")?.w).toBe(1);
    act(() => state.gridProps.onLayoutChange([], { mobile: state.gridProps.layouts.mobile }));
    click("widgets");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "insights:insights.value_strip.book_cost" }),
    );
    expect(state.gridProps.layouts.mobile.find((item) => item.i === "pnl")).toMatchObject({
      x: 1,
      w: 1,
    });
  });

  it("saves visibility and restores it on remount", async () => {
    state.updateSettings.mockImplementation((updates) => {
      state.settings = updates;
      return Promise.resolve();
    });
    const view = render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    hideRegions();
    click("save");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "insights:customize.edit" })).toBeTruthy(),
    );
    expect(state.updateSettings.mock.calls[0][0].insightsOverviewLayout).toMatchObject({
      version: 6,
      hiddenWidgets: ["regions"],
    });
    view.unmount();
    render(<InsightsDashboard widgets={widgets} />);
    expect(screen.queryByText("widget:regions")).toBeNull();
  });

  it("hides one summary metric without hiding the others", async () => {
    render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    fireEvent.click(
      screen.getByRole("button", {
        name: "insights:customize.hide:insights:insights.value_strip.cash_balance",
      }),
    );
    expect(screen.queryByText("widget:cash")).toBeNull();
    for (const id of ["value", "invested", "bookCost"]) {
      expect(screen.getByText(`widget:${id}`)).toBeTruthy();
    }
    click("save");
    await waitFor(() => expect(state.updateSettings).toHaveBeenCalled());
    expect(state.updateSettings.mock.calls[0][0].insightsOverviewLayout.hiddenWidgets).toEqual([
      "cash",
    ]);
  });

  it("retains edits after a failed save and allows retry", async () => {
    state.updateSettings.mockRejectedValueOnce(new Error("offline"));
    render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    hideRegions();
    click("save");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "insights:customize.save" })).not.toBeDisabled(),
    );
    expect(screen.queryByText("widget:regions")).toBeNull();
    state.updateSettings.mockImplementation((updates) => {
      state.settings = updates;
      return Promise.resolve();
    });
    click("save");
    await waitFor(() => expect(state.updateSettings).toHaveBeenCalledTimes(2));
  });

  it("preserves hidden widgets and other breakpoints during visible grid callbacks", async () => {
    render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    hideRegions();
    const desktop = state.gridProps.layouts.desktop.map((item) => ({
      ...item,
      y: item.y + 5,
    }));
    act(() => state.gridProps.onLayoutChange(desktop, { desktop }));
    click("save");
    await waitFor(() => expect(state.updateSettings).toHaveBeenCalled());
    const saved = state.updateSettings.mock.calls[0][0].insightsOverviewLayout;
    expect(saved.layouts.desktop).toHaveLength(WIDGET_IDS.length);
    expect(saved.layouts.desktop.find((item) => item.i === "regions")?.y).toBe(100);
    expect(saved.layouts.desktop.find((item) => item.i === "value")?.y).toBe(5);
    expect(saved.layouts.mobile).toEqual(defaultInsightsLayout().layouts.mobile);
  });

  it("Reset remains a draft until saved, and Cancel returns the saved layout", () => {
    const saved = defaultInsightsLayout();
    saved.hiddenWidgets = ["regions"];
    state.settings.insightsOverviewLayout = saved;
    render(<InsightsDashboard widgets={widgets} />);
    click("edit");
    click("reset");
    expect(screen.getByText("widget:regions")).toBeTruthy();
    expect(state.updateSettings).not.toHaveBeenCalled();
    click("cancel");
    expect(screen.queryByText("widget:regions")).toBeNull();
  });
});
