import { getTransferPairForActivity } from "@/adapters";
import { chargeLinesForCopy } from "@/lib/activity-charges";
import { isSecuritiesTransfer } from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { generateId } from "@/lib/id";
import type { ActivityCreate, ActivityDetails } from "@/lib/types";
import { isSameAccountCashFxConversion } from "../components/transfer-link-utils";
import { isLinkedInternalTransfer } from "./transfer-counterpart";

/** Resolve the whole exchange even when its other leg is on another page. */
export async function buildSameAccountFxDuplicate(activity: ActivityDetails) {
  if (
    !isLinkedInternalTransfer(activity) ||
    isSecuritiesTransfer(activity.activityType, activity.assetSymbol, activity.assetId)
  ) {
    return null;
  }
  const pair = await getTransferPairForActivity(activity.id);
  // A group that resolves to no pair (a broken link, or broker legs sharing a
  // provider group) is not a pair anywhere else either: duplicate the leg.
  if (!pair) return null;
  if (![pair.transferOut.id, pair.transferIn.id].includes(activity.id)) {
    throw new Error("Cannot duplicate an unresolved transfer pair.");
  }
  if (!isSameAccountCashFxConversion(pair.transferOut, pair.transferIn)) return null;

  const sourceGroupId = generateId("wf-transfer");
  const activityDate = new Date();
  return [pair.transferOut, pair.transferIn].map(
    (leg, index) =>
      ({
        idempotencyKey: generateId("manual-duplicate"),
        sourceGroupId,
        accountId: leg.accountId,
        activityType: index === 0 ? ActivityType.TRANSFER_OUT : ActivityType.TRANSFER_IN,
        activityDate,
        amount: leg.amount,
        currency: leg.currency,
        fee: leg.fee,
        tax: leg.tax,
        fxRate: leg.fxRate,
        comment: leg.notes,
        // Each leg keeps its fee and tax lines while they still add up to its totals.
        metadata: { flow: { is_external: false }, ...chargeLinesForCopy(leg) },
      }) satisfies ActivityCreate,
  );
}
