/**
 * Moves focus with the screen on top, for keyboard and screen reader users: to
 * a pushed screen's heading, and back to whatever had focus when a screen was
 * covered once it is shown again.
 */
export function focusScreen(
  container: HTMLElement | null,
  screenId: string,
  restore: Element | undefined,
) {
  const layer = container?.querySelector<HTMLElement>(`[data-stack-screen="${screenId}"]`);
  if (!layer) return;
  if (restore instanceof HTMLElement && restore.isConnected && layer.contains(restore)) {
    restore.focus({ preventScroll: true });
    return;
  }
  // The page already focused something itself, such as a form's first field, in
  // the screen or in one of its popups (a sheet renders outside the screen).
  const active = document.activeElement;
  if (
    active &&
    active !== layer &&
    (layer.contains(active) ||
      active.closest(`[data-portal-scope=${JSON.stringify(screenId)}]`) !== null)
  ) {
    return;
  }
  const heading = layer.querySelector<HTMLElement>("h1") ?? layer;
  if (heading.tabIndex < 0 && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}
