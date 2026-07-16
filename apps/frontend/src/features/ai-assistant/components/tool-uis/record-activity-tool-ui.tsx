import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatPrice,
  Skeleton,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { updateToolResult } from "@/adapters";
import { localizeActivitySubtypeName, localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType, QuoteMode } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { parse as dateFnsParse } from "date-fns";
import {
  ACTIVITY_FORM_CONFIG,
  type ActivityFormValues,
  type PickerActivityType,
} from "@/pages/activity/config/activity-form-config";
import type { AccountSelectOption } from "@/pages/activity/components/forms/fields";
import type { NewActivityFormValues } from "@/pages/activity/components/forms/schemas";
import type { TransferFormValues } from "@/pages/activity/components/forms/transfer-form";
import { useActivityMutations } from "@/pages/activity/hooks/use-activity-mutations";
import { useRuntimeContext } from "../../hooks/use-runtime-context";

// ============================================================================
// Types
// ============================================================================

interface RecordActivityArgs {
  activity_type: string;
  symbol?: string;
  activity_date: string;
  quantity?: number;
  unit_price?: number;
  amount?: number;
  fee?: number;
  account?: string;
  subtype?: string;
  notes?: string;
}

interface ActivityDraft {
  activityType: string;
  activityDate: string;
  symbol?: string;
  assetId?: string;
  assetName?: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  fee?: number;
  currency: string;
  accountId?: string;
  accountName?: string;
  subtype?: string;
  notes?: string;
  priceSource: string;
  quoteMode: string;
  isCustomAsset: boolean;
  assetKind?: string;
}

interface ValidationResult {
  isValid: boolean;
  missingFields: string[];
  errors: ValidationError[];
}

interface ValidationError {
  field: string;
  message: string;
}

interface AccountOption {
  id: string;
  name: string;
  currency: string;
}

interface SubtypeOption {
  value: string;
  label: string;
}

interface ResolvedAsset {
  assetId: string;
  symbol: string;
  name: string;
  currency: string;
  exchange?: string;
  exchangeMic?: string;
  instrumentType?: string;
}

interface RecordActivityOutput {
  draft: ActivityDraft;
  validation: ValidationResult;
  availableAccounts: AccountOption[];
  resolvedAsset?: ResolvedAsset;
  availableSubtypes: SubtypeOption[];
  // Persisted state from DB updates
  submitted?: boolean;
  createdActivityId?: string;
  createdAt?: string;
}

// ============================================================================
// Date Helper
// ============================================================================

/**
 * Parse an ISO date string preserving the date/time as-is (no timezone conversion).
 */
