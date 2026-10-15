"use client";

import { cn } from "../../lib/utils";
import useEmblaCarousel, { type UseEmblaCarouselType } from "embla-carousel-react";
import * as React from "react";

type CarouselApi = UseEmblaCarouselType[1];
const SWIPE_DRAG_BLOCK_SELECTOR = "[data-no-swipe-drag]";

function hasSwipeDragBlocker(evt: Event): boolean {
  if (typeof evt.composedPath === "function") {
    return evt
      .composedPath()
      .some((node) => node instanceof Element && node.closest(SWIPE_DRAG_BLOCK_SELECTOR) !== null);
  }

  return evt.target instanceof Element && evt.target.closest(SWIPE_DRAG_BLOCK_SELECTOR) !== null;
}

export interface SwipableViewItem {
  name: string;
  content: React.ReactNode;
}

export interface SwipableViewProps {
  items: SwipableViewItem[];
  displayToggle?: boolean;
  withMobileNavOffset?: boolean;
  className?: string;
  dotClassName?: string;
  labelClassName?: string;
  onViewChange?: (index: number, name: string) => void;
  onInit?: (api: CarouselApi) => void;
  /**
   * The index to start on. Crucial for syncing with URL on first load.
   */
  initialIndex?: number;
  /**
   * Controlled mode: when provided, the component will scroll to this index
   * whenever it changes. This is the single source of truth for the selected view.
   */
  selectedIndex?: number;
}

export function SwipableView({
  items,
  displayToggle = false,
  withMobileNavOffset = false,
  className,
  dotClassName,
  labelClassName,
  onViewChange,
  onInit: onInitProp,
  initialIndex = 0,
  selectedIndex: controlledIndex,
}: SwipableViewProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: false,
    align: "start",
    skipSnaps: false,
    dragFree: false,
    startIndex: initialIndex, // OPTIMIZATION: Start at correct slide instantly
    watchDrag: (_api, evt) => !hasSwipeDragBlocker(evt),
  });

  const [selectedIndex, setSelectedIndex] = React.useState(initialIndex);
  const [scrollSnaps, setScrollSnaps] = React.useState<number[]>([]);
  const previousIndexRef = React.useRef<number>(initialIndex);

  const scrollTo = React.useCallback((index: number) => emblaApi?.scrollTo(index), [emblaApi]);

  const onSelect = React.useCallback(
    (api: CarouselApi) => {
      if (!api) return;
      const index = api.selectedScrollSnap();
      setSelectedIndex(index);

      // Only call onViewChange if the index actually changed
      if (index !== previousIndexRef.current) {
        previousIndexRef.current = index;
        onViewChange?.(index, items[index]?.name || "");
      }
    },
    [items, onViewChange],
  );

  const onInit = React.useCallback(
    (api: CarouselApi) => {
      if (!api) return;
      setScrollSnaps(api.scrollSnapList());
      onInitProp?.(api);
    },
    [onInitProp],
  );

  React.useEffect(() => {
    if (!emblaApi) return;

    onInit(emblaApi);
    onSelect(emblaApi);
    emblaApi.on("reInit", onInit);
    emblaApi.on("reInit", onSelect);
    emblaApi.on("select", onSelect);

    return () => {
      emblaApi.off("reInit", onInit);
      emblaApi.off("reInit", onSelect);
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi, onInit, onSelect]);

  // Controlled mode: scroll to controlledIndex when it changes
  React.useEffect(() => {
    if (controlledIndex === undefined || !emblaApi) return;
    const currentIndex = emblaApi.selectedScrollSnap();
    if (currentIndex !== controlledIndex) {
      emblaApi.scrollTo(controlledIndex, true); // instant scroll for external changes
    }
  }, [controlledIndex, emblaApi]);

  // MEMORY OPTIMIZATION:
  // Only render the Active Slide and its immediate neighbors (±1).
  // Distant slides are kept as empty divs to maintain scroll width but free up DOM nodes/RAM.
  const shouldRender = (index: number) => Math.abs(selectedIndex - index) <= 1;

  return (
    <div className={cn("relative flex h-full w-full flex-col", className)}>
      {/* Navigation Toggle */}
      {displayToggle && items.length > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 py-2.5">
          {scrollSnaps.map((_, index) => (
            <React.Fragment key={index}>
              {selectedIndex === index ? (
                /* Current View Label */
                <div
                  className={cn(
                    "bg-muted/80 rounded-full px-4 py-1.5 backdrop-blur-sm",
                    "text-foreground text-sm font-medium",
                    "transition-all duration-300",
                    "shadow-sm",
                    labelClassName,
                  )}
                  role="status"
                  aria-live="polite"
                >
                  {items[selectedIndex]?.name || `View ${selectedIndex + 1}`}
                </div>
              ) : (
                /* Dot Navigation */
                <button
                  type="button"
                  onClick={() => scrollTo(index)}
                  className={cn(
                    "size-2 rounded-full transition-all duration-300",
                    "focus-visible:outline-solid focus-visible:outline-ring hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2",
                    "bg-foreground/20 hover:bg-foreground/40",
                    dotClassName,
                  )}
                  aria-label={`Go to ${items[index]?.name || `view ${index + 1}`}`}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Swipable Content */}
      <div ref={emblaRef} className="h-full grow overflow-hidden">
        <div
          className="flex h-full touch-pan-y"
          style={{
            overflowX: "visible",
          }}
        >
          {items.map((item, index) => (
            <div key={index} className="relative h-full min-w-0 shrink-0 grow-0 basis-full">
              {/*
                 SCROLL ARCHITECTURE:
                 1. We use a nested div for scrolling.
                 2. This ensures the Header stays fixed while content scrolls.
                 3. touch-pan-y allows vertical scrolling while horizontal swipes trigger the carousel.
                 4. This nesting makes the pane — not the page container — the scroll port a
                    virtualized list inside a slide has to measure against, so it is marked
                    for `useVirtualScrollContainer` to find.
               */}
              <div
                data-virtual-scroll-parent
                className={cn(
                  "h-full w-full overflow-y-auto overflow-x-hidden",
                  withMobileNavOffset && "scroll-pb-nav pb-[var(--mobile-nav-total-offset)]",
                )}
              >
                {shouldRender(index) ? (
                  item.content
                ) : (
                  // Placeholder for unmounted heavy slides
                  <div className="h-full w-full" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
