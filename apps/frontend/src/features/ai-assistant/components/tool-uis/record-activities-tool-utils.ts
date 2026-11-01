import { buildAssetResolutionInput } from "@/lib/asset-resolution-input";
import type { ActivityBulkMutationResult, ActivityCreate } from "@/lib/types";
import type {
  RecordActivitiesDraft,
  RecordActivitiesDraftRow,
  RecordActivitiesOutput,
  RecordActivitiesSubmissionStatus,
} from "../../types";

type UnknownObject = Record<string, unknown>;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function pickUnknownObject(value: unknown): UnknownObject | undefined {
  if (value && typeof value === "object") {
    return value as UnknownObject;
  }
  return undefined;
}

function pickArray(
  candidate: UnknownObject,
  camelCaseKey: string,
  snakeCaseKey: string,
): unknown[] {
  if (Array.isArray(candidate[camelCaseKey])) {
    return candidate[camelCaseKey] as unknown[];
  }
  if (Array.isArray(candidate[snakeCaseKey])) {
    return candidate[snakeCaseKey] as unknown[];
  }
  return [];
}

function pickString(
  candidate: UnknownObject,
  camelCaseKey: string,
  snakeCaseKey: string,
): string | undefined {
  const camelCaseValue = candidate[camelCaseKey];
  if (typeof camelCaseValue === "string") {
    return camelCaseValue;
  }
  const snakeCaseValue = candidate[snakeCaseKey];
  if (typeof snakeCaseValue === "string") {
    return snakeCaseValue;
  }
  return undefined;
}

function pickNumber(
  candidate: UnknownObject,
  camelCaseKey: string,
  snakeCaseKey: string,
): number | undefined {
  const camelCaseValue = toNumber(candidate[camelCaseKey]);
  if (camelCaseValue !== undefined) {
    return camelCaseValue;
  }
  return toNumber(candidate[snakeCaseKey]);
}

function normalizeDraft(raw: UnknownObject, fallbackCurrency: string): RecordActivitiesDraft {
  return {
    activityType: pickString(raw, "activityType", "activity_type") ?? "UNKNOWN",
    activityDate: pickString(raw, "activityDate", "activity_date") ?? new Date().toISOString(),
    symbol: pickString(raw, "symbol", "symbol"),
    assetId: pickString(raw, "assetId", "asset_id"),
    assetName: pickString(raw, "assetName", "asset_name"),
    quantity: toNumber(raw.quantity),
    unitPrice: pickNumber(raw, "unitPrice", "unit_price"),
    amount: toNumber(raw.amount),
    fee: toNumber(raw.fee),
    tax: toNumber(raw.tax),
    currency: pickString(raw, "currency", "currency") ?? fallbackCurrency,
    accountId: pickString(raw, "accountId", "account_id"),
    accountName: pickString(raw, "accountName", "account_name"),
    subtype: pickString(raw, "subtype", "subtype"),
    notes: pickString(raw, "notes", "notes"),
    priceSource: pickString(raw, "priceSource", "price_source") ?? "none",
    // Rust backend sends "pricing_mode"; the single-tool UI historically used "quoteMode".
    // Accept both for backward compatibility.
    pricingMode:
      pickString(raw, "pricingMode", "pricing_mode") ??
      (typeof raw.quoteMode === "string" ? raw.quoteMode : ""),
    isCustomAsset: Boolean(raw.isCustomAsset ?? raw.is_custom_asset ?? false),
    assetKind: pickString(raw, "assetKind", "asset_kind"),
  };
}

