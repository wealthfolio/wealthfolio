import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { usePortfolios } from "@/hooks/use-portfolios";
import type { AccountScope } from "@/lib/types";

export function useDashboardPortfolio() {
  const { t } = useTranslation();
  const [storedPortfolioId, setPortfolioId] = usePersistentState<string | null>(
    "dashboard-portfolio-id",
    null,
  );
  const portfolioId = typeof storedPortfolioId === "string" ? storedPortfolioId : null;
  const { data: portfolios = [], isPending, isSuccess, error, refetch } = usePortfolios();
  const portfolio = portfolios.find((item) => item.id === portfolioId);

  // Reconcile the saved preference only after a successful inventory read.
  // A loading/error response must not discard a user's selection.
  useEffect(() => {
    if (portfolioId && isSuccess && !portfolio) {
      setPortfolioId(null);
      toast.info(t("dashboard:portfolio_filter.unavailable"));
    }
  }, [portfolioId, isSuccess, portfolio, setPortfolioId, t]);

  const scope = useMemo<AccountScope>(
    () =>
      portfolioId && (!isSuccess || portfolio)
        ? { type: "portfolio", portfolioId }
        : { type: "all" },
    [portfolioId, isSuccess, portfolio],
  );

  return {
    scope,
    portfolio,
    setPortfolioId,
    isLoading: Boolean(portfolioId && isPending),
    error: portfolioId && !portfolio ? error : null,
    refetch,
  };
}
