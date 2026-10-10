import { ActivityType } from "@/lib/constants";
import type { PickerActivityType } from "../config/activity-form-config";

const PURE_CASH_ACTIVITY_TYPES: readonly string[] = [
  ActivityType.FX_EXCHANGE,
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.FEE,
  ActivityType.INTEREST,
  ActivityType.TAX,
  ActivityType.CREDIT,
];

/**
 * Maps a database activity type to the picker activity type.
 * TRANSFER_IN/TRANSFER_OUT are merged into TRANSFER for the picker UI.
 */
export function mapActivityTypeToPicker(
  activityType?: string | null,
): PickerActivityType | undefined {
  if (!activityType) return undefined;
  if (activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT) {
    return "TRANSFER";
  }
  return activityType as PickerActivityType;
}

/**
 * Checks if the activity type is a pure cash activity (no asset involved).
 * Used to determine if account currency should be included in payload.
 */
export function isPureCashActivity(activityType: string): boolean {
  return PURE_CASH_ACTIVITY_TYPES.includes(activityType);
}
