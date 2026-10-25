import { ActivityType } from "@/lib/constants";
import { getEffectiveType } from "@/lib/types";
import { normalizeCurrency } from "@/lib/utils";

export interface TransferLinkActivityLike {
  accountId: string;
  activityType: string;
  activityTypeOverride?: string | null;
  amount?: string | number | null;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  currency: string;
  assetId?: string | null;
  assetSymbol?: string | null;
}

const CASH_SYMBOL_PATTERN = /^\$?CASH[-_:][A-Z]{3}$/;

function isCashPlaceholder(value: string): boolean {
  return CASH_SYMBOL_PATTERN.test(value.trim().toUpperCase());
}

export function nonCashTransferAssetKey(activity: TransferLinkActivityLike): string | undefined {
  const assetId = activity.assetId?.trim();
  if (assetId) {
    const key = assetId.toUpperCase();
    return isCashPlaceholder(key) ? undefined : key;
  }

  const symbol = activity.assetSymbol?.trim();
  if (!symbol) return undefined;
  const key = symbol.toUpperCase();
  if (key === "CASH" || isCashPlaceholder(key)) return undefined;
  return key;
}

export function hasPositiveCashAmount(activity: TransferLinkActivityLike): boolean {
  const amount = Number(activity.amount);
  return Number.isFinite(amount) && Math.abs(amount) > 0;
}

export function isSameAccountCashFxConversion(
  first: TransferLinkActivityLike,
  second: TransferLinkActivityLike,
): boolean {
  const hasTransferPair =
    (first.activityType === ActivityType.TRANSFER_IN &&
      second.activityType === ActivityType.TRANSFER_OUT) ||
    (first.activityType === ActivityType.TRANSFER_OUT &&
      second.activityType === ActivityType.TRANSFER_IN);

  return (
    hasTransferPair &&
    first.accountId === second.accountId &&
    !nonCashTransferAssetKey(first) &&
    !nonCashTransferAssetKey(second) &&
    hasPositiveCashAmount(first) &&
    hasPositiveCashAmount(second) &&
    // Core stores a minor unit (GBX, ZAc) as its major currency, so GBX and
    // GBP are one currency here as they are once saved.
    normalizeCurrency(first.currency) !== normalizeCurrency(second.currency)
  );
}

/** A cash deposit or withdrawal, which "Make it a transfer…" can pair with another account. */
export function canConvertToTransfer(activity: TransferLinkActivityLike): boolean {
  const type = getEffectiveType(activity);
  return (
    (type === ActivityType.DEPOSIT || type === ActivityType.WITHDRAWAL) &&
    !nonCashTransferAssetKey(activity)
  );
}
