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

export function chargeLinesAddUp(
  lines: readonly { amount?: number | string | null }[],
  total: number | string | null | undefined,
): boolean {
  const expected = scaledAmount(total ?? 0);
  if (expected === null) return false;
  let sum = 0n;
  for (const line of lines) {
    const amount = scaledAmount(line.amount ?? 0);
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
  if (!chargeLinesAddUp(fee, activity.fee) || !chargeLinesAddUp(tax, activity.tax)) return null;
  return { fee, tax };
}

/** Scale of `scaledAmount`'s fixed-point integers. */
const SCALE = 28;

function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, -SCALE);
  const fraction = digits.slice(-SCALE).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** A fee or tax line as an activity form edits it. */
export interface ChargeLineValue {
  label: string;
  amount?: number | null;
}

/** A stored line as a form opens it, with its amount. */
type StoredChargeLine = ChargeLineValue & { amount: number };

/** Form fields that hold an activity's fee and tax lines. */
export interface ChargeLineFormValues {
  feeLines?: ChargeLineValue[];
  taxLines?: ChargeLineValue[];
  /** The activity was opened with lines, so saving none clears them. */
  hadChargeLines?: boolean;
  /** The stored lines can't be edited in this form, which leaves them alone. */
  chargeLinesLocked?: boolean;
}

export type ChargeCategory = ActivityCharge["category"];

/**
 * The exact sum of the lines' amounts, which becomes the total they break
 * down. Adding the amounts as floats could store a total such as
 * 0.30000000000000004 that core then finds doesn't match "0.1" and "0.2".
 */
export function sumChargeLines(lines: readonly ChargeLineValue[]): number {
  let sum = 0n;
  for (const line of lines) {
    if (line.amount == null) continue;
    const amount = scaledAmount(line.amount);
    if (amount === null) return Number.NaN;
    sum += amount;
  }
  return Number(formatScaled(sum));
}

/**
 * The fee and tax lines an activity form starts with. A form that can't show
 * every stored line (a fee line on a form with only a tax field, or a rebate,
 * which a money input can't hold) is locked, so it leaves them as they are.
 */
export function chargeLineDefaults(
  activity: ChargeTotals | undefined,
  categories: readonly ChargeCategory[],
): ChargeLineFormValues & { feeLines?: StoredChargeLine[]; taxLines?: StoredChargeLine[] } {
  // A breakdown must cover both totals, including any a form cannot show.
  if (
    (["fee", "tax"] as const).some((key) => !categories.includes(key) && Number(activity?.[key]))
  ) {
    return { chargeLinesLocked: true };
  }
  const raw = activity?.metadata?.[CHARGES_METADATA_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return {};
  const lines = getActivityChargeLines(activity ?? {});
  // Stale lines aren't shown anywhere; saving a changed total drops them.
  if (!lines) return {};
  const all = [...lines.fee, ...lines.tax];
  const totalsEditable = (["fee", "tax"] as const).every(
    (key) => scaledAmount(Number(activity?.[key] ?? 0)) === scaledAmount(activity?.[key] ?? 0),
  );
  const editable =
    totalsEditable &&
    all.every((line) => {
      const amount = Number(line.amount);
      return (
        categories.includes(line.category) &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        scaledAmount(amount) === scaledAmount(line.amount)
      );
    });
  if (!editable) return { chargeLinesLocked: true };
  const toValue = (line: ActivityCharge): StoredChargeLine => ({
    label: line.label,
    amount: Number(line.amount),
  });
  return {
    feeLines: lines.fee.map(toValue),
    taxLines: lines.tax.map(toValue),
    hadChargeLines: true,
  };
}

/**
 * The metadata patch that saves the form's lines: the lines, `null` to clear
 * lines the activity was opened with, or nothing to leave them to core's rule
 * (kept while the totals don't change, dropped when one does).
 */
export function chargeLinesMetadata(
  values: ChargeLineFormValues,
): { [CHARGES_METADATA_KEY]: ActivityCharge[] | null } | undefined {
  if (values.chargeLinesLocked) return undefined;
  const toCharge =
    (category: ChargeCategory) =>
    (line: ChargeLineValue): ActivityCharge => ({
      category,
      label: line.label.trim(),
      amount: String(line.amount ?? 0),
    });
  const charges = [
    ...(values.feeLines ?? []).map(toCharge("fee")),
    ...(values.taxLines ?? []).map(toCharge("tax")),
  ];
  if (charges.length > 0) return { [CHARGES_METADATA_KEY]: charges };
  return values.hadChargeLines ? { [CHARGES_METADATA_KEY]: null } : undefined;
}
