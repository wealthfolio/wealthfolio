import type {
  HistoryChartMarkerTone,
  HistoryChartMarkerVariant,
} from "@/components/history-chart-marker";
import { isAssetBackedIncomeActivity, isSecuritiesTransfer } from "@/lib/activity-utils";
import { ActivityTypeNames } from "@/lib/constants";
import { ActivityDetails, ActivityType } from "@/lib/types";

export type AssetActivityMarkerVariant = Exclude<HistoryChartMarkerVariant, "snapshot">;

export const ASSET_MARKER_ACTIVITY_TYPES = [
  ActivityType.BUY,
  ActivityType.SELL,
  ActivityType.SPLIT,
  ActivityType.DIVIDEND,
  ActivityType.INTEREST,
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
  ActivityType.ADJUSTMENT,
] as const;

export function isAssetMarkerActivity(activity: ActivityDetails, assetId: string) {
  if (activity.assetId !== assetId) {
    return false;
  }

  switch (activity.activityType) {
    case ActivityType.BUY:
    case ActivityType.SELL:
    case ActivityType.SPLIT:
    case ActivityType.ADJUSTMENT:
      return true;
    case ActivityType.TRANSFER_IN:
    case ActivityType.TRANSFER_OUT:
      return isSecuritiesTransfer(activity.activityType, activity.assetSymbol, activity.assetId);
    case ActivityType.DIVIDEND:
    case ActivityType.INTEREST:
      return isAssetBackedIncomeActivity(
        activity.activityType,
        activity.assetSymbol,
        activity.assetId,
      );
    default:
      return false;
  }
}

export function activityMarkerVariant(activityType: ActivityType): AssetActivityMarkerVariant {
  if (activityType === ActivityType.BUY) return "buy";
  if (activityType === ActivityType.SELL) return "sell";
  if (activityType === ActivityType.SPLIT) return "split";
  return "activity";
}

export function activityMarkerLabel(activityType: ActivityType) {
  if (activityType === ActivityType.SPLIT) return "SP";
  if (activityType === ActivityType.ADJUSTMENT) return "AD";
  return (ActivityTypeNames[activityType] ?? activityType).charAt(0).toUpperCase();
}

export function activityMarkerTone(activityType: ActivityType): HistoryChartMarkerTone {
  switch (activityType) {
    case ActivityType.DIVIDEND:
    case ActivityType.INTEREST:
      return "info";
    case ActivityType.BUY:
    case ActivityType.DEPOSIT:
    case ActivityType.TRANSFER_IN:
      return "success";
    case ActivityType.SELL:
    case ActivityType.WITHDRAWAL:
    case ActivityType.TRANSFER_OUT:
    case ActivityType.FEE:
    case ActivityType.TAX:
      return "destructive";
    case ActivityType.SPLIT:
      return "warning";
    case ActivityType.ADJUSTMENT:
      return "secondary";
    default:
      return "default";
  }
}
