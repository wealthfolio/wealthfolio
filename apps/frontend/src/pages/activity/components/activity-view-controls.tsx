import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DateRange } from "react-day-picker";

import { DateRangeFilter } from "@/features/spending/components/date-range-filter";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType, ActivityTypeNames, INSTRUMENT_TYPE_OPTIONS } from "@/lib/constants";
import { debounce } from "@/lib/debounce";
import type { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import {
  AnimatedToggleGroup,
  Button,
  FacetedFilter,
  FacetedSearchInput,
  Icons,
} from "@wealthfolio/ui";
import type { ActivityStatusFilter } from "../hooks/use-activity-search";

export type ActivityViewMode = "table" | "datagrid";

interface ActivityViewControlsProps {
  accounts: Account[];
  portfolios: PortfolioWithAccounts[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  accountScope: AccountScope;
  onAccountScopeChange: (scope: AccountScope) => void;
  selectedActivityTypes: ActivityType[];
  onActivityTypesChange: (types: ActivityType[]) => void;
  selectedInstrumentTypes: string[];
  onInstrumentTypesChange: (types: string[]) => void;
  statusFilter: ActivityStatusFilter;
  onStatusFilterChange: (status: ActivityStatusFilter) => void;
  dateRange: DateRange | undefined;
  onDateRangeChange: (range: DateRange | undefined) => void;
  onResetFilters: () => void;
  viewMode: ActivityViewMode;
  onViewModeChange: (mode: ActivityViewMode) => void;
  /** Shown only in table view - number of activities fetched so far */
  totalFetched?: number;
  /** Shown only in table view - total number of activities matching filters */
  totalRowCount?: number;
  isFetching: boolean;
}

function accountIdsForScope(scope: AccountScope, portfolios: PortfolioWithAccounts[]): string[] {
  if (scope.type === "account") return [scope.accountId];
  if (scope.type === "accounts") return scope.accountIds;
  if (scope.type === "portfolio") {
    return portfolios.find((portfolio) => portfolio.id === scope.portfolioId)?.accountIds ?? [];
  }
  return [];
}

function scopeFromAccountIds(accountIds: string[]): AccountScope {
  if (accountIds.length === 0) return { type: "all" };
  if (accountIds.length === 1) return { type: "account", accountId: accountIds[0] };
  return { type: "accounts", accountIds };
}

export function ActivityViewControls({
  accounts,
  portfolios,
  searchQuery,
  onSearchQueryChange,
  accountScope,
  onAccountScopeChange,
  selectedActivityTypes,
  onActivityTypesChange,
  selectedInstrumentTypes,
  onInstrumentTypesChange,
  statusFilter,
  onStatusFilterChange,
  dateRange,
  onDateRangeChange,
  onResetFilters,
  viewMode,
  onViewModeChange,
  totalFetched,
  totalRowCount,
  isFetching,
}: ActivityViewControlsProps) {
  const { t } = useTranslation();
  const [localSearch, setLocalSearch] = useState(searchQuery);

  // Create a stable debounced search function
  const debouncedSearch = useMemo(
    () => debounce((value: string) => onSearchQueryChange(value), 200),
    [onSearchQueryChange],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedSearch.cancel();
    };
  }, [debouncedSearch]);

  // Sync local state when search query changes externally (e.g., reset)
  useEffect(() => {
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  const accountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: `${account.name} (${account.currency})`,
      })),
    [accounts],
  );

  const selectableAccountIds = useMemo(
    () => new Set(accountOptions.map((option) => option.value)),
    [accountOptions],
  );

  const selectedAccountIds = useMemo(
    () =>
      new Set(
        accountIdsForScope(accountScope, portfolios).filter((accountId) =>
          selectableAccountIds.has(accountId),
        ),
      ),
    [accountScope, portfolios, selectableAccountIds],
  );

  const activityOptions = useMemo(
    () =>
      (Object.keys(ActivityTypeNames) as ActivityType[]).map((value) => ({
        value,
        label: localizeActivityTypeName(t, value),
      })),
    [t],
  );

  const instrumentTypeOptions = useMemo(
    () => INSTRUMENT_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
    [],
  );

  const statusOptions = useMemo(
    () => [
      { value: "all", label: t("activity:view_controls.status_all") },
      { value: "pending", label: t("activity:view_controls.status_pending") },
      { value: "validated", label: t("activity:view_controls.status_validated") },
    ],
    [t],
  );

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    accountScope.type !== "all" ||
    selectedActivityTypes.length > 0 ||
    selectedInstrumentTypes.length > 0 ||
    statusFilter !== "all" ||
    !!dateRange?.from ||
    !!dateRange?.to;

  return (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <FacetedSearchInput
          value={localSearch}
          onChange={(value) => {
            setLocalSearch(value);
            debouncedSearch(value);
          }}
          className="w-[160px] lg:w-[240px]"
        />

        <FacetedFilter
          title={t("activity:view_controls.status")}
          options={statusOptions}
          selectedValues={new Set(statusFilter === "all" ? [] : [statusFilter])}
          onFilterChange={(values: Set<string>) => {
            const selected = Array.from(values);
            onStatusFilterChange(
              selected.length === 0 ? "all" : (selected[0] as ActivityStatusFilter),
            );
          }}
        />

        <DateRangeFilter value={dateRange} onChange={onDateRangeChange} />

        <FacetedFilter
          title={t("activity:filter_account")}
          contentClassName="w-72"
          options={accountOptions}
          selectedValues={selectedAccountIds}
          onFilterChange={(values: Set<string>) =>
            onAccountScopeChange(scopeFromAccountIds(Array.from(values)))
          }
        />

        <FacetedFilter
          title={t("activity:filter_type")}
          options={activityOptions}
          selectedValues={new Set(selectedActivityTypes)}
          onFilterChange={(values: Set<string>) =>
            onActivityTypesChange(Array.from(values) as ActivityType[])
          }
        />

        <FacetedFilter
          title={t("activity:view_controls.instrument")}
          options={instrumentTypeOptions}
          selectedValues={new Set(selectedInstrumentTypes)}
          onFilterChange={(values: Set<string>) => onInstrumentTypesChange(Array.from(values))}
        />

        {hasActiveFilters ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => {
              debouncedSearch.cancel();
              setLocalSearch("");
              onResetFilters();
            }}
          >
            {t("activity:reset_filters")}
            <Icons.Close className="ml-2 h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {/* Show fetched/total count only in table view (when totalFetched is provided) */}
        {totalFetched !== undefined && totalRowCount !== undefined && (
          <span className="text-muted-foreground text-xs">
            {isFetching ? (
              <span className="inline-flex items-center gap-1">
                <Icons.Spinner className="h-4 w-4 animate-spin" />
                {t("activity:loading")}
              </span>
            ) : (
              t("activity:pagination_count", { fetched: totalFetched, total: totalRowCount })
            )}
          </span>
        )}
        <AnimatedToggleGroup
          value={viewMode}
          rounded="lg"
          size="sm"
          onValueChange={(value) => {
            if (value === "datagrid" || value === "table") {
              onViewModeChange(value);
            }
          }}
          className="shrink-0"
          items={[
            {
              value: "table",
              label: (
                <>
                  <Icons.Rows3 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{t("activity:view_mode")}</span>
                </>
              ),
              title: t("activity:view_mode"),
            },
            {
              value: "datagrid",
              label: (
                <>
                  <Icons.Grid3x3 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{t("activity:edit_mode")}</span>
                </>
              ),
              title: t("activity:edit_mode"),
              "data-testid": "edit-mode-toggle",
            },
          ]}
        />
      </div>
    </div>
  );
}
