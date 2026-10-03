import { getTransferPairForActivity } from "@/adapters";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails, InternalTransferPairResponse } from "@/lib/types";

/**
 * A linked internal transfer leg only knows its counterpart once the pair has
 * been resolved. Callers that open the edit form from a bare activity (the
 * Spending tab) must enrich it first, or `TransferForm` renders an empty
 * "To Account" and the save rejects as unpaired — see
 * wealthfolio/wealthfolio#1563.
 *
 * Read-only and total: anything that is not a linked internal transfer is
 * returned unchanged, and so is a leg whose pair cannot be resolved.
 */
export async function attachTransferCounterpart(
  activity: Partial<ActivityDetails>,
): Promise<Partial<ActivityDetails>> {
  if (!activity.id || !isLinkedInternalTransfer(activity)) {
    return activity;
  }

  let pair: InternalTransferPairResponse | null;
  try {
    pair = await getTransferPairForActivity(activity.id);
  } catch {
    // Orphaned/invalid groups resolve to null or throw. Fall back to
    // single-leg editing, matching the behavior before this helper.
    return activity;
  }
  if (!pair?.transferOut?.id || !pair?.transferIn?.id) {
    return activity;
  }

  // The backend only ever returns the pair that contains this leg, and the
  // edited `activityType` is already the effective type, so these two checks
  // are belt-and-braces: they keep malformed data from producing a form whose
  // two accounts are the row itself. The counterpart mirrors the form's own
  // direction rule so the two can never disagree.
  const isPairMember = pair.transferOut.id === activity.id || pair.transferIn.id === activity.id;
  const counterpart =
    activity.activityType === ActivityType.TRANSFER_IN ? pair.transferOut : pair.transferIn;
  if (!isPairMember || counterpart.id === activity.id) {
    return activity;
  }

  return {
    ...activity,
    transferOutId: pair.transferOut.id,
    transferInId: pair.transferIn.id,
    counterpartActivityId: counterpart.id,
    counterpartAccountId: counterpart.accountId,
    counterpartAmount: counterpart.amount ?? null,
    counterpartCurrency: counterpart.currency,
    counterpartFxRate: pair.transferIn.fxRate ?? null,
  };
}

/**
 * A transfer leg that is grouped and not explicitly external — i.e. one that
 * can have a counterpart to resolve. Mirrors the guard the original
 * Investments-path merge used.
 */
function isLinkedInternalTransfer(activity: Partial<ActivityDetails>): boolean {
  const isTransfer =
    activity.activityType === ActivityType.TRANSFER_IN ||
    activity.activityType === ActivityType.TRANSFER_OUT;
  if (!isTransfer || !activity.sourceGroupId) {
    return false;
  }

  const flow = activity.metadata?.flow as { is_external?: boolean } | undefined;
  return flow?.is_external !== true;
}
