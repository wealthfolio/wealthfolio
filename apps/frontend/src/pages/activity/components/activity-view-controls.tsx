import { useEffect, useMemo, useState } from "react";

import { ActivityType, ActivityTypeNames, INSTRUMENT_TYPE_OPTIONS } from "@/lib/constants";
import { debounce } from "@/lib/debounce";
import type { AccountScope } from "@/lib/types";
import { AccountScopeSelector } from "@/components/account-filter-selector";
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
  viewMode: ActivityViewMode;
  onViewModeChange: (mode: ActivityViewMode) => void;
  /** Shown only in table view - number of activities fetched so far */
  totalFetched?: number;
  /** Shown only in table view - total number of activities matching filters */
  totalRowCount?: number;
  isFetching: boolean;
}

export function ActivityViewControls({
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
  viewMode,
  onViewModeChange,
  totalFetched,
  totalRowCount,
  isFetching,
}: ActivityViewControlsProps) {
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

  const activityOptions = useMemo(
    () =>
      (Object.entries(ActivityTypeNames) as [ActivityType, string][]).map(([value, label]) => ({
        value,
        label,
      })),
    [],
  );

  const instrumentTypeOptions = useMemo(
    () => INSTRUMENT_TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
    [],
  );

  const statusOptions = useMemo(
    () => [
      { value: "all", label: "All Activities" },
      { value: "pending", label: "Pending Review" },
      { value: "validated", label: "Validated" },
    ],
    [],
  );

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    accountScope.type !== "all" ||
    selectedActivityTypes.length > 0 ||
    selectedInstrumentTypes.length > 0 ||
    statusFilter !== "all";

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

        <AccountScopeSelector value={accountScope} onChange={onAccountScopeChange} />

        <FacetedFilter
          title="Type"
          options={activityOptions}
          selectedValues={new Set(selectedActivityTypes)}
          onFilterChange={(values: Set<string>) =>
            onActivityTypesChange(Array.from(values) as ActivityType[])
          }
        />

        <FacetedFilter
          title="Instrument"
          options={instrumentTypeOptions}
          selectedValues={new Set(selectedInstrumentTypes)}
          onFilterChange={(values: Set<string>) => onInstrumentTypesChange(Array.from(values))}
        />

        <FacetedFilter
          title="Status"
          options={statusOptions}
          selectedValues={new Set(statusFilter === "all" ? [] : [statusFilter])}
          onFilterChange={(values: Set<string>) => {
            const selected = Array.from(values);
            onStatusFilterChange(
              selected.length === 0 ? "all" : (selected[0] as ActivityStatusFilter),
            );
          }}
        />

        {hasActiveFilters ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => {
              setLocalSearch("");
              onSearchQueryChange("");
              onAccountScopeChange({ type: "all" });
              onActivityTypesChange([]);
              onInstrumentTypesChange([]);
              onStatusFilterChange("all");
            }}
          >
            Reset
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
                Loading…
              </span>
            ) : (
              `${totalFetched} / ${totalRowCount} activities`
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
                  <span className="sr-only">View mode</span>
                </>
              ),
              title: "View mode",
            },
            {
              value: "datagrid",
              label: (
                <>
                  <Icons.Grid3x3 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">Edit mode</span>
                </>
              ),
              title: "Edit mode",
              "data-testid": "edit-mode-toggle",
            },
          ]}
        />
      </div>
    </div>
  );
}
