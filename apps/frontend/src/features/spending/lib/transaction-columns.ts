/**
 * Columns of the desktop transactions table that the user can show or hide.
 * Time, Name / Notes, Category and Amount are always shown. Listed in the
 * order they render, between Name / Notes and Amount.
 */
export const OPTIONAL_TRANSACTION_COLUMNS = ["type", "account", "subcategory"] as const;

export type OptionalTransactionColumn = (typeof OPTIONAL_TRANSACTION_COLUMNS)[number];

export type TransactionColumnVisibility = Record<OptionalTransactionColumn, boolean>;

/** Hidden by default so the table keeps its original layout until asked. */
export const DEFAULT_TRANSACTION_COLUMN_VISIBILITY: TransactionColumnVisibility = {
  type: false,
  account: false,
  subcategory: false,
};

export const TRANSACTION_COLUMNS_STORAGE_KEY = "spending-transactions-columns";

/** Checkbox, Time, Name / Notes, Category, Amount and the row-actions column. */
const FIXED_COLUMN_COUNT = 6;

/**
 * Fills in any column missing from a stored preference, so a column added
 * after the preference was saved starts from its default.
 */
export function resolveTransactionColumns(
  stored: Partial<TransactionColumnVisibility> | null | undefined,
): TransactionColumnVisibility {
  return { ...DEFAULT_TRANSACTION_COLUMN_VISIBILITY, ...stored };
}

export function countVisibleOptionalColumns(columns: TransactionColumnVisibility): number {
  return OPTIONAL_TRANSACTION_COLUMNS.filter((column) => columns[column]).length;
}

/** Every column the table renders, for rows that span the full width. */
export function transactionTableColumnCount(columns: TransactionColumnVisibility): number {
  return FIXED_COLUMN_COUNT + countVisibleOptionalColumns(columns);
}
