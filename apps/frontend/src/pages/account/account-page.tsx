import { getContributionLimit, getSnapshots, searchActivities } from "@/adapters";
import { HistoryChart } from "@/components/history-chart";
import type { ActivityDetails } from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  GainAmount,
  GainPercent,
  AnimatedToggleGroup,
  IntervalSelector,
  Page,
  PageContent,
  PageHeader,
  PrivacyAmount,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { useAccounts } from "@/hooks/use-accounts";
import { useRecalculatePortfolioMutation } from "@/hooks/use-calculate-portfolio";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useHoldings } from "@/hooks/use-holdings";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { canAddHoldings, getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import {
  AccountPurpose,
  AccountType,
  type ActivityType,
  accountSupportsPurpose,
  HoldingType,
  isLiabilityAccountType,
} from "@/lib/constants";
import {
  performanceSummaryReturn,
  performancePeriodPnl,
  simpleReturnFromNetContribution,
} from "@/lib/performance";
import { getPerformanceDateRangeForRequest } from "@/lib/performance-date-range";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  Account,
  AccountValuation,
  ContributionLimit,
  DateRange,
  SnapshotInfo,
  TimePeriod,
  TrackedItem,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityDateSheet } from "@/pages/activity/components/activity-date-sheet";
import { ActivityDeleteModal } from "@/pages/activity/components/activity-delete-modal";
import { ActivityForm, type AccountSelectOption } from "@/pages/activity/components/activity-form";
import { ActivityPagination } from "@/pages/activity/components/activity-pagination";
import ActivityTable from "@/pages/activity/components/activity-table/activity-table";
import ActivityTableMobile from "@/pages/activity/components/activity-table/activity-table-mobile";
import { BulkHoldingsModal } from "@/pages/activity/components/forms/bulk-holdings-modal";
import { MobileActivityForm } from "@/pages/activity/components/mobile-forms/mobile-activity-form";
import { useActivityActionDialogs } from "@/pages/activity/hooks/use-activity-action-dialogs";
import { useActivitySearch } from "@/pages/activity/hooks/use-activity-search";
import { PortfolioUpdateTrigger } from "@/pages/dashboard/portfolio-update-trigger";
import { HoldingsEditMode } from "@/pages/holdings/components/holdings-edit-mode";
import { useCalculatePerformanceHistory } from "@/pages/performance/hooks/use-performance-data";
import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Icons, type Icon } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui/components/ui/sheet";
import { format, subMonths } from "date-fns";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AccountContributionLimit } from "./account-contribution-limit";
import AccountHoldings from "./account-holdings";
import AccountMetrics from "./account-metrics";
import {
  buildCashAuditReviewTarget,
  getCurrentNegativeCashRun,
  offsetDateKey,
  toDateKey,
} from "./cash-audit";
import AccountSnapshotHistory from "./account-snapshot-history";

interface HistoryChartData {
  date: string;
  totalValue: number;
  netContribution: number;
  currency: string;
}

type AccountDetailTab = "holdings" | "activities" | "snapshots";

// Map account types to icons for visual distinction
const accountTypeIcons: Record<AccountType, Icon> = {
  SECURITIES: Icons.Briefcase,
  CASH: Icons.DollarSign,
  CREDIT_CARD: Icons.CreditCard,
  CRYPTOCURRENCY: Icons.Bitcoin,
};

// Helper function to get the initial date range (copied from dashboard)
const getInitialDateRange = (): DateRange => ({
  from: subMonths(new Date(), 3),
  to: new Date(),
});

// Define the initial interval code (consistent with other pages)
const INITIAL_INTERVAL_CODE: TimePeriod = "3M";
const CASH_AUDIT_ACTIVITY_PAGE_SIZE = 500;
const EMPTY_ACCOUNT_IDS: string[] = [];
const EMPTY_ACTIVITY_TYPES: ActivityType[] = [];

async function getCashAuditActivities(
  accountId: string,
  dateFrom: string | undefined,
  dateTo: string,
): Promise<ActivityDetails[]> {
  const activities: ActivityDetails[] = [];
  let page = 0;
  let totalRowCount = Number.POSITIVE_INFINITY;

  while (activities.length < totalRowCount) {
    const response = await searchActivities(
      page,
      CASH_AUDIT_ACTIVITY_PAGE_SIZE,
      { accountIds: [accountId], dateFrom, dateTo },
      "",
      { id: "date", desc: false },
    );

    activities.push(...response.data);
    totalRowCount = response.meta.totalRowCount;

    if (response.data.length < CASH_AUDIT_ACTIVITY_PAGE_SIZE) break;
    page += 1;
  }

  return activities;
}

