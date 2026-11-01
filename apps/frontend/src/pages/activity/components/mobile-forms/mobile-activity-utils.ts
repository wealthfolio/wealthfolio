import { isStoredTradeAmountCustom } from "@/lib/activity-final-amount";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";

export function getMobileActivityAssetId(activity?: Partial<ActivityDetails>): string | undefined {
  return activity?.assetSymbol?.trim() || activity?.assetId?.trim() || undefined;
}

export function hasStoredCustomTradeAmount(activity?: Partial<ActivityDetails>): boolean {
  if (
    !activity ||
    (activity.activityType !== ActivityType.BUY && activity.activityType !== ActivityType.SELL)
  ) {
    return false;
  }

  return isStoredTradeAmountCustom({
    storedAmount: activity.amount,
    activityType: activity.activityType,
    instrumentType: activity.instrumentType ?? "",
    quantity: activity.quantity,
    unitPrice: activity.unitPrice,
    fee: activity.fee,
    tax: activity.tax,
    contractMultiplier: activity.assetContractMultiplier,
    currency: activity.currency,
  });
}
