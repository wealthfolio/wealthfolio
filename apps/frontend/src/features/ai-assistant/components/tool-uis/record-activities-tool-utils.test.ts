import type { ActivityBulkMutationResult } from "@/lib/types";
import { describe, expect, it } from "vitest";
import {
  buildRecordActivitiesCreatePayload,
  hasValidRecordActivityRows,
  mapRecordActivitiesSubmission,
  normalizeRecordActivitiesResult,
} from "./record-activities-tool-utils";

describe("normalizeRecordActivitiesResult", () => {
  it("normalizes snake_case and camelCase result payloads", () => {
    const normalized = normalizeRecordActivitiesResult(
      {
        drafts: [
          {
            row_index: 0,
            draft: {
              activity_type: "BUY",
              activity_date: "2026-02-01",
              symbol: "AAPL",
              quantity: "2",
              unit_price: "200.5",
              amount: "401",
              currency: "USD",
            },
            validation: {
              is_valid: true,
              missing_fields: [],
              errors: [],
            },
            available_subtypes: [],
          },
        ],
        validation: {
          total_rows: 1,
          valid_rows: 1,
          error_rows: 0,
        },
        available_accounts: [{ id: "acc-1", name: "Broker", currency: "USD" }],
      },
      "USD",
    );

    expect(normalized).not.toBeNull();
    expect(normalized?.drafts[0].rowIndex).toBe(0);
    expect(normalized?.drafts[0].draft.activityType).toBe("BUY");
    expect(normalized?.drafts[0].draft.quantity).toBe(2);
    expect(normalized?.validation.validRows).toBe(1);
    expect(normalized?.availableAccounts[0].id).toBe("acc-1");
  });
});

describe("buildRecordActivitiesCreatePayload", () => {
  it("builds creates[] from valid rows only", () => {
    const normalized = normalizeRecordActivitiesResult(
      {
        drafts: [
          {
            rowIndex: 0,
            draft: {
              activityType: "BUY",
              activityDate: "2026-02-01",
              symbol: "AAPL",
              quantity: 1,
              unitPrice: 100,
              currency: "USD",
              accountId: "acc-1",
            },
            validation: { isValid: true, missingFields: [], errors: [] },
            errors: [],
            availableSubtypes: [],
            resolvedAsset: {
              assetId: "SEC:AAPL:XNAS",
              symbol: "AAPL",
              name: "Apple Inc.",
              currency: "USD",
              exchangeMic: "XNAS",
              instrumentType: "EQUITY",
            },
          },
          {
            rowIndex: 1,
            draft: {
              activityType: "BUY",
              activityDate: "2026-02-01",
              symbol: "MSFT",
              currency: "USD",
              accountId: "acc-1",
            },
            validation: { isValid: false, missingFields: ["quantity"], errors: [] },
            errors: ["Missing required field: quantity"],
            availableSubtypes: [],
          },
        ],
        validation: { totalRows: 2, validRows: 1, errorRows: 1 },
        availableAccounts: [],
      },
      "USD",
    );

    const { creates, rowIndexByTempId } = buildRecordActivitiesCreatePayload(
      normalized?.drafts ?? [],
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].activityType).toBe("BUY");
    expect(creates[0].asset?.id).toBe("SEC:AAPL:XNAS");
    expect(creates[0].asset?.symbol).toBe("AAPL");
    expect(creates[0].asset?.exchangeMic).toBe("XNAS");
    expect(creates[0].asset?.quoteCcy).toBe("USD");
    expect(creates[0].asset?.instrumentType).toBe("EQUITY");
    expect(rowIndexByTempId.get("record-activities-0")).toBe(0);
    expect(rowIndexByTempId.get("record-activities-1")).toBeUndefined();
  });

  it("uses the resolved asset symbol when the draft symbol is not canonical", () => {
    const normalized = normalizeRecordActivitiesResult(
      {
        drafts: [
          {
            rowIndex: 0,
            draft: {
              activityType: "BUY",
              activityDate: "2026-02-01",
              symbol: "Tesla",
              quantity: 1,
              unitPrice: 250,
              currency: "USD",
              accountId: "acc-1",
            },
            validation: { isValid: true, missingFields: [], errors: [] },
            errors: [],
            availableSubtypes: [],
            resolvedAsset: {
              assetId: "SEC:TSLA:XNAS",
              symbol: "TSLA",
              name: "Tesla, Inc.",
              currency: "USD",
              exchangeMic: "XNAS",
              instrumentType: "EQUITY",
            },
          },
        ],
        validation: { totalRows: 1, validRows: 1, errorRows: 0 },
        availableAccounts: [],
      },
      "USD",
    );

    const { creates } = buildRecordActivitiesCreatePayload(normalized?.drafts ?? []);

    expect(creates[0].asset).toMatchObject({
      id: "SEC:TSLA:XNAS",
      symbol: "TSLA",
      exchangeMic: "XNAS",
      quoteCcy: "USD",
      instrumentType: "EQUITY",
    });
  });

  it("does not use activity currency as an asset quote currency fallback", () => {
    const normalized = normalizeRecordActivitiesResult(
      {
        drafts: [
          {
            rowIndex: 0,
            draft: {
              activityType: "BUY",
              activityDate: "2026-02-01",
              symbol: "VOD",
              quantity: 1,
              unitPrice: 80,
              currency: "GBP",
              accountId: "acc-1",
            },
            validation: { isValid: true, missingFields: [], errors: [] },
            errors: [],
            availableSubtypes: [],
          },
        ],
        validation: { totalRows: 1, validRows: 1, errorRows: 0 },
        availableAccounts: [],
      },
      "USD",
    );

    const { creates } = buildRecordActivitiesCreatePayload(normalized?.drafts ?? []);

    expect(creates[0].asset?.quoteCcy).toBeUndefined();
  });
});

