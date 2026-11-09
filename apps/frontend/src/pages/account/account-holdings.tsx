import { useShowConnectAccountLink } from "@/features/wealthfolio-connect/hooks/use-show-connect-account-link";
import { connectPagePath } from "@/features/wealthfolio-connect/lib/connect-url";
import { useAccounts } from "@/hooks/use-accounts";
import { useHoldingsWithClosedProbe } from "@/hooks/use-holdings";
import { HoldingsScopeNotice } from "@/components/holdings-scope-notice";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { AccountType, isLiabilityAccountType } from "@/lib/constants";
import { canAddHoldings } from "@/lib/activity-restrictions";
import { HoldingsTable } from "@/pages/holdings/components/holdings-table";
import { HoldingsTableMobile } from "@/pages/holdings/components/holdings-table-mobile";
import {
  Button,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  buttonVariants,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@wealthfolio/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
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

  const { accounts } = useAccounts({ filterActive: false });

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
  const { holdings, isLoading, isComplete, incompleteAccounts, isError, hasHiddenClosedPositions } =
    useHoldingsWithClosedProbe(
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

  // Broker sync creates its own accounts, so an already-synced account gets no link.
  const canShowConnectAccountLink = useShowConnectAccountLink();
  const connectAccountLink =
    canShowConnectAccountLink && !!selectedAccount && !selectedAccount.providerAccountId ? (
      <Link to={connectPagePath("account_empty")} className={buttonVariants({ variant: "link" })}>
        {t("settings:accounts_connect_account")}
      </Link>
    ) : null;

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

  if (!isComplete && holdings.length === 0) {
    return (
      <HoldingsScopeNotice
        isComplete={isComplete}
        isError={isError}
        incompleteAccounts={incompleteAccounts}
      />
    );
  }

  // Show empty state when there are no holdings
  if (isComplete && holdings.length === 0 && !hasHiddenClosedPositions) {
    if (!showEmptyState) {
      return null;
    }

    // For cash / credit-card accounts, an empty holdings response means there
    // is no activity-derived cash position to display yet.
    if (isCashOrCreditAccount) {
      return (
        <div className="flex items-center justify-center py-16">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {<Icons.TrendingUp className="text-muted-foreground size-10" />}
              </EmptyMedia>
              <EmptyTitle>{t("account:empty.no_activity_title")}</EmptyTitle>
              <EmptyDescription>{t("account:empty.no_activity_desc")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <Button
                  size="default"
                  onClick={() =>
                    navigate(
                      `/activities/manage?account=${accountId}&redirect-to=/accounts/${accountId}`,
                    )
                  }
                >
                  <Icons.Plus className="me-2 h-4 w-4" />
                  {t("account:actions_add_transaction")}
                </Button>
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => navigate(`/import?account=${accountId}`)}
                >
                  <Icons.Import className="me-2 h-4 w-4" />
                  {t("account:actions_import_csv")}
                </Button>
              </div>
            </EmptyContent>
          </Empty>
        </div>
      );
    }

    // Different empty state for HOLDINGS mode (manual accounts can edit, connected accounts cannot)
    if (isHoldingsMode) {
      return (
        <div className="flex items-center justify-center py-16">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {<Icons.TrendingUp className="text-muted-foreground size-10" />}
              </EmptyMedia>
              <EmptyTitle>{t("account:empty.no_holdings_title")}</EmptyTitle>
              <EmptyDescription>
                {canEditHoldingsDirectly
                  ? t("account:empty.no_holdings_manual_desc")
                  : t("account:empty.no_holdings_synced_desc")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {canEditHoldingsDirectly && (
                <div className="flex flex-col items-center gap-3 sm:flex-row">
                  <Button size="default" onClick={onAddHoldings}>
                    <Icons.Plus className="me-2 h-4 w-4" />
                    {t("account:actions_add_holdings")}
                  </Button>
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => navigate(`/import?account=${accountId}`)}
                  >
                    <Icons.Import className="me-2 h-4 w-4" />
                    {t("account:actions_import_csv")}
                  </Button>
                </div>
              )}
              {canEditHoldingsDirectly && connectAccountLink}
            </EmptyContent>
          </Empty>
        </div>
      );
    }

    // Default empty state for TRANSACTIONS mode
    return (
      <div className="flex items-center justify-center py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {<Icons.TrendingUp className="text-muted-foreground size-10" />}
            </EmptyMedia>
            <EmptyTitle>{t("account:empty.no_holdings_title")}</EmptyTitle>
            <EmptyDescription>{t("account:empty.no_holdings_default_desc")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              <Button
                size="default"
                onClick={() =>
                  navigate(
                    `/activities/manage?account=${accountId}&redirect-to=/accounts/${accountId}`,
                  )
                }
              >
                <Icons.Plus className="me-2 h-4 w-4" />
                {t("account:actions_add_transaction")}
              </Button>
              <Button
                size="default"
                variant="outline"
                onClick={() => navigate(`/import?account=${accountId}`)}
              >
                <Icons.Import className="me-2 h-4 w-4" />
                {t("account:actions_import_csv")}
              </Button>
            </div>
            {connectAccountLink}
          </EmptyContent>
        </Empty>
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
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onAddHoldings}
                      aria-label={t("account:actions_update_holdings")}
                    />
                  }
                >
                  <Icons.Pencil className="h-4 w-4" />
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
