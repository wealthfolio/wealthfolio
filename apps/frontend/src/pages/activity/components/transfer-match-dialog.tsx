import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  isActivityEditCancelled,
  useConvertToTransferSplitReview,
} from "@/features/spending/components/activity-split-review-provider";
import { useActivitySplits } from "@/features/spending/hooks/use-cash-activities";
import { useEffectOnChange } from "@/hooks/use-effect-on-change";
import {
  convertToInternalTransfer,
  findTransferMatchCandidates,
  getTransferPairForActivity,
  searchActivities,
} from "@/adapters";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import {
  getEffectiveType,
  type Account,
  type Activity,
  type ActivityDetails,
  type TransferMatchCandidate,
} from "@/lib/types";
import { cn, formatDateISO, formatDateTime } from "@/lib/utils";
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
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
  MoneyInput,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
  Spinner,
} from "@wealthfolio/ui";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActivityMutations } from "../hooks/use-activity-mutations";
import { ActivityTypeBadge } from "./activity-type-badge";
import type { NewActivityFormValues } from "./forms/schemas";
import {
  canConvertToTransfer,
  candidateWarnings,
  isSameAccountCashFxConversion,
  nonCashTransferAssetKey,
} from "./transfer-link-utils";

export type TransferDialogActivity = Activity | ActivityDetails;

interface SelectedCandidate {
  activity: TransferDialogActivity;
  /** What differs from the activity being linked, translated. */
  warnings: string[];
  /** The details rows those warnings are about. */
  differs: DetailField[];
}

/** A row of the details table that a warning can point at. */
type DetailField = "date" | "amount" | "currency" | "quantity" | "price";

/** The rows the core's warnings point at, so the table flags what the list warns about. */
function candidateDiffers(candidate: TransferMatchCandidate): DetailField[] {
  return (candidate.warningCodes ?? []).flatMap((warning): DetailField[] => {
    switch (warning.code) {
      case "dates_differ":
        return ["date"];
      case "currencies_differ":
        return ["currency"];
      case "prices_differ":
        return ["price"];
      case "another_match":
        return [];
    }
  });
}

interface TransferMatchDialogProps {
  open: boolean;
  mode: "link" | "unlink";
  sourceActivity?: TransferDialogActivity | null;
  /** Link mode: the other side to select once the suggestions load. */
  counterpartId?: string;
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

/**
 * A suggestion carries only its asset's id. One holding the source's asset takes
 * the source's ticker, so both sides name the security alike.
 */
function withSourceSymbol(activity: Activity, source?: TransferDialogActivity | null): Activity {
  const symbol = source && "assetSymbol" in source ? source.assetSymbol?.trim() : undefined;
  if (!symbol || !activity.assetId || activity.assetId !== source?.assetId) return activity;
  const named: Activity & { assetSymbol: string } = { ...activity, assetSymbol: symbol };
  return named;
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
    // The displayed type, so a broker row overridden to a transfer can be linked.
    activityType: getEffectiveType(activity),
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
  if (!isSecurityTransfer(activity)) return undefined;
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
): Pick<SelectedCandidate, "warnings" | "differs"> {
  const warnings: string[] = [];
  const differs: DetailField[] = [];
  const diff = dateDiffDays(source.date, candidate.date);
  if (diff && diff > 0) {
    warnings.push(t("activity:transfer_match.warning_dates_differ", { count: diff }));
    differs.push("date");
  }
  if (isSameAccountCashFxConversion(source, candidate)) {
    return { warnings, differs };
  }
  if (source.currency !== candidate.currency) {
    warnings.push(
      t("activity:transfer_match.warning_currencies_differ", {
        source: source.currency,
        candidate: candidate.currency,
      }),
    );
    differs.push("currency");
  }
  const sourcePrice = parseNumber(source.unitPrice);
  const candidatePrice = parseNumber(candidate.unitPrice);
  if (
    sourcePrice != null &&
    candidatePrice != null &&
    !absEquals(sourcePrice, candidatePrice, 0.01)
  ) {
    warnings.push(t("activity:transfer_match.warning_prices_differ"));
    differs.push("price");
  }
  if (!sameExactShape(source, candidate)) {
    warnings.push(t("activity:transfer_match.warning_amount_mismatch"));
    differs.push(isSecurityTransfer(source) ? "quantity" : "amount");
  }
  return { warnings, differs };
}

function activitySortKey(activity: TransferDialogActivity): string {
  return `${new Date(getActivityDate(activity)).getTime()}-${activity.id}`;
}

/** The update that marks a transfer as money moving into or out of the portfolio. */
export function externalTransferUpdatePayload(
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
    // The displayed type: echoing it keeps a broker row's type override.
    activityType: getEffectiveType(activity) as Extract<
      ActivityType,
      "TRANSFER_IN" | "TRANSFER_OUT"
    >,
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
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const { t } = useTranslation();
  const normalized = normalizeActivity(activity, accountMap);
  const date = formatDateTime(normalized.date, dateFormatting).date;
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
            ? formatting.formatAmount(Math.abs(amount), normalized.currency)
            : normalized.currency}
        </span>
      </div>
      <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate">{normalized.notes || symbol}</span>
        <span className="shrink-0">
          {quantity != null ? `${Math.abs(quantity)} ${symbol}` : normalized.currency}
        </span>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  [ActivityStatus.POSTED]: "activity:detail.status_posted",
  [ActivityStatus.PENDING]: "activity:detail.status_pending",
  [ActivityStatus.DRAFT]: "activity:detail.status_draft",
  [ActivityStatus.VOID]: "activity:detail.status_void",
};

