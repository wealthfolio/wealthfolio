import type { MouseEvent } from "react";

/**
 * Parts of a clickable table row that keep their own click behaviour. A cell
 * can opt out whole with `data-row-click-ignore`, so a near miss beside a small
 * control (a checkbox, a row menu) does not trigger the row.
 */
const ROW_CLICK_IGNORED = "button, a, input, label, [data-row-click-ignore]";

/** True when a click on a table row landed on the row itself, not one of its controls. */
export function isRowBodyClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element;
  // Popovers and menus opened from the row render outside it but still bubble
  // here through React; only clicks inside the row itself count.
  if (!event.currentTarget.contains(target) || target.closest(ROW_CLICK_IGNORED)) return false;
  // Dragging across text to select it (web build) is not a click.
  return window.getSelection()?.isCollapsed !== false;
}
