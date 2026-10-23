import { AppScreenRoutes } from "@/app-screen-routes";
import { usePlatform } from "@/hooks/use-platform";
import { cn } from "@/lib/utils";
import { PageScrollContainer, PortalScope } from "@wealthfolio/ui";
import { useDirection } from "@wealthfolio/ui/components/ui/direction";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { useLocation } from "react-router-dom";
import { PageErrorBoundary } from "../page-error-boundary";
import { getPageScrollKey } from "../page-scroll-key";
import { StackScreenContext } from "./mobile-stack-contexts";
import { describeTransition, topScreen, type StackScreen } from "./stack-model";
import { useEdgeSwipeBack } from "./use-edge-swipe-back";
import { useRequiredMobileStack } from "./use-mobile-stack";

/** iOS navigation curve and timing. */
const TRANSITION = { duration: 0.42, ease: [0.32, 0.72, 0, 1] } as const;
/** How far the screen underneath sits behind the top one, as a share of the width. */
const UNDER_SHIFT = 0.3;
/** Darkening of the screen underneath while the top one covers it. */
const UNDER_DIM = 0.08;
/**
 * Screens kept mounted per tab besides its first one: the top and the two under
 * it. Deeper screens unmount and open fresh when the user gets back to them.
 */
const KEPT_RECENT_SCREENS = 3;

type ScrollProps = HTMLAttributes<HTMLDivElement>;
type Role = "top" | "under" | "idle";

interface ActiveTransition {
  kind: "push" | "pop";
  from: StackScreen;
  to: StackScreen;
  exiting: StackScreen[];
  /** End at once without animating: the browser already animated its own swipe. */
  instant: boolean;
}

// `?swipe=app` on the first load turns the app's swipe on in a browser, to try
// it, and test it with real touches, without the iOS app. Stripped from
// production builds.
let appSwipeOverride = false;
if (import.meta.env.DEV && typeof window !== "undefined") {
  appSwipeOverride = new URLSearchParams(window.location.search).get("swipe") === "app";
}

/**
 * Who animates a back swipe. Safari has its own, in a tab and in a home-screen
 * web app alike, which a page cannot turn off; on Android the system Back
 * gesture owns the screen edges. The app's swipe runs only in the iOS app.
 */
function useBackSwipeOwner() {
  const { isIOS, isTauri } = usePlatform();
  if (appSwipeOverride) return { appSwipe: true, browserSwipe: false };
  return { appSwipe: isIOS && isTauri, browserSwipe: isIOS && !isTauri };
}

/** Selector for fields that hold the keyboard up while focused. */
const TEXT_FIELD_SELECTOR =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Seconds a transition takes to cover `distance`, a share of the full slide. */
function transitionDuration(distance: number) {
  return 0.15 + Math.abs(distance) * (TRANSITION.duration - 0.15);
}

/** Whether a screen at `position` of a tab's stack of `length` stays mounted. */
function isKept(position: number, length: number) {
  return position === 0 || position >= length - KEPT_RECENT_SCREENS;
}

/**
 * CSS hiding the popups of every stacked screen but the one on top. Popups
 * render at the end of the document, outside their screen, so hiding a screen
 * that stays mounted would otherwise leave its open popups showing.
 */
function hideOtherScreensPopups(topId: string | undefined) {
  const others =
    topId === undefined
      ? "[data-portal-scope]"
      : `[data-portal-scope]:not([data-portal-scope=${JSON.stringify(topId)}])`;
  return `${others}{display:none!important}`;
}

/**
 * Moves focus with the screen on top, for keyboard and screen reader users: to
 * a pushed screen's heading, and back to whatever had focus when a screen was
 * covered once it is shown again.
 */
