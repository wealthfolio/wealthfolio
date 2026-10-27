import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import type { PickerActivityType } from "../config/activity-form-config";

const PURE_CASH_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.FEE,
  ActivityType.INTEREST,
  ActivityType.TAX,
  ActivityType.CREDIT,
];

/**
 * Maps a database activity type to the picker activity type.
 * TRANSFER_IN/TRANSFER_OUT are merged into TRANSFER for the picker UI, and a
 * conversion's ADJUSTMENT rows into CONVERSION.
 */
export function mapActivityTypeToPicker(
  activityType?: string | null,
  subtype?: string | null,
): PickerActivityType | undefined {
  if (!activityType) return undefined;
  if (activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT) {
    return "TRANSFER";
  }
  if (activityType === ActivityType.ADJUSTMENT && isConversionSubtype(subtype)) {
    return "CONVERSION";
  }
  return activityType as PickerActivityType;
}

/** Whether a subtype names a row of a conversion. */
export function isConversionSubtype(subtype?: string | null): boolean {
  const normalized = subtype?.trim().toUpperCase().replace(/[\s-]/g, "_");
  return (
    normalized === ACTIVITY_SUBTYPES.CONVERSION_OUT ||
    normalized === ACTIVITY_SUBTYPES.CONVERSION_IN
  );
}

/**
 * Checks if the activity type is a pure cash activity (no asset involved).
 * Used to determine if account currency should be included in payload.
 */
export function isPureCashActivity(activityType: string): boolean {
  return PURE_CASH_ACTIVITY_TYPES.includes(activityType);
}
