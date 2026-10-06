import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { useCallback, useState } from "react";
import { attachTransferCounterpart, isLinkedInternalTransfer } from "../utils/transfer-counterpart";
import { useActivityMutations } from "./use-activity-mutations";

export function useActivityActionDialogs() {
  const [selectedActivity, setSelectedActivity] = useState<Partial<ActivityDetails> | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const { deleteActivityMutation, duplicateActivityMutation } = useActivityMutations();
  const { mutateAsync: deleteActivity, isPending: isDeleting } = deleteActivityMutation;
  const { mutateAsync: duplicateActivityAsync } = duplicateActivityMutation;

  const openForm = useCallback(async (activity?: ActivityDetails, activityType?: ActivityType) => {
    if (activity?.id && isLinkedInternalTransfer(activity)) {
      setSelectedActivity(await attachTransferCounterpart(activity));
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