function normalizeRow(
  raw: UnknownObject,
  fallbackCurrency: string,
  index: number,
): RecordActivitiesDraftRow {
  const validationRaw = pickUnknownObject(raw.validation) ?? {};
  const missingFields = pickArray(validationRaw, "missingFields", "missing_fields") as string[];

  const errorsRaw = pickArray(validationRaw, "errors", "errors");
  const validationErrors = errorsRaw
    .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
    .map((entry) => ({
      field: (entry.field as string) ?? "",
      message: (entry.message as string) ?? "",
    }));

  const availableSubtypesRaw = pickArray(raw, "availableSubtypes", "available_subtypes");

  const availableSubtypes = availableSubtypesRaw
    .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
    .map((entry) => ({
      value: (entry.value as string) ?? "",
      label: (entry.label as string) ?? (entry.value as string) ?? "",
    }));

  const resolvedAssetRaw =
    pickUnknownObject(raw.resolvedAsset) ?? pickUnknownObject(raw.resolved_asset);
  const resolvedAsset = resolvedAssetRaw
    ? {
        assetId:
          (resolvedAssetRaw.assetId as string) ?? (resolvedAssetRaw.asset_id as string) ?? "",
        symbol: (resolvedAssetRaw.symbol as string) ?? "",
        name: (resolvedAssetRaw.name as string) ?? "",
        currency: (resolvedAssetRaw.currency as string) ?? fallbackCurrency,
        exchange: (resolvedAssetRaw.exchange as string) ?? undefined,
        exchangeMic:
          (resolvedAssetRaw.exchangeMic as string) ??
          (resolvedAssetRaw.exchange_mic as string) ??
          undefined,
        instrumentType:
          (resolvedAssetRaw.instrumentType as string) ??
          (resolvedAssetRaw.instrument_type as string) ??
          undefined,
      }
    : undefined;

  return {
    rowIndex:
      pickNumber(raw, "rowIndex", "row_index") ??
      toNumber(pickUnknownObject(raw.draft)?.rowIndex) ??
      index,
    draft: normalizeDraft(pickUnknownObject(raw.draft) ?? raw, fallbackCurrency),
    validation: {
      isValid: Boolean(validationRaw.isValid ?? validationRaw.is_valid ?? false),
      missingFields,
      errors: validationErrors,
    },
    errors: Array.isArray(raw.errors) ? (raw.errors as string[]) : [],
    resolvedAsset,
    availableSubtypes,
  };
}

