import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { useAccounts } from "@/hooks/use-accounts";
import { usePortfolioMutations } from "@/hooks/use-portfolios";
import type { AccountScope, NewPortfolio, PortfolioWithAccounts } from "@/lib/types";
import { PortfolioDialog } from "@/pages/settings/portfolios/portfolio-dialog";

interface DashboardPortfolioSelectorProps {
  scope: AccountScope;
  portfolio?: PortfolioWithAccounts;
  onSelect: (portfolioId: string | null) => void;
}

interface DashboardPortfolioDialog {
  portfolio: PortfolioWithAccounts | null;
}

export function DashboardPortfolioSelector({
  scope,
  portfolio,
  onSelect,
}: DashboardPortfolioSelectorProps) {
  const navigate = useNavigate();
  const { accounts, isLoading: isAccountsLoading } = useAccounts({
    filterActive: false,
    includeArchived: true,
  });
  const { createMutation, updateMutation } = usePortfolioMutations();
  const [dialog, setDialog] = useState<DashboardPortfolioDialog | null>(null);
  const editing = dialog?.portfolio ?? null;

  useEffect(() => {
    if (editing && (scope.type !== "portfolio" || scope.portfolioId !== editing.id)) {
      setDialog(null);
    }
  }, [editing, scope]);

  return (
    <>
      <AccountScopeSelector
        value={scope}
        onChange={(next) => onSelect(next.type === "portfolio" ? next.portfolioId : null)}
        triggerVariant="icon"
        portfoliosOnly
        onCreatePortfolio={() => setDialog({ portfolio: null })}
        onEditPortfolio={portfolio ? () => setDialog({ portfolio }) : undefined}
        onManagePortfolios={() => navigate("/settings/portfolios")}
      />
      {dialog && !isAccountsLoading && (
        <PortfolioDialog
          key={editing?.id ?? "new"}
          open
          portfolio={editing}
          accountOptions={accounts}
          onClose={() => setDialog(null)}
          onSave={(data) => {
            if (editing) {
              updateMutation.mutate({ ...editing, ...data }, { onSuccess: () => setDialog(null) });
            } else {
              createMutation.mutate(data as NewPortfolio, {
                onSuccess: (created) => {
                  onSelect(created.id);
                  setDialog(null);
                },
              });
            }
          }}
          isSaving={createMutation.isPending || updateMutation.isPending}
        />
      )}
    </>
  );
}
