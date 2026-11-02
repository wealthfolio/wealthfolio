import { useCallback, useLayoutEffect, useState } from "react";
import { observeElementOffset } from "@tanstack/react-virtual";

/** Seed a newly mounted activity list before the virtualizer's initial scrollTo. */
export const observeCurrentScrollOffset: typeof observeElementOffset = (instance, onChange) => {
  onChange(instance.scrollElement?.scrollTop ?? 0, false);
  return observeElementOffset(instance, onChange);
};

/**
 * Markers for the scroll port a virtualized list measures against.
 *
 * `PageScrollContainer` marks itself, `SwipablePage` marks its desktop content,
 * the swipeable pager marks each phone pane, and a list that scrolls inside its
 * own box marks that box.
 *
 * Resolving the port by walking up for a scrollable `overflow` alone would pick
 * the wrong element: below 1024px `globals.css` sets `overflow-x` on every
 * `.flex` and `.grid`, and per spec that makes the other axis compute to
 * `auto`, so most of the ancestor chain reports itself as scrollable.
 */
const SCROLL_PARENT_SELECTOR = "[data-virtual-scroll-parent],[data-page-scroll-container]";

/**
 * Whether `element` is the box that actually scrolls.
 *
 * Being marked is not enough. The same list box can be a real scroll port at
 * one width and merely a `min-h-0 flex-1 overflow-auto` box that grew to fit
 * its content at another, depending on whether an ancestor bounded its height.
 * A box that clips nothing scrolls nothing, so the search continues above it.
 */
function isScrollPort(element: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(element);
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  return element.scrollHeight > element.clientHeight;
}

/** The nearest marked ancestor that is really scrolling, else the outermost. */
function resolveScrollPort(list: HTMLElement): HTMLElement | null {
  let candidate = list.closest<HTMLElement>(SCROLL_PARENT_SELECTOR);
  let outermost: HTMLElement | null = null;

  while (candidate) {
    outermost = candidate;
    if (isScrollPort(candidate)) return candidate;
    candidate = candidate.parentElement?.closest<HTMLElement>(SCROLL_PARENT_SELECTOR) ?? null;
  }

  // Nothing overflows yet — a list short enough to fit needs no virtualizing,
  // and the next pass re-resolves once it grows.
  return outermost;
}

interface VirtualScrollContainer {
  /** Attach to the element wrapping the virtualized rows. */
  listRef: (node: HTMLElement | null) => void;
  /** Pass to the virtualizer's `getScrollElement`. */
  scrollElement: HTMLElement | null;
  /**
   * Distance from the scroll port's content start to the list — the
   * virtualizer's `scrollMargin`. Non-zero whenever anything sits above the
   * list inside the same scroll port: a filter bar, or a sticky table header.
   */
  scrollMargin: number;
}

/**
 * Resolves the scroll port and offset a virtualized list has to measure
 * against, for lists that cannot simply point at their own element.
 */
export function useVirtualScrollContainer(): VirtualScrollContainer {
  const [list, setList] = useState<HTMLElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const listRef = useCallback((node: HTMLElement | null) => {
    setList(node);
    setScrollElement(node ? resolveScrollPort(node) : null);
  }, []);

  // Deliberately no dependency array. Both values move for reasons that are not
  // observable from here: the port changes when a viewport crosses a breakpoint
  // that re-bounds an ancestor's height, and the margin changes when anything
  // above the list resizes — a bulk bar appearing on the first selection, a
  // filter chip wrapping to a second line. Re-resolving each pass is cheap next
  // to enumerating the causes, and settling on unchanged values renders nothing.
  //
  // The lint rule below warns that setting state here can loop. It cannot: both
  // setters return `prev` unless the value really changed, and neither value is
  // affected by the re-render it would cause — the virtualizer resizes its own
  // container, which never moves the list's top edge or reparents it.
  // oxlint-disable-next-line react/exhaustive-deps
  useLayoutEffect(() => {
    if (!list) return;

    const port = resolveScrollPort(list);
    setScrollElement((prev) => (prev === port ? prev : port));
    if (!port) return;

    const next =
      list.getBoundingClientRect().top - port.getBoundingClientRect().top + port.scrollTop;
    // Sub-pixel churn would otherwise re-render on every pass forever.
    setScrollMargin((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  });

  return { listRef, scrollElement, scrollMargin };
}
