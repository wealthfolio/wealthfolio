import { DECIMAL_PRECISION } from "@/lib/constants";

/**
 * Decimals an amount needs to be counted exactly, ignoring trailing zeros,
 * up to `DECIMAL_PRECISION`.
 */
export function significantDecimals(value: number | string | null | undefined): number {
  const match = /^[+-]?\d*(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value ?? "").trim());
  if (!match) return 0;
  const fractionDigits = (match[1] ?? "").replace(/0+$/, "").length;
  const decimals = fractionDigits - Number(match[2] ?? 0);
  return Math.min(Math.max(decimals, 0), DECIMAL_PRECISION);
}

/**
 * Counts an amount in whole units of `10 ** -decimals`. Amounts and units must
 * fit JS number precision.
 */
export function toSplitUnits(value: number | string | null | undefined, decimals: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  if (!Number.isFinite(parsed)) return 0;
  // Match the sent decimal text without floating-point multiplication drift.
  return Number(parsed.toFixed(decimals).replace(".", ""));
}

export function splitUnitsToAmount(units: number, decimals: number): number {
  return units / 10 ** decimals;
}

export function distributeRemainingUnits(
  totalUnits: number,
  assignedUnits: number,
  emptyLineCount: number,
): number[] {
  if (emptyLineCount <= 0) return [];
  const remaining = totalUnits - assignedUnits;
  if (remaining <= 0) return Array.from({ length: emptyLineCount }, () => 0);
  const base = Math.floor(remaining / emptyLineCount);
  const extra = remaining % emptyLineCount;
  return Array.from({ length: emptyLineCount }, (_, index) => base + (index < extra ? 1 : 0));
}

export function distributeEvenlyUnits(totalUnits: number, lineCount: number): number[] {
  return distributeRemainingUnits(Math.abs(totalUnits), 0, lineCount);
}

export function canDistributeSplitUnits(
  totalUnits: number,
  assignedUnits: number,
  emptyLineCount: number,
  lineCount: number,
): boolean {
  const total = Math.abs(totalUnits);
  if (total <= 0 || emptyLineCount <= 0 || lineCount <= 0) return false;
  const remaining = total - assignedUnits;
  return remaining > 0 || (remaining === 0 && lineCount > emptyLineCount);
}
