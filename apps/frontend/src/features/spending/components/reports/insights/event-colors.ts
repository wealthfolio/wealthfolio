import type { EventSpendingSummary } from "../../../types/event";

/** Resolve stroke/fill for an event from its type color (set in event settings). */
export function getEventColors(ev: EventSpendingSummary): { stroke: string; fill: string } {
  const stroke = ev.eventTypeColor ?? "var(--muted-foreground)";
  // Translucent fill derived from the stroke. Hex colors get an alpha suffix;
  // CSS vars use color-mix to stay transparent.
  const fill = ev.eventTypeColor
    ? `${ev.eventTypeColor}33`
    : "color-mix(in oklch, var(--muted-foreground) 20%, transparent)";
  return { stroke, fill };
}
