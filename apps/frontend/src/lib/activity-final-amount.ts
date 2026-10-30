import { ActivityType, DECIMAL_PRECISION, InstrumentType } from "@/lib/constants";
import { currencyCashDigits, currencyMinorUnit, isCryptoInstrument } from "@/lib/currency-decimals";

// Mirrors Asset::contract_multiplier in assets_model.rs - the app-wide
// multiplier defaults (option 100, everything else 1). Bonds deliberately
// default to 1: provider quotes are stored as a FRACTION of par, so a
// percent-of-par default would double-apply the /100. Percent-of-par is
// opt-in per asset via explicit contractMultiplier metadata.
export function resolveActivityCashMultiplier(
  instrumentType: unknown,
  explicitMultiplier?: unknown,
): number {
  const explicit = Number(explicitMultiplier);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const normalizedType =
    typeof instrumentType === "string" ? instrumentType.trim().toUpperCase() : "";
  return normalizedType === InstrumentType.OPTION ? 100 : 1;
}

/** An exact decimal: `digits` × 10^-`scale`. */
interface ScaledDecimal {
  digits: bigint;
  scale: number;
}

/** A finite number's shortest decimal form, which is how it was entered. */
function toScaledDecimal(value: number): ScaledDecimal {
  const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const magnitude = BigInt(whole + fraction);
  const digits = value < 0 ? -magnitude : magnitude;
  return scale < 0 ? { digits: digits * 10n ** BigInt(-scale), scale: 0 } : { digits, scale };
}

/** A form value as a non-negative exact decimal; anything else counts as zero. */
function toScaledCharge(value: unknown): ScaledDecimal {
  const number = Math.abs(Number(value));
  return toScaledDecimal(Number.isFinite(number) ? number : 0);
}