describe("mapRecordActivitiesSubmission", () => {
  it("maps partial success errors back to row statuses", () => {
    const result: ActivityBulkMutationResult = {
      created: [],
      updated: [],
      deleted: [],
      createdMappings: [{ tempId: "record-activities-0", activityId: "act-1" }],
      errors: [{ id: "record-activities-1", action: "create", message: "Invalid symbol" }],
    };

    const mapped = mapRecordActivitiesSubmission(
      result,
      new Map([
        ["record-activities-0", 0],
        ["record-activities-1", 1],
      ]),
    );

    expect(mapped.createdCount).toBe(1);
    expect(mapped.errorCount).toBe(1);
    expect(mapped.rowStatuses).toEqual([
      { rowIndex: 0, status: "submitted" },
      { rowIndex: 1, status: "error", error: "Invalid symbol" },
    ]);
  });

  it("reports an error that refused the whole save on every row", () => {
    const result: ActivityBulkMutationResult = {
      created: [],
      updated: [],
      deleted: [],
      createdMappings: [],
      errors: [{ action: "save", message: "A conversion is written as a pair" }],
    };

    const mapped = mapRecordActivitiesSubmission(
      result,
      new Map([
        ["record-activities-0", 0],
        ["record-activities-1", 1],
      ]),
    );

    expect(mapped.errorCount).toBe(2);
    expect(mapped.rowStatuses).toEqual([
      { rowIndex: 0, status: "error", error: "A conversion is written as a pair" },
      { rowIndex: 1, status: "error", error: "A conversion is written as a pair" },
    ]);
  });
});

describe("hasValidRecordActivityRows", () => {
  it("returns false when zero valid rows exist", () => {
    const normalized = normalizeRecordActivitiesResult(
      {
        drafts: [
          {
            rowIndex: 0,
            draft: { activityType: "BUY", activityDate: "2026-02-01", currency: "USD" },
            validation: { isValid: false, missingFields: ["accountId"], errors: [] },
            errors: [],
            availableSubtypes: [],
          },
        ],
        validation: { totalRows: 1, validRows: 0, errorRows: 1 },
        availableAccounts: [],
      },
      "USD",
    );

    expect(hasValidRecordActivityRows(normalized?.drafts ?? [])).toBe(false);
  });
});
