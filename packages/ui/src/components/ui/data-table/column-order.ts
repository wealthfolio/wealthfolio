import type { ColumnOrderState } from "@tanstack/react-table";

/**
 * The saved order, with each column it doesn't list placed right after the column defined
 * before it. Views sharing a storageKey render different columns, and tanstack would put
 * unlisted ones last, after trailing columns such as row actions. Ids this view doesn't
 * render keep their place, so the other view's order survives.
 */
export function mergeColumnOrder(
  columnIds: string[],
  savedOrder: ColumnOrderState,
): ColumnOrderState {
  const order = [...savedOrder];
  const placed = new Set(savedOrder);
  columnIds.forEach((id, index) => {
    if (placed.has(id)) return;
    const previousId = columnIds[index - 1];
    order.splice(previousId === undefined ? 0 : order.indexOf(previousId) + 1, 0, id);
    placed.add(id);
  });
  return order;
}

/** Place `id` just before or after `neighbourId`. */
export function moveColumn(
  order: ColumnOrderState,
  id: string,
  neighbourId: string,
  placement: "before" | "after",
): ColumnOrderState {
  const next = order.filter((columnId) => columnId !== id);
  next.splice(next.indexOf(neighbourId) + (placement === "after" ? 1 : 0), 0, id);
  return next;
}