/** A heading inside the sheet, with an optional count and something at its end. */
function SheetSectionHeading({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count != null ? (
          <Badge variant="secondary" className="text-2xs h-5 px-1.5 font-medium">
            {count}
          </Badge>
        ) : null}
      </h3>
      {children}
    </div>
  );
}

/** One line under a suggestion: what differs, as the page's rows say it. */
function CandidateWarning({ text }: { text: string }) {
  return (
    <span className="text-warning flex items-start gap-1.5 text-xs">
      <Icons.AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

/** The suggestions failed to load: says so, with a way to try again. */
function SuggestionsError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Icons.AlertCircle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
        {t("activity:transfer_match.error_load_suggestions")}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <Icons.RefreshCw className="me-2 h-3.5 w-3.5" />
        {t("common:retry")}
      </Button>
    </div>
  );
}

/**
 * This activity and the selected match, field by field, so a match can be
 * checked before linking. The rows the match's warnings are about are flagged
 * on its side. Fields both sides leave empty are left out.
 */
function PairDetails({
  source,
  match,
  differs = [],
  awaitingMatch = true,
  accountMap,
}: {
  source: TransferDialogActivity;
  match?: TransferDialogActivity;
  differs?: readonly DetailField[];
  /** Without a match, whether its column points to the list below. */
  awaitingMatch?: boolean;
  accountMap: Map<string, Account>;
}) {
  const { t } = useTranslation();
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const numbers = useNumberFormatting();
  const legs = match ? [source, match] : [source];
  const money = (value: string | null | undefined, currency: string) => {
    const parsed = parseNumber(value);
    return parsed != null && parsed !== 0
      ? formatting.formatAmount(Math.abs(parsed), currency)
      : null;
  };
  const amount = (leg: TransferDialogActivity) => {
    const value = amountValue(normalizeActivity(leg, accountMap));
    return value != null ? formatting.formatAmount(Math.abs(value), leg.currency) : null;
  };
  const quantity = (leg: TransferDialogActivity) => {
    const value = parseNumber(leg.quantity);
    return value != null && value !== 0
      ? `${Math.abs(value)} ${getActivityAssetSymbol(leg) ?? ""}`.trim()
      : null;
  };
  const price = (leg: TransferDialogActivity) => money(leg.unitPrice, leg.currency);
  const status = (leg: TransferDialogActivity) =>
    leg.status ? t(STATUS_LABELS[leg.status] ?? leg.status) : null;
  const fields: {
    label: string;
    value: (leg: TransferDialogActivity) => ReactNode;
    field?: DetailField;
  }[] = [
    {
      label: t("activity:field_account"),
      value: (leg) => getAccountName(leg, accountMap),
    },
    {
      label: t("activity:table_type"),
      value: (leg) => <ActivityTypeBadge type={getEffectiveType(leg) as ActivityType} />,
    },
    {
      label: t("activity:field_date"),
      value: (leg) => dateFormatting.formatDateTime(getActivityDate(leg)),
      field: "date",
    },
    { label: t("activity:field_amount"), value: amount, field: "amount" },
    { label: t("activity:table_currency"), value: (leg) => leg.currency, field: "currency" },
    { label: t("activity:table_quantity"), value: quantity, field: "quantity" },
    { label: t("activity:field_price"), value: price, field: "price" },
    {
      label: t("activity:field_fee"),
      value: (leg) => money(leg.fee, leg.currency),
    },
    {
      label: t("activity:type_tax"),
      value: (leg) => money(leg.tax, leg.currency),
    },
    {
      label: t("activity:detail.fx_rate"),
      value: (leg) => {
        const rate = parseNumber(leg.fxRate);
        return rate != null ? numbers.formatDecimal(rate, { maximumFractionDigits: 8 }) : null;
      },
    },
    { label: t("common:status"), value: status },
    {
      label: t("activity:detail.notes"),
      value: (leg) => getActivityNotes(leg)?.trim() || null,
    },
  ];
  const rows = fields
    .map((field) => ({
      label: field.label,
      values: legs.map(field.value),
      differs: !!match && !!field.field && differs.includes(field.field),
    }))
    .filter((row) => row.values.some((value) => value != null && value !== ""));
  const empty = <span className="text-muted-foreground">—</span>;
  const cell = "px-3 py-2 align-top break-words";
  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full table-fixed text-sm" data-testid="transfer-match-details">
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th scope="col" className="w-[28%] px-3 py-2 text-start font-medium">
              <span className="sr-only">{t("activity:transfer_match.field")}</span>
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t("activity:transfer_match.this_activity")}
            </th>
            {match || awaitingMatch ? (
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("activity:transfer_match.selected_match")}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.label} className="border-t">
              <th
                scope="row"
                className="text-muted-foreground px-3 py-2 text-start align-top font-normal"
              >
                {row.label}
              </th>
              <td className={cell}>{row.values[0] ?? empty}</td>
              {match ? (
                <td className={cn(cell, row.differs && "text-warning")}>
                  {row.differs ? (
                    <span className="inline-flex items-start gap-1.5">
                      <Icons.AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>
                        {row.values[1] ?? empty}
                        <span className="sr-only">
                          {" "}
                          ({t("activity:transfer_match.value_differs")})
                        </span>
                      </span>
                    </span>
                  ) : (
                    (row.values[1] ?? empty)
                  )}
                </td>
              ) : awaitingMatch && index === 0 ? (
                // Nothing selected yet: one cell down the column points to the list.
                <td
                  rowSpan={rows.length}
                  className="text-muted-foreground border-s border-dashed px-3 py-2 text-center align-middle text-xs"
                >
                  {t("activity:transfer_match.choose_match_below")}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Flags a split row: converting retypes it, and a transfer cannot keep spending splits. */
function SplitRemovalNotice({ activityId, className }: { activityId: string; className?: string }) {
  const { t } = useTranslation();
  const { data: splits = [] } = useActivitySplits(activityId);
  if (splits.length === 0) return null;
  return (
    <div className={cn("text-2xs space-y-1.5", className)}>
      <Badge variant="secondary" className="rounded-sm px-1.5 py-0">
        {t("spending:transactions.splitLines", { count: splits.length })}
      </Badge>
      <div className="text-warning flex items-start gap-1.5">
        <Icons.AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{t("activity:transfer_match.convert_removes_split")}</span>
      </div>
    </div>
  );
}

/** A list of suggestions, one row each, as the Match transfers page lists pairs. */
function CandidateList({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-md border">{children}</div>;
}

/**
 * A suggested other side: its account, when and what, its amount, then what
 * differs. The details table compares it in full once selected.
 */
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
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const normalized = normalizeActivity(candidate.activity, accountMap);
  const amount = amountValue(normalized);
  const quantity = parseNumber(normalized.quantity);
  const note = normalized.notes?.trim();
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-2.5 text-start text-sm transition-colors",
        selected && "bg-primary/5 hover:bg-primary/5",
      )}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="flex h-5 shrink-0 items-center">
        {selected ? (
          <Icons.CheckCircle className="text-primary h-4 w-4" />
        ) : (
          <Icons.Circle className="text-muted-foreground/40 h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{normalized.accountName}</span>
          {isTransferType(normalized.activityType) ? null : (
            <ActivityTypeBadge
              type={normalized.activityType as ActivityType}
              className="text-2xs px-1.5 py-0 font-normal"
            />
          )}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {dateFormatting.formatDateTime(normalized.date)}
          {note ? ` · ${note}` : ""}
        </span>
        {candidate.warnings.map((warning) => (
          <CandidateWarning key={warning} text={warning} />
        ))}
        {selected && canConvertToTransfer(candidate.activity) ? (
          <SplitRemovalNotice activityId={candidate.activity.id} className="pt-1" />
        ) : null}
      </span>
      <span className="shrink-0 text-end">
        <span className="block font-medium tabular-nums">
          {amount != null
            ? formatting.formatAmount(Math.abs(amount), normalized.currency)
            : normalized.currency}
        </span>
        {quantity != null && quantity !== 0 && normalized.assetSymbol ? (
          <span className="text-muted-foreground block text-xs">
            {`${Math.abs(quantity)} ${normalized.assetSymbol}`}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Links a transfer with its other side. For a deposit or withdrawal, "link"
 * converts it into a transfer instead, so every "Link transfer…" host also
 * serves "Make it a transfer…".
 */
export function TransferMatchDialog(props: TransferMatchDialogProps) {
  const { sourceActivity, mode } = props;
  if (sourceActivity && mode === "link" && canConvertToTransfer(sourceActivity)) {
    return <ConvertToTransferDialog {...props} sourceActivity={sourceActivity} />;
  }
  return <TransferLinkDialog {...props} />;
}

type ConvertChoice = { kind: "existing"; candidate: SelectedCandidate } | { kind: "new" };

function ConvertToTransferDialog({
  open,
  sourceActivity,
  counterpartId,
  accounts,
  onOpenChange,
  onComplete,
}: TransferMatchDialogProps & { sourceActivity: TransferDialogActivity }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reviewConversion = useConvertToTransferSplitReview();
  const accountMap = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const activeAccounts = useMemo(
    () => accounts.filter((account) => !account.isArchived),
    [accounts],
  );
  const otherAccounts = useMemo(
    () => activeAccounts.filter((account) => account.id !== sourceActivity.accountId),
    [activeAccounts, sourceActivity.accountId],
  );
  const source = useMemo(
    () => normalizeActivity(sourceActivity, accountMap),
    [accountMap, sourceActivity],
  );
  const sourceType = getEffectiveType(sourceActivity);
  const counterpartTypes = useMemo(
    () =>
      sourceType === ActivityType.WITHDRAWAL
        ? [ActivityType.DEPOSIT, ActivityType.TRANSFER_IN]
        : [ActivityType.WITHDRAWAL, ActivityType.TRANSFER_OUT],
    [sourceType],
  );
  const search = useManualTransferSearch({ open, source, counterpartTypes, accountMap });
  const [candidates, setCandidates] = useState<SelectedCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Counts Retry presses, so a press loads the suggestions again.
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState<ConvertChoice | null>(null);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChoice(null);
    setAccountId("");
    setAmount(undefined);
    setLoadFailed(false);
    setLoading(true);
    findTransferMatchCandidates({ activityId: sourceActivity.id, windowDays: 7, limit: 10 })
      .then((result) => {
        if (cancelled) return;
        const loaded = result.map((candidate) => ({
          activity: candidate.activity,
          warnings: candidateWarnings(t, candidate),
          differs: candidateDiffers(candidate),
        }));
        setCandidates(loaded);
        const initial = loaded.find((candidate) => candidate.activity.id === counterpartId);
        if (initial) setChoice({ kind: "existing", candidate: initial });
      })
      .catch(() => {
        if (cancelled) return;
        setCandidates([]);
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sourceActivity.id, counterpartId, attempt, t]);

  const targetAccount = accountMap.get(accountId);
  const needsAmount = !!targetAccount && targetAccount.currency !== sourceActivity.currency;
  const canConfirm =
    !saving &&
    (choice?.kind === "existing" ||
      (choice?.kind === "new" && !!targetAccount && (!needsAmount || (amount ?? 0) > 0)));

  const confirm = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      const request = await reviewConversion({
        activityId: sourceActivity.id,
        ...(choice.kind === "existing"
          ? { counterpartActivityId: choice.candidate.activity.id }
          : {
              counterpartAccountId: accountId,
              counterpartAmount: needsAmount ? amount : undefined,
            }),
      });
      await convertToInternalTransfer(request);
      await queryClient.invalidateQueries();
      toast.success(t("activity:transfer_match.convert_success"));
      onOpenChange(false);
      await onComplete?.();
    } catch (error) {
      if (isActivityEditCancelled(error)) return;
      toast.error(t("activity:transfer_match.convert_error"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-190">
        <SheetHeader>
          <SheetTitle>{t("activity:transfer_match.convert_title")}</SheetTitle>
          <SheetDescription>{t("activity:transfer_match.convert_desc")}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
          <div className="space-y-2">
            <PairDetails
              source={sourceActivity}
              match={choice?.kind === "existing" ? choice.candidate.activity : undefined}
              differs={choice?.kind === "existing" ? choice.candidate.differs : undefined}
              awaitingMatch={choice?.kind !== "new"}
              accountMap={accountMap}
            />
            <SplitRemovalNotice activityId={sourceActivity.id} />
          </div>

          <div className="space-y-2">
            <SheetSectionHeading
              title={t("activity:transfer_match.suggested_matches")}
              count={loading || loadFailed ? undefined : candidates.length}
            />
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : loadFailed ? (
              <SuggestionsError onRetry={() => setAttempt((count) => count + 1)} />
            ) : candidates.length > 0 ? (
              <CandidateList>
                {candidates.map((candidate) => (
                  <CandidateButton
                    key={candidate.activity.id}
                    candidate={candidate}
                    accountMap={accountMap}
                    selected={
                      choice?.kind === "existing" &&
                      choice.candidate.activity.id === candidate.activity.id
                    }
                    onSelect={() => setChoice({ kind: "existing", candidate })}
                  />
                ))}
              </CandidateList>
            ) : (
              <div className="text-muted-foreground flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5 text-sm">
                <span>{t("activity:transfer_match.convert_no_matches")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={search.widenSearch}
                  disabled={search.manualLoading}
                >
                  {t("activity:transfer_match.search_30_days")}
                </Button>
              </div>
            )}
          </div>

          <ManualTransferSearch
            search={search}
            source={source}
            counterpartTypes={counterpartTypes}
            accounts={activeAccounts}
            accountMap={accountMap}
            selectedId={choice?.kind === "existing" ? choice.candidate.activity.id : undefined}
            onSelect={(candidate) => setChoice({ kind: "existing", candidate })}
          />

          <div
            className={cn(
              "space-y-3 rounded-md border p-3",
              choice?.kind === "new" && "border-primary bg-primary/5",
            )}
          >
            <button
              type="button"
              className="flex w-full items-center gap-3 text-start text-sm font-medium"
              onClick={() => setChoice({ kind: "new" })}
              aria-pressed={choice?.kind === "new"}
            >
              {choice?.kind === "new" ? (
                <Icons.CheckCircle className="text-primary h-4 w-4" />
              ) : (
                <Icons.Circle className="text-muted-foreground/30 h-4 w-4" />
              )}
              {t("activity:transfer_match.convert_new")}
            </button>
            {choice?.kind === "new" ? (
              <div className="grid gap-3 ps-7 sm:grid-cols-2">
                <Select
                  items={otherAccounts.map((account) => ({
                    value: account.id,
                    label: `${account.name} (${account.currency})`,
                  }))}
                  value={accountId}
                  onValueChange={(value) => setAccountId(value ?? "")}
                >
                  <SelectTrigger aria-label={t("activity:transfer_match.convert_account")}>
                    <SelectValue placeholder={t("activity:transfer_match.convert_account")} />
                  </SelectTrigger>
                  <SelectContent>
                    {otherAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name} ({account.currency})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {needsAmount ? (
                  <MoneyInput
                    value={amount ?? null}
                    onValueChange={(value) => setAmount(value)}
                    placeholder={t("activity:transfer_match.convert_amount", {
                      currency: targetAccount.currency,
                    })}
                    aria-label={t("activity:transfer_match.convert_amount", {
                      currency: targetAccount.currency,
                    })}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void confirm()} disabled={!canConfirm}>
            {saving ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : (
              <Icons.ArrowLeftRight className="me-2 h-4 w-4" />
            )}
            {t("activity:transfer_match.convert_button")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The "Search eligible transfers" panel's state. `counterpartTypes` lists the
 * activity types the other side may have: the opposite transfer when linking,
 * plus the opposite deposit or withdrawal when converting.
 */
function useManualTransferSearch({
  open,
  source,
  counterpartTypes,
  accountMap,
}: {
  open: boolean;
  source: NormalizedTransferActivity | null;
  counterpartTypes: string[];
  accountMap: Map<string, Account>;
}) {
  const { t } = useTranslation();
  const [manualResults, setManualResults] = useState<ActivityDetails[]>([]);
  const [manualSearched, setManualSearched] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualLinkedCandidateIds, setManualLinkedCandidateIds] = useState<Set<string>>(new Set());
  const [manualGroupCheckPendingIds, setManualGroupCheckPendingIds] = useState<Set<string>>(
    new Set(),
  );
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

  useEffectOnChange(() => {
    if (!open) return;
    setManualResults([]);
    setManualSearched(false);
    setManualError(null);
  }, [open, source?.id]);

  useEffect(() => {
    if (!open) {
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
          const pair = await getTransferPairForActivity(activity.id);
          return pair ? activity.id : null;
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
  }, [manualResults, open]);

  const filteredManualResults = useMemo<SelectedCandidate[]>(() => {
    if (!source || counterpartTypes.length === 0) return [];
    return manualResults
      .filter((activity) => {
        const candidate = normalizeActivity(activity, accountMap);
        const candidateAccount = accountMap.get(candidate.accountId);
        if (candidate.id === source.id) return false;
        if (manualLinkedCandidateIds.has(candidate.id)) return false;
        if (manualGroupCheckPendingIds.has(candidate.id)) return false;
        if (!counterpartTypes.includes(candidate.activityType)) return false;
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
        const { warnings, differs } = manualWarnings(source, candidate, t);
        // A deposit or withdrawal can carry an import group that is not a link.
        if (candidate.sourceGroupId && isTransferType(candidate.activityType)) {
          warnings.push(t("activity:transfer_match.warning_stale_link"));
        }
        return {
          activity,
          warnings,
          differs,
        };
      });
  }, [
    accountId,
    accountMap,
    accountType,
    assetFilter,
    counterpartTypes,
    currency,
    manualResults,
    manualGroupCheckPendingIds,
    manualLinkedCandidateIds,
    matchMode,
    searchText,
    source,
    t,
  ]);

  const runManualSearch = useCallback(
    async (windowDaysOverride?: number) => {
      if (!source || counterpartTypes.length === 0) return;
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
            activityTypes: counterpartTypes,
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
    [accountId, counterpartTypes, source, windowDays, t],
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

  return {
    searchText,
    setSearchText,
    accountId,
    setAccountId,
    accountType,
    setAccountType,
    windowDays,
    setWindowDays,
    currency,
    setCurrency,
    assetFilter,
    setAssetFilter,
    matchMode,
    setMatchMode,
    filtersOpen,
    setFiltersOpen,
    advancedFilterCount,
    manualLoading,
    manualError,
    manualSearched,
    filteredManualResults,
    resetFilters,
    runManualSearch,
    widenSearch,
  };
}

function ManualTransferSearch({
  search,
  source,
  counterpartTypes,
  accounts,
  accountMap,
  selectedId,
  onSelect,
}: {
  search: ReturnType<typeof useManualTransferSearch>;
  source: NormalizedTransferActivity;
  counterpartTypes: string[];
  accounts: Account[];
  accountMap: Map<string, Account>;
  selectedId: string | undefined;
  onSelect: (candidate: SelectedCandidate) => void;
}) {
  const { t } = useTranslation();
  const accountTypeOptions = useMemo(
    () => Array.from(new Set(accounts.map((account) => account.accountType))).sort(),
    [accounts],
  );
  const currencyOptions = useMemo(
    () => Array.from(new Set(accounts.map((account) => account.currency))).sort(),
    [accounts],
  );
  const {
    searchText,
    setSearchText,
    accountId,
    setAccountId,
    accountType,
    setAccountType,
    windowDays,
    setWindowDays,
    currency,
    setCurrency,
    assetFilter,
    setAssetFilter,
    matchMode,
    setMatchMode,
    filtersOpen,
    setFiltersOpen,
    advancedFilterCount,
    manualLoading,
    manualError,
    manualSearched,
    filteredManualResults,
    resetFilters,
    runManualSearch,
  } = search;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("activity:transfer_match.search_eligible")}</div>
          <div className="text-muted-foreground text-xs">
            {t("activity:transfer_match.only_type_searched", {
              type: counterpartTypes.length
                ? counterpartTypes.map((type) => localizeActivityTypeName(t, type)).join(" / ")
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
            <Icons.Search className="text-muted-foreground absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("activity:transfer_match.search_placeholder")}
              className="ps-9"
            />
          </div>
          <Button type="submit" disabled={manualLoading}>
            {manualLoading ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : (
              <Icons.Search className="me-2 h-4 w-4" />
            )}
            {t("common:search")}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Select
            value={accountId}
            items={[
              { value: ALL, label: t("activity:all_accounts") },
              ...accounts.map((account) => ({
                value: account.id,
                label: account.name,
              })),
            ]}
            onValueChange={(value) => {
              if (value !== null) setAccountId(value);
            }}
          >
            <SelectTrigger aria-label={t("activity:filter_account")}>
              <SelectValue placeholder={t("activity:filter_account")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("activity:all_accounts")}</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={windowDays}
            items={[7, 30, 90, 180].map((count) => ({
              value: `${count}`,
              label: t("activity:transfer_match.within_days", { count }),
            }))}
            onValueChange={(value) => {
              if (value !== null) setWindowDays(value);
            }}
          >
            <SelectTrigger aria-label={t("activity:transfer_match.date_range")}>
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
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 px-2 text-xs"
              />
            }
          >
            <Icons.ChevronDown
              className={cn("me-1 h-3.5 w-3.5 transition-transform", filtersOpen && "rotate-180")}
            />
            {t("activity:transfer_match.more_filters")}
            {advancedFilterCount > 0 ? (
              <Badge variant="secondary" className="text-2xs ms-1.5 rounded-sm px-1.5 py-0">
                {advancedFilterCount}
              </Badge>
            ) : null}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Select
                value={accountType}
                items={[
                  { value: ALL, label: t("activity:transfer_match.all_account_types") },
                  ...accountTypeOptions.map((type) => ({ value: type, label: type })),
                ]}
                onValueChange={(value) => {
                  if (value !== null) setAccountType(value);
                }}
              >
                <SelectTrigger aria-label={t("activity:transfer_match.account_type")}>
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

              <Select
                value={currency}
                items={[
                  { value: ALL, label: t("activity:transfer_match.all_currencies") },
                  ...currencyOptions.map((option) => ({ value: option, label: option })),
                ]}
                onValueChange={(value) => {
                  if (value !== null) setCurrency(value);
                }}
              >
                <SelectTrigger aria-label={t("activity:table_currency")}>
                  <SelectValue placeholder={t("activity:table_currency")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("activity:transfer_match.all_currencies")}</SelectItem>
                  {currencyOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={assetFilter}
                items={[
                  { value: ALL, label: t("activity:transfer_match.all_assets") },
                  { value: SAME_ASSET, label: t("activity:transfer_match.same_asset") },
                  { value: CASH_ASSET, label: t("activity:transfer_match.cash_only") },
                ]}
                onValueChange={(value) => {
                  if (value !== null) setAssetFilter(value);
                }}
              >
                <SelectTrigger aria-label={t("activity:transfer_match.asset")}>
                  <SelectValue placeholder={t("activity:transfer_match.asset")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("activity:transfer_match.all_assets")}</SelectItem>
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

              <Select
                value={matchMode}
                items={[
                  { value: STRICT, label: t("activity:transfer_match.exact_amount") },
                  { value: ANY, label: t("activity:transfer_match.any_eligible") },
                ]}
                onValueChange={(value) => {
                  if (value !== null) setMatchMode(value);
                }}
              >
                <SelectTrigger aria-label={t("activity:transfer_match.match_mode")}>
                  <SelectValue placeholder={t("activity:transfer_match.match_mode")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STRICT}>
                    {t("activity:transfer_match.exact_amount")}
                  </SelectItem>
                  <SelectItem value={ANY}>{t("activity:transfer_match.any_eligible")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </form>

      {manualError ? (
        <div className="text-destructive rounded-md border p-3 text-sm">{manualError}</div>
      ) : null}

      {manualSearched ? (
        <div className="space-y-2">
          <div className="text-muted-foreground text-xs">
            {t("activity:transfer_match.eligible_count", {
              count: filteredManualResults.length,
            })}
          </div>
          <ScrollArea className="max-h-72 overflow-y-auto">
            <div className="pe-3">
              {filteredManualResults.length > 0 ? (
                <CandidateList>
                  {filteredManualResults.map((candidate) => (
                    <CandidateButton
                      key={candidate.activity.id}
                      candidate={candidate}
                      accountMap={accountMap}
                      selected={selectedId === candidate.activity.id}
                      onSelect={() => onSelect(candidate)}
                    />
                  ))}
                </CandidateList>
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
  );
}

function TransferLinkDialog({
  open,
  mode,
  sourceActivity,
  counterpartId,
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
  const source = useMemo(
    () => (sourceActivity ? normalizeActivity(sourceActivity, accountMap) : null),
    [accountMap, sourceActivity],
  );
  const oppositeType = oppositeTransferType(source?.activityType);
  const counterpartTypes = useMemo(() => (oppositeType ? [oppositeType] : []), [oppositeType]);
  const search = useManualTransferSearch({ open, source, counterpartTypes, accountMap });

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
  const [suggestionsFailed, setSuggestionsFailed] = useState(false);
  // Counts Retry presses, so a press loads the suggestions again.
  const [attempt, setAttempt] = useState(0);
  const [selectedCandidate, setSelectedCandidate] = useState<SelectedCandidate | null>(null);
  const [counterpart, setCounterpart] = useState<TransferDialogActivity | null>(null);
  const [counterpartError, setCounterpartError] = useState<string | null>(null);
  const [counterpartLoading, setCounterpartLoading] = useState(false);

  useEffectOnChange(() => {
    if (!open) return;
    setSelectedCandidate(null);
    setSuggestions([]);
    setSuggestionsFailed(false);
    setCounterpart(null);
    setCounterpartError(null);

    if (!sourceActivity?.id) return;

    if (mode === "link") {
      setSuggestionsLoading(true);
      findTransferMatchCandidates({
        activityId: sourceActivity.id,
        windowDays: 7,
        limit: 25,
      })
        .then(setSuggestions)
        .catch(() => setSuggestionsFailed(true))
        .finally(() => setSuggestionsLoading(false));
    } else {
      setCounterpartLoading(true);
      getTransferPairForActivity(sourceActivity.id)
        .then((pair) => {
          if (!pair) {
            setCounterpartError(t("activity:transfer_match.error_load_pair"));
            return;
          }
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
  }, [mode, open, sourceActivity, counterpartId, attempt, t]);

  const suggestedCandidates = useMemo<SelectedCandidate[]>(
    () =>
      suggestions.map((candidate) => ({
        activity: withSourceSymbol(candidate.activity, sourceActivity),
        warnings: candidateWarnings(t, candidate),
        differs: candidateDiffers(candidate),
      })),
    [suggestions, sourceActivity, t],
  );
  // The user's pick, else the other side the sheet opened for. Read from the
  // current props, so a late answer for an earlier activity picks nothing.
  const selected =
    selectedCandidate ??
    suggestedCandidates.find((candidate) => candidate.activity.id === counterpartId) ??
    null;

  const confirmLink = useCallback(async () => {
    if (!sourceActivity?.id || !selected?.activity.id) return;
    await linkTransferActivitiesMutation.mutateAsync({
      activityAId: sourceActivity.id,
      activityBId: selected.activity.id,
    });
    await onComplete?.();
    onOpenChange(false);
  }, [
    linkTransferActivitiesMutation,
    onComplete,
    onOpenChange,
    selected?.activity.id,
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
      <SheetContent className="flex w-full flex-col overflow-hidden sm:max-w-190">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
          {mode === "link" ? (
            <PairDetails
              source={sourceActivity}
              match={selected?.activity}
              differs={selected?.differs}
              accountMap={accountMap}
            />
          ) : (
            <div className="space-y-2">
              <SheetSectionHeading title={t("activity:transfer_match.selected_row")} />
              <ActivitySummaryRow
                activity={sourceActivity}
                accountMap={accountMap}
                className="bg-muted/30 border"
              />
            </div>
          )}

          {mode === "unlink" ? (
            <div className="space-y-2">
              <SheetSectionHeading title={t("activity:transfer_match.linked_counterpart")} />
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
                <SheetSectionHeading
                  title={t("activity:transfer_match.suggested_matches")}
                  count={
                    suggestionsLoading || suggestionsFailed ? undefined : suggestedCandidates.length
                  }
                >
                  {oppositeType ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground text-xs">
                        {t("activity:transfer_match.looking_for")}
                      </span>
                      <ActivityTypeBadge type={oppositeType} />
                    </div>
                  ) : null}
                </SheetSectionHeading>
                {suggestionsLoading ? (
                  <Skeleton className="h-28 w-full rounded-md" />
                ) : suggestionsFailed ? (
                  <SuggestionsError onRetry={() => setAttempt((count) => count + 1)} />
                ) : suggestedCandidates.length > 0 ? (
                  <CandidateList>
                    {suggestedCandidates.map((candidate) => (
                      <CandidateButton
                        key={candidate.activity.id}
                        candidate={candidate}
                        accountMap={accountMap}
                        selected={selected?.activity.id === candidate.activity.id}
                        onSelect={() => setSelectedCandidate(candidate)}
                      />
                    ))}
                  </CandidateList>
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
                      onClick={search.widenSearch}
                      disabled={search.manualLoading}
                    >
                      {t("activity:transfer_match.search_30_days")}
                    </Button>
                  </div>
                )}
              </div>

              <ManualTransferSearch
                search={search}
                source={source}
                counterpartTypes={counterpartTypes}
                accounts={activeAccounts}
                accountMap={accountMap}
                selectedId={selected?.activity.id}
                onSelect={setSelectedCandidate}
              />
            </>
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isProcessing}>
            {t("common:cancel")}
          </Button>
          {mode === "link" ? (
            <Button onClick={() => void confirmLink()} disabled={!selected || isProcessing}>
              {isProcessing ? (
                <Spinner className="me-2 h-4 w-4" />
              ) : (
                <Icons.Link className="me-2 h-4 w-4" />
              )}
              {t("activity:transfer_review.link")}
            </Button>
          ) : (
            <Button
              onClick={() => void confirmUnlink()}
              disabled={
                isProcessing || counterpartLoading || (!counterpart && !canClearInvalidLink)
              }
            >
              {isProcessing ? (
                <Spinner className="me-2 h-4 w-4" />
              ) : (
                <Icons.Unlink className="me-2 h-4 w-4" />
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