function parseActivityDateToLocal(dateString: string): Date | undefined {
  const value = dateString.trim();
  if (!value) return undefined;

  const parsed = value.includes("T")
    ? dateFnsParse(value.substring(0, 19), "yyyy-MM-dd'T'HH:mm:ss", new Date())
    : dateFnsParse(value.substring(0, 10), "yyyy-MM-dd", new Date());

  if (Number.isFinite(parsed.getTime())) {
    return parsed;
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumberValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function formatActivityDate(dateString: string, t: TFunction): string {
  return (
    parseActivityDateToLocal(dateString)?.toLocaleDateString() ?? t("ai:recordActivity.invalidDate")
  );
}

function displayPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function hasSameDisplayValue(a: string | undefined, b: string | undefined): boolean {
  const left = displayPart(a)?.toLowerCase();
  const right = displayPart(b)?.toLowerCase();
  return Boolean(left && right && left === right);
}

function joinDisplayParts(parts: (string | undefined)[]): string | undefined {
  const visibleParts = parts.filter((part): part is string => Boolean(displayPart(part)));
  return visibleParts.length > 0 ? visibleParts.join(" \u00b7 ") : undefined;
}

function formatExchange(resolvedAsset: ResolvedAsset | undefined): string | undefined {
  const exchange = displayPart(resolvedAsset?.exchange);
  const exchangeMic = displayPart(resolvedAsset?.exchangeMic);

  if (exchange && exchangeMic && !hasSameDisplayValue(exchange, exchangeMic)) {
    return `${exchange} (${exchangeMic})`;
  }

  return exchange ?? exchangeMic;
}

interface AssetSummary {
  primary: string;
  secondary?: string;
}

function getAssetSummary(
  draft: ActivityDraft,
  resolvedAsset: ResolvedAsset | undefined,
  t: TFunction,
): AssetSummary | undefined {
  const symbol = displayPart(resolvedAsset?.symbol) ?? displayPart(draft.symbol);
  const name = displayPart(resolvedAsset?.name) ?? displayPart(draft.assetName);
  const exchange = formatExchange(resolvedAsset);
  const currency = displayPart(resolvedAsset?.currency) ?? displayPart(draft.currency);

  if (!symbol && !name) {
    if (
      draft.activityType === ActivityType.DEPOSIT ||
      draft.activityType === ActivityType.WITHDRAWAL
    ) {
      return { primary: t("ai:recordActivity.cash"), secondary: currency };
    }
    return undefined;
  }

  return {
    primary: symbol ?? name ?? "",
    secondary: joinDisplayParts([
      hasSameDisplayValue(symbol, name) ? undefined : name,
      exchange,
      currency,
    ]),
  };
}

// ============================================================================
// Normalizer
// ============================================================================

function normalizeResult(result: unknown, fallbackCurrency: string): RecordActivityOutput | null {
  if (!result) return null;

  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) return null;

  const candidate = result as Record<string, unknown>;

  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizeResult(candidate.data, fallbackCurrency);
  }

  const draftRaw = (candidate.draft ?? candidate) as Record<string, unknown>;
  const activityDate =
    stringValue(draftRaw.activityDate) ??
    stringValue(draftRaw.activity_date) ??
    new Date().toISOString();
  const draft: ActivityDraft = {
    activityType: (draftRaw.activityType as string) ?? (draftRaw.activity_type as string) ?? "",
    activityDate,
    symbol: (draftRaw.symbol as string) ?? undefined,
    assetId: (draftRaw.assetId as string) ?? (draftRaw.asset_id as string) ?? undefined,
    assetName: (draftRaw.assetName as string) ?? (draftRaw.asset_name as string) ?? undefined,
    quantity: finiteNumberValue(draftRaw.quantity),
    unitPrice: finiteNumberValue(draftRaw.unitPrice ?? draftRaw.unit_price),
    amount: finiteNumberValue(draftRaw.amount),
    fee: finiteNumberValue(draftRaw.fee),
    currency: (draftRaw.currency as string) ?? fallbackCurrency,
    accountId: (draftRaw.accountId as string) ?? (draftRaw.account_id as string) ?? undefined,
    accountName: (draftRaw.accountName as string) ?? (draftRaw.account_name as string) ?? undefined,
    subtype: (draftRaw.subtype as string) ?? undefined,
    notes: (draftRaw.notes as string) ?? undefined,
    priceSource: (draftRaw.priceSource as string) ?? (draftRaw.price_source as string) ?? "none",
    quoteMode:
      (draftRaw.quoteMode as string) ??
      (draftRaw.quote_mode as string) ??
      (draftRaw.pricingMode as string) ??
      (draftRaw.pricing_mode as string) ??
      "MARKET",
    isCustomAsset: Boolean(draftRaw.isCustomAsset ?? draftRaw.is_custom_asset ?? false),
    assetKind: (draftRaw.assetKind as string) ?? (draftRaw.asset_kind as string) ?? undefined,
  };

  const validationRaw = (candidate.validation ?? {}) as Record<string, unknown>;
  const validation: ValidationResult = {
    isValid: Boolean(validationRaw.isValid ?? validationRaw.is_valid ?? false),
    missingFields: Array.isArray(validationRaw.missingFields)
      ? validationRaw.missingFields
      : Array.isArray(validationRaw.missing_fields)
        ? validationRaw.missing_fields
        : [],
    errors: Array.isArray(validationRaw.errors) ? (validationRaw.errors as ValidationError[]) : [],
  };

  const accountsRaw = Array.isArray(candidate.availableAccounts)
    ? candidate.availableAccounts
    : Array.isArray(candidate.available_accounts)
      ? candidate.available_accounts
      : [];
  const availableAccounts: AccountOption[] = accountsRaw.map((acc: Record<string, unknown>) => ({
    id: (acc.id as string) ?? "",
    name: (acc.name as string) ?? "",
    currency: (acc.currency as string) ?? fallbackCurrency,
  }));

  const assetRaw = (candidate.resolvedAsset ?? candidate.resolved_asset) as
    | Record<string, unknown>
    | undefined;
  const resolvedAsset: ResolvedAsset | undefined = assetRaw
    ? {
        assetId: (assetRaw.assetId as string) ?? (assetRaw.asset_id as string) ?? "",
        symbol: (assetRaw.symbol as string) ?? "",
        name: (assetRaw.name as string) ?? "",
        currency: (assetRaw.currency as string) ?? fallbackCurrency,
        exchange: (assetRaw.exchange as string) ?? undefined,
        exchangeMic:
          (assetRaw.exchangeMic as string) ?? (assetRaw.exchange_mic as string) ?? undefined,
        instrumentType:
          (assetRaw.instrumentType as string) ?? (assetRaw.instrument_type as string) ?? undefined,
      }
    : undefined;

  const subtypesRaw = Array.isArray(candidate.availableSubtypes)
    ? candidate.availableSubtypes
    : Array.isArray(candidate.available_subtypes)
      ? candidate.available_subtypes
      : [];
  const availableSubtypes: SubtypeOption[] = subtypesRaw.map((st: Record<string, unknown>) => ({
    value: (st.value as string) ?? "",
    label: (st.label as string) ?? (st.value as string) ?? "",
  }));

  return {
    draft,
    validation,
    availableAccounts,
    resolvedAsset,
    availableSubtypes,
    submitted: candidate.submitted as boolean | undefined,
    createdActivityId:
      (candidate.createdActivityId as string) ??
      (candidate.created_activity_id as string) ??
      undefined,
    createdAt: (candidate.createdAt as string) ?? (candidate.created_at as string) ?? undefined,
  };
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function RecordActivityLoadingSkeleton() {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Success State
// ============================================================================

interface SuccessStateProps {
  draft: ActivityDraft;
  createdActivityId?: string;
  currency: string;
}

function SuccessState({ draft, createdActivityId, currency }: SuccessStateProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  const formatAmount = useCallback(
    (value: number | undefined) => {
      if (value === undefined) return "-";
      if (isBalanceHidden) return "\u2022\u2022\u2022\u2022\u2022";
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).format(value);
    },
    [currency, isBalanceHidden],
  );

  const activityTypeDisplay = localizeActivityTypeName(t, draft.activityType);

  return (
    <Card className="bg-muted/40 border-success/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icons.CheckCircle className="text-success h-5 w-5" />
          <CardTitle className="text-base">{t("ai:recordActivity.activityRecorded")}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">{t("ai:recordActivity.typeLabel")}</span>{" "}
            <span className="font-medium">{activityTypeDisplay}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t("ai:recordActivity.dateLabel")}</span>{" "}
            <span className="font-medium">{formatActivityDate(draft.activityDate, t)}</span>
          </div>
          {draft.symbol && (
            <div>
              <span className="text-muted-foreground">{t("ai:recordActivity.assetLabel")}</span>{" "}
              <span className="font-medium">{draft.symbol}</span>
            </div>
          )}
          {draft.quantity !== undefined && (
            <div>
              <span className="text-muted-foreground">{t("ai:recordActivity.quantityLabel")}</span>{" "}
              <span className="font-medium">{draft.quantity}</span>
            </div>
          )}
          {draft.amount !== undefined && (
            <div>
              <span className="text-muted-foreground">{t("ai:recordActivity.amountLabel")}</span>{" "}
              <span className="font-medium">{formatAmount(draft.amount)}</span>
            </div>
          )}
          {draft.accountName && (
            <div>
              <span className="text-muted-foreground">{t("ai:recordActivity.accountLabel")}</span>{" "}
              <span className="font-medium">{draft.accountName}</span>
            </div>
          )}
        </div>
        <div className="pt-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={createdActivityId ? `/activities?id=${createdActivityId}` : "/activities"}>
              <Icons.ArrowRight className="mr-2 h-4 w-4" />
              {t("ai:recordActivity.viewInActivities")}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Helpers — bridge AI draft → per-type form config
// ============================================================================

/** Map the AI's activity type string to the picker key used by ACTIVITY_FORM_CONFIG. */
function toPickerActivityType(activityType: string): PickerActivityType | undefined {
  switch (activityType) {
    case ActivityType.BUY:
      return "BUY";
    case ActivityType.SELL:
      return "SELL";
    case ActivityType.DEPOSIT:
      return "DEPOSIT";
    case ActivityType.WITHDRAWAL:
      return "WITHDRAWAL";
    case ActivityType.DIVIDEND:
      return "DIVIDEND";
    case ActivityType.SPLIT:
      return "SPLIT";
    case ActivityType.FEE:
      return "FEE";
    case ActivityType.INTEREST:
      return "INTEREST";
    case ActivityType.TAX:
      return "TAX";
    case ActivityType.TRANSFER_IN:
    case ActivityType.TRANSFER_OUT:
      return "TRANSFER";
    default:
      return undefined;
  }
}

/**
 * Build a `Partial<ActivityDetails>` from the AI's draft so that
 * `ACTIVITY_FORM_CONFIG[type].getDefaults` can populate the per-type form.
 * Leaves `id` undefined so the form treats this as a create, not an edit.
 */
function draftToPseudoActivity(
  draft: ActivityDraft,
  resolvedAsset: ResolvedAsset | undefined,
): Partial<ActivityDetails> {
  const isTransfer =
    draft.activityType === ActivityType.TRANSFER_IN ||
    draft.activityType === ActivityType.TRANSFER_OUT;

  return {
    activityType: draft.activityType as ActivityType,
    date: parseActivityDateToLocal(draft.activityDate),
    accountId: draft.accountId ?? "",
    assetId: resolvedAsset?.assetId ?? draft.assetId ?? "",
    assetSymbol: resolvedAsset?.symbol ?? draft.symbol ?? "",
    assetName: resolvedAsset?.name ?? draft.assetName,
    quantity: draft.quantity != null ? String(draft.quantity) : null,
    unitPrice: draft.unitPrice != null ? String(draft.unitPrice) : null,
    amount: draft.amount != null ? String(draft.amount) : null,
    fee: draft.fee != null ? String(draft.fee) : null,
    currency: draft.currency,
    comment: draft.notes,
    subtype: draft.subtype,
    exchangeMic: resolvedAsset?.exchangeMic,
    instrumentType: resolvedAsset?.instrumentType,
    assetQuoteMode: draft.quoteMode === "MANUAL" ? QuoteMode.MANUAL : QuoteMode.MARKET,
    // metadata.flow.is_external is what TransferForm uses to derive isExternal=true
    metadata: isTransfer ? { flow: { is_external: true } } : undefined,
  };
}

/**
 * Layer AI-specific fields on top of config defaults. The config can't infer
 * resolver-only form fields for a draft (they aren't on ActivityDetails).
 */
function aiSpecificDefaultOverrides(
  draft: ActivityDraft,
  resolvedAsset: ResolvedAsset | undefined,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  // Authoritative quote currency from the AI's symbol resolver, when present.
  if (resolvedAsset?.currency) {
    overrides.symbolQuoteCcy = resolvedAsset.currency;
  }
  if (resolvedAsset?.assetId) {
    overrides.existingAssetId = resolvedAsset.assetId;
  }
  if (resolvedAsset?.instrumentType) {
    overrides.symbolInstrumentType = resolvedAsset.instrumentType;
  }
  // For AI-flagged custom assets, fall back to the activity currency the user
  // already approved. Safe because the asset is being created fresh — there is
  // no canonical quote currency to conflict with.
  if (draft.isCustomAsset && draft.currency && !resolvedAsset?.currency) {
    overrides.symbolQuoteCcy = draft.currency;
  }

  // Asset metadata for the create-on-save path inside BuyForm/SellForm/DividendForm.
  if (draft.isCustomAsset && (draft.symbol || draft.assetName)) {
    overrides.assetMetadata = {
      name: draft.assetName ?? draft.symbol,
      kind: draft.assetKind,
    };
  }

  return overrides;
}

interface ValidationHintsProps {
  validation: ValidationResult;
}

function ValidationHints({ validation }: ValidationHintsProps) {
  const { t } = useTranslation();
  if (validation.errors.length === 0 && validation.missingFields.length === 0) {
    return null;
  }

  return (
    <div className="bg-warning/10 border-warning/30 rounded-md border p-2 text-xs">
      <p className="font-medium">{t("ai:recordActivity.flaggedIssues")}</p>
      <ul className="mt-1 list-disc pl-4">
        {validation.errors.map((e, i) => (
          <li key={`err-${i}`}>
            <span className="font-medium">{e.field}:</span> {e.message}
          </li>
        ))}
        {validation.missingFields.map((f) => (
          <li key={`missing-${f}`}>{t("ai:recordActivity.missing", { field: f })}</li>
        ))}
      </ul>
    </div>
  );
}

interface DraftReviewProps {
  draft: ActivityDraft;
  validation: ValidationResult;
  resolvedAsset?: ResolvedAsset;
  activityTypeDisplay: string;
  isLoading: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}

interface ReviewFieldProps {
  label: string;
  value: string;
  className?: string;
}

function ReviewField({ label, value, className }: ReviewFieldProps) {
  return (
    <div className={className}>
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function DraftReview({
  draft,
  validation,
  resolvedAsset,
  activityTypeDisplay,
  isLoading,
  canConfirm,
  onConfirm,
  onEdit,
}: DraftReviewProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const formatAmount = useCallback(
    (value: number | undefined) => {
      if (value === undefined) return "-";
      if (isBalanceHidden) return "\u2022\u2022\u2022\u2022\u2022";
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: draft.currency,
      }).format(value);
    },
    [draft.currency, isBalanceHidden],
  );

  const assetSummary = getAssetSummary(draft, resolvedAsset, t);

  return (
    <CardContent className="space-y-5">
      {assetSummary && (
        <div className="border-border/70 bg-background/60 flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5">
          <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
            <Icons.ReceiptText className="text-muted-foreground size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{assetSummary.primary}</div>
            {assetSummary.secondary && (
              <div className="text-muted-foreground mt-0.5 truncate text-xs font-medium">
                {assetSummary.secondary}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <ReviewField label={t("ai:recordActivity.type")} value={activityTypeDisplay} />
        <ReviewField
          label={t("ai:recordActivity.date")}
          value={formatActivityDate(draft.activityDate, t)}
        />
        <ReviewField
          label={t("ai:recordActivity.account")}
          value={draft.accountName ?? draft.accountId ?? "-"}
        />
        {draft.quantity !== undefined && (
          <ReviewField label={t("ai:recordActivity.quantity")} value={String(draft.quantity)} />
        )}
        {draft.unitPrice !== undefined && (
          <ReviewField
            label={t("ai:recordActivity.unitPrice")}
            value={
              isBalanceHidden
                ? "\u2022\u2022\u2022\u2022\u2022"
                : formatPrice(draft.unitPrice, draft.currency)
            }
          />
        )}
        {draft.amount !== undefined && (
          <ReviewField label={t("ai:recordActivity.amount")} value={formatAmount(draft.amount)} />
        )}
        {draft.fee !== undefined && (
          <ReviewField label={t("ai:recordActivity.fee")} value={formatAmount(draft.fee)} />
        )}
        {draft.subtype && (
          <ReviewField
            label={t("ai:recordActivity.subtype")}
            value={localizeActivitySubtypeName(t, draft.subtype)}
          />
        )}
      </div>

      {draft.notes && (
        <div className="border-border/70 rounded-lg border px-3 py-2.5 text-sm">
          <div className="text-muted-foreground text-xs font-medium">
            {t("ai:recordActivity.notes")}
          </div>
          <div className="mt-1 font-medium">{draft.notes}</div>
        </div>
      )}

      <ValidationHints validation={validation} />

      <div className="border-border/60 flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="ghost" size="sm" onClick={onEdit} disabled={isLoading}>
          {t("ai:recordActivity.edit")}
        </Button>
        <Button type="button" size="sm" onClick={onConfirm} disabled={isLoading || !canConfirm}>
          {isLoading && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
          {t("ai:recordActivity.confirm")}
        </Button>
      </div>
    </CardContent>
  );
}

// ============================================================================
// Draft Form — dispatcher
// ============================================================================

interface DraftFormProps {
  draft: ActivityDraft;
  validation: ValidationResult;
  availableAccounts: AccountOption[];
  resolvedAsset?: ResolvedAsset;
  toolCallId?: string;
  onSuccess: (createdActivityId: string) => void;
}

function DraftForm({
  draft,
  validation,
  availableAccounts,
  resolvedAsset,
  toolCallId,
  onSuccess,
}: DraftFormProps) {
  const { t } = useTranslation();
  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;
  const { isBalanceHidden } = useBalancePrivacy();
  const [isEditing, setIsEditing] = useState(false);

  const pickerType = useMemo(() => toPickerActivityType(draft.activityType), [draft.activityType]);
  const config = pickerType ? ACTIVITY_FORM_CONFIG[pickerType] : undefined;

  // Convert AI's account list into the per-type form's expected shape.
  const accountOptions: AccountSelectOption[] = useMemo(
    () =>
      availableAccounts.map((a) => ({
        value: a.id,
        label: a.name,
        currency: a.currency,
      })),
    [availableAccounts],
  );

  const pseudoActivity = useMemo(
    () => draftToPseudoActivity(draft, resolvedAsset),
    [draft, resolvedAsset],
  );

  const defaultValues = useMemo(() => {
    if (!config) return undefined;
    const base = config.getDefaults(pseudoActivity, accountOptions);
    const dateOverride = parseActivityDateToLocal(draft.activityDate)
      ? {}
      : { activityDate: undefined };
    return { ...base, ...aiSpecificDefaultOverrides(draft, resolvedAsset), ...dateOverride };
  }, [config, pseudoActivity, accountOptions, draft, resolvedAsset]);
  const canConfirm = Boolean(
    defaultValues && validation.isValid && parseActivityDateToLocal(draft.activityDate),
  );

  // Reuse the existing add-activity mutation — it already handles symbol
  // nesting (id, symbol, exchangeMic, quoteCcy, instrumentType, etc.),
  // numeric coercion, query invalidation, and error toasting.
  const { addActivityMutation } = useActivityMutations();

  const handleFormSubmit = useCallback(
    async (formData: ActivityFormValues) => {
      if (!config) return;
      try {
        const basePayload = config.toPayload(formData);
        let activityType = config.activityType as NewActivityFormValues["activityType"];
        // TransferForm uses "in"/"out" direction; map it back to the actual
        // ActivityType for the create payload.
        if (pickerType === "TRANSFER") {
          const direction = (formData as TransferFormValues).direction;
          activityType = (
            direction === "in" ? ActivityType.TRANSFER_IN : ActivityType.TRANSFER_OUT
          ) as NewActivityFormValues["activityType"];
        }
        const submitData = {
          ...basePayload,
          activityType,
        } as NewActivityFormValues;

        const created = await addActivityMutation.mutateAsync(submitData);

        // Persist that this draft was acted on so the tool card flips to
        // "submitted" state next time the thread is loaded.
        if (threadId && toolCallId) {
          try {
            await updateToolResult({
              threadId,
              toolCallId,
              resultPatch: {
                submitted: true,
                createdActivityId: created.id,
                createdAt: new Date().toISOString(),
              },
            });
          } catch (e) {
            console.error("Failed to update tool result:", e);
          }
        }

        onSuccess(created.id);
      } catch {
        // Error already surfaced via the mutation hook's toast handler.
      }
    },
    [config, pickerType, threadId, toolCallId, onSuccess, addActivityMutation],
  );

  const handleConfirm = useCallback(() => {
    if (!defaultValues || !canConfirm) return;
    void handleFormSubmit(defaultValues as ActivityFormValues);
  }, [canConfirm, defaultValues, handleFormSubmit]);

  if (!config) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:recordActivity.unsupportedType", { type: draft.activityType })}
          </p>
        </CardContent>
      </Card>
    );
  }

  const FormComponent = config.component;
  const activityTypeDisplay = localizeActivityTypeName(t, draft.activityType);
  const cardTitle = isEditing
    ? t("ai:recordActivity.editActivity", { type: activityTypeDisplay })
    : t("ai:recordActivity.reviewActivity", { type: activityTypeDisplay });
  const headerAmount =
    draft.amount ??
    (draft.quantity != null && draft.unitPrice != null
      ? draft.quantity * draft.unitPrice
      : undefined);
  const headerAmountLabel =
    headerAmount !== undefined
      ? isBalanceHidden
        ? "\u2022\u2022\u2022\u2022\u2022"
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: draft.currency,
          }).format(headerAmount)
      : undefined;

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{cardTitle}</CardTitle>
              {draft.isCustomAsset && (
                <Badge variant="warning" className="text-xs">
                  {t("ai:recordActivity.customAsset")}
                </Badge>
              )}
            </div>
            {draft.isCustomAsset && draft.symbol && (
              <p className="text-warning mt-1 text-xs">
                {t("ai:recordActivity.customAssetHint", { symbol: draft.symbol })}
              </p>
            )}
          </div>
          {headerAmountLabel && (
            <div className="text-right">
              <div className="text-muted-foreground text-xs font-medium">
                {t("ai:recordActivity.estimatedTotal")}
              </div>
              <div className="text-lg font-semibold tabular-nums">{headerAmountLabel}</div>
            </div>
          )}
        </div>
      </CardHeader>
      {!isEditing ? (
        <DraftReview
          draft={draft}
          validation={validation}
          resolvedAsset={resolvedAsset}
          activityTypeDisplay={activityTypeDisplay}
          isLoading={addActivityMutation.isPending}
          canConfirm={canConfirm}
          onConfirm={handleConfirm}
          onEdit={() => setIsEditing(true)}
        />
      ) : (
        <CardContent>
          <ValidationHints validation={validation} />
          <FormComponent
            accounts={accountOptions}
            defaultValues={defaultValues}
            onSubmit={handleFormSubmit}
            onCancel={() => setIsEditing(false)}
            isLoading={addActivityMutation.isPending}
            isEditing
          />
        </CardContent>
      )}
    </Card>
  );
}

// ============================================================================
// Main Component
// ============================================================================

type RecordActivityToolUIContentProps = ToolCallMessagePartProps<
  RecordActivityArgs,
  RecordActivityOutput
>;

function RecordActivityToolUIContentImpl({
  result,
  status,
  toolCallId,
}: RecordActivityToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const parsed = useMemo(() => normalizeResult(result, baseCurrency), [baseCurrency, result]);
  const [successState, setSuccessState] = useState<{
    submitted: boolean;
    createdActivityId?: string;
  }>({ submitted: false });

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  const wasSubmitted = parsed?.submitted || successState.submitted;

  if (isLoading) {
    return <RecordActivityLoadingSkeleton />;
  }

  if (isIncomplete) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:recordActivity.failedPrepare")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">{t("ai:recordActivity.interrupted")}</p>
        </CardContent>
      </Card>
    );
  }

  if (!parsed) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">{t("ai:recordActivity.noData")}</p>
        </CardContent>
      </Card>
    );
  }

  if (wasSubmitted) {
    return (
      <SuccessState
        draft={parsed.draft}
        createdActivityId={parsed.createdActivityId ?? successState.createdActivityId}
        currency={parsed.draft.currency}
      />
    );
  }

  return (
    <DraftForm
      draft={parsed.draft}
      validation={parsed.validation}
      availableAccounts={parsed.availableAccounts}
      resolvedAsset={parsed.resolvedAsset}
      toolCallId={toolCallId}
      onSuccess={(createdActivityId) => {
        setSuccessState({ submitted: true, createdActivityId });
      }}
    />
  );
}

// ============================================================================
// Export
// ============================================================================

const RecordActivityToolUIContent = memo(RecordActivityToolUIContentImpl);

export const RecordActivityToolUI = makeAssistantToolUI<RecordActivityArgs, RecordActivityOutput>({
  toolName: "record_activity",
  render: (props) => {
    return <RecordActivityToolUIContent {...props} />;
  },
});
