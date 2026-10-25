import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const dateReviver = (_key: string, value: unknown) => {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))$/;
  if (typeof value === "string" && isoDateRegex.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }
  return value;
};

// Custom event name for same-page synchronization
const PERSISTENT_STATE_CHANGE_EVENT = "persistent-state-change";

interface PersistentStateChangeDetail {
  key: string;
  value: unknown;
}

export function usePersistentState<T>(
  key: string,
  initialState: T,
  fallbackKey?: string,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const storedValue =
        window.localStorage.getItem(key) ??
        (fallbackKey ? window.localStorage.getItem(fallbackKey) : null);
      if (storedValue) {
        return JSON.parse(storedValue, dateReviver) as T;
      }
    } catch (error) {
      console.error(`Error reading from localStorage for key "${key}":`, error);
    }
    return initialState;
  });

  // Resolve updates outside React's updater so broadcasting cannot run during render.
  const current = useRef(state);
  const setStateAndBroadcast = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const newState =
        typeof action === "function" ? (action as (prev: T) => T)(current.current) : action;
      current.current = newState;
      setState(() => newState);

      try {
        window.localStorage.setItem(key, JSON.stringify(newState));
      } catch (error) {
        console.error(`Error writing to localStorage for key "${key}":`, error);
      }
      window.dispatchEvent(
        new CustomEvent<PersistentStateChangeDetail>(PERSISTENT_STATE_CHANGE_EVENT, {
          detail: { key, value: newState },
        }),
      );
    },
    [key],
  );

  // Listen for changes from other instances (same page) and cross-tab storage events
  useEffect(() => {
    // A screen kept hidden (React <Activity>) drops these listeners and adds
    // them back when it is shown again: read storage first, so a change another
    // screen made in between shows here too.
    try {
      const storedValue =
        window.localStorage.getItem(key) ??
        (fallbackKey ? window.localStorage.getItem(fallbackKey) : null);
      if (storedValue !== null && storedValue !== JSON.stringify(current.current)) {
        const value = JSON.parse(storedValue, dateReviver) as T;
        current.current = value;
        setState(() => value);
      }
    } catch (error) {
      console.error(`Error reading from localStorage for key "${key}":`, error);
    }

    // Handle custom event from same page
    const handleCustomEvent = (event: Event) => {
      const customEvent = event as CustomEvent<PersistentStateChangeDetail>;
      if (customEvent.detail.key === key) {
        const value = customEvent.detail.value as T;
        current.current = value;
        setState(() => value);
      }
    };

    // Handle storage event from other tabs
    const handleStorageEvent = (event: StorageEvent) => {
      if (event.key === key && event.newValue !== null) {
        try {
          const value = JSON.parse(event.newValue, dateReviver) as T;
          current.current = value;
          setState(() => value);
        } catch (error) {
          console.error(`Error parsing storage event for key "${key}":`, error);
        }
      }
    };

    window.addEventListener(PERSISTENT_STATE_CHANGE_EVENT, handleCustomEvent);
    window.addEventListener("storage", handleStorageEvent);

    return () => {
      window.removeEventListener(PERSISTENT_STATE_CHANGE_EVENT, handleCustomEvent);
      window.removeEventListener("storage", handleStorageEvent);
    };
  }, [key, fallbackKey]);

  return [state, setStateAndBroadcast];
}
