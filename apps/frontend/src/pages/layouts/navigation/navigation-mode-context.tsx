import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo } from "react";
import { usePersistentState } from "@/hooks/use-persistent-state";

export type NavigationMode = "sidebar" | "launchbar";

interface NavigationModeContextValue {
  mode: NavigationMode;
  setMode: (mode: NavigationMode) => void;
  toggleMode: () => void;
  isLaunchBar: boolean;
  isFocusMode: boolean;
  setFocusMode: (isFocus: boolean) => void;
  toggleFocusMode: () => void;
}

export const NAVIGATION_MODE_STORAGE_KEY = "navigation-mode";
const STORAGE_KEY = NAVIGATION_MODE_STORAGE_KEY;
const FOCUS_STORAGE_KEY = "navigation-focus-mode";
const DEFAULT_MODE: NavigationMode = "sidebar";

const NavigationModeContext = createContext<NavigationModeContextValue | undefined>(undefined);

function parseStoredMode(raw: string | null): NavigationMode | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === "launchbar" || parsed === "sidebar") {
      return parsed;
    }
  } catch {
    if (raw === "launchbar" || raw === "sidebar") {
      return raw;
    }
  }

  return undefined;
}

function readInitialMode(): NavigationMode {
  if (typeof window === "undefined") {
    return DEFAULT_MODE;
  }

  const stored = parseStoredMode(window.localStorage.getItem(STORAGE_KEY));
  return stored ?? DEFAULT_MODE;
}

export function NavigationModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = usePersistentState<NavigationMode>(STORAGE_KEY, readInitialMode());
  const [isFocusMode, setFocusModeState] = usePersistentState<boolean>(FOCUS_STORAGE_KEY, false);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY && event.key !== FOCUS_STORAGE_KEY) {
        return;
      }

      if (event.key === STORAGE_KEY) {
        const nextMode = parseStoredMode(event.newValue);
        if (nextMode && nextMode !== mode) {
          setModeState(nextMode);
        }
        return;
      }

      if (event.key === FOCUS_STORAGE_KEY) {
        const nextFocus = event.newValue === "true";
        if (nextFocus !== isFocusMode) {
          setFocusModeState(nextFocus);
        }
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [mode, isFocusMode, setModeState, setFocusModeState]);

  const setMode = useCallback(
    (nextMode: NavigationMode) => {
      setModeState((previousMode) => (previousMode === nextMode ? previousMode : nextMode));
    },
    [setModeState],
  );

  const toggleMode = useCallback(() => {
    setModeState((currentMode) => (currentMode === "sidebar" ? "launchbar" : "sidebar"));
  }, [setModeState]);

  const setFocusMode = useCallback(
    (focus: boolean) => {
      setFocusModeState((current) => (current === focus ? current : focus));
    },
    [setFocusModeState],
  );

  const toggleFocusMode = useCallback(() => {
    setFocusModeState((current) => !current);
  }, [setFocusModeState]);

  const value = useMemo<NavigationModeContextValue>(
    () => ({
      mode,
      setMode,
      toggleMode,
      isLaunchBar: mode === "launchbar",
      isFocusMode,
      setFocusMode,
      toggleFocusMode,
    }),
    [isFocusMode, mode, setMode, setFocusMode, toggleFocusMode, toggleMode],
  );

  return <NavigationModeContext.Provider value={value}>{children}</NavigationModeContext.Provider>;
}

export function useNavigationMode() {
  const context = useContext(NavigationModeContext);
  if (!context) {
    throw new Error("useNavigationMode must be used within a NavigationModeProvider");
  }
  return context;
}
