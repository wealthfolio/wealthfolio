import type { DateRange } from "react-day-picker";

import { Button, FacetedFilter, FacetedSearchInput, Icons } from "@wealthfolio/ui";

import { AmountRangeFilter, type AmountRange } from "./amount-range-filter";
import { DateRangeFilter } from "./date-range-filter";
import type { CashActivityStatusFilter } from "../types/cash-activity";
import { pluralizeTransaction } from "../lib/transactions-helpers";

export interface FilterOption {
  value: string;
  label: string;
}

interface TransactionsFilterBarProps {
  // Search
  searchInput: string;
  onSearchInputChange: (next: string) => void;

  // Filters
  statusFilter: CashActivityStatusFilter;
  onStatusFilterChange: (next: CashActivityStatusFilter) => void;
  dateRange: DateRange | undefined;
  onDateRangeChange: (next: DateRange | undefined) => void;
  selectedAccounts: Set<string>;
  onAccountsChange: (next: Set<string>) => void;
  selectedTypes: Set<string>;
  onTypesChange: (next: Set<string>) => void;
  selectedCategories: Set<string>;
  onCategoriesChange: (next: Set<string>) => void;
  selectedSubcategories: Set<string>;
  onSubcategoriesChange: (next: Set<string>) => void;
  selectedEvents: Set<string>;
  onEventsChange: (next: Set<string>) => void;
  amountRange: AmountRange;
  onAmountRangeChange: (next: AmountRange) => void;

  // Options
  accountOptions: FilterOption[];
  typeOptions: FilterOption[];
  categoryOptions: FilterOption[];
  subcategoryOptions: FilterOption[];
  eventOptions: FilterOption[];
  hasEvents: boolean;

  // Status
  filtersActive: boolean;
  onClearAll: () => void;

  // Count display
  visibleCount: number;
  totalCount: number;
  isRefreshing: boolean;
}

export function TransactionsFilterBar({
  searchInput,
  onSearchInputChange,
  statusFilter,
  onStatusFilterChange,
  dateRange,
  onDateRangeChange,
  selectedAccounts,
  onAccountsChange,
  selectedTypes,
  onTypesChange,
  selectedCategories,
  onCategoriesChange,
  selectedSubcategories,
  onSubcategoriesChange,
  selectedEvents,
  onEventsChange,
  amountRange,
  onAmountRangeChange,
  accountOptions,
  typeOptions,
  categoryOptions,
  subcategoryOptions,
  eventOptions,
  hasEvents,
  filtersActive,
  onClearAll,
  visibleCount,
  totalCount,
  isRefreshing,
}: TransactionsFilterBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FacetedSearchInput
          value={searchInput}
          onChange={onSearchInputChange}
          placeholder="Search payee, account, category..."
          className="w-full sm:w-[200px] lg:w-[280px]"
        />
        <span className="text-muted-foreground ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums">
          {totalCount > 0
            ? `${visibleCount} / ${totalCount} ${pluralizeTransaction(totalCount)}`
            : "0 transactions"}
          {isRefreshing && (
            <Icons.Spinner className="h-3 w-3 animate-spin" aria-label="Refreshing" />
          )}
        </span>
      </div>
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
        <FacetedFilter
          title="Status"
          options={[
            { value: "needs_review", label: "Needs review" },
            { value: "uncategorized", label: "Uncategorized" },
            { value: "categorized", label: "Categorized" },
          ]}
          selectedValues={new Set(statusFilter === "all" ? [] : [statusFilter])}
          onFilterChange={(v) => {
            const arr = Array.from(v);
            onStatusFilterChange((arr[0] as CashActivityStatusFilter) ?? "all");
          }}
        />
        <DateRangeFilter value={dateRange} onChange={onDateRangeChange} />
        <FacetedFilter
          title="Account"
          options={accountOptions}
          selectedValues={selectedAccounts}
          onFilterChange={onAccountsChange}
        />
        <FacetedFilter
          title="Type"
          options={typeOptions}
          selectedValues={selectedTypes}
          onFilterChange={onTypesChange}
        />
        <FacetedFilter
          title="Category"
          options={categoryOptions}
          selectedValues={selectedCategories}
          onFilterChange={onCategoriesChange}
        />
        <FacetedFilter
          title="Subcategory"
          options={subcategoryOptions}
          selectedValues={selectedSubcategories}
          onFilterChange={onSubcategoriesChange}
        />
        {hasEvents && (
          <FacetedFilter
            title="Event"
            options={eventOptions}
            selectedValues={selectedEvents}
            onFilterChange={onEventsChange}
          />
        )}
        <AmountRangeFilter value={amountRange} onChange={onAmountRangeChange} />
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearAll}
            className="text-muted-foreground hover:text-foreground h-8 shrink-0 px-2 text-xs"
          >
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
