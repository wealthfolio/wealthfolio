import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { MobileStackContext, StackScreenContext } from "./mobile-stack-contexts";
import { getBackTarget } from "./stack-model";

/** The phone stack, or null outside the phone layout. */
export function useMobileStack() {
  return useContext(MobileStackContext);
}

export function useRequiredMobileStack() {
  const stack = useContext(MobileStackContext);
  if (!stack) throw new Error("The phone stack is only available inside MobileStackProvider");
  return stack;
}

/**
 * Back action for a page's back button. On a stacked phone screen with a
 * screen under it, steps back to that screen. Otherwise goes to `fallbackTo`
 * when given (the page's parent), or back in history.
 */
export function useBackNavigation(fallbackTo?: string) {
  const stack = useContext(MobileStackContext);
  const screenId = useContext(StackScreenContext);
  const navigate = useNavigate();
  return useCallback(() => {
    if (stack && screenId && getBackTarget(stack.state)) {
      stack.back();
    } else if (fallbackTo) {
      void navigate(fallbackTo);
    } else {
      void navigate(-1);
    }
  }, [fallbackTo, navigate, screenId, stack]);
}

/**
 * While `when` is true, a system back on this phone screen (the edge swipe,
 * Android's Back) goes through `onAttempt` instead of leaving, for the page to
 * ask before its work is discarded: the swipe is off and Back calls it. The
 * page's own back button should ask the same way. Browser back and forward
 * can't be held.
 */
export function useLeaveGuard(when: boolean, onAttempt: () => void) {
  const guardScreen = useContext(MobileStackContext)?.guardScreen;
  const screenId = useContext(StackScreenContext);
  const latest = useRef(onAttempt);
  useLayoutEffect(() => {
    latest.current = onAttempt;
  });
  useEffect(() => {
    if (!guardScreen || !screenId || !when) return;
    return guardScreen(screenId, () => latest.current());
  }, [guardScreen, screenId, when]);
}
