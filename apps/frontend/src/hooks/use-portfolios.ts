import i18n from "i18next";
import { createPortfolio, deletePortfolio, getPortfolios, updatePortfolioEntry } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import type { NewPortfolio, PortfolioWithAccounts } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

export function usePortfolios() {
  return useQuery<PortfolioWithAccounts[], Error>({
    queryKey: [QueryKeys.PORTFOLIOS],
    queryFn: getPortfolios,
  });
}

export function usePortfolioMutations() {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PORTFOLIOS] });
    invalidatePerformanceCaches(queryClient);
  };

  const createMutation = useMutation({
    mutationFn: (portfolio: NewPortfolio) => createPortfolio(portfolio),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.portfolio_created_successfully"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_create_portfolio")),
  });

  const updateMutation = useMutation({
    mutationFn: (portfolio: PortfolioWithAccounts) => updatePortfolioEntry(portfolio),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.portfolio_updated_successfully"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_update_portfolio")),
  });

  const deleteMutation = useMutation({
    mutationFn: (portfolioId: string) => deletePortfolio(portfolioId),
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t("common:notifications.portfolio_deleted_successfully"));
    },
    onError: () => toast.error(i18n.t("common:notifications.failed_to_delete_portfolio")),
  });

  return { createMutation, updateMutation, deleteMutation };
}
