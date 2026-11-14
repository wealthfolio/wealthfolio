import { profilePreferenceKey, readProfilePreference } from "@/hooks/use-persistent-state";
import { useHapticFeedback, useIsMobileViewport } from "@/hooks";
import { cn } from "@/lib/utils";
import { Page, SwipableView, type Icon } from "@wealthfolio/ui";
import { motion } from "motion/react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";

export interface SwipablePageView {
  value: string;
  label: string;
  icon?: Icon;
  content: React.ReactNode;
  /** Optional actions to display in the header when this view is active */
  actions?: React.ReactNode;
}

interface SwipablePageProps {
  views: SwipablePageView[];
  defaultView?: string;
  onViewChange?: (view: string) => void;
  className?: string;
  contentClassName?: string;
  desktopContentClassName?: string;
  withPadding?: boolean;
  withMobileNavOffset?: boolean;
  title?: string;
  mobileActionsPlacement?: "below" | "header";
  /**
   * When set, the most recently selected view is remembered in localStorage
   * under this key. Used as the fallback when the URL has no `?tab=` param,
   * so navigating back to this page restores the previously chosen tab.
   */
  persistKey?: string;
}

// Navigation Pills Component - Segmented control style
function NavigationPills({
  views,
  currentView,
  onViewChange,
}: {
  views: SwipablePageView[];
  currentView: string;
  onViewChange: (view: string) => void;
}) {
  const layoutId = React.useId();

  return (
    <nav className="bg-muted/60 inline-flex items-center rounded-(--segmented-radius) p-1">
      {views.map((view) => {
        const isActive = currentView === view.value;
        const IconComponent = view.icon;

        return (
          <button
            key={view.value}
            type="button"
            onClick={() => onViewChange(view.value)}
            className={cn(
              "rounded-(--segmented-radius) relative flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm font-medium transition-colors duration-200",
              "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground/80",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive && (
              <motion.div
                layoutId={`nav-pill-${layoutId}`}
                data-slot="segmented-thumb"
                className="absolute inset-0 rounded-(--segmented-radius) bg-(--segmented-thumb) bg-(image:--segmented-thumb-image) shadow-(--segmented-thumb-shadow)"
                initial={false}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 35,
                }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              {IconComponent && <IconComponent className="size-4" />}
              <span>{view.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// Mobile Navigation - Clean pill navigation
function MobileNavigation({
  views,
  currentView,
  onViewChange,
  compact = false,
}: {
  views: SwipablePageView[];
  currentView: string;
  onViewChange: (view: string) => void;
  compact?: boolean;
}) {
  const layoutId = React.useId();
  const navigationRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    navigationRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentView]);

  // The mobile reset clips .flex and sets every max-width to 100vw. Keep
  // this strip's own scrolling and its parent's width as the limit.
  return (
    <div
      ref={navigationRef}
      className={cn(
        "bg-muted/50 rounded-(--segmented-radius) mx-auto inline-flex w-max max-w-full! items-center gap-0.5 overflow-x-auto overscroll-x-contain p-1 backdrop-blur-sm",
      )}
      data-no-swipe-drag
    >
      {views.map((item) => {
        const isActive = currentView === item.value;
        const IconComponent = item.icon;

        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onViewChange(item.value)}
            className={cn(
              // The tap area fills the strip's height; the pill keeps its compact size.
              // The mobile reset's overflow-x on .flex would make that taller ::after
              // scroll inside the button, so overflow stays visible.
              "rounded-(--segmented-radius) relative flex overflow-visible! shrink-0 cursor-pointer after:absolute after:inset-x-0 after:-inset-y-1 items-center justify-center gap-1.5 py-1.5 text-sm font-medium transition-colors duration-200",
              "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              compact ? "px-2" : "px-3",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive && (
              <motion.div
                layoutId={`mobile-nav-bg-${layoutId}`}
                data-slot="segmented-thumb"
                className="absolute inset-0 rounded-(--segmented-radius) bg-(--segmented-thumb) bg-(image:--segmented-thumb-image) shadow-(--segmented-thumb-shadow)"
                initial={false}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 35,
                }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {IconComponent && <IconComponent className="size-4" />}
              {isActive && <span className="whitespace-nowrap">{item.label}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SwipablePage({
  views,
  defaultView,
  onViewChange,
  className,
  contentClassName,
  desktopContentClassName,
  withPadding = true,
  withMobileNavOffset = true,
  title,
  mobileActionsPlacement = "below",
  persistKey,
}: SwipablePageProps) {
  const isMobile = useIsMobileViewport();
  const [searchParams, setSearchParams] = useSearchParams();
  const { triggerHaptic } = useHapticFeedback();

  // Optional persistence: remember the last selected view so navigating back to
  // the page restores it when the URL has no `?tab=` param.
  const [persistedView, setPersistedView] = React.useState<string | null>(() => {
    if (!persistKey) return null;
    try {
      const raw = readProfilePreference(persistKey);
      return raw ? (JSON.parse(raw) as string) : null;
    } catch {
      return null;
    }
  });

  // URL wins; then persisted value (if any); then defaultView.
  const tabFromUrl = searchParams.get("tab");
  const currentView =
    tabFromUrl && views.some((v) => v.value === tabFromUrl)
      ? tabFromUrl
      : persistedView && views.some((v) => v.value === persistedView)
        ? persistedView
        : (defaultView ?? views[0]?.value);

  // Calculate numeric index from URL-derived currentView
  const currentIndex = React.useMemo(() => {
    const idx = views.findIndex((v) => v.value === currentView);
    return idx === -1 ? 0 : idx;
  }, [currentView, views]);
  // The view a swipe has picked, shown in the header from release until the slide
  // lands and the page follows.
  const [swipedView, setSwipedView] = React.useState<string | null>(null);
  const shownView = swipedView ?? currentView;
  // Scrolls the phone carousel; set once it is built.
  const scrollCarouselRef = React.useRef<((index: number) => void) | null>(null);
  const currentActions = views.find((v) => v.value === shownView)?.actions;
  const mobileActionsInHeader = mobileActionsPlacement === "header";

  // On phones the header floats, translucent, over the views as they scroll; each
  // view starts below it by the header's measured height.
  const mobileHeaderRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const header = mobileHeaderRef.current;
    const container = header?.parentElement;
    if (!isMobile || !header || !container) return;
    const update = () =>
      container.style.setProperty("--page-header-height", `${header.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [isMobile]);

  const handleViewChange = React.useCallback(
    (nextView: string, haptic = true) => {
      const swipeIsPending = swipedView !== null;
      setSwipedView(null);
      if (nextView === currentView) {
        // A tap on the current view while a swipe still heads to another one sends the
        // slide back; otherwise it would land and switch to the other view.
        if (swipeIsPending) scrollCarouselRef.current?.(currentIndex);
        return;
      }

      if (isMobile && haptic) {
        triggerHaptic();
      }

      // Update URL - this is the single source of truth
      // SwipableView will sync automatically via selectedIndex prop
      setSearchParams({ tab: nextView }, { replace: true });
      onViewChange?.(nextView);

      if (persistKey) {
        setPersistedView(nextView);
        try {
          window.localStorage.setItem(profilePreferenceKey(persistKey), JSON.stringify(nextView));
        } catch {
          // Swallow quota/serialization errors — persistence is best-effort.
        }
      }
    },
    [
      swipedView,
      currentView,
      currentIndex,
      setSearchParams,
      onViewChange,
      isMobile,
      triggerHaptic,
      persistKey,
    ],
  );

  return (
    <Page className={cn("flex h-full flex-col", className)}>
      <div
        data-ptr-content
        data-virtual-scroll-parent={!isMobile || undefined}
        className={cn("relative mx-auto flex w-full grow flex-col", contentClassName)}
      >
        {isMobile ? (
          /* Mobile: SwipableView with navigation */
          <div className="relative flex h-full flex-col md:hidden">
            {/* Mobile Navigation at top, floating over the views */}
            <div
              ref={mobileHeaderRef}
              className="pt-safe from-background/70 to-background/25 absolute inset-x-0 top-0 z-20 flex flex-col gap-2 bg-linear-to-b px-3 pb-2 backdrop-blur-sm backdrop-saturate-150"
            >
              {/* Equal side columns centre the strip on the header; the actions column never
                  drops below its content, so wider actions push the strip aside, and on a
                  very narrow screen the strip shrinks and scrolls. */}
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(max-content,1fr)] items-center gap-2">
                <div />
                <div className="min-w-0">
                  <MobileNavigation
                    views={views}
                    currentView={shownView}
                    onViewChange={handleViewChange}
                    compact={mobileActionsInHeader}
                  />
                </div>
                <div className="flex min-w-max items-center justify-end gap-2">
                  {mobileActionsInHeader && currentActions}
                </div>
              </div>
              {currentActions && !mobileActionsInHeader && (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {currentActions}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <SwipableView
                initialIndex={currentIndex}
                selectedIndex={currentIndex}
                items={views.map((v) => ({
                  name: v.label,
                  content: (
                    <div
                      className={cn(
                        // Without padding, a view paints its own background (the dashboard's
                        // wash) and keeps its own nav clearance: stretch it to fill the pane,
                        // so no plain band shows below it.
                        withPadding ? "p-2" : "flex min-h-full flex-col [&>*]:grow",
                        "pt-[var(--page-header-height,0px)]",
                        withMobileNavOffset && "pb-[var(--mobile-nav-total-offset)]",
                      )}
                    >
                      {v.content}
                    </div>
                  ),
                }))}
                displayToggle={false}
                onInit={(api) => {
                  scrollCarouselRef.current = api ? (index) => api.scrollTo(index) : null;
                }}
                onSwipeStart={triggerHaptic}
                onSelectView={(index: number) => {
                  const view = views[index]?.value;
                  setSwipedView(view && view !== currentView ? view : null);
                }}
                onViewChange={(index: number) => {
                  const view = views[index]?.value;
                  // The haptic fired when the swipe started.
                  if (view) handleViewChange(view, false);
                }}
              />
            </div>
          </div>
        ) : (
          /* Desktop: Navigation at top center + content below */
          <div className="hidden h-full flex-col md:flex">
            {/* Header with Navigation and Actions */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-2 pt-4 pb-3 lg:px-4">
              <div className="titlebar-nudge flex shrink-0 items-center gap-3">
                {title && <h1 className="text-muted-foreground text-sm font-medium">{title}</h1>}
                <NavigationPills
                  views={views}
                  currentView={currentView}
                  onViewChange={handleViewChange}
                />
              </div>
              {/* Actions slot - renders current view's actions */}
              <div className="ms-auto flex max-w-full min-w-0 items-center gap-2">
                {currentActions}
              </div>
            </div>

            {/* Content - relative for absolute positioned actions within */}
            <div
              className={cn(
                "relative grow overflow-y-auto pt-8 md:pt-2",
                withPadding && "px-2 pb-2 lg:px-4 lg:pb-4",
                desktopContentClassName,
              )}
            >
              {views.find((v) => v.value === currentView)?.content}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}

export default SwipablePage;
