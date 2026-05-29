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
  withPadding?: boolean;
  title?: string;
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
    <nav className="bg-muted/60 inline-flex items-center rounded-full p-1">
      {views.map((view) => {
        const isActive = currentView === view.value;
        const IconComponent = view.icon;

        return (
          <button
            key={view.value}
            type="button"
            onClick={() => onViewChange(view.value)}
            className={cn(
              "relative flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-200",
              "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground/80",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive && (
              <motion.div
                layoutId={`nav-pill-${layoutId}`}
                className="bg-background absolute inset-0 rounded-full shadow-sm"
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
}: {
  views: SwipablePageView[];
  currentView: string;
  onViewChange: (view: string) => void;
}) {
  const layoutId = React.useId();

  return (
    <div className="bg-muted/50 flex items-center gap-0.5 rounded-full p-1 backdrop-blur-sm">
      {views.map((item) => {
        const isActive = currentView === item.value;
        const IconComponent = item.icon;

        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onViewChange(item.value)}
            className={cn(
              "relative flex cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-200",
              "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive && (
              <motion.div
                layoutId={`mobile-nav-bg-${layoutId}`}
                className="bg-background absolute inset-0 rounded-full shadow-sm"
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
  withPadding = true,
  title,
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
      const raw = window.localStorage.getItem(persistKey);
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

  const handleViewChange = React.useCallback(
    (nextView: string) => {
      if (nextView === currentView) {
        return;
      }

      if (isMobile) {
        triggerHaptic();
      }

      // Update URL - this is the single source of truth
      // SwipableView will sync automatically via selectedIndex prop
      setSearchParams({ tab: nextView }, { replace: true });
      onViewChange?.(nextView);

      if (persistKey) {
        setPersistedView(nextView);
        try {
          window.localStorage.setItem(persistKey, JSON.stringify(nextView));
        } catch {
          // Swallow quota/serialization errors — persistence is best-effort.
        }
      }
    },
    [currentView, setSearchParams, onViewChange, isMobile, triggerHaptic, persistKey],
  );

  return (
    <Page className={cn("flex h-full flex-col", className)}>
      <div
        data-ptr-content
        className={cn("relative mx-auto flex w-full grow flex-col", contentClassName)}
      >
        {isMobile ? (
          /* Mobile: SwipableView with navigation */
          <div className="flex h-full flex-col md:hidden">
            {/* Mobile Navigation at top */}
            <div className="pt-safe flex shrink-0 items-center justify-between px-3 pb-2">
              <div className="w-10" />
              <MobileNavigation
                views={views}
                currentView={currentView}
                onViewChange={handleViewChange}
              />
              <div className="flex items-center gap-1.5">
                {views.find((v) => v.value === currentView)?.actions}
              </div>
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
                        withPadding
                          ? "p-2 pb-[calc(var(--mobile-nav-ui-height)+max(var(--mobile-nav-gap),env(safe-area-inset-bottom)))]"
                          : "pb-safe",
                      )}
                    >
                      {v.content}
                    </div>
                  ),
                }))}
                displayToggle={false}
                onViewChange={(_index: number, name: string) => {
                  const matchedView = views.find((v) => v.label === name);
                  if (matchedView) {
                    handleViewChange(matchedView.value);
                  }
                }}
              />
            </div>
          </div>
        ) : (
          /* Desktop: Navigation at top center + content below */
          <div className="hidden h-full flex-col md:flex">
            {/* Header with Navigation and Actions */}
            <div className="flex shrink-0 items-center justify-between gap-4 px-2 pb-3 pt-4 lg:px-4">
              <div className="flex items-center gap-3">
                {title && <h1 className="text-muted-foreground text-sm font-medium">{title}</h1>}
                <NavigationPills
                  views={views}
                  currentView={currentView}
                  onViewChange={handleViewChange}
                />
              </div>
              {/* Actions slot - renders current view's actions */}
              <div className="flex items-center gap-2">
                {views.find((v) => v.value === currentView)?.actions}
              </div>
            </div>

            {/* Content - relative for absolute positioned actions within */}
            <div
              className={cn(
                "relative grow overflow-y-auto pt-8 md:pt-2",
                withPadding && "px-2 pb-2 lg:px-4 lg:pb-4",
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
