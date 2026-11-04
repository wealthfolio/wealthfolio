import type { Location, NavigateOptions } from "react-router-dom";

export const SPENDING_ENTRY_PATH = "/spending/transactions/new";

/** Keep the originating desktop page mounted while its entry sheet is open. */
export function getSpendingBackgroundLocation(location: Location): Location | undefined {
  if (location.pathname !== SPENDING_ENTRY_PATH) return undefined;
  return (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
}

/** Reopening entry via Search replaces that entry, retaining its original page. */
export function spendingEntryNavigationOptions(location: Location): NavigateOptions {
  const isEntry = location.pathname === SPENDING_ENTRY_PATH;
  return {
    replace: isEntry,
    state: { backgroundLocation: isEntry ? getSpendingBackgroundLocation(location) : location },
  };
}
