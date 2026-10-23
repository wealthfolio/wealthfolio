import { useCallback, useRef, type MouseEvent, type PointerEvent } from "react";

/** Width of the band along the leading edge where a back swipe can start. */
const EDGE_WIDTH = 20;
/** Horizontal travel before the drag counts as a back swipe. */
const START_DISTANCE = 8;
/** Vertical travel that turns the touch into a scroll instead. */
const VERTICAL_CANCEL = 10;
/** Share of the width past which releasing completes the swipe. */
const COMMIT_PROGRESS = 0.4;
/** Release speed (px/ms) that completes the swipe however far it went. */
const COMMIT_VELOCITY = 0.35;
/**
 * Speed back toward the edge (px/ms) at release that cancels the swipe however
 * far it went: the user changed their mind. Slower drift is a finger lifting.
 */
const CANCEL_VELOCITY = 0.1;
/** Elements that drag sideways themselves (charts, sliders), as for the section pager. */
const OWN_DRAG_SELECTOR = "[data-no-swipe-drag]";
/** Window the release speed is measured over. */
const VELOCITY_WINDOW_MS = 100;

interface Sample {
  x: number;
  t: number;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  dragging: boolean;
  progress: number;
  samples: Sample[];
}

/** Whether a release at `progress`, moving at `velocity` (px/ms, positive away from the edge), goes back. */
export function shouldCommitSwipe(progress: number, velocity: number): boolean {
  if (velocity < -CANCEL_VELOCITY) return false;
  return progress > COMMIT_PROGRESS || velocity > COMMIT_VELOCITY;
}

export interface EdgeSwipeBackOptions {
  direction: "ltr" | "rtl";
  /** Whether a swipe can start now: there is a screen to go back to. */
  enabled: boolean;
  /** The drag became a back swipe: show the screen underneath. */
  onStart: (width: number) => void;
  /** Share of the width swiped so far, 0 to 1. */
  onProgress: (progress: number) => void;
  /** The finger lifted after swiping; `commit` says whether to go back. */
  onRelease: (commit: boolean, progress: number) => void;
}

/**
 * Capture-phase handlers for the stack's container that turn a horizontal drag
 * starting at the leading edge into a back swipe, as iOS does. The leading edge
 * is the left one, or the right one in a right-to-left layout.
 *
 * Touches are only watched, never taken over, until they move sideways: a tap
 * on a back button at the edge or a scroll that starts there works as usual.
 * Touches inside popups, or on elements that drag sideways themselves, are left
 * alone.
 */
export function useEdgeSwipeBack({
  direction,
  enabled,
  onStart,
  onProgress,
  onRelease,
}: EdgeSwipeBackOptions) {
  const gesture = useRef<Gesture | null>(null);
  // A drag that became a swipe ends in a click on whatever it started on.
  const suppressClick = useRef(false);
  const sign = direction === "rtl" ? -1 : 1;

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      suppressClick.current = false;
      if (!event.isPrimary) return;
      // A new touch means any earlier one ended, even if its end was lost: settle
      // a swipe it left halfway.
      const stale = gesture.current;
      gesture.current = null;
      if (stale?.dragging) onRelease(false, stale.progress);
      if (!enabled) return;
      // Events of popups opened from a screen reach the container through React's
      // tree, though the popups sit elsewhere on the page and are not the screen.
      const target = event.target;
      if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
      if (target.closest(OWN_DRAG_SELECTOR)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const fromEdge = direction === "rtl" ? rect.right - event.clientX : event.clientX - rect.left;
      if (fromEdge < 0 || fromEdge > EDGE_WIDTH) return;
      // A mouse drag would otherwise select the page's text; a tap still clicks.
      if (event.pointerType === "mouse") event.preventDefault();
      gesture.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        dragging: false,
        progress: 0,
        samples: [{ x: event.clientX, t: event.timeStamp }],
      };
    },
    [direction, enabled, onRelease],
  );

  const onPointerMoveCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (current?.pointerId !== event.pointerId) return;
      const dx = (event.clientX - current.startX) * sign;
      const dy = event.clientY - current.startY;

      if (!current.dragging) {
        if (Math.abs(dy) > VERTICAL_CANCEL && Math.abs(dy) > Math.abs(dx)) {
          gesture.current = null;
          return;
        }
        if (dx < START_DISTANCE) return;
        current.dragging = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart(current.width);
      }

      current.samples = [...current.samples, { x: event.clientX, t: event.timeStamp }].filter(
        (sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW_MS,
      );
      current.progress = Math.min(Math.max(dx / current.width, 0), 1);
      onProgress(current.progress);
    },
    [onProgress, onStart, sign],
  );

  const finish = useCallback(
    (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
      const current = gesture.current;
      if (current?.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (!current.dragging) return;
      const first = current.samples[0];
      const elapsed = event.timeStamp - first.t;
      const velocity = elapsed > 0 ? ((event.clientX - first.x) * sign) / elapsed : 0;
      onRelease(!cancelled && shouldCommitSwipe(current.progress, velocity), current.progress);
    },
    [onRelease, sign],
  );

  const onPointerUpCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => finish(event, false),
    [finish],
  );
  const onPointerCancelCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => finish(event, true),
    [finish],
  );
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  };
}
