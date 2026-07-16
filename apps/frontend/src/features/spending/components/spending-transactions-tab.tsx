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
import { useTranslation } from "react-i18next";
import type { DateRange } from "react-day-picker";

import { createActivity, deleteActivity, updateActivity } from "@/adapters";
import { generateId } from "@/lib/id";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { QueryKeys } from "@/lib/query-keys";
import { formatDateISO } from "@/lib/utils";
import type { Account, ActivityDetails, TaxonomyCategory } from "@/lib/types";
import { useSettingsContext } from "@/lib/settings-provider";

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
import { ActivityForm } from "@/pages/activity/components/activity-form";
import { MobileActivityForm } from "@/pages/activity/components/mobile-forms/mobile-activity-form";
import { TransferMatchDialog } from "@/pages/activity/components/transfer-match-dialog";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { ActivityType } from "@/lib/constants";
import type { AmountRange } from "./amount-range-filter";
import { DeleteTransactionsDialog, type DeletePreview } from "./delete-transactions-dialog";
import { TransactionCard } from "./transaction-card";
import { TransactionRow } from "./transaction-row";
import { SplitTransactionSheet } from "./split-transaction-sheet";
import { TransactionsBulkBar } from "./transactions-bulk-bar";
import { TransactionsFilterBar, type FilterOption } from "./transactions-filter-bar";
import type { QuickCategorizeScope } from "./quick-categorize-popover";
import {
  CASH_ACTIVITY_TYPES,
  CASH_ACTIVITY_TYPE_LABELS,
  getEffectiveCashActivityType,
  isCreditCardAccountType,
  isSpendingAccountType,
} from "../lib/constants";
import {
  isTransferCashActivity,
  stableArr,
  toRowVM,
  type TransactionRowVM,
} from "../lib/transactions-helpers";
import { useCashActivitySearch } from "../hooks/use-cash-activity-search";
import {
  useAssignActivityCategory,
  useBulkAssignCategories,
  useClearActivitySplits,
  useReplaceActivitySplits,
  useSetActivityEvent,
  useUnassignActivityCategory,
} from "../hooks/use-cash-activities";
import { useEventTypes, useSpendingEvents } from "../hooks/use-spending-events";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type {
  CashActivitySearchRequest,
  CashActivityStatusFilter,
  NewActivitySplit,
} from "../types/cash-activity";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

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

function toActivityDetails(row: TransactionRowVM, account?: Account): Partial<ActivityDetails> {
  const activity = row.activity;
  const activityType = getEffectiveCashActivityType(activity);
  return {
    id: activity.id,
    activityType: activityType as ActivityType,
    subtype: activity.subtype ?? null,
    status: activity.status,
    date: new Date(activity.activityDate),
    quantity: activity.quantity ?? null,
    unitPrice: activity.unitPrice ?? null,
    amount: activity.amount ?? null,
    fee: activity.fee ?? null,
    currency: activity.currency,
    needsReview: activity.needsReview,
    comment: activity.notes ?? undefined,
    fxRate: activity.fxRate ?? null,
    createdAt: new Date(activity.createdAt),
    updatedAt: new Date(activity.updatedAt),
    accountId: activity.accountId,
    accountName: account?.name ?? activity.accountId,
    accountCurrency: account?.currency ?? activity.currency,
    assetId: activity.assetId ?? "",
    assetSymbol: activity.assetId ?? "",
    sourceSystem: activity.sourceSystem,
    sourceRecordId: activity.sourceRecordId,
    sourceGroupId: activity.sourceGroupId,
    idempotencyKey: activity.idempotencyKey,
    importRunId: activity.importRunId,
    isUserModified: activity.isUserModified,
    metadata: activity.metadata,
  };
}

