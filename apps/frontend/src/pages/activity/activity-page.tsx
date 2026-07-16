import { getAccounts } from "@/adapters";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { SwipablePage, type SwipablePageView } from "@/components/page";
import {
  SpendingTransactionsTab,
  type SpendingTransactionsTabHandle,
} from "@/features/spending/components/spending-transactions-tab";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import { SyncButton } from "@/features/wealthfolio-connect/components/sync-button";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useIsCompactTableViewport, useIsMobileViewport } from "@/hooks/use-platform";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { ActivityType } from "@/lib/constants";
import { debounce } from "@/lib/debounce";
import { QueryKeys } from "@/lib/query-keys";
import { Account, AccountScope, ActivityDetails } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { AlternativeAssetQuickAddModal } from "@/pages/asset/alternative-assets";
import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ActivityDataGrid } from "./components/activity-data-grid/activity-data-grid";
import { ActivityDeleteModal } from "./components/activity-delete-modal";
import { ActivityForm } from "./components/activity-form";
import { ActivityMobileControls } from "./components/activity-mobile-controls";
import { ActivityPagination } from "./components/activity-pagination";
import ActivityTable from "./components/activity-table/activity-table";
import ActivityTableMobile from "./components/activity-table/activity-table-mobile";
import { ActivityViewControls, type ActivityViewMode } from "./components/activity-view-controls";
import { BulkHoldingsModal } from "./components/forms/bulk-holdings-modal";
import { MobileActivityForm } from "./components/mobile-forms/mobile-activity-form";
import { TransferMatchDialog } from "./components/transfer-match-dialog";
import { useActivityActionDialogs } from "./hooks/use-activity-action-dialogs";
import { useActivitySearch, type ActivityStatusFilter } from "./hooks/use-activity-search";
import {
  clearActivityUrlFilters,
  resolveActivityTabFromUrlFilters,
  resolveActivityUrlFilters,
} from "./utils/url-filters";

interface ActivityDateRangeFilter {
  from?: string;
  to?: string;
}

interface InvestmentFilterOverrides {
  accountScope?: AccountScope;
  statusFilter?: ActivityStatusFilter;
  activityTypes?: ActivityType[];
  instrumentTypes?: string[];
  dateRange?: ActivityDateRangeFilter;
  searchQuery?: string;
}

const ALL_ACCOUNT_SCOPE: AccountScope = { type: "all" };
const EMPTY_ACTIVITY_TYPES: ActivityType[] = [];
const EMPTY_INSTRUMENT_TYPES: string[] = [];

function parseLocalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function toDateRange(value: ActivityDateRangeFilter): DateRange | undefined {
  const from = parseLocalDate(value.from);
  const to = parseLocalDate(value.to);
  return from || to ? { from, to } : undefined;
}

function fromDateRange(range: DateRange | undefined): ActivityDateRangeFilter {
  return {
    ...(range?.from ? { from: formatDateISO(range.from) } : {}),
    ...(range?.to ? { to: formatDateISO(range.to) } : {}),
  };
}

