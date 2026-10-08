import { useState } from "react";
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
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const editing = dialog === "edit" ? (portfolio ?? null) : null;

  return (
    <>
      <AccountScopeSelector
        value={scope}
        onChange={(next) => onSelect(next.type === "portfolio" ? next.portfolioId : null)}
        triggerVariant="icon"
        portfoliosOnly
        onCreatePortfolio={() => setDialog("create")}
        onEditPortfolio={portfolio ? () => setDialog("edit") : undefined}
        onManagePortfolios={() => navigate("/settings/portfolios")}
      />
      {dialog && (
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
          isSaving={isAccountsLoading || createMutation.isPending || updateMutation.isPending}
        />
      )}
    </>
  );
}
