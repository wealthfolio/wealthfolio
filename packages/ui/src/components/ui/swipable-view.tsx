"use client";

import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
import { useDirection } from "./direction";
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
  /** Called when a swipe lands on another view. */
  onViewChange?: (index: number, name: string) => void;
  /** Called once per drag, when the slide first moves under the finger. */
  onSwipeStart?: () => void;
  /**
   * Called on release, as soon as a swipe picks a view, while the slide still moves.
   * Keep it light (a highlight): heavy work here stalls the slide.
   */
  onSelectView?: (index: number, name: string) => void;
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

// Embla's `settle` waits for an easing tail far below a pixel, long after the slide looks
// still. A slide counts as landed once it is within 1% of a slide's width of its snap.
function isNearSelectedSnap(api: NonNullable<CarouselApi>) {
  const snaps = api.scrollSnapList();
  if (snaps.length < 2) return true;
  const target = snaps[api.selectedScrollSnap()] ?? 0;
  return Math.abs(api.scrollProgress() - target) * (snaps.length - 1) < 0.01;
}

export function SwipableView({
  items,
  displayToggle = false,
  withMobileNavOffset = false,
  className,
  dotClassName,
  labelClassName,
  onViewChange,
  onSwipeStart,
  onSelectView,
  onInit: onInitProp,
  initialIndex = 0,
  selectedIndex: controlledIndex,
}: SwipableViewProps) {
  const { t } = useTranslation();
  const direction = useDirection();
  // Embla re-initialises whenever its options change, and a re-init jumps straight to
  // startIndex, cutting a swipe's settle animation short. Keep the first index: later
  // changes arrive through selectedIndex.
  const [startIndex] = React.useState(initialIndex);
  const [emblaRef, emblaApi] = useEmblaCarousel({
    direction,
    loop: false,
    align: "start",
    skipSnaps: false,
    dragFree: false,
    startIndex, // OPTIMIZATION: Start at correct slide instantly
    watchDrag: (_api, evt) => !hasSwipeDragBlocker(evt),
  });

  const [selectedIndex, setSelectedIndex] = React.useState(initialIndex);
  // The slide the carousel has landed on; it and its neighbours stay mounted.
  const [landedIndex, setLandedIndex] = React.useState(initialIndex);
  const [scrollSnaps, setScrollSnaps] = React.useState<number[]>([]);
  const previousIndexRef = React.useRef<number>(initialIndex);

  const scrollTo = React.useCallback((index: number) => emblaApi?.scrollTo(index), [emblaApi]);

  // A swipe selects its slide on release, while the slide still moves. Mounting the next
  // neighbours and reporting the view change wait until it lands: the page re-renders
  // for the new view, and doing that mid-slide froze it. Effect events
  // read the latest props, so a re-render mid-swipe doesn't re-run the subscription.
  const handleSelect = React.useEffectEvent((api: NonNullable<CarouselApi>) => {
    const index = api.selectedScrollSnap();
    setSelectedIndex(index);
    onSelectView?.(index, items[index]?.name || "");
  });

  const handleLanded = React.useEffectEvent((api: NonNullable<CarouselApi>) => {
    const index = api.selectedScrollSnap();
    setLandedIndex(index);

    // Only call onViewChange if the index actually changed
    if (index !== previousIndexRef.current) {
      previousIndexRef.current = index;
      onViewChange?.(index, items[index]?.name || "");
    }
  });

  const handleSwipeStart = React.useEffectEvent(() => onSwipeStart?.());

  const handleInit = React.useEffectEvent((api: NonNullable<CarouselApi>) => {
    setScrollSnaps(api.scrollSnapList());
    onInitProp?.(api);
  });

  // A screen shown again (React <Activity>) builds its carousel anew, on
  // initialIndex. It goes back to the view it showed without reporting a change,
  // which would switch the page's tab.
  const placedApi = React.useRef<CarouselApi>(undefined);
  React.useEffect(() => {
    if (!emblaApi) return;

    if (placedApi.current !== emblaApi) {
      placedApi.current = emblaApi;
      if (emblaApi.selectedScrollSnap() !== previousIndexRef.current) {
        emblaApi.scrollTo(previousIndexRef.current, true);
      }
    }
    const onInit = () => handleInit(emblaApi);
    const onSelect = () => handleSelect(emblaApi);
    const onLanded = () => handleLanded(emblaApi);
    // A drag starts a swipe when it first moves the slide; a tap or a vertical scroll
    // never does.
    let dragStarted: boolean | null = null;
    const onPointerDown = () => {
      dragStarted = false;
    };
    const onPointerUp = () => {
      dragStarted = null;
    };
    const onScroll = () => {
      if (dragStarted === false) {
        dragStarted = true;
        handleSwipeStart();
      }
      if (emblaApi.selectedScrollSnap() !== previousIndexRef.current && isNearSelectedSnap(emblaApi)) {
        onLanded();
      }
    };
    onInit();
    onSelect();
    onLanded();
    emblaApi.on("reInit", onInit);
    emblaApi.on("reInit", onSelect);
    emblaApi.on("reInit", onLanded);
    emblaApi.on("select", onSelect);
    emblaApi.on("pointerDown", onPointerDown);
    emblaApi.on("pointerUp", onPointerUp);
    emblaApi.on("scroll", onScroll);
    emblaApi.on("settle", onLanded);

    return () => {
      emblaApi.off("reInit", onInit);
      emblaApi.off("reInit", onSelect);
      emblaApi.off("reInit", onLanded);
      emblaApi.off("select", onSelect);
      emblaApi.off("pointerDown", onPointerDown);
      emblaApi.off("pointerUp", onPointerUp);
      emblaApi.off("scroll", onScroll);
      emblaApi.off("settle", onLanded);
    };
  }, [emblaApi]);

  // Controlled mode: scroll to controlledIndex when it changes. The jump is instant, and
  // Embla reports it settled before it selects the new snap, still on the old one. So
  // count the old snap as reported before the jump (a swipe heading there must not take
  // over from the page's choice), and the new one as landed after it (without reporting
  // it: the page made the change, and a swipe back to the view it left must count).
  React.useEffect(() => {
    if (controlledIndex === undefined || !emblaApi) return;
    const currentIndex = emblaApi.selectedScrollSnap();
    if (currentIndex !== controlledIndex) {
      previousIndexRef.current = currentIndex;
      emblaApi.scrollTo(controlledIndex, true); // instant scroll for external changes
    }
    previousIndexRef.current = controlledIndex;
    setLandedIndex(controlledIndex);
  }, [controlledIndex, emblaApi]);

  // MEMORY OPTIMIZATION:
  // Only render the Active Slide and its immediate neighbors (±1).
  // Distant slides are kept as empty divs to maintain scroll width but free up DOM nodes/RAM.
  const shouldRender = (index: number) => index === selectedIndex || Math.abs(landedIndex - index) <= 1;

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
                  {items[selectedIndex]?.name ||
                    t("ui:navigation.view", "View {{number}}", { number: selectedIndex + 1 })}
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
                  aria-label={t("ui:navigation.goTo", "Go to {{name}}", {
                    name: items[index]?.name || t("ui:navigation.view", "View {{number}}", { number: index + 1 }),
                  })}
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
