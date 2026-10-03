import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRANSACTION_COLUMN_VISIBILITY,
  countVisibleOptionalColumns,
  resolveTransactionColumns,
  transactionTableColumnCount,
} from "./transaction-columns";

describe("resolveTransactionColumns", () => {
  it("starts with every optional column hidden", () => {
    expect(resolveTransactionColumns(undefined)).toEqual(DEFAULT_TRANSACTION_COLUMN_VISIBILITY);
    expect(resolveTransactionColumns(null)).toEqual(DEFAULT_TRANSACTION_COLUMN_VISIBILITY);
  });

  it("keeps stored choices and defaults any column the preference predates", () => {
    expect(resolveTransactionColumns({ type: true })).toEqual({
      type: true,
      account: false,
      subcategory: false,
    });
  });
});

describe("transactionTableColumnCount", () => {
  it("counts the six fixed columns plus each optional column shown", () => {
    expect(transactionTableColumnCount(DEFAULT_TRANSACTION_COLUMN_VISIBILITY)).toBe(6);
    expect(transactionTableColumnCount({ type: true, account: false, subcategory: true })).toBe(8);
    expect(countVisibleOptionalColumns({ type: true, account: true, subcategory: true })).toBe(3);
  });
});