export const SpendingTransactionsTab = forwardRef<SpendingTransactionsTabHandle>(
  function SpendingTransactionsTab(_, ref) {
    const { t } = useTranslation();
    const [searchParams, setSearchParams] = useSearchParams();
    const urlCategoryId = searchParams.get("category");
    const urlSubcategoryId = searchParams.get("subcategory");
    const urlStartDate = searchParams.get("from");
    const urlEndDate = searchParams.get("to");
    const urlStatus = searchParams.get("status") as CashActivityStatusFilter | null;
    const urlTypes = searchParams.get("types");
    const urlAccount = searchParams.get("account");
    const urlAccounts = searchParams.get("accounts") ?? urlAccount;
    const urlEvents = searchParams.get("events");
    const urlSearchQuery = searchParams.get("q");
    const urlAmountMin = searchParams.get("amountMin");
    const urlAmountMax = searchParams.get("amountMax");

    const qc = useQueryClient();
    const { settings } = useSettingsContext();
    const appTimezone = settings?.timezone?.trim() || undefined;
    const applyingUrlParamsRef = useRef(false);

    const [editingActivity, setEditingActivity] = useState<TransactionRowVM | undefined>();
    const [splittingActivity, setSplittingActivity] = useState<TransactionRowVM | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [showTransferForm, setShowTransferForm] = useState(false);
    const [transferFormActivity, setTransferFormActivity] = useState<
      Partial<ActivityDetails> | undefined
    >();
    const [transferMatchDialog, setTransferMatchDialog] = useState<{
      open: boolean;
      mode: "link" | "unlink";
      row: TransactionRowVM | null;
    }>({ open: false, mode: "link", row: null });
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
      if (searchParams.get("tab") === "spending") {
        next.delete("account");
      }
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

    // All active accounts for the transfer form (same full list as the Investments tab uses)
    const transferFormAccounts = useMemo(
      () =>
        accounts
          .filter((a: Account) => !a.isArchived)
          .map((a: Account) => ({
            value: a.id,
            label: a.name,
            currency: a.currency,
            accountType: a.accountType,
            restrictionLevel: getActivityRestrictionLevel(a),
          })),
      [accounts],
    );

    const handleTransferClick = useCallback(
      (accountId: string) => {
        const account = accounts.find((a: Account) => a.id === accountId);
        setTransferFormActivity({
          activityType: isCreditCardAccountType(account?.accountType)
            ? ActivityType.TRANSFER_IN
            : ActivityType.TRANSFER_OUT,
          accountId,
        });
        setShowTransferForm(true);
      },
      [accounts],
    );

    const handleTransferFormClose = useCallback(() => {
      setShowTransferForm(false);
      setTransferFormActivity(undefined);
    }, []);
    const { data: events = [] } = useSpendingEvents();
    const { data: eventTypes = [] } = useEventTypes();
    const spending = useTaxonomy(SPENDING_TAXONOMY);
    const income = useTaxonomy(INCOME_TAXONOMY);
    const savings = useTaxonomy(SAVINGS_TAXONOMY);
    const assignMutation = useAssignActivityCategory();
    const bulkAssignMutation = useBulkAssignCategories();
    const unassignMutation = useUnassignActivityCategory();
    const replaceSplitsMutation = useReplaceActivitySplits();
    const clearSplitsMutation = useClearActivitySplits();
    const setEventMutation = useSetActivityEvent();

    const allCategories = useMemo(() => {
      const map = new Map<string, TaxonomyCategory>();
      (spending.data?.categories ?? []).forEach((c) => map.set(c.id, c));
      (income.data?.categories ?? []).forEach((c) => map.set(c.id, c));
      (savings.data?.categories ?? []).forEach((c) => map.set(c.id, c));
      return map;
    }, [spending.data?.categories, income.data?.categories, savings.data?.categories]);

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
    const bulkCategoryScope = useMemo<QuickCategorizeScope | null>(() => {
      if (selectedRowIds.size === 0) return null;
      const buckets = new Set(
        rows
          .filter((row) => selectedRowIds.has(row.activity.id))
          .map((row) => row.activity.cashFlowBucket),
      );
      if (buckets.size !== 1) return null;
      const [bucket] = [...buckets];
      if (bucket === "spending") return "expense";
      if (bucket === "income") return "income";
      if (bucket === "saving") return "saving";
      return null;
    }, [rows, selectedRowIds]);

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

    const { mutate: duplicateTransaction } = useMutation({
      mutationFn: async (row: TransactionRowVM) => {
        const a = row.activity;
        return createActivity({
          idempotencyKey: generateId("manual-duplicate"),
          accountId: a.accountId,
          activityType: getEffectiveCashActivityType(a),
          currency: a.currency,
          amount: a.amount,
          activityDate:
            typeof a.activityDate === "string" ? a.activityDate : new Date().toISOString(),
          comment: t("spending:txTab.duplicatedComment"),
        });
      },
      onSuccess: () => {
        invalidateSpendingCaches(qc);
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
        toast.success(t("spending:txTab.duplicated"));
      },
      onError: () => toast.error(t("spending:txTab.duplicateFailed")),
    });

    const handleDuplicate = useCallback(
      (row: TransactionRowVM) => duplicateTransaction(row),
      [duplicateTransaction],
    );

    const markReimbursementMutation = useMutation({
      mutationFn: async (row: TransactionRowVM) => {
        const a = row.activity;
        return updateActivity({
          id: a.id,
          accountId: a.accountId,
          activityType: "CREDIT",
          subtype: "REIMBURSEMENT",
          activityDate: a.activityDate,
          amount: Math.abs(Number.parseFloat(a.amount ?? "0")),
          currency: a.currency,
          comment: a.notes ?? null,
        });
      },
      onSuccess: (_, row) => {
        invalidateSpendingCaches(qc);
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
        qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITY_DATA] });
        const updatedRow: TransactionRowVM = {
          ...row,
          activity: {
            ...row.activity,
            activityType: "CREDIT",
            subtype: "REIMBURSEMENT",
            cashFlowBucket: "spending",
          },
          category: null,
          splitCount: 0,
        };
        setEditingActivity(updatedRow);
        setShowForm(true);
        toast.success(t("spending:txTab.markedReimbursement"));
      },
      onError: () => toast.error(t("spending:txTab.markReimbursementFailed")),
    });

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
        if (ok > 0) toast.success(t("spending:txTab.deletedCount", { count: ok }));
        if (failed > 0) toast.error(t("spending:txTab.deleteFailedCount", { count: failed }));
        setDeletingIds(null);
        setDeletePreview(undefined);
        setSelectedRowIds(new Set());
      },
      onError: () => toast.error(t("spending:txTab.deleteFailed")),
    });

    const handleBulkCategorize = useCallback(
      async (taxonomyId: string, categoryId: string) => {
        const ids = Array.from(selectedRowIds);
        if (ids.length === 0) return;
        try {
          const result = await bulkAssignMutation.mutateAsync(
            ids.map((activityId) => ({ activityId, taxonomyId, categoryId })),
          );
          toast.success(t("spending:txTab.categorizedCount", { count: result.length }));
        } catch {
          // Hook already toasts on error.
        }
        setSelectedRowIds(new Set());
      },
      [selectedRowIds, bulkAssignMutation, t],
    );

    const handleBulkSetEvent = useCallback(
      async (eventId: string | null) => {
        const ids = Array.from(selectedRowIds);
        const results = await Promise.allSettled(
          ids.map((activityId) => setEventMutation.mutateAsync({ activityId, eventId })),
        );
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.length - ok;
        if (ok > 0) {
          toast.success(
            eventId
              ? t("spending:txTab.taggedCount", { count: ok })
              : t("spending:txTab.clearedEventCount", { count: ok }),
          );
        }
        if (failed > 0) toast.error(t("spending:txTab.failedOnCount", { count: failed }));
        setSelectedRowIds(new Set());
      },
      [selectedRowIds, setEventMutation, t],
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
    const handleSaveSplits = useCallback(
      async (activityId: string, splits: NewActivitySplit[]) => {
        await replaceSplitsMutation.mutateAsync({ activityId, splits });
        toast.success(t("spending:txTab.splitSaved"));
      },
      [replaceSplitsMutation, t],
    );
    const handleClearSplits = useCallback(
      async (activityId: string) => {
        await clearSplitsMutation.mutateAsync({ activityId });
        toast.success(t("spending:txTab.splitCleared"));
      },
      [clearSplitsMutation, t],
    );

    const handleEditRow = useCallback(
      (row: TransactionRowVM) => {
        if (isTransferCashActivity(row.activity)) {
          setEditingActivity(undefined);
          setShowForm(false);
          setTransferFormActivity(toActivityDetails(row, accountById.get(row.activity.accountId)));
          setShowTransferForm(true);
          return;
        }
        setTransferFormActivity(undefined);
        setShowTransferForm(false);
        setEditingActivity(row);
        setShowForm(true);
      },
      [accountById],
    );
    const handleDeleteRow = useCallback((row: TransactionRowVM) => {
      const activityType = getEffectiveCashActivityType(row.activity);
      setDeletingIds([row.activity.id]);
      setDeletePreview({
        activityType,
        amount: row.activity.amount ?? null,
        currency: row.activity.currency,
      });
    }, []);
    const handleLinkTransfer = useCallback((row: TransactionRowVM) => {
      setTransferMatchDialog({ open: true, mode: "link", row });
    }, []);
    const handleUnlinkTransfer = useCallback((row: TransactionRowVM) => {
      setTransferMatchDialog({ open: true, mode: "unlink", row });
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
            {t("spending:txTab.loading")}
          </>
        ) : (
          t("spending:txTab.loadMore", { count: totalCount - rows.length })
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
            appTimezone={appTimezone}
            isSelected={selectedRowIds.has(r.activity.id)}
            onToggleSelect={handleToggleRow}
            onAssignCategory={handleAssignCategory}
            onClearCategory={handleClearCategory}
            onSetEvent={handleSetEvent}
            onMarkReimbursement={(row) => markReimbursementMutation.mutate(row)}
            onEditSplits={setSplittingActivity}
            onEdit={handleEditRow}
            onDuplicate={handleDuplicate}
            onDelete={handleDeleteRow}
            onLinkTransfer={handleLinkTransfer}
            onUnlinkTransfer={handleUnlinkTransfer}
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
          isMobile={isMobile}
        />

        {selectedRowIds.size > 0 && (
          <TransactionsBulkBar
            selectedCount={selectedRowIds.size}
            categoryScope={bulkCategoryScope}
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
            <EmptyPlaceholder.Title>{t("spending:txTab.loadErrorTitle")}</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {error?.message ?? t("spending:txTab.tryRefreshing")}
            </EmptyPlaceholder.Description>
            <Button variant="outline" onClick={() => void refetch()}>
              {t("common:retry")}
            </Button>
          </EmptyPlaceholder>
        ) : rows.length === 0 ? (
          <EmptyPlaceholder>
            <EmptyPlaceholder.Icon name="Activity" />
            <EmptyPlaceholder.Title>{t("spending:txTab.noTransactions")}</EmptyPlaceholder.Title>
            <EmptyPlaceholder.Description>
              {filtersActive ? t("spending:txTab.noMatchFilters") : t("spending:txTab.addFirst")}
            </EmptyPlaceholder.Description>
            {filtersActive ? (
              <Button variant="outline" onClick={clearAllFilters}>
                {t("spending:txTab.clearFilters")}
              </Button>
            ) : (
              <Button onClick={openAddForm}>
                <Icons.Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("spending:txTab.addTransaction")}
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
                      ? t("spending:txTab.deselectAllVisible")
                      : t("spending:txTab.selectAllVisible")
                  }
                />
                <span className="text-muted-foreground text-xs">{t("common:select_all")}</span>
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
                          ? t("spending:txTab.deselectAllVisible")
                          : t("spending:txTab.selectAllVisible")
                      }
                    />
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">{t("common:date")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common:type")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("common:account")}</TableHead>
                  <TableHead>{t("spending:txTab.nameNotes")}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t("spending:filters.category")}
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t("spending:filters.event")}
                  </TableHead>
                  <TableHead className="text-right">{t("common:amount")}</TableHead>
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
          onTransferClick={handleTransferClick}
        />

        <SplitTransactionSheet
          open={!!splittingActivity}
          row={splittingActivity}
          categories={allCategories}
          isSaving={replaceSplitsMutation.isPending || clearSplitsMutation.isPending}
          onOpenChange={(open) => {
            if (!open) setSplittingActivity(null);
          }}
          onSave={handleSaveSplits}
          onClear={handleClearSplits}
        />

        {showTransferForm &&
          (isMobile ? (
            <MobileActivityForm
              accounts={transferFormAccounts}
              transferAccounts={transferFormAccounts}
              activity={transferFormActivity}
              open={showTransferForm}
              onClose={handleTransferFormClose}
              startOnDetails
            />
          ) : (
            <ActivityForm
              accounts={transferFormAccounts}
              transferAccounts={transferFormAccounts}
              activity={transferFormActivity}
              open={showTransferForm}
              onClose={handleTransferFormClose}
              hidePicker
            />
          ))}

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

        <TransferMatchDialog
          open={transferMatchDialog.open}
          mode={transferMatchDialog.mode}
          sourceActivity={transferMatchDialog.row?.activity}
          accounts={accounts}
          onOpenChange={(open) =>
            setTransferMatchDialog((prev) => ({
              ...prev,
              open,
              row: open ? prev.row : null,
            }))
          }
          onComplete={refetch}
        />
      </div>
    );
  },
);
