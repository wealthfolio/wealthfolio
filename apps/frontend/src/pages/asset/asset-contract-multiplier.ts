/**
 * Contract multiplier metadata, mirroring the Rust resolver in
 * `crates/core/src/assets/assets_model.rs`.
 *
 * Two keys hold a multiplier, mirroring the two position shapes the broker
 * contract defines:
 * - `metadata.option.multiplier` — options, bundled with the contract spec
 * - `metadata.contractMultiplier` — everything else (futures, CFDs, bonds)
 *
 * For options the nested value wins, but only when the whole `OptionSpec`
 * deserializes: its fields are non-`Option` in Rust with no serde defaults, so
 * the parse is all-or-nothing and a partial spec silently falls through to the
 * top-level key.
 */

const CONTRACT_MULTIPLIER_KEY = "contractMultiplier";

/** Fields Rust requires on `OptionSpec` besides `multiplier` itself. */
const OPTION_CONTRACT_FIELDS = ["underlyingAssetId", "expiration", "right", "strike"] as const;

export const OPTION_INSTRUMENT_TYPE = "OPTION";

type Metadata = Record<string, unknown>;

function asObject(value: unknown): Metadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Metadata;
}

/**
 * Accepts numbers and numeric strings, matching the Rust reader which tries
 * `as_f64()` then falls back to parsing a string.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 100 for options, 1 for everything else. */
export function instrumentDefaultMultiplier(instrumentType?: string | null): number {
  return instrumentType === OPTION_INSTRUMENT_TYPE ? 100 : 1;
}

/**
 * True when `metadata.option` carries every contract field Rust needs, so
 * writing `multiplier` into it produces a spec that deserializes.
 */
export function hasCompleteOptionContract(metadata: unknown): boolean {
  const option = asObject(asObject(metadata)?.option);
  if (!option) return false;
  return OPTION_CONTRACT_FIELDS.every(
    (field) => option[field] !== undefined && option[field] !== null,
  );
}

/**
 * The multiplier explicitly stored on the asset, or null when it falls back to
 * the instrument default.
 *
 * Mirrors `explicit_contract_multiplier_from_asset_metadata` — including that
 * the nested branch is *not* filtered on `> 0` while the top-level branch is.
 * Reproduced faithfully so displayed values match what valuation actually uses.
 */
export function explicitContractMultiplier(
  metadata: unknown,
  instrumentType?: string | null,
): number | null {
  const meta = asObject(metadata);
  if (!meta) return null;

  if (instrumentType === OPTION_INSTRUMENT_TYPE && hasCompleteOptionContract(meta)) {
    const nested = toNumber(asObject(meta.option)?.multiplier);
    if (nested !== null) return nested;
  }

  const topLevel = toNumber(meta[CONTRACT_MULTIPLIER_KEY]);
  return topLevel !== null && topLevel > 0 ? topLevel : null;
}

/** The effective multiplier: explicit value, else the instrument default. */
export function resolveContractMultiplier(
  metadata: unknown,
  instrumentType?: string | null,
): number {
  return (
    explicitContractMultiplier(metadata, instrumentType) ??
    instrumentDefaultMultiplier(instrumentType)
  );
}

/**
 * Returns metadata with the multiplier applied, without mutating the input.
 *
 * - complete `OptionSpec` → write `option.multiplier`, keeping the default so
 *   the spec stays deserializable (`multiplier` is a required field: removing
 *   it breaks resolution, option display and expiry handling)
 * - otherwise → write the top-level key, removing it at the instrument default
 *   so we never persist an override the asset never asked for
 */
export function applyContractMultiplier(
  metadata: Metadata,
  instrumentType: string | null | undefined,
  multiplier: number | null | undefined,
): Metadata {
  const next: Metadata = { ...metadata };
  const fallback = instrumentDefaultMultiplier(instrumentType);
  const value = multiplier != null && multiplier > 0 ? multiplier : fallback;

  if (instrumentType === OPTION_INSTRUMENT_TYPE && hasCompleteOptionContract(next)) {
    next.option = { ...(asObject(next.option) ?? {}), multiplier: value };
    // The two keys are mutually exclusive; the nested one now owns the value.
    delete next[CONTRACT_MULTIPLIER_KEY];
    return next;
  }

  if (value === fallback) {
    delete next[CONTRACT_MULTIPLIER_KEY];
  } else {
    next[CONTRACT_MULTIPLIER_KEY] = value;
  }
  return next;
}