export function normalizeRecordActivitiesResult(
  result: unknown,
  fallbackCurrency: string,
): RecordActivitiesOutput | null {
  if (!result) return null;

  if (typeof result === "string") {
    try {
      return normalizeRecordActivitiesResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object") return null;
  const candidate = result as UnknownObject;

  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizeRecordActivitiesResult(candidate.data, fallbackCurrency);
  }

  const draftsRaw = pickArray(candidate, "drafts", "drafts");
  const drafts = draftsRaw
    .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
    .map((entry, index) => normalizeRow(entry, fallbackCurrency, index));

  const validationRaw = pickUnknownObject(candidate.validation) ?? {};
  const rowStatusesRaw = pickArray(candidate, "rowStatuses", "row_statuses");

  const rowStatuses: RecordActivitiesSubmissionStatus[] = rowStatusesRaw
    .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
    .map((entry) => ({
      rowIndex: toNumber(entry.rowIndex ?? entry.row_index) ?? -1,
      status: (entry.status as "submitted" | "error") ?? "error",
      error: (entry.error as string) ?? undefined,
    }))
    .filter((entry) => entry.rowIndex >= 0);

  const accountsRaw = pickArray(candidate, "availableAccounts", "available_accounts");

  const resolvedAssetsRaw = pickArray(candidate, "resolvedAssets", "resolved_assets");

  return {
    drafts,
    validation: {
      totalRows: pickNumber(validationRaw, "totalRows", "total_rows") ?? drafts.length,
      validRows:
        pickNumber(validationRaw, "validRows", "valid_rows") ??
        drafts.filter((row) => row.validation.isValid).length,
      errorRows:
        pickNumber(validationRaw, "errorRows", "error_rows") ??
        drafts.filter((row) => !row.validation.isValid).length,
    },
    availableAccounts: accountsRaw
      .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
      .map((entry) => ({
        id: (entry.id as string) ?? "",
        name: (entry.name as string) ?? "",
        currency: (entry.currency as string) ?? fallbackCurrency,
      })),
    resolvedAssets: resolvedAssetsRaw
      .filter((entry): entry is UnknownObject => !!entry && typeof entry === "object")
      .map((entry) => ({
        assetId: (entry.assetId as string) ?? (entry.asset_id as string) ?? "",
        symbol: (entry.symbol as string) ?? "",
        name: (entry.name as string) ?? "",
        currency: (entry.currency as string) ?? fallbackCurrency,
        exchange: (entry.exchange as string) ?? undefined,
        exchangeMic: (entry.exchangeMic as string) ?? (entry.exchange_mic as string) ?? undefined,
        instrumentType:
          (entry.instrumentType as string) ?? (entry.instrument_type as string) ?? undefined,
      })),
    submitted: Boolean(candidate.submitted ?? false),
    createdCount: pickNumber(candidate, "createdCount", "created_count"),
    errorCount: pickNumber(candidate, "errorCount", "error_count"),
    rowStatuses,
    submittedAt: pickString(candidate, "submittedAt", "submitted_at"),
  };
}

export function hasValidRecordActivityRows(rows: RecordActivitiesDraftRow[]): boolean {
  return rows.some((row) => row.validation.isValid);
}

export function buildRecordActivitiesCreatePayload(rows: RecordActivitiesDraftRow[]): {
  creates: ActivityCreate[];
  rowIndexByTempId: Map<string, number>;
} {
  const rowIndexByTempId = new Map<string, number>();
  const creates: ActivityCreate[] = [];

  for (const row of rows) {
    if (!row.validation.isValid) continue;

    const tempId = `record-activities-${row.rowIndex}`;
    rowIndexByTempId.set(tempId, row.rowIndex);
    const resolvedSymbol = row.resolvedAsset?.symbol.trim();
    const assetSymbol = resolvedSymbol || row.draft.symbol?.trim();

    creates.push({
      id: tempId,
      accountId: row.draft.accountId ?? "",
      activityType: row.draft.activityType,
      subtype: row.draft.subtype ?? undefined,
      activityDate: row.draft.activityDate,
      asset: assetSymbol
        ? buildAssetResolutionInput({
            id: row.resolvedAsset?.assetId ?? row.draft.assetId,
            symbol: assetSymbol,
            exchangeMic: row.resolvedAsset?.exchangeMic,
            name: row.resolvedAsset?.name ?? row.draft.assetName,
            quoteCcy: row.resolvedAsset?.currency,
            instrumentType: row.resolvedAsset?.instrumentType,
          })
        : undefined,
      quantity: row.draft.quantity,
      unitPrice: row.draft.unitPrice,
      amount: row.draft.amount,
      fee: row.draft.fee,
      tax: row.draft.tax,
      currency: row.draft.currency,
      comment: row.draft.notes ?? undefined,
      // Confirming the table - with its amounts visible - is the user's
      // review, so a custom trade total is attested rather than re-queued.
      needsReview: false,
    });
  }

  return { creates, rowIndexByTempId };
}

export function mapRecordActivitiesSubmission(
  result: ActivityBulkMutationResult,
  rowIndexByTempId: Map<string, number>,
): {
  rowStatuses: RecordActivitiesSubmissionStatus[];
  createdCount: number;
  errorCount: number;
} {
  const byRow = new Map<number, RecordActivitiesSubmissionStatus>();
  const orderedRowIndexes = [...rowIndexByTempId.values()];

  for (const mapping of result.createdMappings ?? []) {
    if (!mapping.tempId) continue;
    const rowIndex = rowIndexByTempId.get(mapping.tempId);
    if (rowIndex == null) continue;
    byRow.set(rowIndex, { rowIndex, status: "submitted" });
  }

  if ((result.createdMappings?.length ?? 0) === 0 && (result.created?.length ?? 0) > 0) {
    for (let i = 0; i < result.created.length && i < orderedRowIndexes.length; i += 1) {
      const rowIndex = orderedRowIndexes[i];
      if (!byRow.has(rowIndex)) {
        byRow.set(rowIndex, { rowIndex, status: "submitted" });
      }
    }
  }

  for (const err of result.errors ?? []) {
    if (err.action !== "create") continue;
    const rowIndex = err.id ? rowIndexByTempId.get(err.id) : undefined;
    if (rowIndex == null) continue;
    byRow.set(rowIndex, { rowIndex, status: "error", error: err.message });
  }

  // An error naming no row refused the whole save (a conversion written
  // without its other row, say): it is the error of every row not saved.
  const batchError = (result.errors ?? [])
    .filter((err) => !err.id)
    .map((err) => err.message)
    .join("; ");
  if (batchError) {
    for (const rowIndex of orderedRowIndexes) {
      if (!byRow.has(rowIndex))
        byRow.set(rowIndex, { rowIndex, status: "error", error: batchError });
    }
  }

  const rowStatuses = [...byRow.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  const createdCount = rowStatuses.filter((status) => status.status === "submitted").length;
  const errorCount = rowStatuses.filter((status) => status.status === "error").length;

  return { rowStatuses, createdCount, errorCount };
}
