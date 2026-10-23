import { listenBackButton } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
  type Location,
} from "react-router-dom";
import { readHistoryIndex } from "./history-index";
import { MobileStackContext } from "./mobile-stack-contexts";
import {
  applyNavigation,
  coldStart,
  getBackTarget,
  stepsBackToTabRoot,
  topScreen,
  type StackConfig,
  type StackIntent,
  type StackLocation,
} from "./stack-model";

/** Open popups that Back should close before it leaves the screen. */
const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"][data-open]',
  '[role="alertdialog"][data-open]',
  '[role="menu"][data-open]',
  '[role="listbox"][data-open]',
].join(",");

/** Whether a popup the user can see is open: one of the screen on top, or of no screen. */
function isPopupShown(topScreenId: string | undefined) {
  return [...document.querySelectorAll(OPEN_OVERLAY_SELECTOR)].some((popup) => {
    // A screen kept out of sight keeps its open popups, hidden with it.
    const scope = popup.closest("[data-portal-scope]")?.getAttribute("data-portal-scope");
    return scope === undefined || scope === topScreenId;
  });
}

/** Calls `onChange` whenever a popup may have opened or closed. */
function subscribeToPopups(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-open"],
  });
  return () => observer.disconnect();
}

function subscribeToNothing() {
  return () => undefined;
}

/**
 * Scrolls a screen back to its top, as tapping its tab again does on iOS:
 * whatever scrolls in it, the page itself or the section a page scrolls in.
 */
function scrollScreenToTop(screenId: string) {
  const screen = document.querySelector(`[data-stack-screen="${screenId}"]`);
  if (!screen) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const element of screen.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollTop > 0 && /(auto|scroll)/.test(getComputedStyle(element).overflowY)) {
      element.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    }
  }
}

function toStackLocation(location: Location): StackLocation {
  return {
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    state: location.state as unknown,
    key: location.key,
  };
}

interface MobileStackProviderProps {
  config: StackConfig;
  children: ReactNode;
}

