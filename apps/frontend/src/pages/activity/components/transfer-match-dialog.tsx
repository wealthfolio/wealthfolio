import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import {
  findTransferMatchCandidates,
  getTransferPairForActivity,
  searchActivities,
} from "@/adapters";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { Account, Activity, ActivityDetails, TransferMatchCandidate } from "@/lib/types";
import { cn, formatDateISO, formatDateTime } from "@/lib/utils";
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  formatAmount,
  Icons,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@wealthfolio/ui";
import { ActivityTypeBadge } from "./activity-type-badge";
import type { NewActivityFormValues } from "./forms/schemas";
import { isSameAccountCashFxConversion, nonCashTransferAssetKey } from "./transfer-link-utils";
import { useActivityMutations } from "../hooks/use-activity-mutations";

export type TransferDialogActivity = Activity | ActivityDetails;

interface SelectedCandidate {
  activity: TransferDialogActivity;
  reasons: string[];
  warnings: string[];
}

interface TransferMatchDialogProps {
  open: boolean;
  mode: "link" | "unlink";
  sourceActivity?: TransferDialogActivity | null;
  accounts: Account[];
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void | Promise<unknown>;
}

interface NormalizedTransferActivity {
  id: string;
  accountId: string;
  accountName: string;
  accountType: string;
  accountCurrency: string;
  activityType: string;
  date: Date | string;
  amount?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  currency: string;
  assetId?: string;
  assetSymbol?: string;
  notes?: string;
  sourceGroupId?: string;
  status?: string;
}

const ALL = "__all__";
const STRICT = "strict";
const ANY = "any";
const SAME_ASSET = "same";
const CASH_ASSET = "cash";

function isTransferType(activityType: string | undefined): boolean {
  return activityType === ActivityType.TRANSFER_IN || activityType === ActivityType.TRANSFER_OUT;
}

function oppositeTransferType(activityType: string | undefined): ActivityType | undefined {
  if (activityType === ActivityType.TRANSFER_IN) return ActivityType.TRANSFER_OUT;
  if (activityType === ActivityType.TRANSFER_OUT) return ActivityType.TRANSFER_IN;
  return undefined;
}

