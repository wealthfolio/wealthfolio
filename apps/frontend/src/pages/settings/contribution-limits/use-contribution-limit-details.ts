import { getContributionLimitDetails, setContributionActivityExcluded } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useTranslation } from "react-i18next";

export function useContributionLimitDetails(limitId: string) {
  return useQuery({
    queryKey: [QueryKeys.CONTRIBUTION_LIMIT_DETAILS, limitId],
    queryFn: () => getContributionLimitDetails(limitId),
    enabled: !!limitId,
  });
}

interface ExclusionUpdate {
  activityId: string;
  excluded: boolean;
}

export function useContributionActivityExclusion(limitId: string) {
  const client = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: ({ activityId, excluded }: ExclusionUpdate) =>
      setContributionActivityExcluded(limitId, activityId, excluded),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [QueryKeys.CONTRIBUTION_LIMIT_DETAILS, limitId] }),
        client.invalidateQueries({ queryKey: [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS] }),
      ]);
      toast({ description: t("settings:limits_detail.save_success"), variant: "success" });
    },
    onError: () => {
      toast({ description: t("settings:limits_detail.save_error"), variant: "destructive" });
    },
  });
}
