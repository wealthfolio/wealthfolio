/**
 * Bond spec metadata, stored under `metadata.bond` and mirroring `BondSpec` in
 * `crates/core/src/assets/assets_model.rs`.
 *
 * Unlike `OptionSpec`, every `BondSpec` field is `Option<T>` in Rust and the
 * struct derives `Default`, so a partially-filled object still deserializes.
 * Fields can therefore be written independently without risking the spec.
 *
 * `faceValue` is deliberately not exposed: it cancels out of the Treasury
 * calculation (`price / face_value`), so editing it would change nothing.
 */

import { formatDateISO, parseLocalDate } from "@/lib/utils";

export const BOND_INSTRUMENT_TYPE = "BOND";

/**
 * Frequencies the yield-curve pricer understands. Anything else silently falls
 * through to semi-annual, so offering e.g. MONTHLY would quietly mislead.
 */
export const COUPON_FREQUENCIES = ["ANNUAL", "SEMI_ANNUAL", "QUARTERLY", "ZERO"] as const;

export type CouponFrequency = (typeof COUPON_FREQUENCIES)[number];

type Metadata = Record<string, unknown>;

export interface BondSpecFormValues {
  maturityDate: Date | null;
  /** Percent as shown to the user, e.g. 4.375 for a 4.375% coupon. */
  couponRate: number | null;
  couponFrequency: string;
}

function asObject(value: unknown): Metadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Metadata;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Reads the stored spec into form values.
 *
 * The coupon rate is stored as a fraction (0.04375 = 4.375%) but edited as a
 * percent, matching how the detail card displays it.
 */
export function extractBondSpec(metadata: unknown): BondSpecFormValues {
  const bond = asObject(asObject(metadata)?.bond);
  const couponRate = toNumber(bond?.couponRate);
  const maturityDate = typeof bond?.maturityDate === "string" ? bond.maturityDate : null;

  return {
    // Parse as a local date: `new Date("YYYY-MM-DD")` is treated as UTC and
    // lands on the previous day west of Greenwich.
    maturityDate: maturityDate ? parseLocalDate(maturityDate) : null,
    couponRate: couponRate !== null ? couponRate * 100 : null,
    couponFrequency: typeof bond?.couponFrequency === "string" ? bond.couponFrequency : "",
  };
}

/**
 * Returns metadata with the bond spec applied, without mutating the input.
 * Existing spec keys we do not manage (`faceValue`, `isin`) are preserved.
 */
export function applyBondSpec(metadata: Metadata, values: BondSpecFormValues): Metadata {
  const existing = asObject(metadata.bond) ?? {};
  const next: Metadata = { ...existing };

  if (values.maturityDate) {
    next.maturityDate = formatDateISO(values.maturityDate);
  } else {
    delete next.maturityDate;
  }

  // Zero is meaningful — zero-coupon T-bills are common — so only a null clears.
  if (values.couponRate != null) {
    next.couponRate = values.couponRate / 100;
  } else {
    delete next.couponRate;
  }

  if (values.couponFrequency) {
    next.couponFrequency = values.couponFrequency;
  } else {
    delete next.couponFrequency;
  }

  if (Object.keys(next).length === 0) {
    const { bond: _bond, ...rest } = metadata;
    return rest;
  }
  return { ...metadata, bond: next };
}
