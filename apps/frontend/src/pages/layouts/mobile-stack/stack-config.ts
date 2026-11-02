import type { StackTab } from "./stack-model";

/** Tab that a link straight to a page outside every tab opens in. */
export const HOME_TAB = "dashboard";

/**
 * Paths that stay outside every tab: add-on pages, which run in iframes that
 * keep running while hidden. Matched by prefix because the add-on menu loads
 * after the app starts.
 */
export const OUTSIDE_TAB_PREFIXES: readonly string[] = ["/addons/", "/addon/"];

/**
 * Destinations that keep replacing one another instead of stacking: the
 * assistant's tool cards register in effects, which a hidden screen pauses, so
 * a kept chat would lose what was typed into a card.
 */
const UNSTACKED_DESTINATIONS = new Set(["/assistant"]);

/**
 * The phone layout's stacked tabs: one per destination of the app's
 * navigation, each keeping its own stack of screens.
 */
export function stackTabsFor(hrefs: readonly string[]): StackTab[] {
  return hrefs
    .filter((href) => !UNSTACKED_DESTINATIONS.has(href))
    .map((href) => ({
      id: href.replace(/^\//, ""),
      rootPath: href,
      ...(href === "/dashboard" && { aliases: ["/"] }),
    }));
}
