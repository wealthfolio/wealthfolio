import type { ValuationStatus } from "./types";

/** Numeric values on incomplete valuations are known subtotals. */
export function isValuationComplete(status?: ValuationStatus): boolean {
  return status === undefined || status === "complete";
}
