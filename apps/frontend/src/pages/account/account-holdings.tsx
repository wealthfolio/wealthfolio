import { useAccounts } from "@/hooks/use-accounts";
import { useHoldings } from "@/hooks/use-holdings";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { HoldingType } from "@/lib/types";
import { AccountType, isLiabilityAccountType } from "@/lib/constants";
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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

interface AccountHoldingsProps {
  accountId: string;
  showEmptyState?: boolean;
  showTitle?: boolean;
  onAddHoldings?: () => void;
}

const AccountHoldings = ({
  accountId,
  showEmptyState = true,
  showTitle = true,
  onAddHoldings,
}: AccountHoldingsProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const navigate = useNavigate();
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  const { holdings, isLoading } = useHoldings({
    type: "account",
    accountId,
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

  // Cash and credit-card accounts hold no investments, so a "no holdings"
  // empty state never applies — they only track activity / cash balance.
  const isCashOrCreditAccount = useMemo(() => {
    const accountType = selectedAccount?.accountType;
    return accountType === AccountType.CASH || isLiabilityAccountType(accountType);
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

    // Cash / credit-card accounts have no investment holdings by nature. When
    // the account already has activity (a cash balance), show nothing here —
    // the balance lives in the metrics panel. Only prompt to add an activity
    // when there is no activity at all.
    if (isCashOrCreditAccount) {
      if (holdings && holdings.length > 0) {
        return null;
      }

      return (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
            title={t("account:empty.no_activity_title")}
            description={t("account:empty.no_activity_desc")}
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
                {t("account:actions_add_transaction")}
              </Button>
              <Button
                size="default"
                variant="outline"
                onClick={() => navigate(`/import?account=${accountId}`)}
              >
                <Icons.Import className="mr-2 h-4 w-4" />
                {t("account:actions_import_csv")}
              </Button>
            </div>
          </EmptyPlaceholder>
        </div>
      );
    }

    // Different empty state for HOLDINGS mode (manual accounts can edit, connected accounts cannot)
    if (isHoldingsMode) {
      return (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
            title={t("account:empty.no_holdings_title")}
            description={
              canEditHoldingsDirectly
                ? t("account:empty.no_holdings_manual_desc")
                : t("account:empty.no_holdings_synced_desc")
            }
          >
            {canEditHoldingsDirectly && (
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <Button size="default" onClick={onAddHoldings}>
                  <Icons.Plus className="mr-2 h-4 w-4" />
                  {t("account:actions_add_holdings")}
                </Button>
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => navigate(`/import?account=${accountId}`)}
                >
                  <Icons.Import className="mr-2 h-4 w-4" />
                  {t("account:actions_import_csv")}
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
          title={t("account:empty.no_holdings_title")}
          description={t("account:empty.no_holdings_default_desc")}
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
              {t("account:actions_add_transaction")}
            </Button>
            <Button
              size="default"
              variant="outline"
              onClick={() => navigate(`/import?account=${accountId}`)}
            >
              <Icons.Import className="mr-2 h-4 w-4" />
              {t("account:actions_import_csv")}
            </Button>
          </div>
        </EmptyPlaceholder>
      </div>
    );
  }

  const showHeader = showTitle || (canEditHoldingsDirectly && onAddHoldings);

  return (
    <div>
      {showHeader && (
        <div className={`flex items-center gap-3 ${showTitle ? "justify-between" : "justify-end"}`}>
          {showTitle && <h3 className="text-lg font-bold">{t("account:holdings")}</h3>}
          {canEditHoldingsDirectly && onAddHoldings && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onAddHoldings}>
                    <Icons.Pencil className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("account:actions_update_holdings")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
      {isMobile ? (
        <HoldingsTableMobile
          holdings={filteredHoldings ?? []}
          isLoading={isLoading}
          selectedTypes={selectedTypes}
          setSelectedTypes={setSelectedTypes}
          accountFilter={{ type: "account", accountId: selectedAccount?.id ?? "" }}
          onAccountScopeChange={() => undefined}
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
