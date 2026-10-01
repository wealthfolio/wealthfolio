import type { DriftRow } from "@/lib/types";
import { formatPp } from "./drift-copy";

export function isOutOfBand(row: Pick<DriftRow, "status" | "isRequired">): boolean {
  return (
    row.status === "not_targeted" ||
    (row.isRequired && (row.status === "overweight" || row.status === "underweight"))
  );
}

export function hasVisibleAllocation(
  row: Pick<DriftRow, "currentBps" | "targetBps" | "currentValue" | "targetValue">,
): boolean {
  return (
    row.currentValue !== 0 || row.targetValue !== 0 || row.currentBps !== 0 || row.targetBps !== 0
  );
}

export function formatDriftBps(driftBps: number, decimals = 1): string {
  return formatPp(driftBps, decimals);
}
