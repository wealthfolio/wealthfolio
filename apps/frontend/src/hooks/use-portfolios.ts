import { createPortfolio, deletePortfolio, getPortfolios, updatePortfolioEntry } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
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
  };

  const createMutation = useMutation({
    mutationFn: (portfolio: NewPortfolio) => createPortfolio(portfolio),
    onSuccess: () => {
      invalidate();
      toast.success("Portfolio created successfully.");
    },
    onError: () => toast.error("Failed to create portfolio."),
  });

  const updateMutation = useMutation({
    mutationFn: (portfolio: PortfolioWithAccounts) => updatePortfolioEntry(portfolio),
    onSuccess: () => {
      invalidate();
      toast.success("Portfolio updated successfully.");
    },
    onError: () => toast.error("Failed to update portfolio."),
  });

  const deleteMutation = useMutation({
    mutationFn: (portfolioId: string) => deletePortfolio(portfolioId),
    onSuccess: () => {
      invalidate();
      toast.success("Portfolio deleted successfully.");
    },
    onError: () => toast.error("Failed to delete portfolio."),
  });

  return { createMutation, updateMutation, deleteMutation };
}
