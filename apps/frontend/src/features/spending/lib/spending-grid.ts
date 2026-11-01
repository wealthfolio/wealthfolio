import { ActivityType } from "@/lib/constants";
import { generateId } from "@/lib/id";
import type { Account, ActivityDetails } from "@/lib/types";
import {
  TRACKED_FIELDS,
  valuesAreEqual,
} from "@/pages/activity/components/activity-data-grid/activity-utils";
import {
  toLocalTransaction,
  type LocalTransaction,
  type SavePayloadResult,
} from "@/pages/activity/components/activity-data-grid/types";
import { generateTempActivityId } from "@/pages/activity/components/activity-data-grid/use-activity-grid-state";
import type { ActivitySaveOutcome } from "@/pages/activity/components/activity-data-grid/use-save-activities";

import type { BulkCategoryAssignment } from "../adapters/cash-activities";
import type { CashActivity, CashFlowBucket } from "../types/cash-activity";
import { cashActivityFlowMetadata, resolveCashActivitySubtype } from "./cash-activity-form-utils";
import {
  getActivityTypesForAccount,
  getEffectiveCashActivityType,
  isCashActivityIncome,
} from "./constants";

export const SPENDING_TAXONOMY = "spending_categories";
export const INCOME_TAXONOMY = "income_sources";
export const SAVINGS_TAXONOMY = "savings_categories";

/** A Spending activity as the grid edits it. */
export interface SpendingGridRow extends LocalTransaction {
  /** Category in the row's taxonomy; "" for none. */
  categoryId: string;
  /** Category as loaded, so a save writes only the picks that changed. */
  _originalCategoryId: string;
  /** The server's cash-flow bucket. A new row has none until it is saved. */
  cashFlowBucket?: CashFlowBucket;
  /** Stored split lines. A row with any keeps its categories in the split editor. */
  splitCount: number;
}

/** Why a row's category cannot be picked in the grid, or null when it can. */
export type CategoryLock = "split" | "neutral" | "pendingTypeChange";

