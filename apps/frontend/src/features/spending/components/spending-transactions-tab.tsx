import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import type { DateRange } from "react-day-picker";

import { createActivity, deleteActivity } from "@/adapters";
import { generateId } from "@/lib/id";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { formatDateISO } from "@/lib/utils";
import type { Account, TaxonomyCategory } from "@/lib/types";

import {
  Button,
  Checkbox,
  EmptyPlaceholder,
  Icons,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";

import { CashActivityForm } from "./cash-activity-form";
import type { AmountRange } from "./amount-range-filter";
import { DeleteTransactionsDialog, type DeletePreview } from "./delete-transactions-dialog";
import { TransactionCard } from "./transaction-card";
import { TransactionRow } from "./transaction-row";
import { TransactionsBulkBar } from "./transactions-bulk-bar";
import { TransactionsFilterBar, type FilterOption } from "./transactions-filter-bar";
import {
  CASH_ACTIVITY_TYPES,
  CASH_ACTIVITY_TYPE_LABELS,
  isSpendingAccountType,
} from "../lib/constants";
import {
  pluralizeActivity,
  stableArr,
  toRowVM,
  type TransactionRowVM,
} from "../lib/transactions-helpers";
import { useCashActivitySearch } from "../hooks/use-cash-activity-search";
import {
  useAssignActivityCategory,
  useBulkAssignCategories,
  useSetActivityEvent,
  useUnassignActivityCategory,
} from "../hooks/use-cash-activities";
import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type { CashActivitySearchRequest, CashActivityStatusFilter } from "../types/cash-activity";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";

/**
 * Parse a `YYYY-MM-DD` URL param as LOCAL midnight. `new Date("YYYY-MM-DD")`
 * interprets the string as UTC, which skews the day boundary in non-UTC
 * timezones and drops activities stored at local midnight. Mirrors how the
 * date picker (and `formatDateISO`) treat dates as local.
 */
function parseLocalDate(value: string): Date | undefined {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

function parseSetParam(value: string | null): Set<string> {
  return new Set(value ? value.split(",").filter(Boolean) : []);
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function parseStatusParam(value: CashActivityStatusFilter | null): CashActivityStatusFilter {
  return value === "needs_review" || value === "uncategorized" || value === "categorized"
    ? value
    : "all";
}

function parseAmountRange(minParam: string | null, maxParam: string | null): AmountRange {
  const min = minParam != null ? Number(minParam) : null;
  const max = maxParam != null ? Number(maxParam) : null;
  return {
    min: min != null && Number.isFinite(min) ? min : null,
    max: max != null && Number.isFinite(max) ? max : null,
  };
}

function sameAmountRange(a: AmountRange, b: AmountRange): boolean {
  return a.min === b.min && a.max === b.max;
}

function parseDateRangeParams(start: string | null, end: string | null): DateRange | undefined {
  if (!start && !end) return undefined;
  return {
    from: start ? parseLocalDate(start) : undefined,
    to: end ? parseLocalDate(end) : undefined,
  };
}

function sameDateRange(a: DateRange | undefined, b: DateRange | undefined): boolean {
  return (
    (a?.from ? formatDateISO(a.from) : undefined) ===
      (b?.from ? formatDateISO(b.from) : undefined) &&
    (a?.to ? formatDateISO(a.to) : undefined) === (b?.to ? formatDateISO(b.to) : undefined)
  );
}
const SEARCH_DEBOUNCE_MS = 300;

export interface SpendingTransactionsTabHandle {
  openAddForm: () => void;
}

export const SpendingTransactionsTab = forwardRef<SpendingTransactionsTabHandle>(
  function SpendingTransactionsTab(_, ref) {
    const [searchParams, setSearchParams] = useSearchParams();
    const urlCategoryId = searchParams.get("category");
    const urlSubcategoryId = searchParams.get("subcategory");
    const urlStartDate = searchParams.get("from");
    const urlEndDate = searchParams.get("to");
    const urlStatus = searchParams.get("status") as CashActivityStatusFilter | null;
    const urlTypes = searchParams.get("types");
    const urlAccounts = searchParams.get("accounts");
    const urlEvents = searchParams.get("events");
    const urlSearchQuery = searchParams.get("q");
    const urlAmountMin = searchParams.get("amountMin");
    const urlAmountMax = searchParams.get("amountMax");

    const qc = useQueryClient();
    const applyingUrlParamsRef = useRef(false);

    const [editingActivity, setEditingActivity] = useState<TransactionRowVM | undefined>();
    const [showForm, setShowForm] = useState(false);
    const [deletingIds, setDeletingIds] = useState<string[] | null>(null);
    const [deletePreview, setDeletePreview] = useState<DeletePreview | undefined>();

    const [searchInput, setSearchInput] = useState(urlSearchQuery ?? "");
    const searchInputRef = useRef(searchInput.trim());
    searchInputRef.current = searchInput.trim();
    const debouncedSearch = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS);

    const [statusFilter, setStatusFilter] = useState<CashActivityStatusFilter>(
      parseStatusParam(urlStatus),
    );
    const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => parseSetParam(urlTypes));
    const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(() =>
      parseSetParam(urlAccounts),
    );
    const [selectedCategories, setSelectedCategories] = useState<Set<string>>(() =>
      parseSetParam(urlCategoryId),
    );
    const [selectedSubcategories, setSelectedSubcategories] = useState<Set<string>>(() =>
      parseSetParam(urlSubcategoryId),
    );
    const [selectedEvents, setSelectedEvents] = useState<Set<string>>(() =>
      parseSetParam(urlEvents),
    );
    const [amountRange, setAmountRange] = useState<AmountRange>(() =>
      parseAmountRange(urlAmountMin, urlAmountMax),
    );
    const [dateRange, setDateRange] = useState<DateRange | undefined>(() =>
      parseDateRangeParams(urlStartDate, urlEndDate),
    );

    useEffect(() => {
      applyingUrlParamsRef.current = true;
      setSearchInput((prev) => {
        const next = urlSearchQuery ?? "";
        return prev === next ? prev : next;
      });
      setStatusFilter((prev) => {
        const next = parseStatusParam(urlStatus);
        return prev === next ? prev : next;
      });
      setSelectedTypes((prev) => {
        const next = parseSetParam(urlTypes);
        return setsEqual(prev, next) ? prev : next;
      });
      setSelectedAccounts((prev) => {
        const next = parseSetParam(urlAccounts);
        return setsEqual(prev, next) ? prev : next;
      });
      setSelectedCategories((prev) => {
        const next = parseSetParam(urlCategoryId);
        return setsEqual(prev, next) ? prev : next;
      });
      setSelectedSubcategories((prev) => {
        const next = parseSetParam(urlSubcategoryId);
        return setsEqual(prev, next) ? prev : next;
      });
      setSelectedEvents((prev) => {
        const next = parseSetParam(urlEvents);
        return setsEqual(prev, next) ? prev : next;
      });
      setAmountRange((prev) => {
        const next = parseAmountRange(urlAmountMin, urlAmountMax);
        return sameAmountRange(prev, next) ? prev : next;
      });
      setDateRange((prev) => {
        const next = parseDateRangeParams(urlStartDate, urlEndDate);
        return sameDateRange(prev, next) ? prev : next;
      });
    }, [
      urlAccounts,
      urlAmountMax,
      urlAmountMin,
      urlCategoryId,
      urlEndDate,
      urlEvents,
      urlSearchQuery,
      urlStartDate,
      urlStatus,
      urlSubcategoryId,
      urlTypes,
    ]);

    // Sync filter state → URL params (debounced search included via
    // debouncedSearch). `replace: true` so each keystroke doesn't pollute
    // history. Empty/default values are removed from the URL so a "clean"
    // state reflects in the address bar.
    useEffect(() => {
      if (applyingUrlParamsRef.current) {
        applyingUrlParamsRef.current = false;
        return;
      }
      const next = new URLSearchParams(searchParams);
      const setOrDelete = (key: string, value: string | null | undefined) => {
        if (value && value.length > 0) next.set(key, value);
        else next.delete(key);
      };
      const setSet = (key: string, set: Set<string>) =>
        setOrDelete(key, set.size > 0 ? Array.from(set).join(",") : null);
      setOrDelete("status", statusFilter === "all" ? null : statusFilter);
      setSet("types", selectedTypes);
      setSet("accounts", selectedAccounts);
      setSet("category", selectedCategories);
      setSet("subcategory", selectedSubcategories);
      setSet("events", selectedEvents);
      setOrDelete("q", searchInputRef.current || null);
      setOrDelete("amountMin", amountRange.min != null ? String(amountRange.min) : null);
      setOrDelete("amountMax", amountRange.max != null ? String(amountRange.max) : null);
      setOrDelete("from", dateRange?.from ? formatDateISO(dateRange.from) : null);
      setOrDelete("to", dateRange?.to ? formatDateISO(dateRange.to) : null);
      // Only call setSearchParams when the serialized form actually changed,
      // otherwise React Router still bumps history.
      if (next.toString() !== searchParams.toString()) {
        setSearchParams(next, { replace: true });
      }
    }, [
      statusFilter,
      selectedTypes,
      selectedAccounts,
      selectedCategories,
      selectedSubcategories,
      selectedEvents,
      debouncedSearch,
      amountRange,
      dateRange,
      searchParams,
      setSearchParams,
    ]);

    const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

    const { accounts = [] } = useAccounts({ filterActive: false });
    const { accountIds: spendingAccountIds } = useSpendingSettings();
    const spendingAccounts = useMemo(() => {
      const includedIds = new Set(spendingAccountIds);
      return accounts.filter(
        (a: Account) => isSpendingAccountType(a.accountType) && includedIds.has(a.id),
      );
    }, [accounts, spendingAccountIds]);
    const { data: events = [] } = useSpendingEvents();
    const { data: eventTypes = [] } = useEventTypes();
    const spending = useTaxonomy(SPENDING_TAXONOMY);
    const income = useTaxonomy(INCOME_TAXONOMY);
    const assignMutation = useAssignActivityCategory();
    const bulkAssignMutation = useBulkAssignCategories();
    const unassignMutation = useUnassignActivityCategory();
    const setEventMutation = useSetActivityEvent();

    const allCategories = useMemo(() => {
      const map = new Map<string, TaxonomyCategory>();
      (spending.data?.categories ?? []).forEach((c) => map.set(c.id, c));
      (income.data?.categories ?? []).forEach((c) => map.set(c.id, c));
      return map;
    }, [spending.data?.categories, income.data?.categories]);

    const topLevelCategories = useMemo(
      () =>
        Array.from(allCategories.values())
          .filter((c) => !c.parentId)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      [allCategories],
    );

    const subcategoriesForFilter = useMemo(() => {
      const all = Array.from(allCategories.values()).filter((c) => !!c.parentId);
      if (selectedCategories.size === 0) return all;
      return all.filter((c) => c.parentId && selectedCategories.has(c.parentId));
    }, [allCategories, selectedCategories]);

    const expandedCategoryIds = useMemo(() => {
      if (selectedCategories.size === 0) return undefined;
      const out = new Set<string>(selectedCategories);
      allCategories.forEach((c) => {
        if (c.parentId && selectedCategories.has(c.parentId)) out.add(c.id);
      });
      return [...out].sort();
    }, [selectedCategories, allCategories]);

    const searchRequest: Omit<CashActivitySearchRequest, "offset" | "limit"> = useMemo(() => {
      return {
        search: debouncedSearch || undefined,
        accountIds: stableArr(selectedAccounts),
        activityTypes: stableArr(selectedTypes),
        categoryIds: expandedCategoryIds,
        subcategoryIds: stableArr(selectedSubcategories),
        eventIds: stableArr(selectedEvents),
        status: statusFilter,
        startDate: dateRange?.from ? dateRange.from.toISOString() : undefined,
        endDate: dateRange?.to
          ? (() => {
              const end = new Date(dateRange.to);
              end.setHours(23, 59, 59, 999);
              return end.toISOString();
            })()
          : undefined,
        minAmount: amountRange.min ?? undefined,
        maxAmount: amountRange.max ?? undefined,
        sortBy: "date",
        sortDir: "desc",
      };
    }, [
      debouncedSearch,
      selectedAccounts,
      selectedTypes,
      expandedCategoryIds,
      selectedSubcategories,
      selectedEvents,
      statusFilter,
      dateRange,
      amountRange,
    ]);

    const {
      items,
      totalCount,
      isLoading,
      isFetching,
      isFetchingNextPage,
      isError,
      error,
      hasNextPage,
      fetchNextPage,
      refetch,
    } = useCashActivitySearch(searchRequest);

    const accountById = useMemo(() => {
      const m = new Map<string, Account>();
      spendingAccounts.forEach((a) => m.set(a.id, a));
      return m;
    }, [spendingAccounts]);

    const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
    const eventTypeById = useMemo(() => new Map(eventTypes.map((t) => [t.id, t])), [eventTypes]);

    const rows: TransactionRowVM[] = useMemo(
      () => items.map((it) => toRowVM(it, allCategories)),
      [items, allCategories],
    );

    const filtersActive =
      !!debouncedSearch ||
      statusFilter !== "all" ||
      selectedTypes.size > 0 ||
      selectedAccounts.size > 0 ||
      selectedCategories.size > 0 ||
      selectedSubcategories.size > 0 ||
      selectedEvents.size > 0 ||
      amountRange.min != null ||
      amountRange.max != null ||
      !!dateRange?.from ||
      !!dateRange?.to;

    const clearAllFilters = useCallback(() => {
      setSearchInput("");
      setStatusFilter("all");
      setSelectedTypes(new Set());
      setSelectedAccounts(new Set());
      setSelectedCategories(new Set());
      setSelectedSubcategories(new Set());
      setSelectedEvents(new Set());
      setAmountRange({ min: null, max: null });
      setDateRange(undefined);
    }, []);

    const requestKey = useMemo(() => JSON.stringify(searchRequest), [searchRequest]);
    const [lastRequestKey, setLastRequestKey] = useState(requestKey);
    if (lastRequestKey !== requestKey) {
      setLastRequestKey(requestKey);
      setSelectedRowIds(new Set());
    }

    const duplicateMutation = useMutation({
      mutationFn: async (row: TransactionRowVM) => {
        const a = row.activity;
        return createActivity({
          idempotencyKey: generateId("manual-duplicate"),
          accountId: a.accountId,
          activityType: a.activityType,
          currency: a.currency,
          amount: a.amount,
          activityDate:
            typeof a.activityDate === "string" ? a.activityDate : new Date().toISOString(),
          comment: "Duplicated",
        });
      },
      onSuccess: () => {
        invalidateSpendingCaches(qc);
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
        toast.success("Transaction duplicated.");
      },
      onError: () => toast.error("Failed to duplicate transaction."),
    });

    const handleDuplicate = useCallback(
      (row: TransactionRowVM) => duplicateMutation.mutate(row),
      [duplicateMutation],
    );

    const deleteMutation = useMutation({
      mutationFn: async (ids: string[]) => {
        const results = await Promise.allSettled(ids.map((id) => deleteActivity(id)));
        return results;
      },
      onSuccess: (results) => {
        invalidateSpendingCaches(qc);
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.length - ok;
        if (ok > 0) toast.success(`Deleted ${ok} ${pluralizeActivity(ok)}.`);
        if (failed > 0) toast.error(`Failed to delete ${failed} ${pluralizeActivity(failed)}.`);
        setDeletingIds(null);
        setDeletePreview(undefined);
        setSelectedRowIds(new Set());
      },
      onError: () => toast.error("Failed to delete activities."),
    });

    const handleBulkCategorize = useCallback(
      async (taxonomyId: string, categoryId: string) => {
        const ids = Array.from(selectedRowIds);
        if (ids.length === 0) return;
        try {
          const result = await bulkAssignMutation.mutateAsync(
            ids.map((activityId) => ({ activityId, taxonomyId, categoryId })),
          );
          toast.success(`Categorized ${result.length} ${pluralizeActivity(result.length)}.`);
        } catch {
          // Hook already toasts on error.
        }
        setSelectedRowIds(new Set());
      },
      [selectedRowIds, bulkAssignMutation],
    );

    const handleBulkSetEvent = useCallback(
      async (eventId: string | null) => {
        const ids = Array.from(selectedRowIds);
        const results = await Promise.allSettled(
          ids.map((activityId) => setEventMutation.mutateAsync({ activityId, eventId })),
        );
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.length - ok;
        const verb = eventId ? "Tagged" : "Cleared event from";
        if (ok > 0) toast.success(`${verb} ${ok} ${pluralizeActivity(ok)}.`);
        if (failed > 0) toast.error(`Failed on ${failed} ${pluralizeActivity(failed)}.`);
        setSelectedRowIds(new Set());
      },
      [selectedRowIds, setEventMutation],
    );

    const clearSelection = useCallback(() => setSelectedRowIds(new Set()), []);

    const handleAssignCategory = useCallback(
      (activityId: string, taxonomyId: string, categoryId: string) => {
        assignMutation.mutate({ activityId, taxonomyId, categoryId });
      },
      [assignMutation],
    );
    const handleClearCategory = useCallback(
      (activityId: string, taxonomyId: string) => {
        unassignMutation.mutate({ activityId, taxonomyId });
      },
      [unassignMutation],
    );
    const handleSetEvent = useCallback(
      (activityId: string, eventId: string | null) => {
        setEventMutation.mutate({ activityId, eventId });
      },
      [setEventMutation],
    );

    const handleEditRow = useCallback((row: TransactionRowVM) => {
      setEditingActivity(row);
      setShowForm(true);
    }, []);
    const handleDeleteRow = useCallback((row: TransactionRowVM) => {
      setDeletingIds([row.activity.id]);
      setDeletePreview({
        activityType: row.activity.activityType,
        amount: row.activity.amount ?? null,
        currency: row.activity.currency,
      });
    }, []);

    const handleToggleRow = useCallback((id: string) => {
      setSelectedRowIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);

    const allVisibleSelected =
      rows.length > 0 && rows.every((r) => selectedRowIds.has(r.activity.id));
    const someVisibleSelected =
      rows.some((r) => selectedRowIds.has(r.activity.id)) && !allVisibleSelected;

    const toggleSelectAllVisible = () => {
      setSelectedRowIds((prev) => {
        const next = new Set(prev);
        if (allVisibleSelected) rows.forEach((r) => next.delete(r.activity.id));
        else rows.forEach((r) => next.add(r.activity.id));
        return next;
      });
    };

    const handleBulkDelete = () => {
      setDeletingIds(Array.from(selectedRowIds));
      setDeletePreview(undefined);
    };

    const typeOptions = useMemo<FilterOption[]>(
      () =>
        CASH_ACTIVITY_TYPES.map((t) => ({
          value: t,
          label: CASH_ACTIVITY_TYPE_LABELS[t],
        })),
      [],
    );
    const accountOptions = useMemo<FilterOption[]>(
      () => spendingAccounts.map((a) => ({ value: a.id, label: a.name })),
      [spendingAccounts],
    );
    const categoryOptions = useMemo<FilterOption[]>(
      () => topLevelCategories.map((c) => ({ value: c.id, label: c.name })),
      [topLevelCategories],
    );
    const subcategoryOptions = useMemo<FilterOption[]>(
      () =>
        subcategoriesForFilter.map((c) => {
          const parent = c.parentId ? allCategories.get(c.parentId) : null;
          return {
            value: c.id,
            label: parent ? `${parent.name} / ${c.name}` : c.name,
          };
        }),
      [subcategoriesForFilter, allCategories],
    );
    const eventOptions = useMemo<FilterOption[]>(
      () => events.map((e) => ({ value: e.id, label: e.name })),
      [events],
    );

    const handleCategoriesChange = useCallback(
      (next: Set<string>) => {
        setSelectedCategories(next);
        setSelectedSubcategories((prev) => {
          const drop = new Set<string>();
          prev.forEach((id) => {
            const cat = allCategories.get(id);
            if (!cat?.parentId || !next.has(cat.parentId)) drop.add(id);
          });
          if (drop.size === 0) return prev;
          const out = new Set(prev);
          drop.forEach((id) => out.delete(id));
          return out;
        });
      },
      [allCategories],
    );

    const openAddForm = useCallback(() => {
      setEditingActivity(undefined);
      setShowForm(true);
    }, []);

    useImperativeHandle(ref, () => ({ openAddForm }), [openAddForm]);

    const isRefreshing = isFetching && !isFetchingNextPage;
    const isMobile = useIsMobileViewport();

    const loadMoreButton = hasNextPage ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => fetchNextPage()}
        disabled={isFetchingNextPage}
      >
        {isFetchingNextPage ? (
          <>
            <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </>
        ) : (
          `Load more (${totalCount - rows.length} remaining)`
        )}
      </Button>
    ) : null;

    const renderRows = () =>
      rows.map((r) => {
        const eventId = r.activity.eventId ?? null;
        const ev = eventId ? eventsById.get(eventId) : null;
        const eventTypeColor = ev ? (eventTypeById.get(ev.eventTypeId)?.color ?? null) : null;
        const RowComponent = isMobile ? TransactionCard : TransactionRow;
        return (
          <RowComponent
            key={r.activity.id}
            row={r}
            account={accountById.get(r.activity.accountId)}
            event={ev ?? null}
            eventTypeColor={eventTypeColor}
            isSelected={selectedRowIds.has(r.activity.id)}
            onToggleSelect={handleToggleRow}
            onAssignCategory={handleAssignCategory}
            onClearCategory={handleClearCategory}
            onSetEvent={handleSetEvent}
            onEdit={handleEditRow}
            onDuplicate={handleDuplicate}
            onDelete={handleDeleteRow}
          />
        );
      });

    const editingActivityForForm = useMemo(() => {
      if (!editingActivity) return undefined;
      const a = editingActivity.activity;
      const c = editingActivity.category;
      return c
        ? {
            ...a,
            categoryAssignmentId: c.assignmentId,
            categoryTaxonomyId: c.taxonomyId,
            categoryId: c.id,
          }
        : a;
    }, [editingActivity]);

    return (
      <div className="space-y-4">
        <TransactionsFilterBar
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          selectedAccounts={selectedAccounts}
          onAccountsChange={setSelectedAccounts}
          selectedTypes={selectedTypes}
          onTypesChange={setSelectedTypes}
          selectedCategories={selectedCategories}
          onCategoriesChange={handleCategoriesChange}
          selectedSubcategories={selectedSubcategories}
          onSubcategoriesChange={setSelectedSubcategories}
          selectedEvents={selectedEvents}
          onEventsChange={setSelectedEvents}
          amountRange={amountRange}
          onAmountRangeChange={setAmountRange}
          accountOptions={accountOptions}
          typeOptions={typeOptions}
          categoryOptions={categoryOptions}
          subcategoryOptions={subcategoryOptions}
          eventOptions={eventOptions}
          hasEvents={events.length > 0}
          filtersActive={filtersActive}
          onClearAll={clearAllFilters}
          visibleCount={rows.length}
          totalCount={totalCount}
          isRefreshing={isRefreshing}
        />

        {selectedRowIds.size > 0 && (
          <TransactionsBulkBar
            selectedCount={selectedRowIds.size}
            onCategorize={handleBulkCategorize}
            onTagEvent={handleBulkSetEvent}
            onDelete={handleBulkDelete}
            onClearSelection={clearSelection}
          />
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : isError ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="AlertTriangle" />
            <EmptyPlaceholder.Title>Transactions could not load</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {error?.message ?? "Try refreshing the list."}
            </EmptyPlaceholder.Description>
            <Button variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </EmptyPlaceholder>
        ) : rows.length === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Activity" />
            <EmptyPlaceholder.Title>No transactions</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {filtersActive
                ? "No cash activity matches your filters."
                : "Add your first transaction to get started."}
            </EmptyPlaceholder.Description>
            {filtersActive ? (
              <Button variant="outline" onClick={clearAllFilters}>
                Clear filters
              </Button>
            ) : (
              <Button onClick={openAddForm}>
                <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Add transaction
              </Button>
            )}
          </EmptyPlaceholder>
        ) : isMobile ? (
          <div className="space-y-2">
            {rows.length > 1 && (
              <div className="flex items-center gap-2 px-1">
                <Checkbox
                  checked={
                    allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                  }
                  onCheckedChange={toggleSelectAllVisible}
                  aria-label={
                    allVisibleSelected
                      ? "Deselect all visible transactions"
                      : "Select all visible transactions"
                  }
                />
                <span className="text-muted-foreground text-xs">Select all</span>
              </div>
            )}
            {renderRows()}
            {loadMoreButton && <div className="flex justify-center pt-1">{loadMoreButton}</div>}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false
                      }
                      onCheckedChange={toggleSelectAllVisible}
                      aria-label={
                        allVisibleSelected
                          ? "Deselect all visible transactions"
                          : "Select all visible transactions"
                      }
                    />
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead className="hidden lg:table-cell">Account</TableHead>
                  <TableHead>Name / Notes</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden lg:table-cell">Event</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>{renderRows()}</TableBody>
            </Table>

            {loadMoreButton && (
              <div className="border-border flex items-center justify-center border-t p-3">
                {loadMoreButton}
              </div>
            )}
          </div>
        )}

        <CashActivityForm
          open={showForm}
          onOpenChange={setShowForm}
          activity={editingActivityForForm}
        />

        <DeleteTransactionsDialog
          open={!!deletingIds && deletingIds.length > 0}
          count={deletingIds?.length ?? 0}
          preview={deletePreview}
          isPending={deleteMutation.isPending}
          onCancel={() => {
            setDeletingIds(null);
            setDeletePreview(undefined);
          }}
          onConfirm={() => deletingIds && deleteMutation.mutate(deletingIds)}
        />
      </div>
    );
  },
);
