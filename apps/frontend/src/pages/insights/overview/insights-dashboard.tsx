import { useIsMobileViewport } from "@/hooks/use-platform";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  Button,
  Icons,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, GripVertical, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getBreakpointFromWidth,
  Responsive,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import {
  defaultInsightsLayout,
  GRID_COLUMNS,
  mergeVisibleLayout,
  moveWidget,
  normalizeLayout,
  readInsightsLayout,
  repackMobile,
  WIDGET_IDS,
  SUMMARY_WIDGET_IDS,
  type InsightsLayout,
  type LayoutBreakpoint,
  type WidgetId,
} from "./insights-layout";
import "react-grid-layout/css/styles.css";
import "./insights-dashboard.css";

const GRID_BREAKPOINTS = { desktop: 1100, tablet: 700, mobile: 0 };

interface InsightsDashboardProps {
  widgets: Record<WidgetId, ReactNode>;
  onCustomizeActionChange?: (action: ReactNode | null) => void;
}

// Measure normal document flow so summaries, charts and expanded tables retain
// their original heights instead of stretching to arbitrary grid row counts.
function WidgetContent({
  children,
  onHeight,
  minHeight,
  summary = false,
}: {
  children: ReactNode;
  onHeight: (height: number) => void;
  minHeight?: number;
  summary?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measured = summary ? (element.querySelector("[data-value-content]") ?? element) : element;
    const observer = new ResizeObserver(() => {
      // Summary backgrounds stretch together; measure the natural inner content.
      const height =
        Math.ceil(measured.getBoundingClientRect().height) + (measured !== element ? 2 : 0);
      if (height > 0) onHeight(height);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [onHeight, summary, children]);
  return (
    <div ref={ref} className="insights-widget-content" style={{ minHeight }}>
      {children}
    </div>
  );
}

export function InsightsDashboard({ widgets, onCustomizeActionChange }: InsightsDashboardProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const { settings, updateSettings, isLoading, isError } = useSettingsContext();
  const saved = useMemo(
    () => readInsightsLayout(settings?.insightsOverviewLayout),
    [settings?.insightsOverviewLayout],
  );
  const [draft, setDraft] = useState<InsightsLayout | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { width, containerRef, mounted } = useContainerWidth();
  const breakpoint = getBreakpointFromWidth<LayoutBreakpoint>(GRID_BREAKPOINTS, width);
  const [heights, setHeights] = useState<
    Partial<Record<LayoutBreakpoint, Partial<Record<WidgetId, number>>>>
  >({});
  const heightCallbacks = useMemo(
    () =>
      Object.fromEntries(
        WIDGET_IDS.map((id) => [
          id,
          (height: number) => {
            setHeights((prev) =>
              prev[breakpoint]?.[id] === height
                ? prev
                : {
                    ...prev,
                    [breakpoint]: { ...prev[breakpoint], [id]: height },
                  },
            );
          },
        ]),
      ) as Record<WidgetId, (height: number) => void>,
    [breakpoint],
  );
  const editing = draft !== null;
  const current = draft ?? saved;
  const labels: Record<WidgetId, string> = {
    value: t("insights:insights.value_strip.portfolio_value"),
    cash: t("insights:insights.value_strip.cash_balance"),
    invested: t("insights:insights.value_strip.invested"),
    bookCost: t("insights:insights.value_strip.book_cost"),
    pnl: t("holdings:unrealized_pnl"),
    accounts: t("insights:insights.explorer.lens_accounts"),
    classes: t("insights:insights.chart_classes"),
    regions: t("insights:insights.chart_regions"),
    sectors: t("insights:insights.chart_sectors"),
    composition: t("holdings:composition"),
    targets: t("insights:insights.target_allocation"),
    movers: t("insights:highlights.movers"),
    concentration: t("insights:highlights.concentration"),
    breakdown: t("insights:customize.breakdown"),
  };
  const visibleLayouts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]).map((key) => {
          const visible = normalizeLayout(
            current.layouts[key].filter(
              (item) => !current.hiddenWidgets.includes(item.i as WidgetId),
            ),
            key,
          );
          return [key, key === "mobile" ? repackMobile(visible) : visible];
        }),
      ) as InsightsLayout["layouts"],
    [current],
  );
  const summaryHeight = useCallback(
    (id: string, key: LayoutBreakpoint) => {
      const item = visibleLayouts[key].find((item) => item.i === id);
      const peers = visibleLayouts[key].filter(
        (other) => SUMMARY_WIDGET_IDS.includes(other.i as WidgetId) && other.y === item?.y,
      );
      return Math.max(0, ...peers.map((peer) => heights[key]?.[peer.i as WidgetId] ?? 0));
    },
    [visibleLayouts, heights],
  );
  const layouts = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]).map((breakpoint) => [
          breakpoint,
          visibleLayouts[breakpoint].map((item, _, visible) => ({
            ...item,
            ...(breakpoint === "mobile" &&
            !visible.some((other) => other.i !== item.i && other.y === item.y)
              ? { x: 0, w: GRID_COLUMNS.mobile, maxW: GRID_COLUMNS.mobile }
              : {}),
            h:
              (SUMMARY_WIDGET_IDS.includes(item.i as WidgetId)
                ? summaryHeight(item.i, breakpoint) || item.h - 16
                : (heights[breakpoint]?.[item.i as WidgetId] ?? item.h - 16)) + 16,
          })),
        ]),
      ),
    [visibleLayouts, heights, summaryHeight],
  );
  const summaryNeighbor = (id: WidgetId, side: "left" | "right") => {
    if (!SUMMARY_WIDGET_IDS.includes(id)) return false;
    const item = visibleLayouts[breakpoint].find((item) => item.i === id)!;
    return visibleLayouts[breakpoint].some(
      (other) =>
        other.i !== id &&
        SUMMARY_WIDGET_IDS.includes(other.i as WidgetId) &&
        other.y === item.y &&
        (side === "left" ? other.x + other.w === item.x : item.x + item.w === other.x),
    );
  };
  const orderedIds = [...current.layouts.mobile]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => item.i as WidgetId);
  const visibleIds = [...verticalCompactor.compact(layouts[breakpoint], GRID_COLUMNS[breakpoint])]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => item.i as WidgetId);

  const toggleWidget = (id: WidgetId) =>
    setDraft(
      (prev) =>
        prev && {
          ...prev,
          hiddenWidgets: prev.hiddenWidgets.includes(id)
            ? prev.hiddenWidgets.filter((hidden) => hidden !== id)
            : [...prev.hiddenWidgets, id],
        },
    );
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await updateSettings({ insightsOverviewLayout: { ...draft } });
      setDraft(null);
      setPickerOpen(false);
    } catch {
      // Settings mutation reports the error; retain the draft for retry.
    } finally {
      setSaving(false);
    }
  };

  const customizeAction = useMemo(
    () =>
      editing ? null : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="bg-secondary/30 hover:bg-muted/80 text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 rounded-full"
                aria-label={t("insights:customize.edit")}
                disabled={isLoading || isError || !settings}
                onClick={() => setDraft(readInsightsLayout(settings?.insightsOverviewLayout))}
              >
                <Icons.LayoutDashboard className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("insights:customize.edit")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ),
    [editing, isLoading, isError, settings, t],
  );

  useEffect(() => {
    onCustomizeActionChange?.(customizeAction);
    return () => onCustomizeActionChange?.(null);
  }, [customizeAction, onCustomizeActionChange]);

  return (
    <div className="space-y-3">
      {(editing || !onCustomizeActionChange) && (
        <div className="flex justify-end">
          {editing ? (
            <TooltipProvider>
              <div
                role="toolbar"
                aria-label={t("insights:customize.edit")}
                className="bg-secondary/30 border-border/50 flex w-full items-center gap-1 rounded-full border p-1.5 sm:w-auto"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 flex-1 gap-2 rounded-full px-3 sm:flex-none"
                  disabled={saving}
                  onClick={() => setPickerOpen(true)}
                >
                  <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                  {t("insights:customize.widgets")}
                </Button>
                <div className="bg-border mx-1 h-5 w-px shrink-0" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 rounded-full"
                      aria-label={t("insights:customize.reset")}
                      disabled={saving}
                      onClick={() => setDraft(defaultInsightsLayout())}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("insights:customize.reset")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground h-9 w-9 shrink-0 rounded-full"
                      aria-label={t("insights:customize.cancel")}
                      disabled={saving}
                      onClick={() => {
                        setDraft(null);
                        setPickerOpen(false);
                      }}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("insights:customize.cancel")}</TooltipContent>
                </Tooltip>
                <Button
                  size="sm"
                  className="ml-1 h-9 shrink-0 gap-1.5 rounded-full px-4"
                  aria-label={t(saving ? "insights:customize.saving" : "insights:customize.save")}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {t(saving ? "insights:customize.saving" : "common:save")}
                </Button>
              </div>
            </TooltipProvider>
          ) : (
            customizeAction
          )}
        </div>
      )}
      <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={
            isMobile
              ? "max-h-[85dvh] overflow-y-auto rounded-t-3xl pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"
              : "overflow-y-auto"
          }
        >
          <SheetHeader>
            <SheetTitle>{t("insights:customize.widgets")}</SheetTitle>
            <SheetDescription>{t("insights:customize.description")}</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-3">
            {orderedIds.map((id, index) => (
              <div key={id} className="flex items-center gap-2">
                <Switch
                  id={`widget-${id}`}
                  checked={!current.hiddenWidgets.includes(id)}
                  disabled={saving}
                  onCheckedChange={() => toggleWidget(id)}
                />
                <label htmlFor={`widget-${id}`} className="flex-1 text-sm">
                  {labels[id]}
                </label>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={saving || index === 0}
                  aria-label={t("insights:customize.move_up", { widget: labels[id] })}
                  onClick={() => setDraft((prev) => prev && moveWidget(prev, id, -1))}
                >
                  <Icons.ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={saving || index === orderedIds.length - 1}
                  aria-label={t("insights:customize.move_down", { widget: labels[id] })}
                  onClick={() => setDraft((prev) => prev && moveWidget(prev, id, 1))}
                >
                  <Icons.ArrowDown className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
      {current.hiddenWidgets.length === WIDGET_IDS.length && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-12 text-center">
          {t("insights:customize.empty")}
        </div>
      )}
      <div ref={containerRef} className="insights-dashboard">
        {mounted && (
          <Responsive
            width={width}
            layouts={layouts}
            breakpoints={GRID_BREAKPOINTS}
            cols={GRID_COLUMNS}
            rowHeight={1}
            margin={[16, 0]}
            containerPadding={[0, 0]}
            dragConfig={{
              enabled: editing && !saving && breakpoint !== "mobile",
              handle: ".insights-drag-handle",
            }}
            resizeConfig={{
              enabled: editing && !saving && breakpoint !== "mobile",
              handles: ["e"],
            }}
            onLayoutChange={(_, nextLayouts) => {
              if (!editing || saving) return;
              setDraft((prev) => {
                if (!prev) return prev;
                const next = { ...prev, layouts: { ...prev.layouts } };
                for (const key of Object.keys(GRID_COLUMNS) as LayoutBreakpoint[]) {
                  // Mobile widths adapt to visibility; preserve the saved pairs for restoring cards.
                  if (key === "mobile") continue;
                  if (nextLayouts[key])
                    next.layouts[key] = mergeVisibleLayout(prev.layouts[key], nextLayouts[key]);
                }
                return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
              });
            }}
          >
            {visibleIds.map((id) => (
              <div
                key={id}
                data-widget-id={id}
                data-summary-left={(!editing && summaryNeighbor(id, "left")) || undefined}
                data-summary-right={(!editing && summaryNeighbor(id, "right")) || undefined}
                className={`${SUMMARY_WIDGET_IDS.includes(id) ? "@container" : ""} min-h-0 rounded-lg pb-4 ${editing ? "insights-widget-editing" : ""}`}
              >
                {editing && (
                  <div className="bg-popover text-muted-foreground absolute -top-3.5 left-1/2 z-20 flex h-7 -translate-x-1/2 items-center rounded-full border px-1 shadow-sm">
                    {breakpoint !== "mobile" && (
                      <span
                        className="insights-drag-handle hover:text-foreground flex h-7 w-7 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
                        title={t("insights:customize.drag", { widget: labels[id] })}
                      >
                        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      className="hover:bg-muted hover:text-foreground focus-visible:ring-ring flex h-6 w-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 disabled:opacity-50"
                      aria-label={t("insights:customize.hide", { widget: labels[id] })}
                      title={t("insights:customize.hide", { widget: labels[id] })}
                      onClick={() => toggleWidget(id)}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
                <WidgetContent
                  onHeight={heightCallbacks[id]}
                  summary={SUMMARY_WIDGET_IDS.includes(id)}
                  minHeight={
                    SUMMARY_WIDGET_IDS.includes(id)
                      ? summaryHeight(id, breakpoint) || undefined
                      : id === "targets" &&
                          breakpoint === "desktop" &&
                          !current.hiddenWidgets.includes("composition") &&
                          current.layouts.desktop.find((item) => item.i === "targets")?.y ===
                            current.layouts.desktop.find((item) => item.i === "composition")?.y
                        ? heights.desktop?.composition
                        : undefined
                  }
                >
                  {widgets[id]}
                </WidgetContent>
              </div>
            ))}
          </Responsive>
        )}
      </div>
    </div>
  );
}
