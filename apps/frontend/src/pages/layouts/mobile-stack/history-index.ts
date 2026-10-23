import type { Location } from "react-router-dom";

/**
 * Position of the location's entry in this tab's history. React Router keeps it
 * in each entry's state (`idx`), so it holds across reloads and counts every
 * navigation, including ones that land in the same render. Read only when the
 * current entry is the location being rendered.
 *
 * `idx` is React Router's own field, not public API; `history-index.test.tsx`
 * fails if an upgrade stops writing it.
 */
export function readHistoryIndex(location: Location): number | null {
  const entry = window.history.state as { key?: unknown; idx?: unknown } | null;
  if (entry?.key !== location.key && location.key !== "default") return null;
  return typeof entry?.idx === "number" ? entry.idx : null;
}
