import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";

import {
  Button,
  FacetedFilter,
  FacetedSearchInput,
  Icons,
  Input,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";

import { AmountRangeFilter, type AmountRange } from "./amount-range-filter";
import { DateRangeFilter } from "./date-range-filter";
import type { CashActivityStatusFilter } from "../types/cash-activity";

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
  isMobile?: boolean;
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
  isMobile = false,
}: TransactionsFilterBarProps) {
  const { t } = useTranslation();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const statusOptions = [
    { value: "needs_review", label: t("spending:filters.statusNeedsReview") },
    { value: "uncategorized", label: t("spending:filters.statusUncategorized") },
    { value: "categorized", label: t("spending:filters.statusCategorized") },
  ];
  const controlFiltersActive =
    statusFilter !== "all" ||
    selectedAccounts.size > 0 ||
    selectedTypes.size > 0 ||
    selectedCategories.size > 0 ||
    selectedSubcategories.size > 0 ||
    selectedEvents.size > 0 ||
    amountRange.min != null ||
    amountRange.max != null ||
    !!dateRange?.from ||
    !!dateRange?.to;
  const countLabel =
    totalCount > 0
      ? t("spending:filters.countLabel", {
          visible: visibleCount,
          total: totalCount,
          count: totalCount,
        })
      : t("spending:filters.countZero");

  const filterControls = (
    <>
      <FacetedFilter
        title={t("common:status")}
        options={statusOptions}
        selectedValues={new Set(statusFilter === "all" ? [] : [statusFilter])}
        onFilterChange={(v) => {
          const arr = Array.from(v);
          onStatusFilterChange((arr[0] as CashActivityStatusFilter) ?? "all");
        }}
      />
      <DateRangeFilter value={dateRange} onChange={onDateRangeChange} />
      <FacetedFilter
        title={t("common:account")}
        options={accountOptions}
        selectedValues={selectedAccounts}
        onFilterChange={onAccountsChange}
      />
      <FacetedFilter
        title={t("common:type")}
        options={typeOptions}
        selectedValues={selectedTypes}
        onFilterChange={onTypesChange}
      />
      <AmountRangeFilter value={amountRange} onChange={onAmountRangeChange} />
      <FacetedFilter
        title={t("spending:filters.category")}
        options={categoryOptions}
        selectedValues={selectedCategories}
        onFilterChange={onCategoriesChange}
      />
      <FacetedFilter
        title={t("spending:filters.subcategory")}
        options={subcategoryOptions}
        selectedValues={selectedSubcategories}
        onFilterChange={onSubcategoriesChange}
      />
      {hasEvents && (
        <FacetedFilter
          title={t("spending:filters.event")}
          options={eventOptions}
          selectedValues={selectedEvents}
          onFilterChange={onEventsChange}
        />
      )}
    </>
  );

  if (isMobile) {
    return (
      <div className="space-y-2">
        <div className="flex shrink-0 items-center gap-2 pt-2">
          <Input
            placeholder={t("common:search_placeholder")}
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
            className="bg-secondary/30 h-10 flex-1 rounded-full border-none md:h-12"
          />
          <Button
            variant="outline"
            size="icon"
            className="size-9 flex-shrink-0"
            onClick={() => setMobileFiltersOpen(true)}
            aria-label={t("spending:filters.filterTransactions")}
            title={t("spending:filters.filterTransactions")}
          >
            <div className="relative">
              <Icons.ListFilter className="h-4 w-4" />
              {controlFiltersActive && (
                <span className="bg-primary absolute -left-[1.5px] -top-1 h-2 w-2 rounded-full" />
              )}
            </div>
          </Button>
        </div>
        <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <SheetContent side="bottom" className="rounded-t-4xl mx-1 flex h-[80vh] flex-col p-0">
            <SheetHeader className="border-border border-b px-6 py-4 text-left">
              <SheetTitle>{t("spending:filters.filterTransactions")}</SheetTitle>
            </SheetHeader>
            <ScrollArea className="flex-1">
              <div className="flex flex-wrap gap-2 px-6 py-4">{filterControls}</div>
            </ScrollArea>
            <SheetFooter className="border-border flex-row border-t px-6 py-4">
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={onClearAll}
                disabled={!filtersActive}
              >
                {t("spending:filters.clearAll")}
              </Button>
              <Button className="ml-auto" onClick={() => setMobileFiltersOpen(false)}>
                {t("spending:filters.done")}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="-mx-1 flex flex-wrap items-center gap-2 px-1 pb-1">
      <FacetedSearchInput
        value={searchInput}
        onChange={onSearchInputChange}
        className="w-[160px] lg:w-[240px]"
      />
      {filterControls}
      {filtersActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="text-muted-foreground hover:text-foreground h-8 shrink-0 px-2 text-xs"
        >
          {t("spending:filters.clearAll")}
        </Button>
      )}
      <span className="text-muted-foreground ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums">
        {countLabel}
        {isRefreshing && (
          <Icons.Spinner
            className="h-3 w-3 animate-spin"
            aria-label={t("spending:filters.refreshing")}
          />
        )}
      </span>
    </div>
  );
}
