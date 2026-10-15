import { waitFor } from "@testing-library/react";

/** Base UI tooltips are visual labels without a `tooltip` role, so tests find the popup by its slot. */
export function queryTooltip() {
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

export function findTooltip() {
  return waitFor(() => {
    const tooltip = queryTooltip();
    if (!tooltip) throw new Error("No tooltip is open");
    return tooltip;
  });
}
