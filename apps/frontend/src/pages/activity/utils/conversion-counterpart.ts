import { getTransferPairForActivity, logger, searchActivities } from "@/adapters";
import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import { generateId } from "@/lib/id";
import type { ActivityCreate, ActivityDetails } from "@/lib/types";
import { isConversionSubtype } from "./activity-form-utils";

/** A row of a conversion: an ADJUSTMENT with a conversion subtype and a group. */
export function isConversionActivity(activity: Partial<ActivityDetails> | undefined): boolean {
  return (
    activity?.activityType === ActivityType.ADJUSTMENT &&
    isConversionSubtype(activity.subtype) &&
    !!activity.sourceGroupId
  );
}

/**
 * When a conversion folds: at the earlier of its two rows' times (rules R7.5).
 * `undefined` when neither row's time is known.
 */
export function conversionFirstDate(activity: Partial<ActivityDetails>): Date | undefined {
  const times = [activity.date, activity.counterpartDate]
    .filter((date): date is Date | string => !!date)
    .map((date) => new Date(date).getTime());
  return times.length ? new Date(Math.min(...times)) : undefined;
}

/** Whether a conversion row is the one whose units leave. */
export function isLeavingConversionRow(activity: Partial<ActivityDetails> | undefined): boolean {
  return (
    activity?.subtype?.trim().toUpperCase().replace(/[\s-]/g, "_") ===
    ACTIVITY_SUBTYPES.CONVERSION_OUT
  );
}

/**
 * A conversion row only knows its other row once the pair is resolved: the
 * edit form shows both sides. The pair lookup answers for conversions as for
 * transfers (its outgoing side is the leaving row); a search by id adds the
 * other row's symbol. Anything that is not a conversion row, or a row whose
 * pair does not resolve, is returned unchanged.
 */
export async function attachConversionCounterpart(
  activity: Partial<ActivityDetails>,
): Promise<Partial<ActivityDetails>> {
  if (!activity.id || !isConversionActivity(activity)) {
    return activity;
  }
  try {
    const pair = await getTransferPairForActivity(activity.id);
    if (!pair) return activity;
    const counterpart = isLeavingConversionRow(activity) ? pair.transferIn : pair.transferOut;
    if (counterpart.id === activity.id) return activity;
    const found = await searchActivities(0, 1, { activityIds: [counterpart.id] }, "");
    const details = found.data[0];
    return {
      ...activity,
      counterpartActivityId: counterpart.id,
      counterpartAssetId: counterpart.assetId ?? null,
      counterpartAssetSymbol: details?.assetSymbol ?? counterpart.assetId ?? null,
      counterpartQuantity: counterpart.quantity ?? null,
      counterpartCurrency: counterpart.currency,
      counterpartDate: counterpart.activityDate,
    };
  } catch (error) {
    logger.error(`Could not load the conversion of activity ${activity.id}: ${String(error)}`);
    return activity;
  }
}

/**
 * Both rows of a conversion, copied with a new group and dated today: a
 * conversion is duplicated whole, as a same-account exchange is. `null` for
 * anything that is not a conversion row, or one whose pair does not resolve.
 */
export async function buildConversionDuplicate(
  activity: ActivityDetails,
): Promise<ActivityCreate[] | null> {
  if (!isConversionActivity(activity)) return null;
  const pair = await getTransferPairForActivity(activity.id);
  if (!pair || ![pair.transferOut.id, pair.transferIn.id].includes(activity.id)) return null;
  const sourceGroupId = generateId("wf-conversion");
  const activityDate = new Date();
  return [pair.transferOut, pair.transferIn].map(
    (row) =>
      ({
        idempotencyKey: generateId("manual-duplicate"),
        sourceGroupId,
        accountId: row.accountId,
        activityType: ActivityType.ADJUSTMENT,
        subtype: row.subtype,
        activityDate,
        quantity: row.quantity,
        currency: row.currency,
        comment: row.notes,
        asset: row.assetId ? { id: row.assetId } : undefined,
      }) satisfies ActivityCreate,
  );
}