function addScaled(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    digits: a.digits * 10n ** BigInt(scale - a.scale) + b.digits * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

function negateScaled({ digits, scale }: ScaledDecimal): ScaledDecimal {
  return { digits: -digits, scale };
}

/** Rounds an exact decimal half away from zero to `places`. */
function roundToScale({ digits, scale }: ScaledDecimal, places: number): ScaledDecimal {
  if (scale <= places) return { digits, scale };
  const divisor = 10n ** BigInt(scale - places);
  const magnitude = digits < 0n ? -digits : digits;
  const quotient = magnitude / divisor + (2n * (magnitude % divisor) >= divisor ? 1n : 0n);
  return { digits: digits < 0n ? -quotient : quotient, scale: places };
}

/** An exact decimal as a number, at the stored precision of 8 places. */
function toStoredNumber(value: ScaledDecimal): number {
  const { digits, scale } = roundToScale(value, DECIMAL_PRECISION);
  return Number(`${digits}e-${scale}`);
}

/**
 * The exact product of `operands` (quantity, price, multiplier) and that
 * product rounded the way `round_derived_cash` in activities_service.rs rounds
 * a calculated value. It multiplies the decimals as entered, not binary
 * floats, so a tie such as 10.005 survives and 0.3 × 3.34999999 (1.004999997)
 * is not rounded twice. A value rounds half away from zero to the currency's
 * minor unit; a crypto value stays exact, since exchanges settle past the
 * cent; a non-zero value never rounds to zero, since a zero total means units
 * received for free.
 */
function derivedValue(
  operands: number[],
  currency: unknown,
  instrumentType: unknown,
): { exact: ScaledDecimal; rounded: ScaledDecimal } {
  const exact = operands.map(toScaledDecimal).reduce(
    (total, factor) => ({
      digits: total.digits * factor.digits,
      scale: total.scale + factor.scale,
    }),
    { digits: 1n, scale: 0 },
  );
  if (isCryptoInstrument(instrumentType)) return { exact, rounded: exact };
  const rounded = roundToScale(
    exact,
    currencyCashDigits(typeof currency === "string" ? currency : undefined),
  );
  return { exact, rounded: rounded.digits === 0n && exact.digits !== 0n ? exact : rounded };
}

interface TradeCashInputs {
  activityType: ActivityType;
  instrumentType: string;
  quantity: unknown;
  unitPrice: unknown;
  fee: unknown;
  tax: unknown;
  contractMultiplier?: unknown;
  /** The activity currency, whose minor unit a calculated total rounds to. */
  currency?: unknown;
}

interface StoredTradeAmountInputs extends TradeCashInputs {
  storedAmount: unknown;
}

/**
 * Signed cash effect of a trade: negative is cash out. A BUY is always a
 * debit; a SELL whose charges exceed its proceeds is one too, which is why
 * the sign lives here rather than being re-derived per call site. Mirrors the
 * SELL reversal in economic_events.rs. The trade value is rounded before the
 * charges are added, as a statement builds it.
 */
export function calculateTradeFinalCash({
  activityType,
  instrumentType,
  quantity,
  unitPrice,
  fee,
  tax,
  contractMultiplier,
  currency,
}: TradeCashInputs): number | undefined {
  const q = Number(quantity);
  const price = Number(unitPrice);
  if (!(q > 0) || !(price > 0) || !Number.isFinite(q) || !Number.isFinite(price)) {
    return undefined;
  }

  const gross = derivedValue(
    [q, price, resolveActivityCashMultiplier(instrumentType, contractMultiplier)],
    currency,
    instrumentType,
  );
  const charges = addScaled(toScaledCharge(fee), toScaledCharge(tax));
  const cashFrom = (value: ScaledDecimal) =>
    activityType === ActivityType.BUY
      ? negateScaled(addScaled(value, charges))
      : addScaled(value, negateScaled(charges));
  const exactCash = cashFrom(gross.exact);
  const roundedCash = cashFrom(gross.rounded);
  // Readers take a SELL's direction from the exact value (isProvenNegativeSell),
  // so, as the writer does, a rounding that would turn proceeds into a debit or
  // a debit into proceeds keeps the exact value. Both stay exact decimals until
  // the direction is settled.
  const flipsDirection =
    roundedCash.digits !== 0n && roundedCash.digits < 0n !== exactCash.digits < 0n;
  return toStoredNumber(flipsDirection ? exactCash : roundedCash);
}

/**
 * The magnitude a trade's `amount` column stores. Direction is carried by the
 * activity type, so persistence only ever sees the absolute value.
 */
export function calculateTradeFinalAmount(inputs: TradeCashInputs): number | undefined {
  const cash = calculateTradeFinalCash(inputs);
  return cash === undefined ? undefined : Math.abs(cash);
}

/**
 * Whether an existing trade total must remain user-owned when an edit form
 * opens. A matching stored total follows future calculation changes; a
 * different total is authoritative until the user explicitly opts back in.
 */
export function isStoredTradeAmountCustom({
  storedAmount,
  ...cashInputs
}: StoredTradeAmountInputs): boolean {
  if (storedAmount === null || storedAmount === undefined || storedAmount === "") return false;
  const stored = Number(storedAmount);
  if (!Number.isFinite(stored)) return false;

  const calculated = calculateTradeFinalAmount(cashInputs);
  if (calculated === undefined) return true;

  // This only seeds form ownership. A total the app calculated matches the
  // calculation at the app's precision: a crypto trade's to 8 places, any
  // other within half a minor unit, which also covers totals saved unrounded
  // before calculated totals were rounded. A crypto exchange's total that
  // differs by less than a cent stays the user's.
  const currency = typeof cashInputs.currency === "string" ? cashInputs.currency : undefined;
  const tolerance = isCryptoInstrument(cashInputs.instrumentType)
    ? 1e-8
    : currencyMinorUnit(currency) / 2;
  return Math.abs(stored - calculated) > tolerance;
}

interface IncomeCashInputs {
  quantity: unknown;
  unitPrice: unknown;
  instrumentType?: unknown;
  contractMultiplier?: unknown;
  /** The activity currency, whose minor unit the calculated value rounds to. */
  currency?: unknown;
}

export function calculateIncomeFinalAmount({
  quantity,
  unitPrice,
  instrumentType,
  contractMultiplier,
  currency,
}: IncomeCashInputs): number | undefined {
  const q = Number(quantity);
  const price = Number(unitPrice);
  if (!(q > 0) || !(price > 0) || !Number.isFinite(q) || !Number.isFinite(price)) {
    return undefined;
  }
  // Mirrors calculate_composite_final_cash (economic_events.rs) with the
  // multiplier defaults from Asset::contract_multiplier (assets_model.rs), which
  // includes the asset's unit multiplier, rounded as the writer rounds it.
  return toStoredNumber(
    derivedValue(
      [q, price, resolveActivityCashMultiplier(instrumentType, contractMultiplier)],
      currency,
      instrumentType,
    ).rounded,
  );
}
