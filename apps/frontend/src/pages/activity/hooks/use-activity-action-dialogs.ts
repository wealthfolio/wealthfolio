import { getTransferPairForActivity } from "@/adapters";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { useCallback, useState } from "react";
import { useActivityMutations } from "./use-activity-mutations";

export function isInternalTransfer(activity: Partial<ActivityDetails>): boolean {
  return (
    (activity.activityType === ActivityType.TRANSFER_IN ||
      activity.activityType === ActivityType.TRANSFER_OUT) &&
    !!activity.sourceGroupId &&
    ((activity.metadata?.flow as { is_external?: boolean } | undefined)?.is_external ?? false) !==
      true
  );
}

/**
 * Attaches the paired leg so the transfer form can show both accounts.
 * Returns the activity unchanged when the pair cannot be resolved.
 */
export async function withTransferPair(
  activity: Partial<ActivityDetails>,
): Promise<Partial<ActivityDetails>> {
  if (!activity.id) return activity;
  try {
    const pair = await getTransferPairForActivity(activity.id);
    if (!pair) return activity;
    const counterpart =
      activity.activityType === ActivityType.TRANSFER_IN ? pair.transferOut : pair.transferIn;
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
  } catch {
    // Fall back to single-leg editing for invalid groups.
    return activity;
  }
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
      setSelectedActivity(await withTransferPair(activity));
      setFormOpen(true);
      return;
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
