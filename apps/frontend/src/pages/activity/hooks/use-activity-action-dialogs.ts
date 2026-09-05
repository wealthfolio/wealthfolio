import {
  getExchangePairForActivity,
  getTransferPairForActivity,
  searchActivities,
} from "@/adapters";
import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { useCallback, useState } from "react";
import { useActivityMutations } from "./use-activity-mutations";

function isInternalTransfer(activity: ActivityDetails): boolean {
  return (
    (activity.activityType === ActivityType.TRANSFER_IN ||
      activity.activityType === ActivityType.TRANSFER_OUT) &&
    !!activity.sourceGroupId &&
    ((activity.metadata?.flow as { is_external?: boolean } | undefined)?.is_external ?? false) !==
      true
  );
}

function isInternalExchange(activity: ActivityDetails): boolean {
  return (
    activity.activityType === ActivityType.ADJUSTMENT &&
    (activity.subtype === ACTIVITY_SUBTYPES.EXCHANGE_OUT ||
      activity.subtype === ACTIVITY_SUBTYPES.EXCHANGE_IN) &&
    !!activity.sourceGroupId
  );
}

export function useActivityActionDialogs() {
  const [selectedActivity, setSelectedActivity] = useState<Partial<ActivityDetails> | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const { deleteActivityMutation, duplicateActivityMutation } = useActivityMutations();
  const { mutateAsync: deleteActivity, isPending: isDeleting } = deleteActivityMutation;
  const { mutateAsync: duplicateActivityAsync } = duplicateActivityMutation;

  const openForm = useCallback(async (activity?: ActivityDetails, activityType?: ActivityType) => {
    if (activity?.id && isInternalTransfer(activity)) {
      try {
        const pair = await getTransferPairForActivity(activity.id);
        const counterpart =
          activity.activityType === ActivityType.TRANSFER_IN ? pair.transferOut : pair.transferIn;

        setSelectedActivity({
          ...activity,
          transferOutId: pair.transferOut.id,
          transferInId: pair.transferIn.id,
          counterpartActivityId: counterpart.id,
          counterpartAccountId: counterpart.accountId,
          counterpartAmount: counterpart.amount ?? null,
          counterpartCurrency: counterpart.currency,
          counterpartFxRate: pair.transferIn.fxRate ?? null,
        });
        setFormOpen(true);
        return;
      } catch {
        // Fall back to single-leg editing for invalid groups.
      }
    }

    if (activity?.id && isInternalExchange(activity)) {
      try {
        const pair = await getExchangePairForActivity(activity.id);
        const isOut = activity.subtype === ACTIVITY_SUBTYPES.EXCHANGE_OUT;
        const counterpart = isOut ? pair.exchangeIn : pair.exchangeOut;

        // The pair response returns raw Activity rows (no joined asset symbol),
        // so look up the counterpart's full details separately for its symbol.
        const counterpartSearch = await searchActivities(
          1,
          1,
          { activityIds: [counterpart.id] },
          "",
        );
        const counterpartDetails = counterpartSearch.data[0];

        setSelectedActivity({
          ...activity,
          exchangeOutId: isOut ? activity.id : counterpart.id,
          exchangeInId: isOut ? counterpart.id : activity.id,
          counterpartActivityId: counterpart.id,
          counterpartAssetId: counterpart.assetId ?? null,
          counterpartAssetSymbol: counterpartDetails?.assetSymbol ?? null,
          counterpartQuantity: counterpart.quantity ?? null,
          counterpartCurrency: counterpart.currency,
          counterpartFee: counterpart.fee ?? null,
          counterpartActivityDate: counterpart.activityDate ?? null,
        });
        setFormOpen(true);
        return;
      } catch {
        // Fall back to single-leg editing for invalid groups.
      }
    }

    setSelectedActivity(activity ?? { activityType });
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setSelectedActivity(undefined);
  }, []);

  const requestDelete = useCallback((activity: ActivityDetails) => {
    setSelectedActivity(activity);
    setDeleteDialogOpen(true);
  }, []);

  const cancelDelete = useCallback(() => {
    setDeleteDialogOpen(false);
    setSelectedActivity(undefined);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!selectedActivity?.id) return;
    await deleteActivity(selectedActivity.id);
    setDeleteDialogOpen(false);
    setSelectedActivity(undefined);
  }, [deleteActivity, selectedActivity?.id]);

  const duplicateActivity = useCallback(
    async (activity: ActivityDetails) => {
      await duplicateActivityAsync(activity);
    },
    [duplicateActivityAsync],
  );

  return {
    selectedActivity,
    formOpen,
    deleteDialogOpen,
    isDeleting,
    openForm,
    closeForm,
    requestDelete,
    cancelDelete,
    confirmDelete,
    duplicateActivity,
  };
}
