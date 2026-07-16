import { getTransferPairForActivity } from "@/adapters";
import { ActivityType } from "@/lib/constants";
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