const ActivityPage = () => {
  const { t } = useTranslation();
  const [showBulkHoldingsForm, setShowBulkHoldingsForm] = useState(false);
  const [showAlternativeAssetModal, setShowAlternativeAssetModal] = useState(false);
  const [transferMatchDialog, setTransferMatchDialog] = useState<{
    open: boolean;
    mode: "link" | "unlink";
    activity: ActivityDetails | null;
  }>({ open: false, mode: "link", activity: null });
  const [showActionPalette, setShowActionPalette] = useState(false);
  const [showSpendingActionPalette, setShowSpendingActionPalette] = useState(false);
  const isMobileViewport = useIsMobileViewport();
  const isCompactTableViewport = useIsCompactTableViewport();
  const {
    selectedActivity,
    formOpen: showForm,
    deleteDialogOpen: showDeleteAlert,
    isDeleting,
    openForm: handleEdit,
    closeForm: handleFormClose,
    requestDelete: handleDelete,
    cancelDelete: handleDeleteCancel,
    confirmDelete: handleDeleteConfirm,
    duplicateActivity: handleDuplicate,
  } = useActivityActionDialogs();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activityUrlFilterKey = searchParams.toString();
  const activityUrlFilters = useMemo(
    () => resolveActivityUrlFilters(new URLSearchParams(activityUrlFilterKey)),
    [activityUrlFilterKey],
  );

  // Filter and search state
  const [persistedAccountScope, setPersistedAccountScope] = usePersistentState<AccountScope>(
    "activity-filter-scope",
    { type: "all" },
  );
  const { data: portfolios = [] } = usePortfolios();
  const [selectedActivityTypes, setSelectedActivityTypes] = usePersistentState<ActivityType[]>(
    "activity-filter-types",
    [],
  );
  const [selectedInstrumentTypes, setSelectedInstrumentTypes] = usePersistentState<string[]>(
    "activity-filter-instrument-types",
    [],
  );
  const [persistedStatusFilter, setPersistedStatusFilter] =
    usePersistentState<ActivityStatusFilter>("activity-filter-status", "all");
  const [selectedDateRange, setSelectedDateRange] = usePersistentState<ActivityDateRangeFilter>(
    "activity-filter-date-range",
    {},
  );
  const [searchInput, setSearchInput] = usePersistentState<string>("activity-filter-search", "");
  const [searchQuery, setSearchQuery] = useState(searchInput);
  const [viewMode, setViewMode] = usePersistentState<ActivityViewMode>(
    "activity-view-mode",
    "table",
  );
  const [sorting, setSorting] = usePersistentState<SortingState>("activity-filter-sorting", [
    { id: "date", desc: true },
  ]);
  const [isCompactView, setIsCompactView] = usePersistentState(
    "activity-mobile-view-compact",
    true,
  );

  // Pagination state for datagrid view
  const [pageIndex, setPageIndex] = usePersistentState("activity-datagrid-page-index", 0);
  const [pageSize, setPageSize] = usePersistentState("activity-datagrid-page-size", 50);

  const {
    isEnabled: isSpendingEnabled,
    accountIds: spendingAccountIds,
    isLoading: isSpendingSettingsLoading,
  } = useSpendingSettings();

  const hasActivityUrlFilters =
    searchParams.has("account") ||
    searchParams.has("needsReview") ||
    searchParams.has("types") ||
    searchParams.has("from") ||
    searchParams.has("to") ||
    searchParams.has("q") ||
    searchParams.has("activity") ||
    searchParams.has("healthContext");
  const isHealthActivityDeepLink = activityUrlFilters.healthContext === "activity";
  const accountScope =
    activityUrlFilters.accountScope ??
    (hasActivityUrlFilters ? ALL_ACCOUNT_SCOPE : persistedAccountScope);
  const statusFilter =
    activityUrlFilters.statusFilter ?? (hasActivityUrlFilters ? "all" : persistedStatusFilter);
  // Health Center deeplinks can scope the list to specific activity types / a date
  // window (e.g. transfers around an incomplete-transfer issue). URL wins over persisted.
  const urlActivityTypes = activityUrlFilters.activityTypes;
  const effectiveActivityTypes =
    urlActivityTypes ?? (hasActivityUrlFilters ? EMPTY_ACTIVITY_TYPES : selectedActivityTypes);
  const urlDateFrom = activityUrlFilters.dateFrom;
  const urlDateTo = activityUrlFilters.dateTo;
  const effectiveDateFrom =
    urlDateFrom ?? (hasActivityUrlFilters ? undefined : selectedDateRange.from);
  const effectiveDateTo = urlDateTo ?? (hasActivityUrlFilters ? undefined : selectedDateRange.to);
  const urlSearchQuery = activityUrlFilters.searchQuery;
  const effectiveSearchQuery = urlSearchQuery ?? (hasActivityUrlFilters ? "" : searchQuery);
  const displayedSearchInput = urlSearchQuery ?? (hasActivityUrlFilters ? "" : searchInput);
  const effectiveInstrumentTypes = useMemo(
    () => (hasActivityUrlFilters ? EMPTY_INSTRUMENT_TYPES : selectedInstrumentTypes),
    [hasActivityUrlFilters, selectedInstrumentTypes],
  );
  const effectiveDateRange = useMemo(
    () => toDateRange({ from: effectiveDateFrom, to: effectiveDateTo }),
    [effectiveDateFrom, effectiveDateTo],
  );

  const clearActivityUrlFilterParams = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = clearActivityUrlFilters(prev);
        return next.toString() === prev.toString() ? prev : next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const materializeInvestmentFilters = useCallback(
    (overrides: InvestmentFilterOverrides = {}) => {
      setPersistedAccountScope(overrides.accountScope ?? accountScope);
      setPersistedStatusFilter(overrides.statusFilter ?? statusFilter);
      setSelectedActivityTypes(overrides.activityTypes ?? effectiveActivityTypes);
      setSelectedInstrumentTypes(overrides.instrumentTypes ?? effectiveInstrumentTypes);
      setSelectedDateRange(overrides.dateRange ?? { from: effectiveDateFrom, to: effectiveDateTo });

      const nextSearchQuery = overrides.searchQuery ?? displayedSearchInput;
      setSearchInput(nextSearchQuery);
      setSearchQuery(nextSearchQuery);

      if (hasActivityUrlFilters) {
        clearActivityUrlFilterParams();
      }
    },
    [
      accountScope,
      clearActivityUrlFilterParams,
      displayedSearchInput,
      effectiveActivityTypes,
      effectiveDateFrom,
      effectiveDateTo,
      effectiveInstrumentTypes,
      hasActivityUrlFilters,
      setPersistedAccountScope,
      setPersistedStatusFilter,
      setSearchInput,
      setSelectedActivityTypes,
      setSelectedDateRange,
      setSelectedInstrumentTypes,
      statusFilter,
    ],
  );

  const setAccountScope = useCallback(
    (scope: AccountScope) => {
      materializeInvestmentFilters({ accountScope: scope });
    },
    [materializeInvestmentFilters],
  );

  const setStatusFilter = useCallback(
    (status: ActivityStatusFilter) => {
      materializeInvestmentFilters({ statusFilter: status });
    },
    [materializeInvestmentFilters],
  );

  const setInvestmentDateRange = useCallback(
    (range: DateRange | undefined) => {
      materializeInvestmentFilters({ dateRange: fromDateRange(range) });
    },
    [materializeInvestmentFilters],
  );

  const setInvestmentActivityTypes = useCallback(
    (types: ActivityType[]) => {
      materializeInvestmentFilters({ activityTypes: types });
    },
    [materializeInvestmentFilters],
  );

  const setInvestmentInstrumentTypes = useCallback(
    (types: string[]) => {
      materializeInvestmentFilters({ instrumentTypes: types });
    },
    [materializeInvestmentFilters],
  );

  // handle filter changes in mobile form
  const setMobileFilters = useCallback(
    (types: ActivityType[], range: DateRange | undefined, scope: AccountScope) => {
      materializeInvestmentFilters({
        accountScope: scope,
        activityTypes: types,
        dateRange: fromDateRange(range),
      });
    },
    [materializeInvestmentFilters],
  );

  // Coerce "spending" URL state back to investments when the module is disabled.
  const urlTab = searchParams.get("tab");
  useEffect(() => {
    if (urlTab === "spending" && !isSpendingSettingsLoading && !isSpendingEnabled) {
      const next = new URLSearchParams(searchParams);
      next.delete("tab");
      setSearchParams(next, { replace: true });
    }
  }, [urlTab, isSpendingSettingsLoading, isSpendingEnabled, searchParams, setSearchParams]);

  useEffect(() => {
    if (!isSpendingEnabled || isSpendingSettingsLoading) return;

    const targetTab = resolveActivityTabFromUrlFilters(searchParams, spendingAccountIds);
    if (!targetTab || urlTab === targetTab) return;

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", targetTab);
        return next;
      },
      { replace: true },
    );
  }, [
    isSpendingEnabled,
    isSpendingSettingsLoading,
    searchParams,
    setSearchParams,
    spendingAccountIds,
    urlTab,
  ]);

  const spendingTabRef = useRef<SpendingTransactionsTabHandle | null>(null);

  // Debounced search handler
  const debouncedUpdateSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearchQuery(value);
      }, 500),
    [],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (hasActivityUrlFilters) {
        materializeInvestmentFilters({ searchQuery: value });
        return;
      }
      debouncedUpdateSearch(value);
    },
    [debouncedUpdateSearch, hasActivityUrlFilters, materializeInvestmentFilters, setSearchInput],
  );

  // Cleanup debounced function on unmount
  useEffect(() => {
    return () => {
      debouncedUpdateSearch.cancel();
    };
  }, [debouncedUpdateSearch]);

  const { data: accounts = [] } = useQuery<Account[], Error>({
    queryKey: [QueryKeys.ACCOUNTS],
    queryFn: () => getAccounts(),
  });

  const isDatagridView = viewMode === "datagrid";
  const shouldUseDatagridView = isDatagridView && !isCompactTableViewport;

  // Resolve the typed scope to a flat account ID list for the activity search.
  const effectiveAccountIds = useMemo<string[] | undefined>(() => {
    if (accountScope.type === "account") return [accountScope.accountId];
    if (accountScope.type === "accounts") return accountScope.accountIds;
    if (accountScope.type === "portfolio") {
      return portfolios.find((p) => p.id === accountScope.portfolioId)?.accountIds ?? [];
    }
    return undefined; // "all" → no filter
  }, [accountScope, portfolios]);

  // Accounts opted into the Spending module are shown on the Spending tab; the
  // Investments tab must exclude them so cash/credit-card activity doesn't double-up.
  const investmentAccounts = useMemo(() => {
    if (!isSpendingEnabled || spendingAccountIds.length === 0) return accounts;
    const excluded = new Set(spendingAccountIds);
    return accounts.filter((a) => !excluded.has(a.id));
  }, [accounts, spendingAccountIds, isSpendingEnabled]);

  const investmentAccountIds = useMemo(
    () => investmentAccounts.map((a) => a.id),
    [investmentAccounts],
  );

  const activityFormAccounts = useMemo(() => {
    const source = isSpendingEnabled ? investmentAccounts : accounts;
    const selectedAccount = selectedActivity?.accountId
      ? accounts.find((account) => account.id === selectedActivity.accountId)
      : undefined;
    const list =
      selectedAccount && !source.some((account) => account.id === selectedAccount.id)
        ? [...source, selectedAccount]
        : source;

    return list
      .filter((acc: Account) => !acc.isArchived)
      .map((account: Account) => ({
        value: account.id,
        label: account.name,
        currency: account.currency,
        accountType: account.accountType,
        restrictionLevel: getActivityRestrictionLevel(account),
      }));
  }, [accounts, investmentAccounts, isSpendingEnabled, selectedActivity?.accountId]);

  // Transfers move money between ANY accounts, including spending/saving cash
  // accounts that the Spending split otherwise hides from the Investments view.
  // The Transfer form's From/To selectors use this full active-account list so
  // that bridge (e.g. brokerage ↔ savings) can be recorded.
  const transferFormAccounts = useMemo(
    () =>
      accounts
        .filter((acc: Account) => !acc.isArchived)
        .map((account: Account) => ({
          value: account.id,
          label: account.name,
          currency: account.currency,
          accountType: account.accountType,
          restrictionLevel: getActivityRestrictionLevel(account),
        })),
    [accounts],
  );

  // Intersect main's scope-resolved IDs with the spending-excluded set so the
  // Investments tab respects both the typed AccountScope (main's
  // portfolio-filters work) AND the spending opt-in partitioning (this
  // branch's work). Empty effectiveAccountIds means "all" — collapses to
  // the investment-only set.
  const effectiveInvestmentAccountIds = useMemo(() => {
    if (!isSpendingEnabled || spendingAccountIds.length === 0) return effectiveAccountIds;
    if (!effectiveAccountIds || effectiveAccountIds.length === 0) return investmentAccountIds;
    const allowed = new Set(investmentAccountIds);
    return effectiveAccountIds.filter((id) => allowed.has(id));
  }, [effectiveAccountIds, investmentAccountIds, isSpendingEnabled, spendingAccountIds]);

  // A health-check deep-link (?activity=<id>) pins the list to one transaction,
  // filtered server-side so it's found regardless of paging.
  const activityIdFilter = activityUrlFilters.activityId
    ? [activityUrlFilters.activityId]
    : undefined;

  // Infinite scroll search for table view
  const infiniteSearch = useActivitySearch({
    mode: "infinite",
    filters: {
      accountIds: effectiveInvestmentAccountIds,
      activityTypes: effectiveActivityTypes,
      instrumentTypes: effectiveInstrumentTypes,
      status: statusFilter,
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      activityIds: activityIdFilter,
    },
    searchQuery: effectiveSearchQuery,
    sorting,
  });

  // Paginated search for datagrid view
  const paginatedSearch = useActivitySearch({
    mode: "paginated",
    filters: {
      accountIds: effectiveInvestmentAccountIds,
      activityTypes: effectiveActivityTypes,
      instrumentTypes: effectiveInstrumentTypes,
      status: statusFilter,
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      activityIds: activityIdFilter,
    },
    searchQuery: effectiveSearchQuery,
    sorting,
    pageIndex,
    pageSize,
  });

  // Reset page index when filters or search change (only for datagrid)
  useEffect(() => {
    if (isDatagridView) {
      setPageIndex(0);
    }
  }, [
    effectiveInvestmentAccountIds,
    isDatagridView,
    effectiveActivityTypes,
    effectiveInstrumentTypes,
    statusFilter,
    effectiveDateFrom,
    effectiveDateTo,
    effectiveSearchQuery,
    setPageIndex,
    sorting,
  ]);

  // Use appropriate data based on view mode. The ?activity=<id> deep-link is
  // applied server-side via the activityIds filter, so no client-side narrowing.
  const tableActivities = infiniteSearch.data;
  const datagridActivities = paginatedSearch.data;
  const totalFetched = tableActivities.length;
  const totalRowCount = shouldUseDatagridView
    ? paginatedSearch.totalRowCount
    : infiniteSearch.totalRowCount;

  const handleLinkTransfer = useCallback((activity: ActivityDetails) => {
    setTransferMatchDialog({ open: true, mode: "link", activity });
  }, []);

  const handleUnlinkTransfer = useCallback((activity: ActivityDetails) => {
    setTransferMatchDialog({ open: true, mode: "unlink", activity });
  }, []);

  const investmentsFiltersActive =
    accountScope.type !== "all" ||
    effectiveActivityTypes.length > 0 ||
    effectiveInstrumentTypes.length > 0 ||
    statusFilter !== "all" ||
    !!effectiveDateFrom ||
    !!effectiveDateTo ||
    displayedSearchInput.trim().length > 0;

  const clearInvestmentsFilters = useCallback(() => {
    debouncedUpdateSearch.cancel();
    setPersistedAccountScope({ type: "all" });
    setSelectedActivityTypes([]);
    setSelectedInstrumentTypes([]);
    setPersistedStatusFilter("all");
    setSelectedDateRange({});
    setSearchInput("");
    setSearchQuery("");
    clearActivityUrlFilterParams();
  }, [
    clearActivityUrlFilterParams,
    debouncedUpdateSearch,
    setPersistedAccountScope,
    setSelectedActivityTypes,
    setSelectedInstrumentTypes,
    setPersistedStatusFilter,
    setSelectedDateRange,
    setSearchInput,
  ]);

  const actionPaletteGroups: ActionPaletteGroup[] = useMemo(
    () => [
      {
        items: [
          {
            icon: Icons.Activity,
            label: t("activity:add_transaction"),
            testId: "add-transaction-action",
            onClick: () => handleEdit(undefined),
          },
          {
            icon: Icons.UploadSimple,
            label: t("activity:page.import_from_csv"),
            testId: "import-activities-action",
            onClick: () => navigate("/import"),
          },
          {
            icon: Icons.Holdings,
            label: t("activity:page.transfer_holdings"),
            testId: "transfer-holdings-action",
            onClick: () => setShowBulkHoldingsForm(true),
          },
          {
            icon: Icons.House,
            label: t("activity:page.add_personal_asset"),
            testId: "add-personal-asset-action",
            onClick: () => setShowAlternativeAssetModal(true),
          },
        ],
      },
    ],
    [handleEdit, navigate, t],
  );

  const investmentActions = (
    <div className="flex flex-wrap items-center gap-2">
      <SyncButton />
      {/* Desktop action palette */}
      <div className="hidden sm:flex">
        <ActionPalette
          open={showActionPalette}
          onOpenChange={setShowActionPalette}
          groups={actionPaletteGroups}
          trigger={
            <Button data-testid="add-activities-button" size="sm">
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("activity:page.add_activities")}
            </Button>
          }
        />
      </div>

      {/* Mobile add button */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button size="icon" title={t("common:import")} variant="outline" asChild>
          <Link to={"/import"}>
            <Icons.Import className="size-4" />
          </Link>
        </Button>
        <Button size="icon" title={t("common:add")} onClick={() => handleEdit(undefined)}>
          <Icons.Plus className="size-4" />
        </Button>
      </div>
    </div>
  );

  const spendingActionPaletteGroups: ActionPaletteGroup[] = useMemo(
    () => [
      {
        items: [
          {
            icon: Icons.Activity,
            label: t("activity:add_transaction"),
            testId: "add-transaction-action",
            onClick: () => spendingTabRef.current?.openAddForm(),
          },
          {
            icon: Icons.UploadSimple,
            label: t("activity:page.import_from_csv"),
            testId: "import-activities-action",
            onClick: () => navigate("/import"),
          },
        ],
      },
    ],
    [navigate, t],
  );

  const spendingActions = (
    <div className="flex flex-wrap items-center gap-2">
      <SyncButton />
      {/* Ask AI to categorize uncategorized transactions */}
      <Button
        asChild
        size="icon"
        variant="outline"
        title={t("activity:page.ask_ai_categorize")}
        aria-label={t("activity:page.ask_ai_categorize")}
      >
        <Link
          to="/assistant"
          state={{ aiPrompt: "Help me categorize all my uncategorized transactions." }}
        >
          <Icons.Sparkles className="size-4" />
        </Link>
      </Button>
      {/* Desktop action palette */}
      <div className="hidden sm:flex">
        <ActionPalette
          open={showSpendingActionPalette}
          onOpenChange={setShowSpendingActionPalette}
          groups={spendingActionPaletteGroups}
          trigger={
            <Button data-testid="add-activities-button" size="sm">
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("activity:page.add_activities")}
            </Button>
          }
        />
      </div>

      {/* Mobile add button */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button size="icon" title={t("common:import")} variant="outline" asChild>
          <Link to={"/import"}>
            <Icons.Import className="size-4" />
          </Link>
        </Button>
        <Button
          size="icon"
          title={t("common:add")}
          onClick={() => spendingTabRef.current?.openAddForm()}
        >
          <Icons.Plus className="size-4" />
        </Button>
      </div>
    </div>
  );

  const investmentContent = (
    <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-hidden">
      {isHealthActivityDeepLink && (
        <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icons.Info className="text-muted-foreground h-4 w-4 shrink-0" />
            <p className="text-sm">
              {activityUrlFilters.activityId
                ? "Showing the transaction flagged by Health Center"
                : "Showing transactions flagged by Health Center"}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={clearActivityUrlFilterParams}>
            Clear
          </Button>
        </div>
      )}

      {isMobileViewport ? (
        <ActivityMobileControls
          accounts={investmentAccounts}
          portfolios={portfolios}
          searchQuery={displayedSearchInput}
          onSearchQueryChange={handleSearchChange}
          accountScope={accountScope}
          selectedActivityTypes={effectiveActivityTypes}
          dateRange={effectiveDateRange}
          isCompactView={isCompactView}
          onCompactViewChange={setIsCompactView}
          onFilterChange={setMobileFilters}
        />
      ) : (
        <ActivityViewControls
          accounts={investmentAccounts}
          portfolios={portfolios}
          searchQuery={displayedSearchInput}
          onSearchQueryChange={handleSearchChange}
          accountScope={accountScope}
          onAccountScopeChange={setAccountScope}
          selectedActivityTypes={effectiveActivityTypes}
          onActivityTypesChange={setInvestmentActivityTypes}
          selectedInstrumentTypes={effectiveInstrumentTypes}
          onInstrumentTypesChange={setInvestmentInstrumentTypes}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          dateRange={effectiveDateRange}
          onDateRangeChange={setInvestmentDateRange}
          onResetFilters={clearInvestmentsFilters}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          totalFetched={shouldUseDatagridView ? undefined : totalFetched}
          totalRowCount={shouldUseDatagridView ? undefined : totalRowCount}
          isFetching={
            shouldUseDatagridView ? paginatedSearch.isFetching : infiniteSearch.isFetching
          }
        />
      )}

      {isCompactTableViewport ? (
        <ActivityTableMobile
          activities={tableActivities}
          isCompactView={isCompactView}
          handleEdit={handleEdit}
          handleDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onLinkTransfer={handleLinkTransfer}
          onUnlinkTransfer={handleUnlinkTransfer}
          filtersActive={investmentsFiltersActive}
          onAdd={() => handleEdit(undefined)}
          onClearFilters={clearInvestmentsFilters}
        />
      ) : shouldUseDatagridView ? (
        <ActivityDataGrid
          accounts={investmentAccounts}
          transferMatchAccounts={accounts}
          activities={datagridActivities}
          onRefetch={paginatedSearch.refetch}
          onEditActivity={handleEdit}
          sorting={sorting}
          onSortingChange={setSorting}
          pageIndex={pageIndex}
          pageSize={pageSize}
          pageCount={paginatedSearch.pageCount}
          totalRowCount={paginatedSearch.totalRowCount}
          isFetching={paginatedSearch.isFetching}
          onPageChange={setPageIndex}
          onPageSizeChange={setPageSize}
        />
      ) : (
        <ActivityTable
          activities={tableActivities}
          isLoading={infiniteSearch.isLoading}
          sorting={sorting}
          onSortingChange={setSorting}
          handleEdit={handleEdit}
          handleDelete={handleDelete}
          onLinkTransfer={handleLinkTransfer}
          onUnlinkTransfer={handleUnlinkTransfer}
          filtersActive={investmentsFiltersActive}
          onAdd={() => handleEdit(undefined)}
          onClearFilters={clearInvestmentsFilters}
        />
      )}

      {!shouldUseDatagridView && (
        <ActivityPagination
          hasMore={infiniteSearch.hasNextPage ?? false}
          onLoadMore={infiniteSearch.fetchNextPage}
          isFetching={infiniteSearch.isFetchingNextPage}
          totalFetched={totalFetched}
          totalCount={infiniteSearch.totalRowCount}
        />
      )}
    </div>
  );

  const sharedModals = (
    <>
      {isMobileViewport ? (
        <MobileActivityForm
          key={selectedActivity?.id ?? "new"}
          accounts={activityFormAccounts}
          transferAccounts={transferFormAccounts}
          activity={selectedActivity}
          open={showForm}
          onClose={handleFormClose}
        />
      ) : (
        <ActivityForm
          accounts={activityFormAccounts}
          transferAccounts={transferFormAccounts}
          activity={selectedActivity}
          open={showForm}
          onClose={handleFormClose}
        />
      )}
      <ActivityDeleteModal
        isOpen={showDeleteAlert}
        isDeleting={isDeleting}
        linkedTransfer={!!selectedActivity?.sourceGroupId}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
      <BulkHoldingsModal
        open={showBulkHoldingsForm}
        onClose={() => setShowBulkHoldingsForm(false)}
        onSuccess={() => {
          setShowBulkHoldingsForm(false);
        }}
      />
      <AlternativeAssetQuickAddModal
        open={showAlternativeAssetModal}
        onOpenChange={setShowAlternativeAssetModal}
      />
      <TransferMatchDialog
        open={transferMatchDialog.open}
        mode={transferMatchDialog.mode}
        sourceActivity={transferMatchDialog.activity}
        accounts={accounts}
        onOpenChange={(open) =>
          setTransferMatchDialog((prev) => ({
            ...prev,
            open,
            activity: open ? prev.activity : null,
          }))
        }
        onComplete={infiniteSearch.refetch}
      />
    </>
  );

  // When spending is disabled, keep the classic Activity page header — no pills.
  if (!isSpendingEnabled) {
    return (
      <Page>
        <PageHeader actions={investmentActions} />
        <PageContent className="pb-2 md:pb-4 lg:pb-5">{investmentContent}</PageContent>
        {sharedModals}
      </Page>
    );
  }

  const views: SwipablePageView[] = [
    {
      value: "investments",
      label: t("activity:page.investments"),
      icon: Icons.TrendingUp,
      content: investmentContent,
      actions: investmentActions,
    },
    {
      value: "spending",
      label: t("activity:page.spending"),
      icon: Icons.Wallet,
      content: <SpendingTransactionsTab ref={spendingTabRef} />,
      actions: spendingActions,
    },
  ];

  return (
    <>
      <SwipablePage views={views} defaultView="investments" persistKey="activity-page-tab" />
      {sharedModals}
    </>
  );
};

export default ActivityPage;
