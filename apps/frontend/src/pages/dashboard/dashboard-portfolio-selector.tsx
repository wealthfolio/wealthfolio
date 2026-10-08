import { useNavigate } from "react-router-dom";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import type { AccountScope } from "@/lib/types";

interface DashboardPortfolioSelectorProps {
  scope: AccountScope;
  onSelect: (portfolioId: string | null) => void;
}

export function DashboardPortfolioSelector({ scope, onSelect }: DashboardPortfolioSelectorProps) {
  const navigate = useNavigate();

  return (
    <AccountScopeSelector
      value={scope}
      onChange={(next) => onSelect(next.type === "portfolio" ? next.portfolioId : null)}
      triggerVariant="icon"
      portfoliosOnly
      onManagePortfolios={() => navigate("/settings/portfolios")}
    />
  );
}
