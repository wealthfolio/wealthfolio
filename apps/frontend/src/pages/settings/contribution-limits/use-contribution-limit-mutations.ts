import i18n from "i18next";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  deleteContributionLimit,
  createContributionLimit,
  updateContributionLimit,
  calculateDepositsForLimit,
} from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { ContributionLimit, NewContributionLimit, DepositsCalculation } from "@/lib/types";
import { logger } from "@/adapters";

export const useContributionLimitProgress = (limitId: string) => {
  return useQuery<DepositsCalculation>({
    queryKey: [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, limitId],
    queryFn: async () => {
      try {
        return await calculateDepositsForLimit(limitId);
      } catch (e) {
        logger.error(`Error calculating deposits for limit: ${String(e)}`);
        toast({
          title: i18n.t("common:notifications.error_calculating_deposits"),
          description: i18n.t("common:notifications.deposit_calculation_error_description"),
          variant: "destructive",
        });
        throw e;
      }
    },
  });
};

export const useContributionLimitMutations = () => {
  const queryClient = useQueryClient();

  const handleSuccess = (message: string, limit?: ContributionLimit) => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.CONTRIBUTION_LIMITS] });
    queryClient.invalidateQueries({
      queryKey: [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, limit?.accountIds, limit?.contributionYear],
    });
    toast({
      description: message,
      variant: "success",
    });
  };

  const handleError = (action: "add" | "update" | "delete") => {
    toast({
      title: i18n.t("settings:settings_update_error_title"),
      description: i18n.t(`settings:messages.contribution.${action}Failed`),
      variant: "destructive",
    });
  };

  const addContributionLimitMutation = useMutation({
    mutationFn: createContributionLimit,
    onSuccess: (limit) => handleSuccess(i18n.t("settings:messages.contribution.added"), limit),
    onError: (e) => {
      logger.error(`Error adding contribution limit: ${String(e)}`);
      handleError("add");
    },
  });

  const updateContributionLimitMutation = useMutation({
    mutationFn: (params: { id: string; updatedLimit: NewContributionLimit }) =>
      updateContributionLimit(params.id, params.updatedLimit),
    onSuccess: (limit) => handleSuccess(i18n.t("settings:messages.contribution.updated"), limit),
    onError: (e) => {
      logger.error(`Error updating contribution limit: ${String(e)}`);
      handleError("update");
    },
  });

  const deleteContributionLimitMutation = useMutation({
    mutationFn: deleteContributionLimit,
    onSuccess: () => handleSuccess(i18n.t("settings:messages.contribution.deleted"), undefined),
    onError: (e) => {
      logger.error(`Error deleting contribution limit: ${String(e)}`);
      handleError("delete");
    },
  });

  return {
    deleteContributionLimitMutation,
    addContributionLimitMutation,
    updateContributionLimitMutation,
  };
};
