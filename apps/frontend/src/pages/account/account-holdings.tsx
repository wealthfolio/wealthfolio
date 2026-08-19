import { useAccounts } from "@/hooks/use-accounts";
import { useHoldingsWithClosedProbe } from "@/hooks/use-holdings";
import { useIsMobileViewport } from "@/hooks/use-platform";
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
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  DEFAULT_HOLDINGS_VISIBILITY,
  HOLDINGS_VISIBILITY_STORAGE_KEY,
  filterHoldingsByVisibility,
  getEffectiveHoldingsVisibility,
  type HoldingsVisibilityFilter,
} from "@/pages/holdings/components/holdings-visibility";
import {
  getHoldingTypeFilterOption,
  getHoldingTypeTranslationKey,
} from "@/pages/holdings/components/holdings-type-filter";

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
  const [visibilityFilters, setVisibilityFilters] = usePersistentState<HoldingsVisibilityFilter[]>(
    HOLDINGS_VISIBILITY_STORAGE_KEY,
    [...DEFAULT_HOLDINGS_VISIBILITY],
  );

  const { accounts } = useAccounts();

  const selectedAccount = useMemo(() => {
    return accounts?.find((acc) => acc.id === accountId) ?? null;
  }, [accounts, accountId]);

  // Check if this is a HOLDINGS mode account
  const isHoldingsMode = useMemo(() => {
    if (!selectedAccount) return false;
    return selectedAccount.trackingMode === "HOLDINGS";
  }, [selectedAccount]);

  const showClosedPositions = !isHoldingsMode;
  const effectiveVisibilityFilters = useMemo(
    () => getEffectiveHoldingsVisibility(visibilityFilters, showClosedPositions),
    [showClosedPositions, visibilityFilters],
  );
  const handleVisibilityFiltersChange = useCallback(
    (nextFilters: HoldingsVisibilityFilter[]) => {
      setVisibilityFilters(getEffectiveHoldingsVisibility(nextFilters, showClosedPositions));
    },
    [setVisibilityFilters, showClosedPositions],
  );

  const includeClosed = effectiveVisibilityFilters.includes("closed");
  const { holdings, isLoading, hasHiddenClosedPositions } = useHoldingsWithClosedProbe(
    {
      type: "account",
      accountId,
    },
    {
      includeClosed,
      probeClosedWhenEmpty: showClosedPositions,
    },
  );

  // Check if user can directly edit holdings (manual HOLDINGS-mode accounts only)
  const canEditHoldingsDirectly = useMemo(() => {
    return canAddHoldings(selectedAccount ?? undefined);
  }, [selectedAccount]);

  // Cash and credit-card accounts track activity and cash rather than investments.
  const isCashOrCreditAccount = useMemo(() => {
    const accountType = selectedAccount?.accountType;
    return accountType === AccountType.CASH || isLiabilityAccountType(accountType);
  }, [selectedAccount]);

  const filteredHoldings = filterHoldingsByVisibility(holdings ?? [], effectiveVisibilityFilters);
  const hasHiddenPositions =
    hasHiddenClosedPositions || (holdings.length > 0 && filteredHoldings.length === 0);

  const typeOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const h of holdings ?? []) {
      const option = getHoldingTypeFilterOption(h, t("holdings:cash"));
      if (option && !seen.has(option.value)) {
        seen.add(option.value);
        options.push({
          value: option.value,
          label: t(getHoldingTypeTranslationKey(option.value), {
            defaultValue: option.fallbackLabel,
          }),
        });
      }
    }
    return options;
  }, [holdings, t]);

  // Show loading state while data is being fetched
  if (isLoading) {
    return null;
  }

  // Show empty state when there are no holdings
  if (holdings.length === 0 && !hasHiddenClosedPositions) {
    if (!showEmptyState) {
      return null;
    }

    // For cash / credit-card accounts, an empty holdings response means there
    // is no activity-derived cash position to display yet.
    if (isCashOrCreditAccount) {
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
          visibilityFilters={effectiveVisibilityFilters}
          setVisibilityFilters={handleVisibilityFiltersChange}
          showClosedPositions={showClosedPositions}
          hasHiddenPositions={hasHiddenPositions}
        />
      ) : (
        <HoldingsTable
          holdings={filteredHoldings ?? []}
          isLoading={isLoading}
          visibilityFilters={effectiveVisibilityFilters}
          setVisibilityFilters={handleVisibilityFiltersChange}
          showClosedPositions={showClosedPositions}
        />
      )}
    </div>
  );
};

export default AccountHoldings;
