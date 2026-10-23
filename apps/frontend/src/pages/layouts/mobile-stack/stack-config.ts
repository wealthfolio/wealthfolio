import type { StackTab } from "./stack-model";

/**
 * Tabs whose screens stack on the phone layout. Other pages still replace one
 * another as before.
 */
export const STACKED_TABS: readonly StackTab[] = [
  { id: "holdings", rootPath: "/holdings" },
  { id: "settings", rootPath: "/settings" },
];
