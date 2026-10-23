/**
 * Key for a page's scroll container: a new page starts at the top, while
 * add-on routes share one container so moving within an add-on keeps it.
 */
export function getPageScrollKey(pathname: string): string {
  return pathname.startsWith("/addon/") || pathname.startsWith("/addons/") ? "/addons" : pathname;
}
