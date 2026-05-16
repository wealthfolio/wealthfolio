import { getAccounts } from "@/adapters";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { debounce } from "@/lib/debounce";
import { ActivityType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { Account, ActivityDetails } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Button, Icons, Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

const ActivityPage = () => {
  const [showForm, setShowForm] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Partial<ActivityDetails> | undefined>();
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [showBulkHoldingsForm, setShowBulkHoldingsForm] = useState(false);
  const [showAlternativeAssetModal, setShowAlternativeAssetModal] = useState(false);
  const [showActionPalette, setShowActionPalette] = useState(false);

  // Filter and search state
  const [selectedAccounts, setSelectedAccounts] = usePersistentState<string[]>(
    "activity-filter-accounts",
    [],
  );
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

  // Infinite scroll search for table view
  const infiniteSearch = useActivitySearch({
    mode: "infinite",
    filters: {
      accountIds: selectedAccounts,
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
      accountIds: selectedAccounts,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedAccounts,
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

  const headerActions = (
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

  return (
    <Page>
      <PageHeader heading="Activity" actions={headerActions} />
      <PageContent className="pb-2 md:pb-4 lg:pb-5">
        <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-hidden">
          {/* Unified Controls */}
          {isMobileViewport ? (
            <ActivityMobileControls
              accounts={accounts}
              searchQuery={searchInput}
              onSearchQueryChange={handleSearchChange}
              selectedAccountIds={selectedAccounts}
              onAccountIdsChange={setSelectedAccounts}
              selectedActivityTypes={selectedActivityTypes}
              onActivityTypesChange={setSelectedActivityTypes}
              isCompactView={isCompactView}
              onCompactViewChange={setIsCompactView}
            />
          ) : (
            <ActivityViewControls
              accounts={accounts}
              searchQuery={searchInput}
              onSearchQueryChange={handleSearchChange}
              selectedAccountIds={selectedAccounts}
              onAccountIdsChange={setSelectedAccounts}
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

          {/* View-Specific Renderers */}
          {isMobileViewport ? (
            <ActivityTableMobile
              activities={tableActivities}
              isCompactView={isCompactView}
              handleEdit={handleEdit}
              handleDelete={handleDelete}
              onDuplicate={handleDuplicate}
            />
          ) : isDatagridView ? (
            <ActivityDataGrid
              accounts={accounts}
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
            />
          )}

          {/* Load more pagination - only for table view (not datagrid) */}
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
        {isMobileViewport ? (
          <MobileActivityForm
            key={selectedActivity?.id ?? "new"}
            accounts={
              accounts
                ?.filter((acc: Account) => !acc.isArchived)
                .map((account: Account) => ({
                  value: account.id,
                  label: account.name,
                  currency: account.currency,
                  restrictionLevel: getActivityRestrictionLevel(account),
                })) ?? []
            }
            activity={selectedActivity}
            open={showForm}
            onClose={handleFormClose}
          />
        ) : (
          <ActivityForm
            accounts={
              accounts
                ?.filter((acc: Account) => !acc.isArchived)
                .map((account: Account) => ({
                  value: account.id,
                  label: account.name,
                  currency: account.currency,
                  restrictionLevel: getActivityRestrictionLevel(account),
                })) || []
            }
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
      </PageContent>
    </Page>
  );
};

export default ActivityPage;