const AccountPage = () => {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const appTimezone = settings?.timezone?.trim() || undefined;
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [dateRange, setDateRange] = useState<DateRange | undefined>(getInitialDateRange());
  const [selectedIntervalCode, setSelectedIntervalCode] =
    useState<TimePeriod>(INITIAL_INTERVAL_CODE);
  const [desktopSelectorOpen, setDesktopSelectorOpen] = useState(false);
  const [mobileSelectorOpen, setMobileSelectorOpen] = useState(false);
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false);
  const [isEditingHoldings, setIsEditingHoldings] = useState(false);
  const [showSnapshotMarkers, setShowSnapshotMarkers] = useState(false);
  const [editingSnapshotDate, setEditingSnapshotDate] = useState<string | null>(null);
  const [selectedActivityDate, setSelectedActivityDate] = useState<string | null>(null);
  const [isActivitySheetOpen, setIsActivitySheetOpen] = useState(false);
  const [showBulkHoldingsForm, setShowBulkHoldingsForm] = useState(false);
  const [accountDetailTab, setAccountDetailTab] = useState<AccountDetailTab>("holdings");
  const [accountActivitiesSorting, setAccountActivitiesSorting] = useState<SortingState>([
    { id: "date", desc: true },
  ]);
  const {
    selectedActivity,
    formOpen: activityFormOpen,
    deleteDialogOpen: showActivityDeleteAlert,
    isDeleting: isActivityDeleting,
    openForm: handleActivityEdit,
    closeForm: handleActivityFormClose,
    requestDelete: handleActivityDelete,
    cancelDelete: handleActivityDeleteCancel,
    confirmDelete: handleActivityDeleteConfirm,
    duplicateActivity: handleActivityDuplicate,
  } = useActivityActionDialogs();

  const recalculatePortfolioMutation = useRecalculatePortfolioMutation();
  const { accounts, isLoading: isAccountsLoading } = useAccounts();
  const account = useMemo(() => accounts?.find((acc) => acc.id === id), [accounts, id]);
  const isLiabilityAccount = isLiabilityAccountType(account?.accountType);
  const isCashOnlyAccount = account?.accountType === AccountType.CASH || isLiabilityAccount;
  const supportsPerformance = accountSupportsPurpose(account, AccountPurpose.PERFORMANCE);
  const supportsContributionLimits = accountSupportsPurpose(
    account,
    AccountPurpose.CONTRIBUTION_LIMITS,
  );
  const currentContributionYear = new Date().getFullYear();

  const { data: contributionLimits, isLoading: isContributionLimitsLoading } = useQuery<
    ContributionLimit[],
    Error
  >({
    queryKey: [QueryKeys.CONTRIBUTION_LIMITS],
    queryFn: getContributionLimit,
    enabled: supportsContributionLimits,
  });

  const currentContributionLimit = contributionLimits?.find(
    (limit) => limit.accountIds?.includes(id) && limit.contributionYear === currentContributionYear,
  );
  const showContributionLimitCard =
    supportsContributionLimits && (isContributionLimitsLoading || !!currentContributionLimit);

  // Check if this account is in HOLDINGS tracking mode
  const isHoldingsMode = useMemo(() => {
    if (!account) return false;
    return account.trackingMode === "HOLDINGS";
  }, [account]);

  // Check if user can directly edit holdings (manual HOLDINGS-mode accounts only)
  const canEditHoldingsDirectly = useMemo(() => {
    return canAddHoldings(account);
  }, [account]);

  const { holdings, isLoading: isHoldingsLoading } = useHoldings({
    type: "account",
    accountId: id,
  });

  // Check if account has any holdings (including cash)
  const hasHoldings = useMemo(() => {
    if (!holdings) return false;
    return holdings.length > 0;
  }, [holdings]);

  const hasNonCashHoldings = useMemo(() => {
    if (!holdings) return false;
    return holdings.some((holding) => holding.holdingType !== HoldingType.CASH);
  }, [holdings]);

  const shouldShowSnapshotHistory = isHoldingsMode && hasHoldings && !isHoldingsLoading;

  const accountDetailTabs = useMemo(() => {
    if (!account) return [];
    const tabs: { value: AccountDetailTab; label: string }[] = [];

    if (!isCashOnlyAccount && (!shouldShowSnapshotHistory || hasNonCashHoldings)) {
      tabs.push({ value: "holdings", label: t("account:holdings") });
    }

    tabs.push({ value: "activities", label: t("common:activities") });

    if (shouldShowSnapshotHistory) {
      tabs.push({ value: "snapshots", label: t("account:snapshot.tab") });
    }

    return tabs;
  }, [account, hasNonCashHoldings, isCashOnlyAccount, shouldShowSnapshotHistory, t]);

  const activeAccountDetailTab = accountDetailTabs.some((tab) => tab.value === accountDetailTab)
    ? accountDetailTab
    : (accountDetailTabs[0]?.value ?? "activities");

  const isAccountActivitiesTabActive = activeAccountDetailTab === "activities";
  const accountActivityAccountIds = useMemo(
    () => (isAccountActivitiesTabActive && account ? [id] : EMPTY_ACCOUNT_IDS),
    [account, id, isAccountActivitiesTabActive],
  );
  const accountActivitiesSearch = useActivitySearch({
    mode: "infinite",
    filters: {
      accountIds: accountActivityAccountIds,
      activityTypes: EMPTY_ACTIVITY_TYPES,
    },
    searchQuery: "",
    sorting: accountActivitiesSorting,
  });

  const activityFormAccounts = useMemo<AccountSelectOption[]>(
    () =>
      accounts
        .filter((acc) => !acc.isArchived)
        .map((acc) => ({
          value: acc.id,
          label: acc.name,
          currency: acc.currency,
          accountType: acc.accountType,
          restrictionLevel: getActivityRestrictionLevel(acc),
        })),
    [accounts],
  );

  // Format date range for snapshot query
  const snapshotDateFrom = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const snapshotDateTo = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;

  // Query snapshots for chart markers (only when toggle is on)
  // Filtered by the chart's visible date range
  const { data: snapshots } = useQuery<SnapshotInfo[], Error>({
    queryKey: [...QueryKeys.snapshots(id), snapshotDateFrom, snapshotDateTo],
    queryFn: () => getSnapshots(id, snapshotDateFrom, snapshotDateTo),
    enabled: showSnapshotMarkers && !!account,
  });

  // Extract snapshot dates for chart markers (used in HOLDINGS mode)
  const snapshotDates = useMemo(() => {
    if (!snapshots) return [];
    return snapshots.map((s) => s.snapshotDate);
  }, [snapshots]);

  // In TRANSACTIONS mode, fetch activity dates for markers (snapshot dates include
  // carry-forward days with no activities, so we need actual activity dates instead)
  const { data: activityMarkerDates } = useQuery<string[], Error>({
    queryKey: ["activities", "markerDates", id, snapshotDateFrom, snapshotDateTo],
    queryFn: async () => {
      const response = await searchActivities(
        0,
        1000,
        { accountIds: [id], dateFrom: snapshotDateFrom, dateTo: snapshotDateTo },
        "",
        { id: "date", desc: true },
      );
      const dates = new Set<string>();
      response.data.forEach((a) => {
        const d = typeof a.date === "string" ? a.date : a.date.toISOString();
        dates.add(d.split("T")[0]);
      });
      return [...dates];
    },
    enabled: showSnapshotMarkers && !isHoldingsMode && !!account,
  });

  // Use activity dates for TRANSACTIONS mode, snapshot dates for HOLDINGS mode
  const markerDates = isHoldingsMode ? snapshotDates : (activityMarkerDates ?? []);

  // Query activities for selected date (Transactions mode marker click)
  const { data: dateActivities, isLoading: isDateActivitiesLoading } = useQuery<
    ActivityDetails[],
    Error
  >({
    queryKey: ["activities", "byDate", id, selectedActivityDate],
    queryFn: async () => {
      if (!selectedActivityDate) return [];
      const response = await searchActivities(
        0,
        100,
        { accountIds: [id], dateFrom: selectedActivityDate, dateTo: selectedActivityDate },
        "",
        { id: "date", desc: true },
      );
      return response.data;
    },
    enabled: isActivitySheetOpen && !!selectedActivityDate,
  });

  // Group accounts by type for the selector
  const accountsByType = useMemo(() => {
    const grouped: Record<string, Account[]> = {};
    accounts.forEach((acc) => {
      if (!grouped[acc.accountType]) {
        grouped[acc.accountType] = [];
      }
      grouped[acc.accountType].push(acc);
    });
    return Object.entries(grouped);
  }, [accounts]);

  const accountTrackedItem: TrackedItem | undefined = useMemo(() => {
    if (account && supportsPerformance) {
      return { id: account.id, type: "account", name: account.name };
    }
    return undefined;
  }, [account, supportsPerformance]);

  const performanceDateRange = getPerformanceDateRangeForRequest(dateRange, selectedIntervalCode);

  // Pass tracking mode to the performance hook for SOTA calculations
  const {
    data: performanceResponse,
    isLoading: isPerformanceHistoryLoading,
    hasErrors: hasPerformanceError,
    errorMessages: performanceErrorMessages,
  } = useCalculatePerformanceHistory({
    selectedItems: accountTrackedItem ? [accountTrackedItem] : [],
    dateRange: performanceDateRange,
    trackingMode: isHoldingsMode ? "HOLDINGS" : "TRANSACTIONS",
  });

  const accountPerformance = performanceResponse?.[0] || null;

  const { valuationHistory, isLoading: isValuationHistoryLoading } = useValuationHistory(
    dateRange,
    { type: "account", accountId: id },
  );
  const {
    currentValuation: liveCurrentValuation,
    isLoading: isCurrentValuationLoading,
    error: currentValuationError,
  } = useCurrentValuation(
    { type: "account", accountId: id },
    { includeAccounts: true, enabled: Boolean(id) },
  );

  const currentValuation = valuationHistory?.[valuationHistory.length - 1];
  const currentAccountValuation = liveCurrentValuation?.accounts[0];
  const metricsValuation = useMemo(() => {
    if (!currentValuation || !currentAccountValuation) return currentValuation;

    return {
      ...currentValuation,
      accountCurrency: currentAccountValuation.accountCurrency,
      baseCurrency: currentAccountValuation.baseCurrency,
      cashBalance: currentAccountValuation.cashBalance,
      investmentMarketValue: currentAccountValuation.investmentMarketValue,
      totalValue: currentAccountValuation.totalValue,
      cashBalanceBase: currentAccountValuation.cashBalanceBase,
      investmentMarketValueBase: currentAccountValuation.investmentMarketValueBase,
      totalValueBase: currentAccountValuation.totalValueBase,
      calculatedAt: currentAccountValuation.calculatedAt,
    };
  }, [currentAccountValuation, currentValuation]);
  const currentCashBalanceIsNegative = (currentValuation?.cashBalance ?? 0) < 0;
  const shouldLoadCashAuditValuationHistory =
    currentCashBalanceIsNegative && !isHoldingsMode && !isLiabilityAccount;

  const {
    valuationHistory: cashAuditValuationHistory,
    isLoading: isCashAuditValuationHistoryLoading,
  } = useValuationHistory(
    undefined,
    { type: "account", accountId: id },
    {
      enabled: shouldLoadCashAuditValuationHistory,
    },
  );

  const selectedActivityDateValuation = useMemo(() => {
    if (!selectedActivityDate) return null;
    const selectedDateKey = toDateKey(selectedActivityDate, appTimezone);
    const histories = [valuationHistory, cashAuditValuationHistory];
    for (const history of histories) {
      const valuation = history?.find(
        (item) => toDateKey(item.valuationDate, appTimezone) === selectedDateKey,
      );
      if (valuation) return valuation;
    }
    return null;
  }, [appTimezone, cashAuditValuationHistory, selectedActivityDate, valuationHistory]);

  const currentNegativeCashRun = useMemo(() => {
    if (isHoldingsMode || isLiabilityAccount || !cashAuditValuationHistory) return null;
    return getCurrentNegativeCashRun(cashAuditValuationHistory, appTimezone);
  }, [appTimezone, cashAuditValuationHistory, isHoldingsMode, isLiabilityAccount]);

  const firstVisibleNegativeCashValuation = useMemo(() => {
    if (isHoldingsMode || isLiabilityAccount || !valuationHistory) return null;
    return (
      valuationHistory.find((valuation) => valuation.cashBalance < 0) ??
      currentNegativeCashRun?.firstNegativeValuation ??
      null
    );
  }, [currentNegativeCashRun, isHoldingsMode, isLiabilityAccount, valuationHistory]);

  const cashAuditRunStartDate = toDateKey(
    currentNegativeCashRun?.firstNegativeValuation.valuationDate,
    appTimezone,
  );
  const cashAuditPreviousDate = toDateKey(
    currentNegativeCashRun?.previousNonNegativeValuation?.valuationDate,
    appTimezone,
  );
  const cashAuditDateFrom = offsetDateKey(cashAuditPreviousDate, -1);
  const cashAuditDateTo = offsetDateKey(cashAuditRunStartDate, 1);

  const { data: cashAuditActivities = [], isLoading: isCashAuditActivitiesLoading } = useQuery<
    ActivityDetails[],
    Error
  >({
    queryKey: ["activities", "cashAudit", id, cashAuditDateFrom, cashAuditDateTo],
    queryFn: async () => {
      if (!cashAuditDateTo) return [];
      return getCashAuditActivities(id, cashAuditDateFrom, cashAuditDateTo);
    },
    enabled:
      !!account && currentCashBalanceIsNegative && !!currentNegativeCashRun && !!cashAuditDateTo,
  });

  const negativeCashAuditTarget = useMemo(
    () => buildCashAuditReviewTarget(currentNegativeCashRun, cashAuditActivities, appTimezone),
    [appTimezone, cashAuditActivities, currentNegativeCashRun],
  );

  const selectedCashAuditTarget =
    toDateKey(selectedActivityDate, appTimezone) === negativeCashAuditTarget?.activityDate
      ? negativeCashAuditTarget
      : null;
  const selectedCashAuditActivities = useMemo(() => {
    if (!selectedCashAuditTarget) return undefined;
    return cashAuditActivities.filter(
      (activity) => toDateKey(activity.date, appTimezone) === selectedCashAuditTarget.activityDate,
    );
  }, [appTimezone, cashAuditActivities, selectedCashAuditTarget]);

  const frontendGainLossAmount = performancePeriodPnl(accountPerformance);
  const frontendSummaryReturn = performanceSummaryReturn(accountPerformance);
  const allTimeReturnAmount = metricsValuation
    ? metricsValuation.totalValue - metricsValuation.netContribution
    : null;
  const allTimeSimpleReturn = simpleReturnFromNetContribution(
    allTimeReturnAmount,
    metricsValuation?.netContribution,
  );
  const gainLossAmountToDisplay =
    selectedIntervalCode === "ALL" && !isHoldingsMode
      ? allTimeReturnAmount
      : frontendGainLossAmount;
  const displayedValueCurrency =
    account?.currency ??
    currentAccountValuation?.accountCurrency ??
    currentValuation?.accountCurrency ??
    baseCurrency;
  const displayedTotalValue =
    currentAccountValuation?.totalValue ??
    (!isCurrentValuationLoading && !currentValuationError ? currentValuation?.totalValue : 0) ??
    0;
  const displayedSourceDataAsOf =
    currentAccountValuation?.sourceDataAsOf ??
    (!currentAccountValuation && !isCurrentValuationLoading && !currentValuationError
      ? currentValuation?.calculatedAt
      : undefined);
  const displayedValuationNotices =
    currentAccountValuation?.warnings ?? liveCurrentValuation?.summary.warnings;
  const isCurrentValuationUnavailable =
    !isCurrentValuationLoading && !currentAccountValuation && Boolean(currentValuationError);
  const performanceCurrency = accountPerformance?.scope.currency ?? baseCurrency;
  const gainLossCurrencyToDisplay =
    selectedIntervalCode === "ALL" && !isHoldingsMode
      ? displayedValueCurrency
      : performanceCurrency;
  const showGainLossCurrency =
    gainLossCurrencyToDisplay.toUpperCase() !== displayedValueCurrency.toUpperCase();

  const chartData: HistoryChartData[] = useMemo(() => {
    if (!valuationHistory) return [];
    return valuationHistory.map((valuation: AccountValuation) => ({
      date: valuation.valuationDate,
      totalValue: valuation.totalValue,
      netContribution: valuation.netContribution,
      currency: valuation.accountCurrency,
    }));
  }, [valuationHistory]);

  const isLoading = isAccountsLoading || isValuationHistoryLoading;

  // Callback for IntervalSelector
  const handleIntervalSelect = (
    code: TimePeriod,
    _description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setDateRange(range);
  };

  const percentageToDisplay = useMemo(() => {
    // Holdings mode has no transaction cash-flow history, so show value return.
    if (isHoldingsMode) {
      return frontendSummaryReturn;
    }
    if (selectedIntervalCode === "ALL") {
      return allTimeSimpleReturn;
    }
    if (accountPerformance) {
      return performanceSummaryReturn(accountPerformance);
    }
    return null;
  }, [
    accountPerformance,
    selectedIntervalCode,
    frontendSummaryReturn,
    allTimeSimpleReturn,
    isHoldingsMode,
  ]);

  const handleAccountSwitch = (selectedAccount: Account) => {
    navigate(`/accounts/${selectedAccount.id}`);
    setDesktopSelectorOpen(false);
    setMobileSelectorOpen(false);
  };

  const accountActivitiesContent = isMobile ? (
    <>
      <ActivityTableMobile
        activities={accountActivitiesSearch.data}
        isLoading={accountActivitiesSearch.isLoading}
        isCompactView={true}
        handleEdit={handleActivityEdit}
        handleDelete={handleActivityDelete}
        onDuplicate={handleActivityDuplicate}
        onAdd={() => navigate(`/activities/manage?account=${id}`)}
      />
      <ActivityPagination
        hasMore={accountActivitiesSearch.hasNextPage ?? false}
        onLoadMore={accountActivitiesSearch.fetchNextPage}
        isFetching={accountActivitiesSearch.isFetchingNextPage}
        totalFetched={accountActivitiesSearch.data.length}
        totalCount={accountActivitiesSearch.totalRowCount}
      />
    </>
  ) : (
    <>
      <ActivityTable
        activities={accountActivitiesSearch.data}
        isLoading={accountActivitiesSearch.isLoading}
        sorting={accountActivitiesSorting}
        onSortingChange={setAccountActivitiesSorting}
        handleEdit={handleActivityEdit}
        handleDelete={handleActivityDelete}
        onAdd={() => navigate(`/activities/manage?account=${id}`)}
      />
      <ActivityPagination
        hasMore={accountActivitiesSearch.hasNextPage ?? false}
        onLoadMore={accountActivitiesSearch.fetchNextPage}
        isFetching={accountActivitiesSearch.isFetchingNextPage}
        totalFetched={accountActivitiesSearch.data.length}
        totalCount={accountActivitiesSearch.totalRowCount}
      />
    </>
  );

  const accountDetailsContent = (
    <div className="space-y-4">
      {(accountDetailTabs.length > 1 || activeAccountDetailTab === "activities") && (
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          {accountDetailTabs.length > 1 ? (
            <AnimatedToggleGroup<AccountDetailTab>
              items={accountDetailTabs}
              value={activeAccountDetailTab}
              onValueChange={setAccountDetailTab}
              size={isMobile ? "compact" : "default"}
              className="min-w-0"
            />
          ) : (
            <div />
          )}

          {activeAccountDetailTab === "activities" && (
            <Button variant="ghost" size="sm" className="shrink-0" asChild>
              <Link to={`/activities?account=${id}`} className="inline-flex items-center gap-1.5">
                {t("account:explore")}
                <Icons.ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      )}

      {activeAccountDetailTab === "holdings" ? (
        <AccountHoldings
          accountId={id}
          showEmptyState={true}
          showTitle={false}
          onAddHoldings={() => setIsEditingHoldings(true)}
        />
      ) : activeAccountDetailTab === "activities" ? (
        accountActivitiesContent
      ) : account ? (
        <AccountSnapshotHistory
          account={account}
          canEditSnapshots={canEditHoldingsDirectly}
          onAddSnapshot={() => {
            setEditingSnapshotDate(null);
            setIsEditingHoldings(true);
          }}
        />
      ) : null}
    </div>
  );

  return (
    <Page>
      <PageHeader
        onBack={() => navigate(-1)}
        actions={
          <ActionPalette
            open={actionPaletteOpen}
            onOpenChange={setActionPaletteOpen}
            groups={
              canEditHoldingsDirectly
                ? ([
                    {
                      title: t("account:action_group_holdings"),
                      items: [
                        {
                          icon: Icons.Pencil,
                          label: t("account:update_holdings_title"),
                          onClick: () => {
                            setEditingSnapshotDate(null);
                            setIsEditingHoldings(true);
                          },
                        },
                        {
                          icon: Icons.Import,
                          label: t("account:action_import_csv"),
                          onClick: () => navigate(`/import?account=${id}`),
                        },
                      ],
                    },
                    {
                      title: t("account:action_group_manage"),
                      items: [
                        {
                          icon: Icons.Clock,
                          label: t("account:action_recalculate_history"),
                          onClick: () => recalculatePortfolioMutation.mutate(),
                        },
                      ],
                    },
                  ] satisfies ActionPaletteGroup[])
                : ([
                    {
                      title: isLiabilityAccount
                        ? t("account:action_group_activity")
                        : t("account:action_group_transactions"),
                      items: [
                        ...(!isLiabilityAccount
                          ? [
                              {
                                icon: Icons.Plus,
                                label: t("account:action_record_transaction"),
                                onClick: () => navigate(`/activities/manage?account=${id}`),
                              },
                            ]
                          : []),
                        ...(isHoldingsMode || isLiabilityAccount
                          ? []
                          : [
                              {
                                icon: Icons.Holdings,
                                label: t("account:action_transfer_holdings"),
                                onClick: () => setShowBulkHoldingsForm(true),
                              },
                            ]),
                        {
                          icon: Icons.Import,
                          label: t("account:action_import_csv"),
                          onClick: () => navigate(`/import?account=${id}`),
                        },
                      ],
                    },
                    {
                      title: t("account:action_group_manage"),
                      items: [
                        {
                          icon: Icons.Clock,
                          label: t("account:action_recalculate_history"),
                          onClick: () => recalculatePortfolioMutation.mutate(),
                        },
                      ],
                    },
                  ] satisfies ActionPaletteGroup[])
            }
          />
        }
      >
        <div className="flex items-center gap-2" data-tauri-drag-region="true">
          {/* Tracking mode avatar */}
          {account && (
            <div className="bg-primary/10 dark:bg-primary/20 flex size-9 shrink-0 items-center justify-center rounded-full">
              {account.trackingMode === "HOLDINGS" ? (
                <Icons.Holdings className="text-primary h-5 w-5" />
              ) : (
                <Icons.Activity className="text-primary h-5 w-5" />
              )}
            </div>
          )}
          <div className="flex min-w-0 flex-col justify-center">
            <div className="flex min-w-0 items-center">
              {/* Desktop account selector */}
              <div className="hidden min-w-0 sm:block">
                <Popover open={desktopSelectorOpen} onOpenChange={setDesktopSelectorOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className="-ml-2 h-auto min-w-0 justify-start rounded-md px-2 py-1 text-left"
                      aria-label={t("account:switch_account")}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {account?.group ? (
                          <>
                            <span className="text-muted-foreground truncate text-base font-semibold leading-tight md:text-lg">
                              {account.group}
                            </span>
                            <span className="text-muted-foreground text-sm" aria-hidden="true">
                              &gt;
                            </span>
                          </>
                        ) : null}
                        <span className="truncate text-base font-semibold leading-tight md:text-lg">
                          {account?.name ?? t("account:account")}
                        </span>
                        <Icons.ChevronDown className="text-muted-foreground size-5 shrink-0" />
                      </span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-60 p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t("account:search_accounts")} />
                      <CommandList>
                        <CommandEmpty>{t("account:no_accounts_found")}</CommandEmpty>
                        {accountsByType.map(([type, typeAccounts]) => (
                          <CommandGroup key={type} heading={type}>
                            {typeAccounts.map((acc) => {
                              const IconComponent =
                                accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                              return (
                                <CommandItem
                                  key={acc.id}
                                  value={`${acc.name} ${acc.currency}`}
                                  onSelect={() => handleAccountSwitch(acc)}
                                  className="flex items-center py-1.5"
                                >
                                  <IconComponent className="mr-2 h-4 w-4" />
                                  <span>
                                    {acc.name} ({acc.currency})
                                  </span>
                                  <Icons.Check
                                    className={cn(
                                      "ml-auto h-4 w-4",
                                      account?.id === acc.id ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                </CommandItem>
                              );
                            })}
                          </CommandGroup>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Mobile account selector */}
              <div className="block min-w-0 sm:hidden">
                <Sheet open={mobileSelectorOpen} onOpenChange={setMobileSelectorOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="ghost"
                      className="-ml-2 h-auto min-w-0 justify-start rounded-md px-2 py-1 text-left"
                      aria-label={t("account:switch_account")}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-base font-semibold leading-tight">
                          {account?.name ?? t("account:account")}
                        </span>
                        <Icons.ChevronDown className="text-muted-foreground h-5 w-5 shrink-0" />
                      </span>
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[80vh] p-0">
                    <SheetHeader className="border-border border-b px-6 py-4">
                      <SheetTitle>{t("account:switch_account_title")}</SheetTitle>
                      <SheetDescription>{t("account:choose_account_to_view")}</SheetDescription>
                    </SheetHeader>
                    <ScrollArea className="h-[calc(80vh-5rem)] px-6 py-4">
                      <div className="space-y-6">
                        {accountsByType.map(([type, typeAccounts]) => (
                          <div key={type}>
                            <h3 className="text-muted-foreground mb-3 text-sm font-medium">
                              {type}
                            </h3>
                            <div className="space-y-2">
                              {typeAccounts.map((acc) => {
                                const IconComponent =
                                  accountTypeIcons[acc.accountType] ?? Icons.CreditCard;
                                return (
                                  <button
                                    key={acc.id}
                                    onClick={() => handleAccountSwitch(acc)}
                                    className={cn(
                                      "hover:bg-accent active:bg-accent/80 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors focus:outline-none",
                                      account?.id === acc.id
                                        ? "border-primary bg-accent"
                                        : "border-transparent",
                                    )}
                                  >
                                    <div className="bg-primary/10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                                      <IconComponent className="text-primary h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-foreground truncate font-medium">
                                        {acc.name}
                                      </div>
                                      <div className="text-muted-foreground text-sm">
                                        {acc.currency}
                                      </div>
                                    </div>
                                    {account?.id === acc.id && (
                                      <Icons.Check className="text-primary h-5 w-5 shrink-0" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </SheetContent>
                </Sheet>
              </div>
            </div>
            {!account?.group && account?.currency && (
              <p className="text-muted-foreground text-xs leading-tight md:text-sm">
                {account?.currency}
              </p>
            )}
          </div>
        </div>
      </PageHeader>
      <PageContent>
        {hasHoldings && !isHoldingsLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 pt-0 md:grid-cols-3">
              <Card className="col-span-1 md:col-span-2">
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-md">
                    <PortfolioUpdateTrigger
                      lastCalculatedAt={displayedSourceDataAsOf}
                      notices={displayedValuationNotices}
                    >
                      <div className="flex items-start gap-2">
                        <div>
                          <p className="pt-3 text-xl font-bold">
                            {isCurrentValuationLoading ? (
                              <Skeleton className="h-8 w-36" />
                            ) : isCurrentValuationUnavailable ? (
                              <span className="text-muted-foreground">
                                {t("account:not_available")}
                              </span>
                            ) : (
                              <PrivacyAmount
                                value={displayedTotalValue}
                                currency={displayedValueCurrency}
                              />
                            )}
                          </p>
                          {!hasPerformanceError && (
                            <div className="flex items-center gap-2 text-sm">
                              {gainLossAmountToDisplay == null ? (
                                <span className="text-muted-foreground text-sm font-light">
                                  {t("account:not_available")}
                                </span>
                              ) : (
                                <GainAmount
                                  className="text-sm font-light"
                                  value={gainLossAmountToDisplay}
                                  currency={gainLossCurrencyToDisplay}
                                  displayCurrency={showGainLossCurrency}
                                />
                              )}
                              {percentageToDisplay == null ? (
                                <span className="text-muted-foreground bg-foreground/10 rounded-md px-2 py-px text-xs font-light">
                                  {t("account:not_available")}
                                </span>
                              ) : (
                                <GainPercent
                                  value={percentageToDisplay}
                                  variant="badge"
                                  className="text-xs"
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </PortfolioUpdateTrigger>
                  </CardTitle>
                  <div className="-mt-3 flex items-center gap-1 self-start">
                    <PrivacyToggle />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={showSnapshotMarkers ? "default" : "secondary"}
                            size="icon-xs"
                            className={cn(
                              "rounded-full",
                              !showSnapshotMarkers && "bg-secondary/50",
                            )}
                            onClick={() => setShowSnapshotMarkers(!showSnapshotMarkers)}
                          >
                            <Icons.History className="size-5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            {showSnapshotMarkers
                              ? t("account:hide_snapshot_markers")
                              : t("account:show_snapshot_markers")}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="w-full p-0">
                    <div className="flex w-full flex-col">
                      <div className="h-120 w-full">
                        <HistoryChart
                          data={chartData}
                          isLoading={false}
                          showMarkers={showSnapshotMarkers}
                          snapshotDates={markerDates}
                          onMarkerClick={(date) => {
                            if (isHoldingsMode) {
                              // Holdings mode: open edit holdings sheet
                              setEditingSnapshotDate(date);
                              setIsEditingHoldings(true);
                            } else {
                              // Transactions mode: open activities sheet for this date
                              setSelectedActivityDate(date);
                              setIsActivitySheetOpen(true);
                            }
                          }}
                        />
                        <IntervalSelector
                          className="relative bottom-10 left-0 right-0 z-10"
                          onIntervalSelect={handleIntervalSelect}
                          isLoading={isValuationHistoryLoading}
                          defaultValue={INITIAL_INTERVAL_CODE}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex min-h-0 flex-col gap-4">
                <AccountMetrics
                  valuation={metricsValuation}
                  performance={accountPerformance}
                  cashCurrencySplit={liveCurrentValuation?.summary.cashCurrencySplit}
                  className="min-h-0 grow"
                  compact={showContributionLimitCard}
                  isLoading={isLoading}
                  isPerformanceLoading={isPerformanceHistoryLoading}
                  performanceError={hasPerformanceError ? performanceErrorMessages[0] : undefined}
                  hideBalanceEdit={isHoldingsMode || isLiabilityAccount}
                  isHoldingsMode={isHoldingsMode}
                  balanceLabel={
                    isLiabilityAccount ? t("account:balance_label") : t("account:cash_balance")
                  }
                  balanceWarning={
                    firstVisibleNegativeCashValuation && currentCashBalanceIsNegative
                      ? {
                          label: t("account:review_cash_impact"),
                          disabled: !negativeCashAuditTarget,
                          isLoading:
                            isCashAuditValuationHistoryLoading || isCashAuditActivitiesLoading,
                          onClick: () => {
                            if (!negativeCashAuditTarget) return;
                            setSelectedActivityDate(negativeCashAuditTarget.activityDate);
                            setIsActivitySheetOpen(true);
                          },
                        }
                      : undefined
                  }
                />
                {showContributionLimitCard && <AccountContributionLimit accountId={id} />}
              </div>
            </div>

            {accountDetailTabs.length > 0 ? (
              accountDetailsContent
            ) : (
              <AccountHoldings accountId={id} onAddHoldings={() => setIsEditingHoldings(true)} />
            )}
          </>
        ) : accountDetailTabs.length > 0 ? (
          accountDetailsContent
        ) : (
          <AccountHoldings
            accountId={id}
            showEmptyState={true}
            onAddHoldings={() => setIsEditingHoldings(true)}
          />
        )}
      </PageContent>

      {/* Holdings Edit Mode Sheet for manual HOLDINGS-mode accounts */}
      {account && canEditHoldingsDirectly && (
        <Sheet open={isEditingHoldings} onOpenChange={setIsEditingHoldings}>
          <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-2xl">
            <SheetHeader className="border-b px-6 py-4">
              <SheetTitle>{t("account:update_holdings_title")}</SheetTitle>
              <SheetDescription>
                {t("account:update_holdings_desc", { name: account.name })}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-hidden px-6">
              <HoldingsEditMode
                holdings={holdings ?? []}
                account={account}
                isLoading={isHoldingsLoading}
                onClose={() => {
                  setIsEditingHoldings(false);
                  setEditingSnapshotDate(null);
                }}
                existingSnapshotDate={editingSnapshotDate}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {isMobile ? (
        <MobileActivityForm
          key={selectedActivity?.id ?? "new"}
          accounts={activityFormAccounts}
          transferAccounts={activityFormAccounts}
          activity={selectedActivity}
          open={activityFormOpen}
          onClose={handleActivityFormClose}
        />
      ) : (
        <ActivityForm
          accounts={activityFormAccounts}
          transferAccounts={activityFormAccounts}
          activity={selectedActivity}
          open={activityFormOpen}
          onClose={handleActivityFormClose}
        />
      )}
      <ActivityDeleteModal
        isOpen={showActivityDeleteAlert}
        isDeleting={isActivityDeleting}
        linkedTransfer={!!selectedActivity?.sourceGroupId}
        onConfirm={handleActivityDeleteConfirm}
        onCancel={handleActivityDeleteCancel}
      />

      <ActivityDateSheet
        open={isActivitySheetOpen}
        onOpenChange={setIsActivitySheetOpen}
        date={selectedActivityDate}
        activities={selectedCashAuditActivities ?? dateActivities ?? []}
        isLoading={selectedCashAuditTarget ? isCashAuditActivitiesLoading : isDateActivitiesLoading}
        endingCashBalance={
          selectedCashAuditTarget?.endingCashBalance ?? selectedActivityDateValuation?.cashBalance
        }
        cashCurrency={
          selectedCashAuditTarget?.cashCurrency ??
          selectedActivityDateValuation?.accountCurrency ??
          account?.currency ??
          currentValuation?.accountCurrency
        }
        cashAuditTarget={selectedCashAuditTarget ?? undefined}
      />

      {/* Bulk Holdings Modal for Transfer Holdings */}
      <BulkHoldingsModal
        open={showBulkHoldingsForm}
        onClose={() => setShowBulkHoldingsForm(false)}
        defaultAccount={account}
        onSuccess={() => {
          setShowBulkHoldingsForm(false);
        }}
      />
    </Page>
  );
};

export default AccountPage;
