import { ActivityType, InstrumentType } from "@/lib/constants";
import { currencyFractionDigits, currencyMinorUnit } from "@/lib/currency-decimals";
import { roundDecimal } from "@/lib/utils";

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

function isCryptoInstrument(instrumentType: unknown): boolean {
  const normalizedType =
    typeof instrumentType === "string" ? instrumentType.trim().toUpperCase() : "";
  return normalizedType === InstrumentType.CRYPTO || normalizedType === "CRYPTOCURRENCY";
}

/**
 * Rounds half away from zero. The shift goes through the decimal string so a
 * tie such as 10.005 survives binary floating point (10.005 * 100 is
 * 1000.4999...).
 */
function roundHalfAwayFromZero(value: number, places: number): number {
  const shifted = Number(`${Math.abs(value)}e${places}`);
  if (!Number.isFinite(shifted)) return value;
  const rounded = Number(`${Math.round(shifted)}e-${places}`);
  return value < 0 ? -rounded : rounded;
}

/**
 * Mirrors `derived_cash_scale` and `round_derived_cash` in
 * activities_service.rs: a calculated value rounds to the currency's minor
 * unit; a crypto trade's stays exact, since exchanges settle past the cent; a
 * non-zero value never rounds to zero, since a zero total means units received
 * for free.
 */
function roundDerivedCash(value: number, currency: unknown, instrumentType: unknown): number {
  // Eight places first clears float noise from the multiplication.
  const exact = roundDecimal(value);
  if (isCryptoInstrument(instrumentType)) return exact;
  const rounded = roundHalfAwayFromZero(
    exact,
    currencyFractionDigits(typeof currency === "string" ? currency : undefined),
  );
  return rounded === 0 && exact !== 0 ? exact : rounded;
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
  if (!(q > 0) || !(price > 0)) return undefined;

  const gross = roundDerivedCash(
    q * price * resolveActivityCashMultiplier(instrumentType, contractMultiplier),
    currency,
    instrumentType,
  );
  const charges = Math.abs(Number(fee) || 0) + Math.abs(Number(tax) || 0);
  const signed = activityType === ActivityType.BUY ? -(gross + charges) : gross - charges;
  // Round the magnitude, then re-apply the sign: roundDecimal breaks ties
  // upward, so rounding the signed value would round a debit and a credit of
  // the same size to different magnitudes.
  const magnitude = roundDecimal(Math.abs(signed));
  return signed < 0 ? -magnitude : magnitude;
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
  if (!(q > 0) || !(price > 0)) return undefined;
  // Mirrors calculate_composite_final_cash (economic_events.rs) with the
  // multiplier defaults from Asset::contract_multiplier (assets_model.rs), which
  // includes the asset's unit multiplier, rounded as the writer rounds it.
  return roundDerivedCash(
    q * price * resolveActivityCashMultiplier(instrumentType, contractMultiplier),
    currency,
    instrumentType,
  );
}
