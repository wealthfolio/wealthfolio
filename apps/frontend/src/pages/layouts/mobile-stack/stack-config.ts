import type { StackTab } from "./stack-model";

/** Tab that a link straight to a page outside every tab opens in. */
export const HOME_TAB = "dashboard";

/**
 * The phone layout's stacked tabs: one per destination of the app's
 * navigation, each keeping its own stack of screens. Add-on pages are left out
 * and replace one another as before: they run in iframes, which keep running
 * while hidden.
 */
export function stackTabsFor(hrefs: readonly string[]): StackTab[] {
  return hrefs.map((href) => ({
    id: href.replace(/^\//, ""),
    rootPath: href,
    ...(href === "/dashboard" && { aliases: ["/"] }),
  }));
}
