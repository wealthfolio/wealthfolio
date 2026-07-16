export function toCents(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function centsToAmount(cents: number): number {
  return cents / 100;
}

export function distributeRemainingCents(
  totalCents: number,
  assignedCents: number,
  emptyLineCount: number,
): number[] {
  if (emptyLineCount <= 0) return [];
  const remaining = totalCents - assignedCents;
  if (remaining <= 0) return Array.from({ length: emptyLineCount }, () => 0);
  const base = Math.floor(remaining / emptyLineCount);
  const extra = remaining % emptyLineCount;
  return Array.from({ length: emptyLineCount }, (_, index) => base + (index < extra ? 1 : 0));
}

export function distributeEvenlyCents(totalCents: number, lineCount: number): number[] {
  return distributeRemainingCents(Math.abs(totalCents), 0, lineCount);
}

export function canDistributeSplitCents(
  totalCents: number,
  assignedCents: number,
  emptyLineCount: number,
  lineCount: number,
): boolean {
  const total = Math.abs(totalCents);
  if (total <= 0 || emptyLineCount <= 0 || lineCount <= 0) return false;
  const remaining = total - assignedCents;
  return remaining > 0 || (remaining === 0 && lineCount > emptyLineCount);
}
