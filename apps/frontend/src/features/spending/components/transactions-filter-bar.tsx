import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";

import {
  AmountDisplay,
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
  useBalancePrivacy,
  Spinner,
} from "@wealthfolio/ui";

import { cn } from "@/lib/utils";

import { AmountRangeFilter, type AmountRange } from "./amount-range-filter";
import { DateRangeFilter } from "./date-range-filter";
import type { CurrencyNet, NetSummary } from "../types/cash-activity";
import type { CashActivityStatusFilter } from "../types/cash-activity";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * One currency's net, shaped like the currency pills on the insights value
 * strip: a coloured tick, the code, then the figure. The code carries the
 * currency so the amount itself is rendered without a symbol.
 */
function CurrencyNetPill({ total }: { total: CurrencyNet }) {
  const { isBalanceHidden } = useBalancePrivacy();
  const isNegative = total.amount < 0;
  return (
    <span className="bg-muted/45 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 whitespace-nowrap">
      <span
        className={cn("h-2 w-1 rounded-sm", isNegative ? "bg-destructive/70" : "bg-success/70")}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{total.currency}</span>
      <span className="text-foreground font-semibold tabular-nums">
        {isNegative ? "-" : "+"}
        <AmountDisplay
          value={Math.abs(total.amount)}
          currency={total.currency}
          displayCurrency={false}
          isHidden={isBalanceHidden}
        />
      </span>
    </span>
  );
}

/**
 * A labelled net: the converted figure when there is one, with the per-currency
 * breakdown beside it. When conversion was withheld — a single currency, or a
 * currency with no rate — the breakdown stands alone and is still exact.
 */
function NetReadout({ label, net }: { label: string; net: NetSummary }) {
  const { isBalanceHidden } = useBalancePrivacy();
  if (net.byCurrency.length === 0) return null;
  return (
    // Wraps rather than staying on one line: each currency adds a pill, and
    // from three of them the readout is wider than a phone. It sits under a
    // `.flex` ancestor, which `globals.css` gives `overflow-x: hidden` below
    // 1024px, so anything past the edge is clipped with no way to scroll to it.
    // The pills keep `whitespace-nowrap` so a break lands between them rather
    // than inside an amount.
    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {label}
      {net.converted && (
        <span
          className={cn(
            "text-foreground font-semibold tabular-nums",
            net.converted.amount < 0 ? "text-destructive" : "text-success",
          )}
        >
          {net.converted.amount < 0 ? "-" : "+"}
          <AmountDisplay
            value={Math.abs(net.converted.amount)}
            currency={net.converted.currency}
            isHidden={isBalanceHidden}
          />
        </span>
      )}
      {net.byCurrency.map((total) => (
        <CurrencyNetPill key={total.currency} total={total} />
      ))}
    </span>
  );
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
  /** Net of the checked rows, one entry per currency. Empty hides the readout. */
  selectedNet: NetSummary;
  /** Net of the filtered set, one entry per currency. Empty hides the readout. */
  filteredNet: NetSummary | null;
  isRefreshing: boolean;
  isMobile?: boolean;
  /** Hides the loaded-of-total count, e.g. when a pager shows it instead. */
  showCount?: boolean;
  /** The list / grid switch, shown at the end of the desktop bar. */
  viewToggle?: React.ReactNode;
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
  selectedNet,
  filteredNet,
  isRefreshing,
  isMobile = false,
  showCount = true,
  viewToggle,
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
                <span className="bg-primary absolute -start-[1.5px] -top-1 h-2 w-2 rounded-full" />
              )}
            </div>
          </Button>
        </div>
        <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <SheetContent side="bottom" className="mx-1 flex h-[80vh] flex-col rounded-t-4xl p-0">
            <SheetHeader className="border-border border-b px-6 py-4 text-start">
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
              <Button className="ms-auto" onClick={() => setMobileFiltersOpen(false)}>
                {t("spending:filters.done")}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
        {/* The nets belong on a phone too — arguably more, since the row list
            is harder to scan there. They wrap under the search row rather than
            sitting inline with it. */}
        {(selectedNet.byCurrency.length > 0 || filteredNet) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
            {selectedNet.byCurrency.length > 0 && (
              <NetReadout label={t("spending:filters.selectedNet")} net={selectedNet} />
            )}
            {filteredNet && (
              <NetReadout label={t("spending:filters.filteredNet")} net={filteredNet} />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="-mx-1 flex flex-wrap items-center gap-2 px-1 pb-1">
      <FacetedSearchInput
        value={searchInput}
        onChange={onSearchInputChange}
        className="w-40 lg:w-60"
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
      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
        {selectedNet.byCurrency.length > 0 && (
          <NetReadout label={t("spending:filters.selectedNet")} net={selectedNet} />
        )}
        {filteredNet && <NetReadout label={t("spending:filters.filteredNet")} net={filteredNet} />}
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap tabular-nums">
          {showCount && countLabel}
          {isRefreshing && (
            <Spinner className="h-3 w-3" aria-label={t("spending:filters.refreshing")} />
          )}
        </span>
        {viewToggle}
      </div>
    </div>
  );
}
