import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface ScrollPosition {
  top: number;
  left: number;
}

/**
 * Keeps where a kept screen's boxes were scrolled while it is hidden.
 *
 * `<Activity>` hides a kept screen with `display: none`. Chromium keeps a hidden
 * box's scroll offset; WebKit (Safari, the iOS app) drops it, so a screen shown
 * again would open at the top. Offsets are recorded while the screen is visible
 * and put back before it is painted again. A virtualized list restores itself
 * too; writing the same offset again changes nothing.
 */
export function useKeptScrollPositions(
  layerRef: RefObject<HTMLElement | null>,
  visible: boolean,
): void {
  const positions = useRef(new Map<Element, ScrollPosition>());
  // Read by the scroll listener: an event that arrives after the screen was
  // hidden must not record the reset offset.
  const visibleRef = useRef(visible);

  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    for (const [element, position] of positions.current) {
      if (!element.isConnected || !layerRef.current?.contains(element)) {
        positions.current.delete(element);
        continue;
      }
      if (element.scrollTop !== position.top) element.scrollTop = position.top;
      if (element.scrollLeft !== position.left) element.scrollLeft = position.left;
    }
  }, [layerRef, visible]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const record = (event: Event) => {
      if (!visibleRef.current || !(event.target instanceof Element)) return;
      const { scrollTop: top, scrollLeft: left } = event.target;
      positions.current.set(event.target, { top, left });
    };
    // Scroll events do not bubble; the capture phase sees every box in the screen.
    layer.addEventListener("scroll", record, { capture: true, passive: true });
    return () => layer.removeEventListener("scroll", record, { capture: true });
  }, [layerRef]);
}
