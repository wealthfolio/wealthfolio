import { createContext } from "react";
import type { StackConfig, StackState } from "./stack-model";

export interface MobileStackContextValue {
  state: StackState;
  config: StackConfig;
  /** Returns to the screen under the top one, or goes back in history at a tab's root. */
  back: () => void;
  /** Shows a tab as it was left; on the tab already shown, returns it to its first screen. */
  openTab: (tabId: string) => void;
  /**
   * The last navigation was a history step the app did not make: the browser's
   * back or forward, Safari's own back swipe, or Android's default Back.
   */
  historyDriven: boolean;
  /**
   * Whether the browser played its own transition for the last history step
   * (`PopStateEvent.hasUAVisualTransition`); null where browsers don't say.
   */
  popAnimated: boolean | null;
}

export const MobileStackContext = createContext<MobileStackContextValue | null>(null);

/** Id of the stacked screen a page is rendered in. */
export const StackScreenContext = createContext<string | null>(null);