function parseNumber(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function absEquals(a: number | undefined, b: number | undefined, tolerance = 0.000001): boolean {
  if (a == null || b == null) return false;
  return Math.abs(Math.abs(a) - Math.abs(b)) <= tolerance;
}

function getActivityDate(activity: TransferDialogActivity): Date | string {
  return "date" in activity ? activity.date : activity.activityDate;
}

function getActivityNotes(activity: TransferDialogActivity): string | undefined {
  if ("comment" in activity) return activity.comment;
  return (activity as Activity).notes;
}

function getActivityAssetSymbol(activity: TransferDialogActivity): string | undefined {
  if ("assetSymbol" in activity && activity.assetSymbol?.trim()) return activity.assetSymbol;
  return activity.assetId;
}

function getAccountName(
  activity: TransferDialogActivity,
  accountMap: Map<string, Account>,
): string {
  if ("accountName" in activity && activity.accountName?.trim()) return activity.accountName;
  return accountMap.get(activity.accountId)?.name ?? activity.accountId;
}

function getAccountCurrency(
  activity: TransferDialogActivity,
  accountMap: Map<string, Account>,
): string {
  if ("accountCurrency" in activity && activity.accountCurrency?.trim()) {
    return activity.accountCurrency;
  }
  return accountMap.get(activity.accountId)?.currency ?? activity.currency;
}

function normalizeActivity(
  activity: TransferDialogActivity,
  accountMap: Map<string, Account>,
): NormalizedTransferActivity {
  const account = accountMap.get(activity.accountId);
  return {
    id: activity.id,
    accountId: activity.accountId,
    accountName: getAccountName(activity, accountMap),
    accountType: account?.accountType ?? "",
    accountCurrency: getAccountCurrency(activity, accountMap),
    activityType: activity.activityType,
    date: getActivityDate(activity),
    amount: activity.amount,
    quantity: activity.quantity,
    unitPrice: activity.unitPrice,
    currency: activity.currency,
    assetId: activity.assetId,
    assetSymbol: getActivityAssetSymbol(activity),
    notes: getActivityNotes(activity),
    sourceGroupId: activity.sourceGroupId,
    status: activity.status,
  };
}

function assetKey(activity: NormalizedTransferActivity): string | undefined {
  return nonCashTransferAssetKey(activity);
}

function amountValue(activity: NormalizedTransferActivity): number | undefined {
  const amount = parseNumber(activity.amount);
  if (amount != null) return amount;
  const quantity = parseNumber(activity.quantity);
  const unitPrice = parseNumber(activity.unitPrice);
  if (quantity != null && unitPrice != null) return quantity * unitPrice;
  return undefined;
}

function isSecurityTransfer(activity: NormalizedTransferActivity): boolean {
  return Boolean(assetKey(activity));
}

function sameExactShape(
  source: NormalizedTransferActivity,
  candidate: NormalizedTransferActivity,
): boolean {
  if (isSameAccountCashFxConversion(source, candidate)) return true;
  if (isSecurityTransfer(source) || isSecurityTransfer(candidate)) {
    return (
      assetKey(source) === assetKey(candidate) &&
      absEquals(parseNumber(source.quantity), parseNumber(candidate.quantity))
    );
  }
  return (
    source.currency === candidate.currency && absEquals(amountValue(source), amountValue(candidate))
  );
}

function canLinkCandidate(
  source: NormalizedTransferActivity,
  candidate: NormalizedTransferActivity,
): boolean {
  if (source.accountId === candidate.accountId) {
    return isSameAccountCashFxConversion(source, candidate);
  }
  if (isSecurityTransfer(source) || isSecurityTransfer(candidate)) {
    return (
      assetKey(source) === assetKey(candidate) &&
      absEquals(parseNumber(source.quantity), parseNumber(candidate.quantity))
    );
  }
  return true;
}

function dateDiffDays(a: Date | string, b: Date | string): number | undefined {
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
  return Math.round(Math.abs(left - right) / (1000 * 60 * 60 * 24));
}

function dateWindow(date: Date | string, windowDays: number): { from: string; to: string } {
  const center = new Date(date);
  const from = new Date(center);
  const to = new Date(center);
  from.setDate(center.getDate() - windowDays);
  to.setDate(center.getDate() + windowDays);
  return { from: formatDateISO(from), to: formatDateISO(to) };
}

function activityMatchesText(activity: NormalizedTransferActivity, searchText: string): boolean {
  const needle = searchText.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [activity.notes, activity.assetSymbol, activity.assetId, activity.accountName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function manualWarnings(
  source: NormalizedTransferActivity,
  candidate: NormalizedTransferActivity,
  t: TFunction,
): string[] {
  const warnings: string[] = [];
  const diff = dateDiffDays(source.date, candidate.date);
  if (diff && diff > 0)
    warnings.push(t("activity:transfer_match.warning_dates_differ", { count: diff }));
  if (isSameAccountCashFxConversion(source, candidate)) {
    return warnings;
  }
  if (source.currency !== candidate.currency) {
    warnings.push(
      t("activity:transfer_match.warning_currencies_differ", {
        source: source.currency,
        candidate: candidate.currency,
      }),
    );
  }
  const sourcePrice = parseNumber(source.unitPrice);
  const candidatePrice = parseNumber(candidate.unitPrice);
  if (
    sourcePrice != null &&
    candidatePrice != null &&
    !absEquals(sourcePrice, candidatePrice, 0.01)
  ) {
    warnings.push(t("activity:transfer_match.warning_prices_differ"));
  }
  if (!sameExactShape(source, candidate)) {
    warnings.push(t("activity:transfer_match.warning_amount_mismatch"));
  }
  return warnings;
}

function activitySortKey(activity: TransferDialogActivity): string {
  return `${new Date(getActivityDate(activity)).getTime()}-${activity.id}`;
}

function externalTransferUpdatePayload(
  activity: TransferDialogActivity,
): NewActivityFormValues & { id: string; currentAssetId?: string } {
  const amount = parseNumber(activity.amount);
  const quantity = parseNumber(activity.quantity);
  const unitPrice = parseNumber(activity.unitPrice);
  const fee = parseNumber(activity.fee);
  const fxRate = parseNumber(activity.fxRate);

  return {
    id: activity.id,
    accountId: activity.accountId,
    activityType: activity.activityType as Extract<ActivityType, "TRANSFER_IN" | "TRANSFER_OUT">,
    activityDate: getActivityDate(activity),
    currency: activity.currency,
    amount,
    quantity,
    unitPrice,
    fee,
    fxRate,
    comment: getActivityNotes(activity),
    subtype: activity.subtype ?? null,
    currentAssetId: activity.assetId,
    metadata: { flow: { is_external: true } },
  } as NewActivityFormValues & { id: string; currentAssetId?: string };
}

function ActivitySummaryRow({
  activity,
  accountMap,
  className,
}: {
  activity: TransferDialogActivity;
  accountMap: Map<string, Account>;
  className?: string;
}) {
  const { t } = useTranslation();
  const normalized = normalizeActivity(activity, accountMap);
  const date = formatDateTime(normalized.date).date;
  const amount = amountValue(normalized);
  const quantity = parseNumber(normalized.quantity);
  const symbol = normalized.assetSymbol || normalized.assetId || t("activity:date_list.cash");

  return (
    <div className={cn("flex flex-col gap-1.5 rounded-md px-3 py-2.5 text-sm", className)}>
      <div className="flex items-center justify-between gap-3">
        <ActivityTypeBadge type={normalized.activityType as ActivityType} />
        <span className="text-muted-foreground shrink-0 text-xs">{date}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{normalized.accountName}</span>
        <span className="shrink-0 font-medium tabular-nums">
          {amount != null
            ? formatAmount(Math.abs(amount), normalized.currency)
            : normalized.currency}
        </span>
      </div>
      <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate">{normalized.notes || symbol}</span>
        <span className="shrink-0">
          {quantity != null ? `${Math.abs(quantity)} ${symbol}` : normalized.accountCurrency}
        </span>
      </div>
    </div>
  );
}

function CandidateButton({
  candidate,
  accountMap,
  selected,
  onSelect,
}: {
  candidate: SelectedCandidate;
  accountMap: Map<string, Account>;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-muted/50 flex w-full items-start rounded-md border text-left transition-colors",
        selected && "border-primary bg-primary/5 hover:bg-primary/5",
      )}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="py-3 pl-3">
        {selected ? (
          <Icons.CheckCircle className="text-primary h-4 w-4" />
        ) : (
          <Icons.Circle className="text-muted-foreground/30 h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <ActivitySummaryRow activity={candidate.activity} accountMap={accountMap} />
        {candidate.reasons.length > 0 || candidate.warnings.length > 0 ? (
          <div className="space-y-1.5 px-3 pb-2.5">
            {candidate.reasons.length > 0 ? (
              <div className="text-muted-foreground flex flex-wrap gap-1 text-[11px]">
                {candidate.reasons.map((reason) => (
                  <Badge key={reason} variant="secondary" className="rounded-sm px-1.5 py-0">
                    {reason}
                  </Badge>
                ))}
              </div>
            ) : null}
            {candidate.warnings.length > 0 ? (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-600">
                <Icons.AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{candidate.warnings.join(" ")}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </button>
  );
}

export function TransferMatchDialog({
  open,
  mode,
  sourceActivity,
  accounts,
  onOpenChange,
  onComplete,
}: TransferMatchDialogProps) {
  const { t } = useTranslation();
  const accountMap = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const activeAccounts = useMemo(
    () => accounts.filter((account) => !account.isArchived),
    [accounts],
  );
  const accountTypeOptions = useMemo(
    () => Array.from(new Set(activeAccounts.map((account) => account.accountType))).sort(),
    [activeAccounts],
  );
  const currencyOptions = useMemo(
    () => Array.from(new Set(activeAccounts.map((account) => account.currency))).sort(),
    [activeAccounts],
  );

  const source = useMemo(
    () => (sourceActivity ? normalizeActivity(sourceActivity, accountMap) : null),
    [accountMap, sourceActivity],
  );
  const oppositeType = oppositeTransferType(source?.activityType);

  const {
    linkTransferActivitiesMutation,
    unlinkTransferActivitiesMutation,
    updateActivityMutation,
  } = useActivityMutations();
  const isProcessing =
    mode === "link"
      ? linkTransferActivitiesMutation.isPending
      : unlinkTransferActivitiesMutation.isPending || updateActivityMutation.isPending;

  const [suggestions, setSuggestions] = useState<TransferMatchCandidate[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [manualResults, setManualResults] = useState<ActivityDetails[]>([]);
  const [manualSearched, setManualSearched] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualLinkedCandidateIds, setManualLinkedCandidateIds] = useState<Set<string>>(new Set());
  const [manualGroupCheckPendingIds, setManualGroupCheckPendingIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedCandidate, setSelectedCandidate] = useState<SelectedCandidate | null>(null);
  const [counterpart, setCounterpart] = useState<TransferDialogActivity | null>(null);
  const [counterpartError, setCounterpartError] = useState<string | null>(null);
  const [counterpartLoading, setCounterpartLoading] = useState(false);

  const [searchText, setSearchText] = useState("");
  const [accountId, setAccountId] = useState(ALL);
  const [accountType, setAccountType] = useState(ALL);
  const [windowDays, setWindowDays] = useState("7");
  const [currency, setCurrency] = useState(ALL);
  const [assetFilter, setAssetFilter] = useState(ALL);
  const [matchMode, setMatchMode] = useState(STRICT);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const resetFilters = useCallback(() => {
    setSearchText("");
    setAccountId(ALL);
    setAccountType(ALL);
    setWindowDays("7");
    setCurrency(ALL);
    setAssetFilter(ALL);
    setMatchMode(STRICT);
    setManualResults([]);
    setManualSearched(false);
    setManualError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSelectedCandidate(null);
    setSuggestions([]);
    setSuggestionsError(null);
    setManualResults([]);
    setManualSearched(false);
    setManualError(null);
    setManualLinkedCandidateIds(new Set());
    setManualGroupCheckPendingIds(new Set());
    setCounterpart(null);
    setCounterpartError(null);

    if (!sourceActivity?.id) return;

    if (mode === "link") {
      setSuggestionsLoading(true);
      findTransferMatchCandidates({ activityId: sourceActivity.id, windowDays: 7, limit: 25 })
        .then((result) => setSuggestions(result))
        .catch((error) =>
          setSuggestionsError(
            error instanceof Error
              ? error.message
              : t("activity:transfer_match.error_load_suggestions"),
          ),
        )
        .finally(() => setSuggestionsLoading(false));
    } else {
      setCounterpartLoading(true);
      getTransferPairForActivity(sourceActivity.id)
        .then((pair) => {
          setCounterpart(
            sourceActivity.id === pair.transferIn.id ? pair.transferOut : pair.transferIn,
          );
        })
        .catch((error) =>
          setCounterpartError(
            error instanceof Error ? error.message : t("activity:transfer_match.error_load_pair"),
          ),
        )
        .finally(() => setCounterpartLoading(false));
    }
  }, [mode, open, sourceActivity, t]);

  useEffect(() => {
    if (!open || mode !== "link") {
      setManualLinkedCandidateIds(new Set());
      setManualGroupCheckPendingIds(new Set());
      return;
    }

    const groupedCandidates = manualResults.filter((activity) => activity.sourceGroupId);
    if (groupedCandidates.length === 0) {
      setManualLinkedCandidateIds(new Set());
      setManualGroupCheckPendingIds(new Set());
      return;
    }

    let cancelled = false;
    setManualLinkedCandidateIds(new Set());
    setManualGroupCheckPendingIds(new Set(groupedCandidates.map((activity) => activity.id)));

    void Promise.all(
      groupedCandidates.map(async (activity) => {
        try {
          await getTransferPairForActivity(activity.id);
          return activity.id;
        } catch {
          return null;
        }
      }),
    ).then((linkedIds) => {
      if (cancelled) return;
      setManualLinkedCandidateIds(new Set(linkedIds.filter((id): id is string => Boolean(id))));
      setManualGroupCheckPendingIds(new Set());
    });

    return () => {
      cancelled = true;
    };
  }, [manualResults, mode, open]);

  const suggestedCandidates = useMemo<SelectedCandidate[]>(
    () =>
      suggestions.map((candidate) => ({
        activity: candidate.activity,
        reasons: candidate.reasons,
        warnings: candidate.warnings,
      })),
    [suggestions],
  );

  const filteredManualResults = useMemo<SelectedCandidate[]>(() => {
    if (!source || !oppositeType) return [];
    return manualResults
      .filter((activity) => {
        const candidate = normalizeActivity(activity, accountMap);
        const candidateAccount = accountMap.get(candidate.accountId);
        if (candidate.id === source.id) return false;
        if (manualLinkedCandidateIds.has(candidate.id)) return false;
        if (manualGroupCheckPendingIds.has(candidate.id)) return false;
        if (candidate.activityType !== oppositeType) return false;
        if (candidate.status && candidate.status !== ActivityStatus.POSTED) return false;
        if (accountId !== ALL && candidate.accountId !== accountId) return false;
        if (accountType !== ALL && candidateAccount?.accountType !== accountType) return false;
        if (currency !== ALL && candidate.currency !== currency) return false;
        if (assetFilter === SAME_ASSET && assetKey(candidate) !== assetKey(source)) return false;
        if (assetFilter === CASH_ASSET && assetKey(candidate)) return false;
        if (!canLinkCandidate(source, candidate)) return false;
        if (matchMode === STRICT && !sameExactShape(source, candidate)) return false;
        return activityMatchesText(candidate, searchText);
      })
      .sort((left, right) => activitySortKey(right).localeCompare(activitySortKey(left)))
      .map((activity) => {
        const candidate = normalizeActivity(activity, accountMap);
        const reasons = isSameAccountCashFxConversion(source, candidate)
          ? [t("activity:transfer_match.reason_fx_conversion")]
          : sameExactShape(source, candidate)
            ? [
                isSecurityTransfer(source)
                  ? t("activity:transfer_match.reason_same_asset_quantity")
                  : t("activity:transfer_match.reason_same_amount_currency"),
              ]
            : [t("activity:transfer_match.reason_eligible_opposite")];
        const warnings = manualWarnings(source, candidate, t);
        if (candidate.sourceGroupId) {
          warnings.push(t("activity:transfer_match.warning_stale_link"));
        }
        return {
          activity,
          reasons,
          warnings,
        };
      });
  }, [
    accountId,
    accountMap,
    accountType,
    assetFilter,
    currency,
    manualResults,
    manualGroupCheckPendingIds,
    manualLinkedCandidateIds,
    matchMode,
    oppositeType,
    searchText,
    source,
    t,
  ]);

  const runManualSearch = useCallback(
    async (windowDaysOverride?: number) => {
      if (!source || !oppositeType) return;
      const days = windowDaysOverride ?? Number(windowDays);
      const safeWindowDays = Number.isFinite(days) ? days : 7;
      const { from, to } = dateWindow(source.date, safeWindowDays);
      setManualLoading(true);
      setManualError(null);
      try {
        const response = await searchActivities(
          0,
          250,
          {
            activityTypes: [oppositeType],
            accountIds: accountId === ALL ? undefined : [accountId],
            dateFrom: from,
            dateTo: to,
          },
          "",
          { id: "date", desc: true },
        );
        setManualResults(response.data);
        setManualSearched(true);
      } catch (error) {
        setManualError(
          error instanceof Error ? error.message : t("activity:transfer_match.error_search"),
        );
      } finally {
        setManualLoading(false);
      }
    },
    [accountId, oppositeType, source, windowDays, t],
  );

  const widenSearch = useCallback(() => {
    setWindowDays("30");
    void runManualSearch(30);
  }, [runManualSearch]);

  const advancedFilterCount = [
    accountType !== ALL,
    currency !== ALL,
    assetFilter !== ALL,
    matchMode !== STRICT,
  ].filter(Boolean).length;

  const confirmLink = useCallback(async () => {
    if (!sourceActivity?.id || !selectedCandidate?.activity.id) return;
    await linkTransferActivitiesMutation.mutateAsync({
      activityAId: sourceActivity.id,
      activityBId: selectedCandidate.activity.id,
    });
    await onComplete?.();
    onOpenChange(false);
  }, [
    linkTransferActivitiesMutation,
    onComplete,
    onOpenChange,
    selectedCandidate?.activity.id,
    sourceActivity?.id,
  ]);

  const canClearInvalidLink =
    mode === "unlink" && !counterpartLoading && !counterpart && Boolean(source?.sourceGroupId);

  const confirmUnlink = useCallback(async () => {
    if (!sourceActivity?.id) return;

    if (counterpart?.id) {
      await unlinkTransferActivitiesMutation.mutateAsync({
        activityAId: sourceActivity.id,
        activityBId: counterpart.id,
      });
    } else if (source?.sourceGroupId) {
      await updateActivityMutation.mutateAsync(externalTransferUpdatePayload(sourceActivity));
    } else {
      return;
    }

    await onComplete?.();
    onOpenChange(false);
  }, [
    counterpart?.id,
    onComplete,
    onOpenChange,
    source?.sourceGroupId,
    sourceActivity,
    unlinkTransferActivitiesMutation,
    updateActivityMutation,
  ]);

  const title =
    mode === "link"
      ? t("activity:transfer_match.link_title")
      : t("activity:transfer_match.unlink_title");
  const description =
    mode === "link"
      ? t("activity:transfer_match.link_desc")
      : canClearInvalidLink
        ? t("activity:transfer_match.clear_stale_desc")
        : t("activity:transfer_match.unlink_desc");

  if (!sourceActivity || !source || !isTransferType(source.activityType)) {
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-[760px]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs font-medium uppercase">
              {t("activity:transfer_match.selected_row")}
            </div>
            <ActivitySummaryRow
              activity={sourceActivity}
              accountMap={accountMap}
              className="bg-muted/30 border"
            />
          </div>

          {mode === "unlink" ? (
            <div className="space-y-3">
              <div className="text-muted-foreground text-xs font-medium uppercase">
                {t("activity:transfer_match.linked_counterpart")}
              </div>
              {counterpartLoading ? (
                <div className="text-muted-foreground rounded-md border p-3 text-sm">
                  {t("activity:transfer_match.loading_linked")}
                </div>
              ) : counterpart ? (
                <ActivitySummaryRow
                  activity={counterpart}
                  accountMap={accountMap}
                  className="bg-muted/30 border"
                />
              ) : canClearInvalidLink ? (
                <div className="rounded-md border p-3 text-sm">
                  <div className="font-medium">{t("activity:transfer_match.no_counterpart")}</div>
                  <div className="text-muted-foreground mt-1">
                    {t("activity:transfer_match.no_counterpart_clear_hint")}
                  </div>
                </div>
              ) : (
                <div className="text-destructive rounded-md border p-3 text-sm">
                  {counterpartError ?? t("activity:transfer_match.no_counterpart")}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-muted-foreground text-xs font-medium uppercase">
                    {t("activity:transfer_match.suggested_matches")}
                  </div>
                  {oppositeType ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-xs">
                        {t("activity:transfer_match.looking_for")}
                      </span>
                      <ActivityTypeBadge type={oppositeType} />
                    </div>
                  ) : null}
                </div>
                {suggestionsLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-[88px] w-full rounded-md" />
                    <Skeleton className="h-[88px] w-full rounded-md" />
                  </div>
                ) : suggestionsError ? (
                  <div className="text-destructive rounded-md border p-3 text-sm">
                    {suggestionsError}
                  </div>
                ) : suggestedCandidates.length > 0 ? (
                  <div className="space-y-2">
                    {suggestedCandidates.map((candidate) => (
                      <CandidateButton
                        key={candidate.activity.id}
                        candidate={candidate}
                        accountMap={accountMap}
                        selected={selectedCandidate?.activity.id === candidate.activity.id}
                        onSelect={() => setSelectedCandidate(candidate)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 text-center">
                    <Icons.Search className="text-muted-foreground h-5 w-5" />
                    <p className="text-muted-foreground text-sm">
                      {t("activity:transfer_match.no_matches_7_days")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={widenSearch}
                      disabled={manualLoading}
                    >
                      {t("activity:transfer_match.search_30_days")}
                    </Button>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {t("activity:transfer_match.search_eligible")}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t("activity:transfer_match.only_type_searched", {
                        type: oppositeType
                          ? localizeActivityTypeName(t, oppositeType)
                          : t("activity:transfer_match.opposite_transfer"),
                      })}
                    </div>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
                    {t("activity:transfer_match.reset_filters")}
                  </Button>
                </div>

                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runManualSearch();
                  }}
                >
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Icons.Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                      <Input
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder={t("activity:transfer_match.search_placeholder")}
                        className="pl-9"
                      />
                    </div>
                    <Button type="submit" disabled={manualLoading}>
                      {manualLoading ? (
                        <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Icons.Search className="mr-2 h-4 w-4" />
                      )}
                      {t("common:search")}
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <Select value={accountId} onValueChange={setAccountId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("activity:filter_account")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>{t("activity:all_accounts")}</SelectItem>
                        {activeAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Select value={windowDays} onValueChange={setWindowDays}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("activity:transfer_match.date_range")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7">
                          {t("activity:transfer_match.within_days", { count: 7 })}
                        </SelectItem>
                        <SelectItem value="30">
                          {t("activity:transfer_match.within_days", { count: 30 })}
                        </SelectItem>
                        <SelectItem value="90">
                          {t("activity:transfer_match.within_days", { count: 90 })}
                        </SelectItem>
                        <SelectItem value="180">
                          {t("activity:transfer_match.within_days", { count: 180 })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-7 px-2 text-xs"
                      >
                        <Icons.ChevronDown
                          className={cn(
                            "mr-1 h-3.5 w-3.5 transition-transform",
                            filtersOpen && "rotate-180",
                          )}
                        />
                        {t("activity:transfer_match.more_filters")}
                        {advancedFilterCount > 0 ? (
                          <Badge
                            variant="secondary"
                            className="ml-1.5 rounded-sm px-1.5 py-0 text-[10px]"
                          >
                            {advancedFilterCount}
                          </Badge>
                        ) : null}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-2">
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <Select value={accountType} onValueChange={setAccountType}>
                          <SelectTrigger>
                            <SelectValue placeholder={t("activity:transfer_match.account_type")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ALL}>
                              {t("activity:transfer_match.all_account_types")}
                            </SelectItem>
                            {accountTypeOptions.map((type) => (
                              <SelectItem key={type} value={type}>
                                {type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select value={currency} onValueChange={setCurrency}>
                          <SelectTrigger>
                            <SelectValue placeholder={t("activity:table_currency")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ALL}>
                              {t("activity:transfer_match.all_currencies")}
                            </SelectItem>
                            {currencyOptions.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select value={assetFilter} onValueChange={setAssetFilter}>
                          <SelectTrigger>
                            <SelectValue placeholder={t("activity:transfer_match.asset")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ALL}>
                              {t("activity:transfer_match.all_assets")}
                            </SelectItem>
                            {isSecurityTransfer(source) ? (
                              <SelectItem value={SAME_ASSET}>
                                {t("activity:transfer_match.same_asset")}
                              </SelectItem>
                            ) : (
                              <SelectItem value={CASH_ASSET}>
                                {t("activity:transfer_match.cash_only")}
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>

                        <Select value={matchMode} onValueChange={setMatchMode}>
                          <SelectTrigger>
                            <SelectValue placeholder={t("activity:transfer_match.match_mode")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={STRICT}>
                              {t("activity:transfer_match.exact_amount")}
                            </SelectItem>
                            <SelectItem value={ANY}>
                              {t("activity:transfer_match.any_eligible")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </form>

                {manualError ? (
                  <div className="text-destructive rounded-md border p-3 text-sm">
                    {manualError}
                  </div>
                ) : null}

                {manualSearched ? (
                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs">
                      {t("activity:transfer_match.eligible_count", {
                        count: filteredManualResults.length,
                      })}
                    </div>
                    <ScrollArea className="max-h-72">
                      <div className="space-y-2 pr-3">
                        {filteredManualResults.length > 0 ? (
                          filteredManualResults.map((candidate) => (
                            <CandidateButton
                              key={candidate.activity.id}
                              candidate={candidate}
                              accountMap={accountMap}
                              selected={selectedCandidate?.activity.id === candidate.activity.id}
                              onSelect={() => setSelectedCandidate(candidate)}
                            />
                          ))
                        ) : (
                          <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
                            {t("activity:transfer_match.no_eligible_filters")}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isProcessing}>
            {t("common:cancel")}
          </Button>
          {mode === "link" ? (
            <Button
              onClick={() => void confirmLink()}
              disabled={!selectedCandidate || isProcessing}
            >
              {isProcessing ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Link className="mr-2 h-4 w-4" />
              )}
              {t("activity:transfer_match.link_button")}
            </Button>
          ) : (
            <Button
              onClick={() => void confirmUnlink()}
              disabled={
                isProcessing || counterpartLoading || (!counterpart && !canClearInvalidLink)
              }
            >
              {isProcessing ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Unlink className="mr-2 h-4 w-4" />
              )}
              {counterpart
                ? t("activity:transfer_match.unlink_button_plural")
                : t("activity:transfer_match.unlink_button")}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