/** Tracks the router's navigations as per-tab screen stacks for the phone layout. */
export function MobileStackProvider({ config, children }: MobileStackProviderProps) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const { isAndroid, isTauri } = usePlatform();
  const isAndroidApp = isTauri && isAndroid;
  const [intent, setIntent] = useState<StackIntent | null>(null);
  const [state, setState] = useState(() =>
    coldStart(config, toStackLocation(location), undefined, readHistoryIndex(location) ?? 0),
  );
  const [seenKey, setSeenKey] = useState(location.key);
  const [appWentBack, setAppWentBack] = useState(false);
  const [historyDriven, setHistoryDriven] = useState(false);
  const [popAnimated, setPopAnimated] = useState<boolean | null>(null);
  // Screens holding unsaved work: system backs go through the page instead.
  const leaveGuards = useRef(new Map<string, () => void>());
  const [guardedScreens, setGuardedScreens] = useState<ReadonlySet<string>>(() => new Set());

  // Whether the browser animated a history step itself (a back swipe or back
  // preview), so the screens don't animate it a second time. Listening in the
  // capture phase runs before the router's listener renders the new location.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) =>
      setPopAnimated(
        "hasUAVisualTransition" in event ? Boolean(event.hasUAVisualTransition) : null,
      );
    window.addEventListener("popstate", onPopState, true);
    return () => window.removeEventListener("popstate", onPopState, true);
  }, []);

  // Each navigation becomes one stack update, applied while rendering the new
  // location so the screens never show a frame of the old stack.
  if (location.key !== seenKey) {
    setSeenKey(location.key);
    setIntent(null);
    setAppWentBack(false);
    setHistoryDriven(navigationType === NavigationType.Pop && !appWentBack);
    setState(
      applyNavigation(
        state,
        {
          action: navigationType,
          location: toStackLocation(location),
          intent,
          index: readHistoryIndex(location),
        },
        config,
      ),
    );
  }

  const back = useCallback(() => {
    const target = getBackTarget(state);
    if (!target || target.viaHistory) {
      setAppWentBack(true);
      void navigate(-1);
      return;
    }
    // History does not lead to the screen under this one (the tab was opened
    // directly on a deeper screen, or reached from another tab), so this entry
    // is replaced by that screen instead.
    const { pathname, search, hash, state: locationState } = target.screen.location;
    setIntent({ type: "popTo", screenId: target.screen.id });
    void navigate({ pathname, search, hash }, { replace: true, state: locationState });
  }, [navigate, state]);

  const openTab = useCallback(
    (tabId: string) => {
      const tab = config.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const screens = state.stacks[tabId] ?? [];
      if (state.activeTab === tabId) {
        if (screens.length < 2) {
          if (screens[0]) scrollScreenToTop(screens[0].id);
          return;
        }
        // Back to the tab's first screen through history when the screens above
        // it are the latest entries, so no closed screen stays behind in history.
        const steps = stepsBackToTabRoot(state, tabId);
        if (steps) {
          setAppWentBack(true);
          void navigate(-steps);
        } else {
          void navigate(tab.rootPath);
        }
        return;
      }
      const top = screens[screens.length - 1];
      setIntent({ type: "openTab", tab: tabId });
      // In Android's app a tab switch takes no history entry, so its Back never
      // walks back through the tabs the user went through.
      const replace = isAndroidApp;
      if (top) {
        const { pathname, search, hash, state: locationState } = top.location;
        void navigate({ pathname, search, hash }, { replace, state: locationState });
      } else {
        void navigate(tab.rootPath, { replace });
      }
    },
    [config.tabs, isAndroidApp, navigate, state],
  );

  const guardScreen = useCallback((screenId: string, onAttempt: () => void) => {
    leaveGuards.current.set(screenId, onAttempt);
    setGuardedScreens((current) => new Set(current).add(screenId));
    return () => {
      if (leaveGuards.current.get(screenId) === onAttempt) leaveGuards.current.delete(screenId);
      setGuardedScreens((current) => {
        const next = new Set(current);
        next.delete(screenId);
        return next;
      });
    };
  }, []);

  // Android's Back closes an open popup first, then steps back through the tab
  // like the screen's back button, asking first on a screen with unsaved work.
  // At another tab's first screen it goes to the home tab, as Android apps do.
  // With none of that to do, Android keeps its own Back: leaving the app.
  const canGoBack = getBackTarget(state) !== null;
  const topId = topScreen(state)?.id;
  const popupShown = useSyncExternalStore(
    isAndroidApp ? subscribeToPopups : subscribeToNothing,
    () => isAndroidApp && isPopupShown(topId),
  );
  const atOtherTabRoot =
    !canGoBack && state.activeTab !== null && state.activeTab !== config.homeTab;
  const handlesBack = canGoBack || popupShown || (atOtherTabRoot && config.homeTab !== undefined);
  const onAndroidBack = useEffectEvent(() => {
    const leaveGuard = topId ? leaveGuards.current.get(topId) : undefined;
    if (isPopupShown(topId)) {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    } else if (canGoBack && leaveGuard) {
      leaveGuard();
    } else if (canGoBack) {
      back();
    } else if (atOtherTabRoot && config.homeTab) {
      openTab(config.homeTab);
    } else {
      // The popup closed just before the press: what Android would have done.
      void navigate(-1);
    }
  });
  useEffect(() => {
    if (!isAndroidApp || !handlesBack) return;
    let stop: (() => Promise<void>) | undefined;
    let disposed = false;
    void listenBackButton(() => onAndroidBack()).then((unlisten) => {
      if (disposed) void unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      void stop?.();
    };
  }, [handlesBack, isAndroidApp]);

  const value = useMemo(
    () => ({
      state,
      config,
      back,
      openTab,
      historyDriven,
      popAnimated,
      guardScreen,
      guardedScreens,
    }),
    [state, config, back, openTab, historyDriven, popAnimated, guardScreen, guardedScreens],
  );

  return <MobileStackContext.Provider value={value}>{children}</MobileStackContext.Provider>;
}
