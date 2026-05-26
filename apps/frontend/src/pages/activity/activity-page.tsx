import { getAccounts } from "@/adapters";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { usePortfolios } from "@/hooks/use-portfolios";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { debounce } from "@/lib/debounce";
import { ActivityType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { Account, AccountScope, ActivityDetails } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { ActivityDeleteModal } from "./components/activity-delete-modal";
import { ActivityDataGrid } from "./components/activity-data-grid/activity-data-grid";
import { ActivityForm } from "./components/activity-form";
import { ActivityMobileControls } from "./components/activity-mobile-controls";
import { ActivityPagination } from "./components/activity-pagination";
import ActivityTable from "./components/activity-table/activity-table";
import ActivityTableMobile from "./components/activity-table/activity-table-mobile";
import { ActivityViewControls, type ActivityViewMode } from "./components/activity-view-controls";
import { BulkHoldingsModal } from "./components/forms/bulk-holdings-modal";
import { MobileActivityForm } from "./components/mobile-forms/mobile-activity-form";
import { useActivityMutations } from "./hooks/use-activity-mutations";
import { useActivitySearch, type ActivityStatusFilter } from "./hooks/use-activity-search";
import { SyncButton } from "@/features/wealthfolio-connect/components/sync-button";
import { AlternativeAssetQuickAddModal } from "@/pages/asset/alternative-assets";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { SwipablePage, type SwipablePageView } from "@/components/page";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import {
  SpendingTransactionsTab,
  type SpendingTransactionsTabHandle,
} from "@/features/spending/components/spending-transactions-tab";

const ActivityPage = () => {
  const [showForm, setShowForm] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Partial<ActivityDetails> | undefined>();
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [showBulkHoldingsForm, setShowBulkHoldingsForm] = useState(false);
  const [showAlternativeAssetModal, setShowAlternativeAssetModal] = useState(false);
  const [showActionPalette, setShowActionPalette] = useState(false);
  const [showSpendingActionPalette, setShowSpendingActionPalette] = useState(false);

  // Filter and search state
  const [accountScope, setAccountScope] = usePersistentState<AccountScope>(
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
  const [statusFilter, setStatusFilter] = usePersistentState<ActivityStatusFilter>(
    "activity-filter-status",
    "all",
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

  const isMobileViewport = useIsMobileViewport();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    isEnabled: isSpendingEnabled,
    accountIds: spendingAccountIds,
    isLoading: isSpendingSettingsLoading,
  } = useSpendingSettings();

  // Coerce "spending" URL state back to investments when the module is disabled.
  const urlTab = searchParams.get("tab");
  useEffect(() => {
    if (urlTab === "spending" && !isSpendingSettingsLoading && !isSpendingEnabled) {
      const next = new URLSearchParams(searchParams);
      next.delete("tab");
      setSearchParams(next, { replace: true });
    }
  }, [urlTab, isSpendingSettingsLoading, isSpendingEnabled, searchParams, setSearchParams]);

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
      debouncedUpdateSearch(value);
    },
    [debouncedUpdateSearch],
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

  const { deleteActivityMutation, duplicateActivityMutation } = useActivityMutations();

  const isDatagridView = viewMode === "datagrid";

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
        restrictionLevel: getActivityRestrictionLevel(account),
      }));
  }, [accounts, investmentAccounts, isSpendingEnabled, selectedActivity?.accountId]);

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

  // Infinite scroll search for table view
  const infiniteSearch = useActivitySearch({
    mode: "infinite",
    filters: {
      accountIds: effectiveInvestmentAccountIds,
      activityTypes: selectedActivityTypes,
      instrumentTypes: selectedInstrumentTypes,
      status: statusFilter,
    },
    searchQuery,
    sorting,
  });

  // Paginated search for datagrid view
  const paginatedSearch = useActivitySearch({
    mode: "paginated",
    filters: {
      accountIds: effectiveInvestmentAccountIds,
      activityTypes: selectedActivityTypes,
      instrumentTypes: selectedInstrumentTypes,
      status: statusFilter,
    },
    searchQuery,
    sorting,
    pageIndex,
    pageSize,
  });

  // Reset page index when filters or search change (only for datagrid)
  useEffect(() => {
    if (isDatagridView && pageIndex !== 0) {
      setPageIndex(0);
    }
  }, [
    effectiveInvestmentAccountIds,
    isDatagridView,
    pageIndex,
    selectedActivityTypes,
    selectedInstrumentTypes,
    statusFilter,
    searchQuery,
    sorting,
  ]);

  // Use appropriate data based on view mode
  const tableActivities = infiniteSearch.data;
  const datagridActivities = paginatedSearch.data;
  const totalFetched = tableActivities.length;
  const totalRowCount = isDatagridView
    ? paginatedSearch.totalRowCount
    : infiniteSearch.totalRowCount;

  const handleEdit = useCallback((activity?: ActivityDetails, activityType?: ActivityType) => {
    setSelectedActivity(activity ?? { activityType });
    setShowForm(true);
  }, []);

  const handleDelete = useCallback((activity: ActivityDetails) => {
    setSelectedActivity(activity);
    setShowDeleteAlert(true);
  }, []);

  const handleDuplicate = useCallback(
    async (activity: ActivityDetails) => {
      await duplicateActivityMutation.mutateAsync(activity);
    },
    [duplicateActivityMutation],
  );

  const handleDeleteConfirm = async () => {
    if (!selectedActivity?.id) return;
    await deleteActivityMutation.mutateAsync(selectedActivity.id);
    setShowDeleteAlert(false);
    setSelectedActivity(undefined);
  };

  const handleFormClose = useCallback(() => {
    setShowForm(false);
    setSelectedActivity(undefined);
  }, []);

  const investmentsFiltersActive =
    accountScope.type !== "all" ||
    selectedActivityTypes.length > 0 ||
    selectedInstrumentTypes.length > 0 ||
    statusFilter !== "all" ||
    searchInput.trim().length > 0;

  const clearInvestmentsFilters = useCallback(() => {
    setAccountScope({ type: "all" });
    setSelectedActivityTypes([]);
    setSelectedInstrumentTypes([]);
    setStatusFilter("all");
    setSearchInput("");
    setSearchQuery("");
  }, [
    setAccountScope,
    setSelectedActivityTypes,
    setSelectedInstrumentTypes,
    setStatusFilter,
    setSearchInput,
  ]);

  const actionPaletteGroups: ActionPaletteGroup[] = useMemo(
    () => [
      {
        items: [
          {
            icon: Icons.Activity,
            label: "Add Transaction",
            onClick: () => handleEdit(undefined),
          },
          {
            icon: Icons.UploadSimple,
            label: "Import from CSV",
            onClick: () => navigate("/import"),
          },
          {
            icon: Icons.Holdings,
            label: "Transfer Holdings",
            onClick: () => setShowBulkHoldingsForm(true),
          },
          {
            icon: Icons.House,
            label: "Add Personal Asset",
            onClick: () => setShowAlternativeAssetModal(true),
          },
        ],
      },
    ],
    [handleEdit, navigate],
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
            <Button size="sm">
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add Activities
            </Button>
          }
        />
      </div>

      {/* Mobile add button */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button size="icon" title="Import" variant="outline" asChild>
          <Link to={"/import"}>
            <Icons.Import className="size-4" />
          </Link>
        </Button>
        <Button size="icon" title="Add" onClick={() => handleEdit(undefined)}>
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
            label: "Add Transaction",
            onClick: () => spendingTabRef.current?.openAddForm(),
          },
          {
            icon: Icons.UploadSimple,
            label: "Import from CSV",
            onClick: () => navigate("/import"),
          },
        ],
      },
    ],
    [navigate],
  );

  const spendingActions = (
    <div className="flex flex-wrap items-center gap-2">
      <SyncButton />
      {/* Desktop action palette */}
      <div className="hidden sm:flex">
        <ActionPalette
          open={showSpendingActionPalette}
          onOpenChange={setShowSpendingActionPalette}
          groups={spendingActionPaletteGroups}
          trigger={
            <Button size="sm">
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add Activities
            </Button>
          }
        />
      </div>

      {/* Mobile add button */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button size="icon" title="Import" variant="outline" asChild>
          <Link to={"/import"}>
            <Icons.Import className="size-4" />
          </Link>
        </Button>
        <Button size="icon" title="Add" onClick={() => spendingTabRef.current?.openAddForm()}>
          <Icons.Plus className="size-4" />
        </Button>
      </div>
    </div>
  );

  const investmentContent = (
    <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-hidden">
      {isMobileViewport ? (
        <ActivityMobileControls
          accounts={investmentAccounts}
          portfolios={portfolios}
          searchQuery={searchInput}
          onSearchQueryChange={handleSearchChange}
          accountScope={accountScope}
          onAccountScopeChange={setAccountScope}
          selectedActivityTypes={selectedActivityTypes}
          onActivityTypesChange={setSelectedActivityTypes}
          isCompactView={isCompactView}
          onCompactViewChange={setIsCompactView}
        />
      ) : (
        <ActivityViewControls
          searchQuery={searchInput}
          onSearchQueryChange={handleSearchChange}
          accountScope={accountScope}
          onAccountScopeChange={setAccountScope}
          selectedActivityTypes={selectedActivityTypes}
          onActivityTypesChange={setSelectedActivityTypes}
          selectedInstrumentTypes={selectedInstrumentTypes}
          onInstrumentTypesChange={setSelectedInstrumentTypes}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          totalFetched={isDatagridView ? undefined : totalFetched}
          totalRowCount={isDatagridView ? undefined : totalRowCount}
          isFetching={isDatagridView ? paginatedSearch.isFetching : infiniteSearch.isFetching}
        />
      )}

      {isMobileViewport ? (
        <ActivityTableMobile
          activities={tableActivities}
          isCompactView={isCompactView}
          handleEdit={handleEdit}
          handleDelete={handleDelete}
          onDuplicate={handleDuplicate}
          filtersActive={investmentsFiltersActive}
          onAdd={() => handleEdit(undefined)}
          onClearFilters={clearInvestmentsFilters}
        />
      ) : isDatagridView ? (
        <ActivityDataGrid
          accounts={investmentAccounts}
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
          filtersActive={investmentsFiltersActive}
          onAdd={() => handleEdit(undefined)}
          onClearFilters={clearInvestmentsFilters}
        />
      )}

      {!isDatagridView && (
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
          activity={selectedActivity}
          open={showForm}
          onClose={handleFormClose}
        />
      ) : (
        <ActivityForm
          accounts={activityFormAccounts}
          activity={selectedActivity}
          open={showForm}
          onClose={handleFormClose}
        />
      )}
      <ActivityDeleteModal
        isOpen={showDeleteAlert}
        isDeleting={deleteActivityMutation.isPending}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setShowDeleteAlert(false);
          setSelectedActivity(undefined);
        }}
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
    </>
  );

  // When spending is disabled, keep the classic Activity page header — no pills.
  if (!isSpendingEnabled) {
    return (
      <Page>
        <PageHeader heading="Activity" actions={investmentActions} />
        <PageContent className="pb-2 md:pb-4 lg:pb-5">{investmentContent}</PageContent>
        {sharedModals}
      </Page>
    );
  }

  const views: SwipablePageView[] = [
    {
      value: "investments",
      label: "Investments",
      icon: Icons.TrendingUp,
      content: investmentContent,
      actions: investmentActions,
    },
    {
      value: "spending",
      label: "Spending",
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
