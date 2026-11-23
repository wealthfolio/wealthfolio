import { useHoldings } from "@/hooks/use-holdings";
import { ActivityStatus, ActivityType, DECIMAL_PRECISION } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";

interface SellHoldingSelection {
  accountId: string;
  assetId: string;
  exchangeMic?: string | null;
  originalActivity?: Partial<ActivityDetails>;
  originalAssetId?: string;
  enabled?: boolean;
}

/** An edited sale can also dispose the units its original row already removed. */
export function useSellHoldings({
  accountId,
  assetId,
  exchangeMic,
  originalActivity,
  originalAssetId,
  enabled = true,
}: SellHoldingSelection) {
  const { holdings, isLoading, isFetching, isError, isUpdating } = useHoldings(
    { type: "account", accountId },
    { enabled },
  );
  const selectedExchange = exchangeMic?.trim().toUpperCase();
  const exactHolding = assetId
    ? holdings.find((h) => h.instrument?.id === assetId || h.id === assetId)
    : undefined;
  const symbolHoldings =
    assetId && !exactHolding
      ? holdings.filter(
          (h) =>
            h.instrument?.symbol === assetId &&
            (!selectedExchange ||
              h.instrument?.exchangeMic?.trim().toUpperCase() === selectedExchange),
        )
      : [];
  const holding = exactHolding ?? (symbolHoldings.length === 1 ? symbolHoldings[0] : undefined);
  const original = Number(originalActivity?.quantity);
  const isSameEditedHolding =
    !!originalActivity?.id &&
    originalActivity.activityType === ActivityType.SELL &&
    originalActivity.status === ActivityStatus.POSTED &&
    !!accountId &&
    accountId === originalActivity.accountId &&
    !!assetId &&
    assetId === originalAssetId;
  const availableQuantity =
    isSameEditedHolding && Number.isFinite(original)
      ? Number(((holding?.quantity ?? 0) + Math.abs(original)).toFixed(DECIMAL_PRECISION))
      : (holding?.quantity ?? 0);

  return { availableQuantity, isLoading: isLoading || isUpdating, isFetching, isError };
}
