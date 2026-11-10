import type { ActivityCharge } from "@/lib/types";

/** Metadata key of an activity's fee and tax lines (`CHARGES_METADATA_KEY` in core). */
const CHARGES_METADATA_KEY = "charges";

export interface ActivityChargeLines {
  fee: ActivityCharge[];
  tax: ActivityCharge[];
}

interface ChargeTotals {
  fee?: number | string | null;
  tax?: number | string | null;
  metadata?: Record<string, unknown> | null;
}

function isChargeLine(value: unknown): value is ActivityCharge {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    (line.category === "fee" || line.category === "tax") &&
    typeof line.label === "string" &&
    line.label.trim().length > 0 &&
    (typeof line.amount === "string" || typeof line.amount === "number")
  );
}

/** Fixed-scale integers keep the check exact across core's 28 decimal places. */
function scaledAmount(value: number | string): bigint | null {
  const text = String(value).trim();
  if (text.length > 128) return null;
  const parts = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!parts) return null;
  const [, sign, whole, fraction = "", exponent = "0"] = parts;
  const shift = 28 + Number(exponent) - fraction.length;
  if (!Number.isInteger(shift) || shift < 0 || shift > 56) return null;
  const digits = BigInt(whole + fraction) * 10n ** BigInt(shift);
  return sign === "-" ? -digits : digits;
}

function addsUp(lines: ActivityCharge[], total: number | string | null | undefined): boolean {
  const expected = scaledAmount(total ?? 0);
  if (expected === null) return false;
  let sum = 0n;
  for (const line of lines) {
    const amount = scaledAmount(line.amount);
    if (amount === null) return false;
    sum += amount;
  }
  return sum === expected;
}

/**
 * The activity's stored fee and tax lines, or `null` when it has none or they
 * no longer add up to its totals (an older app on a synced device can change
 * a total without touching the lines).
 */
export function getActivityChargeLines(activity: ChargeTotals): ActivityChargeLines | null {
  const raw = activity.metadata?.[CHARGES_METADATA_KEY];
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isChargeLine)) return null;
  const fee = raw.filter((line) => line.category === "fee");
  const tax = raw.filter((line) => line.category === "tax");
  if (!addsUp(fee, activity.fee) || !addsUp(tax, activity.tax)) return null;
  return { fee, tax };
}