export function toActivityDetails(activity: CashActivity, account?: Account): ActivityDetails {
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

export function taxonomyForBucket(bucket: CashFlowBucket | undefined): string | null {
  if (bucket === "spending") return SPENDING_TAXONOMY;
  if (bucket === "income") return INCOME_TAXONOMY;
  if (bucket === "saving") return SAVINGS_TAXONOMY;
  return null;
}

export function toSpendingGridRow(activity: CashActivity, account?: Account): SpendingGridRow {
  const taxonomyId = taxonomyForBucket(activity.cashFlowBucket);
  const splitCount = activity.splits?.length ?? 0;
  // A split row's categories live in its lines, as in the list.
  const assignment =
    taxonomyId && splitCount === 0
      ? activity.assignments?.find((item) => item.taxonomyId === taxonomyId)
      : undefined;
  const categoryId = assignment?.categoryId ?? "";
  return {
    ...toLocalTransaction(toActivityDetails(activity, account)),
    categoryId,
    _originalCategoryId: categoryId,
    cashFlowBucket: activity.cashFlowBucket,
    splitCount,
  };
}

export function isTransferRow(row: { activityType: string }): boolean {
  return (
    row.activityType === ActivityType.TRANSFER_IN || row.activityType === ActivityType.TRANSFER_OUT
  );
}

/**
 * The taxonomy a row's category belongs to. A saved row takes it from its
 * bucket; a new one follows the Spending form: an income type gets an income
 * source, anything else a spending category.
 */
export function categoryTaxonomyFor(
  row: SpendingGridRow,
  accountType: string | undefined,
): string | null {
  if (!row.isNew) return taxonomyForBucket(row.cashFlowBucket);
  return isCashActivityIncome(row.activityType, accountType, row.subtype)
    ? INCOME_TAXONOMY
    : SPENDING_TAXONOMY;
}

function changesTypeOrAccount(row: SpendingGridRow, original: SpendingGridRow | undefined) {
  return (
    !!original &&
    (row.activityType !== original.activityType || row.accountId !== original.accountId)
  );
}

export function getCategoryLock(
  row: SpendingGridRow,
  original: SpendingGridRow | undefined,
): CategoryLock | null {
  if (row.splitCount > 0) return "split";
  if (!row.isNew && !taxonomyForBucket(row.cashFlowBucket)) return "neutral";
  // A saved row's bucket comes from the server, so a new type or account
  // decides its taxonomy only once saved.
  if (changesTypeOrAccount(row, original)) return "pendingTypeChange";
  return null;
}

/** Translation keys for the edits the grid refuses. */
export const EDIT_REJECTIONS = {
  transferPair: "activity:datagrid.edit_transfer_pair",
  transferType: "spending:grid.transferInForm",
  split: "spending:split.categoryProtected",
  neutral: "spending:grid.noCategory",
  saveTypeFirst: "spending:grid.saveTypeFirst",
  saveCategoryFirst: "spending:grid.saveCategoryFirst",
} as const;

/**
 * Checks one row's edit before it applies. Paste, fill and clear arrive here
 * as well, so a refused cell refuses the whole operation, as in the
 * Investments grid.
 */
export function getEditRejection(
  previous: SpendingGridRow,
  next: SpendingGridRow,
  original: SpendingGridRow | undefined,
): string | null {
  const typeChanged = next.activityType !== previous.activityType;
  if (typeChanged && (isTransferRow(previous) || isTransferRow(next))) {
    return previous.sourceGroupId ? EDIT_REJECTIONS.transferPair : EDIT_REJECTIONS.transferType;
  }
  if (
    isTransferRow(previous) &&
    previous.sourceGroupId &&
    (next.accountId !== previous.accountId || next.currency !== previous.currency)
  ) {
    return EDIT_REJECTIONS.transferPair;
  }

  if (next.categoryId !== previous.categoryId) {
    const lock = getCategoryLock(previous, original);
    if (lock === "split") return EDIT_REJECTIONS.split;
    if (lock === "neutral") return EDIT_REJECTIONS.neutral;
    if (lock === "pendingTypeChange") return EDIT_REJECTIONS.saveTypeFirst;
  }

  // A category picked earlier, or in the same paste, is saved apart from a new
  // type or account: the server decides the row's taxonomy from those.
  const typeOrAccountChanged = typeChanged || next.accountId !== previous.accountId;
  if (typeOrAccountChanged && !previous.isNew && next.categoryId !== next._originalCategoryId) {
    return EDIT_REJECTIONS.saveCategoryFirst;
  }
  return null;
}

/**
 * Applies what the Spending form does on a type or account change, after the
 * shared grid update has run: a credit on a cash account is a reimbursement
 * unless it already was a credit, and a new row's category is dropped when its
 * taxonomy changes.
 */
export function applySpendingRules(
  previous: SpendingGridRow,
  updated: SpendingGridRow,
  accountTypeOf: (accountId: string) => string | undefined,
): SpendingGridRow {
  let row = updated;
  if (row.activityType !== previous.activityType && row.activityType === ActivityType.CREDIT) {
    const subtype = resolveCashActivitySubtype({
      activityType: row.activityType,
      accountType: accountTypeOf(row.accountId),
      existingActivityType: previous.activityType,
      existingSubtype: previous.subtype,
    });
    if (subtype) row = { ...row, subtype };
  }
  if (
    row.isNew &&
    row.categoryId &&
    categoryTaxonomyFor(row, accountTypeOf(row.accountId)) !==
      categoryTaxonomyFor(previous, accountTypeOf(previous.accountId))
  ) {
    row = { ...row, categoryId: "" };
  }
  return row;
}

/** Whether a row changed anything stored on the activity itself. */
export function hasActivityChanges(row: SpendingGridRow, original: SpendingGridRow): boolean {
  return (
    TRACKED_FIELDS.some((field) => !valuesAreEqual(field, original[field], row[field])) ||
    row.needsReview !== original.needsReview ||
    row.status !== original.status
  );
}

export interface SpendingValidationError {
  transactionId: string;
  field: string;
  message: string;
}

/** The Spending form's checks the shared grid validation does not make. */
export function validateSpendingRows(
  rows: SpendingGridRow[],
  dirtyIds: ReadonlySet<string>,
  originals: ReadonlyMap<string, SpendingGridRow>,
  accountTypeOf: (accountId: string) => string | undefined,
  messages: { typeNotForAccount: string; amountNonNegative: string; amountRequired: string },
): SpendingValidationError[] {
  const errors: SpendingValidationError[] = [];
  for (const row of rows) {
    if (!dirtyIds.has(row.id)) continue;
    const original = originals.get(row.id);
    const accountType = accountTypeOf(row.accountId);
    if (
      (row.isNew || changesTypeOrAccount(row, original)) &&
      !isTransferRow(row) &&
      !(getActivityTypesForAccount(accountType) as string[]).includes(row.activityType)
    ) {
      errors.push({
        transactionId: row.id,
        field: "activityType",
        message: messages.typeNotForAccount,
      });
    }
    const amount = row.amount == null || row.amount === "" ? null : Number(row.amount);
    if (row.isNew && amount === null) {
      errors.push({ transactionId: row.id, field: "amount", message: messages.amountRequired });
    } else if (amount !== null && amount < 0) {
      errors.push({ transactionId: row.id, field: "amount", message: messages.amountNonNegative });
    }
  }
  return errors;
}

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shapes the shared grid payload as the Spending form would: rows whose only
 * change is their category send no activity update, and each activity carries
 * the form's flow metadata. Transfers keep the shared grid's, as the form
 * never writes them.
 */
export function prepareSpendingPayload(
  payload: SavePayloadResult,
  rows: ReadonlyMap<string, SpendingGridRow>,
  originals: ReadonlyMap<string, SpendingGridRow>,
): SavePayloadResult {
  const withFlowMetadata = <
    T extends { activityType: string; subtype?: string; metadata?: string },
  >(
    item: T,
    existing: Record<string, unknown> | undefined,
  ): T => {
    if (isTransferRow(item)) return item;
    const metadata = cashActivityFlowMetadata(item.activityType, item.subtype || null, existing);
    return metadata ? { ...item, metadata: JSON.stringify(metadata) } : item;
  };

  return {
    // A new row's metadata is only what the grid set; the copied source's is not sent.
    creates: payload.creates.map((item) => withFlowMetadata(item, parseMetadata(item.metadata))),
    updates: payload.updates
      .filter((item) => {
        const row = rows.get(item.id);
        const original = originals.get(item.id);
        return !row || !original || hasActivityChanges(row, original);
      })
      .map((item) => withFlowMetadata(item, rows.get(item.id)?.metadata)),
    deleteIds: payload.deleteIds,
  };
}

export interface CategoryWrites {
  assign: BulkCategoryAssignment[];
  clear: { activityId: string; taxonomyId: string }[];
}

/**
 * The category picks to write once the activities are saved: a created row
 * by its new id, and nothing for a row the activity save rejected or deleted.
 */
export function planCategoryWrites(
  rows: SpendingGridRow[],
  dirtyIds: ReadonlySet<string>,
  outcome: ActivitySaveOutcome,
  accountTypeOf: (accountId: string) => string | undefined,
): CategoryWrites {
  const writes: CategoryWrites = { assign: [], clear: [] };
  for (const row of rows) {
    if (!dirtyIds.has(row.id) || row.categoryId === row._originalCategoryId) continue;
    if (outcome.failedIds.has(row.id) || outcome.deletedIds.has(row.id)) continue;
    const activityId = row.isNew ? outcome.createdIds.get(row.id) : row.id;
    const taxonomyId = categoryTaxonomyFor(row, accountTypeOf(row.accountId));
    if (!activityId || !taxonomyId) continue;
    if (row.categoryId) {
      writes.assign.push({ activityId, taxonomyId, categoryId: row.categoryId });
    } else {
      writes.clear.push({ activityId, taxonomyId });
    }
  }
  return writes;
}

/** A new row on the first account, as the Spending form starts one. */
export function createSpendingDraft(account: Account | undefined, fallbackCurrency: string) {
  const now = new Date();
  const currency = account?.currency ?? fallbackCurrency;
  const draft: SpendingGridRow = {
    id: generateTempActivityId(),
    activityType: ActivityType.WITHDRAWAL,
    date: now,
    quantity: null,
    unitPrice: null,
    amount: null,
    fee: null,
    tax: null,
    currency,
    needsReview: false,
    comment: "",
    createdAt: now,
    updatedAt: now,
    assetId: "",
    assetSymbol: "",
    accountId: account?.id ?? "",
    accountName: account?.name ?? "",
    accountCurrency: currency,
    isNew: true,
    _amountEdited: true,
    categoryId: "",
    _originalCategoryId: "",
    splitCount: 0,
  };
  return draft;
}

/**
 * A copy of a saved row as a new, unsaved one dated now, as the Investments
 * grid duplicates. Only the explicit external-flow marker is carried over, and
 * the category only when the copy's taxonomy is the same.
 */
export function duplicateSpendingRow(
  source: SpendingGridRow,
  accountType: string | undefined,
): SpendingGridRow {
  const now = new Date();
  const duplicate: SpendingGridRow = {
    ...source,
    id: generateTempActivityId(),
    date: now,
    createdAt: now,
    updatedAt: now,
    isNew: true,
    needsReview: false,
    idempotencyKey: generateId("manual-duplicate"),
    sourceGroupId: undefined,
    sourceSystem: undefined,
    sourceRecordId: undefined,
    importRunId: undefined,
    isUserModified: undefined,
    status: undefined,
    metadata: undefined,
    _amountEdited: true,
    _originalCategoryId: "",
    cashFlowBucket: undefined,
    splitCount: 0,
  };
  const keepsTaxonomy =
    categoryTaxonomyFor(duplicate, accountType) === taxonomyForBucket(source.cashFlowBucket);
  return keepsTaxonomy ? duplicate : { ...duplicate, categoryId: "" };
}
