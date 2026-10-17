import { useLayoutEffect, useState } from "react";

/**
 * Whether `content` is wider than `box`, re-checked whenever either resizes.
 *
 * A box that scrolls sideways is a scroll container on both axes, so a
 * `sticky top-*` header inside it pins to that box, which never scrolls
 * vertically, instead of to the page. Knowing when the content fits lets the
 * box stop being a scroll container there and keep sideways scrolling for when
 * it is needed.
 *
 * Starts as `true`, the scrolling layout, until the first measurement.
 */
export function useHorizontalOverflow(box: HTMLElement | null, content: HTMLElement | null) {
  const [overflows, setOverflows] = useState(true);

  useLayoutEffect(() => {
    if (!box || !content) return;

    // Both are rounded to whole pixels, and a full-width table that fits
    // rounds to exactly the box's width.
    const measure = () => setOverflows(content.offsetWidth > box.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [box, content]);

  return overflows;
}
