import { listenBackButton } from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
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
        if (screens.length > 1) void navigate(tab.rootPath);
        return;
      }
      const top = screens[screens.length - 1];
      setIntent({ type: "openTab", tab: tabId });
      if (top) {
        const { pathname, search, hash, state: locationState } = top.location;
        void navigate({ pathname, search, hash }, { state: locationState });
      } else {
        void navigate(tab.rootPath);
      }
    },
    [config.tabs, navigate, state],
  );

  // Android's Back closes an open popup first, then steps back through the tab
  // like the screen's back button. With neither to do, Android keeps its own
  // Back: history back, or leaving the app.
  const canGoBack = getBackTarget(state) !== null;
  const topId = topScreen(state)?.id;
  const popupShown = useSyncExternalStore(
    isAndroidApp ? subscribeToPopups : subscribeToNothing,
    () => isAndroidApp && isPopupShown(topId),
  );
  const handlesBack = canGoBack || popupShown;
  const onAndroidBack = useEffectEvent(() => {
    if (isPopupShown(topId)) {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    } else if (canGoBack) {
      back();
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
    () => ({ state, config, back, openTab, historyDriven, popAnimated }),
    [state, config, back, openTab, historyDriven, popAnimated],
  );

  return <MobileStackContext.Provider value={value}>{children}</MobileStackContext.Provider>;
}
