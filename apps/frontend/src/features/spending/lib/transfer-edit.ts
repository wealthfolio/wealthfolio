import { getEffectiveCashActivityType } from "./constants";
import { attachTransferCounterpart } from "@/pages/activity/utils/transfer-counterpart";
import { ActivityType } from "@/lib/constants";
import type { Account, ActivityDetails } from "@/lib/types";
import type { TransactionRowVM } from "./transactions-helpers";

/**
 * Map a spending row to the `ActivityForm` shape. Kept out of the component so
 * it can be exercised without mounting the whole tab.
 */
export function toActivityDetails(
  row: TransactionRowVM,
  account?: Account,
): Partial<ActivityDetails> {
  const activity = row.activity;
  const activityType = getEffectiveCashActivityType(activity);
  return {
    id: activity.id,
    activityType: activityType as ActivityType,
    subtype: activity.subtype ?? null,
    status: activity.status,
    date: new Date(activity.activityDate),
    quantity: activity.quantity ?? null,
    unitPrice: activity.unitPrice ?? null,
    amount: activity.amount ?? null,
    fee: activity.fee ?? null,
    currency: activity.currency,
    needsReview: activity.needsReview,
    comment: activity.notes ?? undefined,
    fxRate: activity.fxRate ?? null,
    createdAt: new Date(activity.createdAt),
    updatedAt: new Date(activity.updatedAt),
    accountId: activity.accountId,
    accountName: account?.name ?? activity.accountId,
    accountCurrency: account?.currency ?? activity.currency,
    assetId: activity.assetId ?? "",
    assetSymbol: activity.assetId ?? "",
    sourceSystem: activity.sourceSystem,
    sourceRecordId: activity.sourceRecordId,
    sourceGroupId: activity.sourceGroupId,
    idempotencyKey: activity.idempotencyKey,
    importRunId: activity.importRunId,
    isUserModified: activity.isUserModified,
    metadata: activity.metadata,
  };
}

/**
 * Build the `ActivityForm` payload for a transfer row, resolving the pair so
 * the dialog pre-fills the counterpart account (wealthfolio/wealthfolio#1563).
 */
export async function resolveTransferFormActivity(
  row: TransactionRowVM,
  account?: Account,
): Promise<Partial<ActivityDetails>> {
  return attachTransferCounterpart(toActivityDetails(row, account));
}
