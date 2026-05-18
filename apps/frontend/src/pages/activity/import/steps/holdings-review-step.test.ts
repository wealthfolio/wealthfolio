import { describe, expect, it } from "vitest";

import { HoldingsFormat } from "./holdings-mapping-step";
import {
  buildHoldingsRowResolutionMap,
  parseHoldingsSnapshots,
} from "../utils/holdings-import-utils";
import type { DraftActivity } from "../context";

function createDraft(overrides: Partial<DraftActivity>): DraftActivity {
  return {
    rowIndex: 0,
    rawRow: [],
    activityDate: "2000-01-01",
    activityType: "BUY",
    currency: "USD",
    accountId: "acc-1",
    quantity: "1",
    unitPrice: "1",
    status: "valid",
    errors: {},
    warnings: {},
    isEdited: false,
    ...overrides,
  };
}

describe("holdings review helpers", () => {
  it("maps created asset ids back onto row resolutions", () => {
    const resolutions = buildHoldingsRowResolutionMap(
      [
        createDraft({
          rowIndex: 2,
          symbol: "VOO",
          exchangeMic: "ARCX",
          importAssetKey: "asset-key-1",
        }),
      ],
      {
        "asset-key-1": "asset-123",
      },
    );

    expect(resolutions[2]).toEqual({
      symbol: "VOO",
      exchangeMic: "ARCX",
      assetId: "asset-123",
    });
  });

  it("maps created asset ids from candidate keys back onto row resolutions", () => {
    const resolutions = buildHoldingsRowResolutionMap(
      [
        createDraft({
          rowIndex: 4,
          symbol: "SHOP",
          exchangeMic: "XTSE",
          assetCandidateKey: "candidate-key-1",
        }),
      ],
      {
        "candidate-key-1": "asset-shop-tsx",
      },
    );

    expect(resolutions[4]).toEqual({
      symbol: "SHOP",
      exchangeMic: "XTSE",
      assetId: "asset-shop-tsx",
    });
  });

  it("carries provider refs through row resolutions and snapshots", () => {
    const resolutions = buildHoldingsRowResolutionMap([
      createDraft({
        rowIndex: 0,
        symbol: "SHOP",
        exchangeMic: "XTSE",
        quoteCcy: "CAD",
        instrumentType: "EQUITY",
        providerId: "YAHOO",
        providerSymbol: "SHOP.TO",
      }),
    ]);

    expect(resolutions[0]).toEqual({
      symbol: "SHOP",
      exchangeMic: "XTSE",
      quoteCcy: "CAD",
      instrumentType: "EQUITY",
      providerId: "YAHOO",
      providerSymbol: "SHOP.TO",
    });

    const snapshots = parseHoldingsSnapshots(
      ["date", "symbol", "quantity", "currency"],
      [["2026-01-02", "SHOP.TO", "10", "CAD"]],
      {
        [HoldingsFormat.DATE]: "date",
        [HoldingsFormat.SYMBOL]: "symbol",
        [HoldingsFormat.QUANTITY]: "quantity",
        [HoldingsFormat.CURRENCY]: "currency",
      },
      {
        dateFormat: "YYYY-MM-DD",
        decimalSeparator: ".",
        thousandsSeparator: ",",
        defaultCurrency: "USD",
      },
      undefined,
      undefined,
      resolutions,
    );

    expect(snapshots[0].positions[0]).toMatchObject({
      symbol: "SHOP",
      exchangeMic: "XTSE",
      quoteCcy: "CAD",
      instrumentType: "EQUITY",
      providerId: "YAHOO",
      providerSymbol: "SHOP.TO",
    });
  });

  it("keeps row-level resolutions distinct for duplicate raw symbols", () => {
    const snapshots = parseHoldingsSnapshots(
      ["date", "symbol", "quantity", "currency"],
      [
        ["2026-01-02", "SHOP", "10", "USD"],
        ["2026-01-02", "SHOP", "5", "CAD"],
      ],
      {
        [HoldingsFormat.DATE]: "date",
        [HoldingsFormat.SYMBOL]: "symbol",
        [HoldingsFormat.QUANTITY]: "quantity",
        [HoldingsFormat.CURRENCY]: "currency",
      },
      {
        dateFormat: "YYYY-MM-DD",
        decimalSeparator: ".",
        thousandsSeparator: ",",
        defaultCurrency: "USD",
      },
      undefined,
      undefined,
      {
        0: { symbol: "SHOP", exchangeMic: "XNYS", assetId: "shop-nyse" },
        1: { symbol: "SHOP", exchangeMic: "XTSE", assetId: "shop-tsx" },
      },
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].positions).toEqual([
      {
        symbol: "SHOP",
        quantity: "10",
        avgCost: undefined,
        currency: "USD",
        exchangeMic: "XNYS",
        assetId: "shop-nyse",
      },
      {
        symbol: "SHOP",
        quantity: "5",
        avgCost: undefined,
        currency: "CAD",
        exchangeMic: "XTSE",
        assetId: "shop-tsx",
      },
    ]);
  });
});
