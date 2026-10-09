import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

import {
  sameTarget,
  type HighlightState,
  type HighlightTarget,
} from "./allocation-worksheet-amounts";

interface HighlightActions {
  point: (target: HighlightTarget) => void;
  /** Ends pointing only if nothing else was pointed at since. */
  unpoint: (target: HighlightTarget) => void;
  toggleSelected: (target: HighlightTarget) => void;
  select: (target: HighlightTarget) => void;
  clearSelection: () => void;
  /** Nothing pointed at or selected, as when the list leaves the screen. */
  reset: () => void;
  /** Drops a row that left the worksheet, so nothing stays lit for it. */
  forgetRow: (assetId: string) => void;
}

export type HighlightStore = HighlightState & HighlightActions;

/**
 * Pointing and selection change on every mouse move, so they live outside the
 * worksheet's state: only the rows and classes whose emphasis changes render
 * again, never the whole worksheet.
 */
export function createHighlightStore(): StoreApi<HighlightStore> {
  return createStore<HighlightStore>()((set) => ({
    pointed: null,
    selected: null,
    point: (target) =>
      set((state) => (sameTarget(state.pointed, target) ? state : { pointed: target })),
    unpoint: (target) =>
      set((state) => (sameTarget(state.pointed, target) ? { pointed: null } : state)),
    toggleSelected: (target) =>
      set((state) => ({ selected: sameTarget(state.selected, target) ? null : target })),
    select: (target) =>
      set((state) => (sameTarget(state.selected, target) ? state : { selected: target })),
    clearSelection: () => set({ selected: null }),
    reset: () => set({ pointed: null, selected: null }),
    forgetRow: (assetId) =>
      set((state) => {
        const row: HighlightTarget = { kind: "row", assetId };
        return {
          pointed: sameTarget(state.pointed, row) ? null : state.pointed,
          selected: sameTarget(state.selected, row) ? null : state.selected,
        };
      }),
  }));
}

export const HighlightStoreContext = createContext<StoreApi<HighlightStore> | null>(null);

function useHighlightStoreApi(): StoreApi<HighlightStore> {
  const store = useContext(HighlightStoreContext);
  if (!store) throw new Error("Highlight hooks need a HighlightStoreContext provider");
  return store;
}

/** Subscribes to one derived value; return a primitive or a stored reference. */
export function useHighlight<T>(selector: (state: HighlightStore) => T): T {
  return useStore(useHighlightStoreApi(), selector);
}

/** The actions, without subscribing to any change. */
export function useHighlightActions(): HighlightActions {
  return useHighlightStoreApi().getState();
}
