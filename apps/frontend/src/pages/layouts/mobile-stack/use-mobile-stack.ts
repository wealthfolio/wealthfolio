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
 * While `when` is true, the stack's ways off this phone screen go through
 * `onAttempt` instead of leaving, for the page to ask before its work is
 * discarded: the edge swipe is off, and Android's Back or tapping the screen's
 * tab again call it with `proceed`, the leave to make if the user agrees. The
 * page's own back button should ask the same way. Browser back and forward
 * can't be held.
 */
export function useLeaveGuard(when: boolean, onAttempt: (proceed: () => void) => void) {
  const guardScreen = useContext(MobileStackContext)?.guardScreen;
  const screenId = useContext(StackScreenContext);
  const latest = useRef(onAttempt);
  useLayoutEffect(() => {
    latest.current = onAttempt;
  });
  useEffect(() => {
    if (!guardScreen || !screenId || !when) return;
    return guardScreen(screenId, (proceed) => latest.current(proceed));
  }, [guardScreen, screenId, when]);
}
