import { describe, expect, it } from "vitest";

import { ActivityType } from "@/lib/constants";
import type { ImportAssetPreviewItem, ImportMappingData } from "@/lib/types";
import type { DraftActivity } from "../context";
import { HoldingsFormat } from "../steps/holdings-mapping-step";
import {
  canProceedFromAssetReviewStep,
  holdingsImportHasAssets,
  type AssetReviewProceedInput,
} from "./asset-review-utils";

function createDraft(overrides: Partial<DraftActivity> = {}): DraftActivity {
  return {
    rowIndex: 0,
    rawRow: [],
    activityDate: "2024-01-15",
    activityType: ActivityType.BUY,
    symbol: "AAPL",
    quantity: "1",
    unitPrice: "100",
    currency: "USD",
    accountId: "acc-1",
    status: "valid",
    errors: {},
    warnings: {},
    isEdited: false,
    ...overrides,
  };
}

function createHoldingsMapping(
  fieldMappings: Record<string, string>,
  overrides: Partial<ImportMappingData> = {},
): ImportMappingData {
  return {
    accountId: "acc-1",
    importType: "CSV_HOLDINGS",
    name: "Holdings",
    fieldMappings,
    activityMappings: {},
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
    ...overrides,
  };
}

function previewItem(overrides: Partial<ImportAssetPreviewItem> = {}): ImportAssetPreviewItem {
  return {
    key: "AAPL::EQUITY::::::",
    status: "EXISTING_ASSET",
    resolutionSource: "market_data",
    ...overrides,
  };
}

function proceedInput(overrides: Partial<AssetReviewProceedInput> = {}): AssetReviewProceedInput {
  return {
    isHoldingsMode: false,
    parsedRowCount: 0,
    draftActivities: [],
    isPreviewingAssets: false,
    assetPreviewError: null,
    assetPreviewItems: [],
    ...overrides,
  };
}

const HOLDINGS_HEADERS = ["date", "symbol", "quantity", "currency"];
const HOLDINGS_FIELD_MAPPINGS: Record<string, string> = {
  [HoldingsFormat.DATE]: "date",
  [HoldingsFormat.SYMBOL]: "symbol",
  [HoldingsFormat.QUANTITY]: "quantity",
  [HoldingsFormat.CURRENCY]: "currency",
};

describe("holdingsImportHasAssets", () => {
  it("returns false for a cash-only holdings import", () => {
    const rows = [
      ["2026-01-01", "$CASH", "1000", "USD"],
      ["2026-02-01", "$CASH", "1100", "USD"],
    ];

    expect(
      holdingsImportHasAssets(
        HOLDINGS_HEADERS,
        rows,
        createHoldingsMapping(HOLDINGS_FIELD_MAPPINGS),
        "acc-1",
        "USD",
      ),
    ).toBe(false);
  });

  it("returns true when the import contains a non-cash security", () => {
    const rows = [
      ["2026-01-01", "$CASH", "1000", "USD"],
      ["2026-01-01", "AAPL", "10", "USD"],
    ];

    expect(
      holdingsImportHasAssets(
        HOLDINGS_HEADERS,
        rows,
        createHoldingsMapping(HOLDINGS_FIELD_MAPPINGS),
        "acc-1",
        "USD",
      ),
    ).toBe(true);
  });

  it("returns false when the symbol column is not mapped", () => {
    const rows = [["2026-01-01", "AAPL", "10", "USD"]];
    const mapping = createHoldingsMapping({
      [HoldingsFormat.DATE]: "date",
      [HoldingsFormat.QUANTITY]: "quantity",
    });

    expect(holdingsImportHasAssets(HOLDINGS_HEADERS, rows, mapping, "acc-1", "USD")).toBe(false);
  });
});

describe("canProceedFromAssetReviewStep", () => {
  it("allows a cash-only holdings import to proceed with no synthetic drafts (issue #1111)", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({ isHoldingsMode: true, parsedRowCount: 3, draftActivities: [] }),
      ),
    ).toBe(true);
  });

  it("blocks a holdings import with no parsed rows", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({ isHoldingsMode: true, parsedRowCount: 0, draftActivities: [] }),
      ),
    ).toBe(false);
  });

  it("blocks an activity import that produced no drafts", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({ isHoldingsMode: false, parsedRowCount: 5, draftActivities: [] }),
      ),
    ).toBe(false);
  });

  it("allows an activity import whose drafts need no asset resolution (cash)", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({
          draftActivities: [createDraft({ symbol: "$CASH", activityType: ActivityType.DEPOSIT })],
        }),
      ),
    ).toBe(true);
  });

  it("blocks while assets are still being previewed", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({ isHoldingsMode: true, parsedRowCount: 3, isPreviewingAssets: true }),
      ),
    ).toBe(false);
  });

  it("blocks when asset preview failed", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({
          isHoldingsMode: true,
          parsedRowCount: 3,
          assetPreviewError: "Network error",
        }),
      ),
    ).toBe(false);
  });

  it("blocks when a candidate asset still needs fixing", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({
          draftActivities: [createDraft()],
          assetPreviewItems: [previewItem({ status: "NEEDS_FIXING" })],
        }),
      ),
    ).toBe(false);
  });

  it("blocks when candidates exist but the preview has not returned yet", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({ draftActivities: [createDraft()], assetPreviewItems: [] }),
      ),
    ).toBe(false);
  });

  it("allows once every candidate asset is resolved", () => {
    expect(
      canProceedFromAssetReviewStep(
        proceedInput({
          draftActivities: [createDraft()],
          assetPreviewItems: [previewItem({ status: "EXISTING_ASSET" })],
        }),
      ),
    ).toBe(true);
  });
});