function focusScreen(
  container: HTMLElement | null,
  screenId: string,
  restore: Element | undefined,
) {
  const layer = container?.querySelector<HTMLElement>(`[data-stack-screen="${screenId}"]`);
  if (!layer) return;
  if (restore instanceof HTMLElement && restore.isConnected && layer.contains(restore)) {
    restore.focus({ preventScroll: true });
    return;
  }
  // The page already focused something itself, such as a form's first field.
  if (
    document.activeElement &&
    document.activeElement !== layer &&
    layer.contains(document.activeElement)
  ) {
    return;
  }
  const heading = layer.querySelector<HTMLElement>("h1") ?? layer;
  if (heading.tabIndex < 0 && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

interface StackLayerProps {
  screen: StackScreen;
  role: Role;
  visible: boolean;
  x: MotionValue<number>;
  dim: MotionValue<number>;
  scrollProps: ScrollProps;
}

function StackLayer({ screen, role, visible, x, dim, scrollProps }: StackLayerProps) {
  return (
    <Activity mode={visible ? "visible" : "hidden"}>
      <motion.div
        data-stack-screen={screen.id}
        data-stack-role={role}
        className="bg-background absolute inset-0 flex flex-col"
        style={{ x, zIndex: role === "top" ? 2 : role === "under" ? 1 : 0 }}
        inert={role !== "top"}
      >
        {role === "under" && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 bg-black"
            style={{ opacity: dim }}
          />
        )}
        <StackScreenContext.Provider value={screen.id}>
          <PortalScope name={screen.id}>
            {/* Pages only pan vertically, so the browser leaves a sideways drag to
                the app (back swipe, section pager) instead of cancelling it. */}
            <PageScrollContainer
              withMobileNavOffset
              className="touch-pan-y lg:px-6 lg:py-0"
              {...scrollProps}
            >
              <PageErrorBoundary>
                <AppScreenRoutes location={screen.location} />
              </PageErrorBoundary>
            </PageScrollContainer>
          </PortalScope>
        </StackScreenContext.Provider>
      </motion.div>
    </Activity>
  );
}

interface MobileStackOutletProps {
  /** Handlers for each page's scroll container, such as pull to refresh. */
  scrollProps: ScrollProps;
}

/**
 * Pages of the phone layout. Pages of a stacked tab stay mounted under the one
 * on top, so going back shows them as they were left; other pages replace one
 * another.
 */
export function MobileStackOutlet({ scrollProps }: MobileStackOutletProps) {
  const { state, back, historyDriven, popAnimated } = useRequiredMobileStack();
  const location = useLocation();
  const direction = useDirection();
  const reduceMotion = useReducedMotion();
  const { appSwipe, browserSwipe } = useBackSwipeOwner();
  const containerRef = useRef<HTMLDivElement>(null);
  // Focus to restore per screen, and the screen to focus once a transition ends.
  const focusOrigins = useRef(new Map<string, Element>());
  const pendingFocus = useRef<{ screenId: string; restore: boolean } | null>(null);

  const [previous, setPrevious] = useState(state);
  const [transition, setTransition] = useState<ActiveTransition | null>(null);
  // A swipe is moving the screens, or settling them after the finger lifted.
  const [gestureArmed, setGestureArmed] = useState(false);

  // Work out how the top screen changed while rendering the new stack, so the
  // screen leaving is still drawn in the same frame.
  if (state !== previous) {
    setPrevious(state);
    const change = describeTransition(previous, state);
    // Skip the animation when the browser already played its own: Safari's back
    // swipe, or a browser's back preview. Without the browser saying so, assume
    // Safari animated any back or forward it made.
    const instant = historyDriven && (popAnimated ?? browserSwipe);
    setTransition(
      change
        ? {
            kind: change.kind,
            from: change.from,
            to: change.to,
            exiting: change.kind === "pop" ? change.exiting : [],
            instant,
          }
        : null,
    );
    // A released swipe hands the screens to the pop it started. A page updating
    // its own URL during the drag leaves the swipe alone.
    if (gestureArmed && topScreen(previous)?.id !== topScreen(state)?.id) {
      setGestureArmed(false);
    }
  }

  // 0: the top screen covers the one underneath. 1: it has moved off.
  const progress = useMotionValue(0);
  const width = useMotionValue(0);
  const sign = useMotionValue(direction === "rtl" ? -1 : 1);
  useEffect(() => sign.set(direction === "rtl" ? -1 : 1), [direction, sign]);
  const topX = useTransform(() => progress.get() * width.get() * sign.get());
  const underX = useTransform(() => -(1 - progress.get()) * UNDER_SHIFT * width.get() * sign.get());
  const underDim = useTransform(() => (1 - progress.get()) * UNDER_DIM);
  const restX = useMotionValue(0);

  useLayoutEffect(() => {
    if (!transition) {
      progress.set(0);
      return;
    }
    width.set(containerRef.current?.clientWidth || window.innerWidth);
    if (transition.kind === "push") {
      focusOrigins.current.set(transition.from.id, document.activeElement ?? document.body);
    } else {
      for (const screen of transition.exiting) focusOrigins.current.delete(screen.id);
    }
    pendingFocus.current = { screenId: transition.to.id, restore: transition.kind === "pop" };
    if (transition.instant) {
      setTransition(null);
      return;
    }
    // A pop starts where the top screen is: at rest, partway off under a released
    // swipe, or partway in when it interrupts the push bringing that screen in.
    const [from, to] = transition.kind === "push" ? [1, 0] : [progress.get(), 1];
    progress.set(from);
    const controls = animate(
      progress,
      to,
      reduceMotion
        ? { duration: 0 }
        : { duration: transitionDuration(to - from), ease: TRANSITION.ease },
    );
    void controls.then(() => setTransition((current) => (current === transition ? null : current)));
    return () => controls.stop();
  }, [progress, reduceMotion, transition, width]);

  // Forget the focus of screens that left the stack without a pop, such as one a
  // redirect replaced, so their unmounted pages are not kept in memory.
  useEffect(() => {
    const ids = new Set(Object.values(state.stacks).flatMap((stack) => stack.map((s) => s.id)));
    for (const id of focusOrigins.current.keys()) {
      if (!ids.has(id)) focusOrigins.current.delete(id);
    }
  }, [state]);

  // Once the screens settle (and the new top is no longer inert), move focus.
  useEffect(() => {
    const target = pendingFocus.current;
    if (transition || !target) return;
    pendingFocus.current = null;
    const restore = target.restore ? focusOrigins.current.get(target.screenId) : undefined;
    focusScreen(containerRef.current, target.screenId, restore);
  }, [transition]);

  const onStart = useCallback(
    (containerWidth: number) => {
      width.set(containerWidth);
      progress.set(0);
      setGestureArmed(true);
      // The keyboard goes down as the screen starts to leave, as on iOS.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches(TEXT_FIELD_SELECTOR)) focused.blur();
    },
    [progress, width],
  );
  const onProgress = useCallback((value: number) => progress.set(value), [progress]);
  const onRelease = useCallback(
    (commit: boolean, released: number) => {
      // Going back starts the pop now; it carries on from where the finger left
      // the screen, and keeps taps and swipes off until it ends.
      if (commit) {
        back();
        return;
      }
      void animate(
        progress,
        0,
        reduceMotion
          ? { duration: 0 }
          : { duration: transitionDuration(released), ease: TRANSITION.ease },
      ).then(() => setGestureArmed(false));
    },
    [back, progress, reduceMotion],
  );
  const activeScreens = state.activeTab ? (state.stacks[state.activeTab] ?? []) : [];
  const canSwipeBack = appSwipe && activeScreens.length > 1 && transition === null && !gestureArmed;
  const edgeHandlers = useEdgeSwipeBack({
    direction,
    enabled: canSwipeBack,
    onStart,
    onProgress,
    onRelease,
  });

  const exiting = transition?.kind === "pop" ? transition.exiting : [];
  const layered = [...activeScreens, ...exiting];
  const topId = layered[layered.length - 1]?.id;
  const underId =
    transition?.kind === "push"
      ? transition.from.id
      : transition?.kind === "pop"
        ? transition.to.id
        : activeScreens[activeScreens.length - 2]?.id;
  const showUnder = transition !== null || gestureArmed;

  const screens = [
    ...Object.values(state.stacks).flatMap((stack) =>
      stack.filter((_, position) => isKept(position, stack.length)),
    ),
    ...exiting,
  ];

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex min-h-0 w-full flex-1 overflow-hidden",
        transition && "pointer-events-none",
      )}
      {...edgeHandlers}
    >
      <style>{hideOtherScreensPopups(topId)}</style>
      {state.activeTab === null && (
        <PageScrollContainer
          key={getPageScrollKey(location.pathname)}
          withMobileNavOffset
          className="lg:px-6 lg:py-0"
          {...scrollProps}
        >
          <PageErrorBoundary>
            <AppScreenRoutes />
          </PageErrorBoundary>
        </PageScrollContainer>
      )}

      {screens.map((screen) => {
        const inActiveTab = state.activeTab !== null && screen.tab === state.activeTab;
        const role: Role =
          inActiveTab && screen.id === topId
            ? "top"
            : inActiveTab && screen.id === underId
              ? "under"
              : "idle";
        return (
          <StackLayer
            key={screen.id}
            screen={screen}
            role={role}
            visible={role === "top" || (role === "under" && showUnder)}
            x={role === "top" ? topX : role === "under" ? underX : restX}
            dim={underDim}
            scrollProps={scrollProps}
          />
        );
      })}
    </div>
  );
}
