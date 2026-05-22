import { getHoldings } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import { Holding, HoldingType } from "@/lib/types";
import { canAddHoldings } from "@/lib/activity-restrictions";
import { HoldingsTable } from "@/pages/holdings/components/holdings-table";
import { HoldingsTableMobile } from "@/pages/holdings/components/holdings-table-mobile";
import {
  Button,
  EmptyPlaceholder,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

interface AccountHoldingsProps {
  accountId: string;
  showEmptyState?: boolean;
  onAddHoldings?: () => void;
}

const AccountHoldings = ({
  accountId,
  showEmptyState = true,
  onAddHoldings,
}: AccountHoldingsProps) => {
  const isMobile = useIsMobileViewport();
  const navigate = useNavigate();
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  const { data: holdings, isLoading } = useQuery<Holding[], Error>({
    queryKey: [QueryKeys.HOLDINGS, accountId],
    queryFn: () => getHoldings({ type: "account", accountId }),
  });

  const { accounts } = useAccounts();

  const selectedAccount = useMemo(() => {
    return accounts?.find((acc) => acc.id === accountId) ?? null;
  }, [accounts, accountId]);

  // Check if this is a HOLDINGS mode account
  const isHoldingsMode = useMemo(() => {
    if (!selectedAccount) return false;
    return selectedAccount.trackingMode === "HOLDINGS";
  }, [selectedAccount]);

  // Check if user can directly edit holdings (manual HOLDINGS-mode accounts only)
  const canEditHoldingsDirectly = useMemo(() => {
    return canAddHoldings(selectedAccount ?? undefined);
  }, [selectedAccount]);

  const filteredHoldings = holdings?.filter((holding) => holding.holdingType !== HoldingType.CASH);

  const typeOptions = useMemo(() => {
    if (!filteredHoldings) return [];
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const h of filteredHoldings) {
      const name = h.instrument?.classifications?.assetType?.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        options.push({ value: name, label: name });
      }
    }
    return options;
  }, [filteredHoldings]);

  // Show loading state while data is being fetched
  if (isLoading) {
    return null;
  }

  // Show empty state when there are no holdings
  if (!filteredHoldings || filteredHoldings.length === 0) {
    if (!showEmptyState) {
      return null;
    }

    // Different empty state for HOLDINGS mode (manual accounts can edit, connected accounts cannot)
    if (isHoldingsMode) {
      return (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
            title="No holdings yet"
            description={
              canEditHoldingsDirectly
                ? "Add your current holdings snapshot or import from a CSV file to get started."
                : "Holdings will be synced from your connected account."
            }
          >
            {canEditHoldingsDirectly && (
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <Button size="default" onClick={onAddHoldings}>
                  <Icons.Plus className="mr-2 h-4 w-4" />
                  Add Holdings
                </Button>
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => navigate(`/import?account=${accountId}`)}
                >
                  <Icons.Import className="mr-2 h-4 w-4" />
                  Import from CSV
                </Button>
              </div>
            )}
          </EmptyPlaceholder>
        </div>
      );
    }

    // Default empty state for TRANSACTIONS mode
    return (
      <div className="flex items-center justify-center py-16">
        <EmptyPlaceholder
          icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
          title="No holdings yet"
          description="Get started by adding your first transaction or quickly import your existing holdings from a CSV file."
        >
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <Button
              size="default"
              onClick={() =>
                navigate(
                  `/activities/manage?account=${accountId}&redirect-to=/accounts/${accountId}`,
                )
              }
            >
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add Transaction
            </Button>
            <Button
              size="default"
              variant="outline"
              onClick={() => navigate(`/import?account=${accountId}`)}
            >
              <Icons.Import className="mr-2 h-4 w-4" />
              Import from CSV
            </Button>
          </div>
        </EmptyPlaceholder>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold">Holdings</h3>
        {canEditHoldingsDirectly && onAddHoldings && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onAddHoldings}>
                  <Icons.Pencil className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Update holdings</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {isMobile ? (
        <HoldingsTableMobile
          holdings={filteredHoldings ?? []}
          isLoading={isLoading}
          selectedTypes={selectedTypes}
          setSelectedTypes={setSelectedTypes}
          accountFilter={{ type: "account", accountId: selectedAccount?.id ?? "" }}
          onAccountScopeChange={() => {}}
          accounts={[]}
          portfolios={[]}
          showAccountScope={false}
          typeOptions={typeOptions}
        />
      ) : (
        <HoldingsTable holdings={filteredHoldings ?? []} isLoading={isLoading} />
      )}
    </div>
  );
};

export default AccountHoldings;
