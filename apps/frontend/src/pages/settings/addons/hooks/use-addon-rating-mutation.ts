import i18n from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@wealthfolio/ui/components/ui/use-toast";
import { submitAddonRating, getAddonRatings } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

interface SubmitRatingParams {
  addonId: string;
  rating: number;
  review?: string;
}

export function useAddonRatingMutation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submitRatingMutation = useMutation({
    mutationFn: async ({ addonId, rating, review }: SubmitRatingParams) => {
      return submitAddonRating(addonId, rating, review);
    },
    onSuccess: () => {
      toast({
        title: i18n.t("common:notifications.rating_submitted"),
        description: i18n.t("common:notifications.thank_you_for_your_feedback"),
      });

      // Invalidate relevant queries to refresh data
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.ADDON_STORE_LISTINGS],
      });

      // Could also invalidate specific addon ratings if we had that query
      // queryClient.invalidateQueries({
      //   queryKey: ['addon-ratings', variables.addonId]
      // });
    },
    onError: (error: Error) => {
      console.error("Failed to submit rating:", error);
      toast({
        title: i18n.t("common:notifications.rating_submission_failed"),
        description: error.message || "Failed to submit rating",
        variant: "destructive",
      });
    },
  });

  return {
    submitRating: submitRatingMutation.mutate,
    submitRatingAsync: submitRatingMutation.mutateAsync,
    isSubmittingRating: submitRatingMutation.isPending,
    submitRatingError: submitRatingMutation.error,
    submitRatingData: submitRatingMutation.data,
    resetSubmitRating: submitRatingMutation.reset,
  };
}

// Optional: Hook for fetching ratings with React Query
export function useAddonRatings(addonId: string, enabled = true) {
  const query = useQuery({
    queryKey: ["addon-ratings", addonId],
    queryFn: () => getAddonRatings(addonId),
    enabled: enabled && !!addonId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });

  return query;
}
