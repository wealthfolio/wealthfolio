/** Inclusive day count between A and B — same day = 1, next day = 2, etc. */
export function inclusiveDays(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (24 * 3600 * 1000))) + 1;
}
