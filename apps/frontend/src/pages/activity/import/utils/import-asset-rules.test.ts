import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import type { DraftActivity } from "../context";
import {
  applyAssetResolution,
  buildImportAssetCandidateFromDraft,
  buildNewAssetFromDraft,
  buildNewAssetFromSearchResult,
} from "./asset-review-utils";
import { validateDraft } from "./draft-utils";

function createDraft(overrides: Partial<DraftActivity> = {}): DraftActivity {
  return {
    rowIndex: 0,
    rawRow: [],
    activityDate: "2024-01-15",
    activityType: ActivityType.BUY,
    symbol: "AAPL",
    quantity: "1",
    unitPrice: "100",
    amount: "100",
    currency: "USD",
    accountId: "acc-1",
    status: "valid",
    errors: {},
    warnings: {},
    isEdited: false,
    ...overrides,
  };
}

describe("import asset rules", () => {
  it("builds asset candidates for staking rewards", () => {
    const candidate = buildImportAssetCandidateFromDraft(
      createDraft({
        activityType: ActivityType.INTEREST,
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        symbol: "SOL",
        instrumentType: "CRYPTO",
        quoteCcy: "USD",
      }),
    );

    expect(candidate).not.toBeNull();
    expect(candidate?.symbol).toBe("SOL");
  });

  it("keeps otherwise identical candidates distinct when their ISIN differs", () => {
    const first = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "SHOP",
        instrumentType: "EQUITY",
        quoteCcy: "CAD",
        isin: "ca82509l1076",
      }),
    );
    const second = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "SHOP",
        instrumentType: "EQUITY",
        quoteCcy: "CAD",
        isin: "CA82509L1077",
      }),
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.key).not.toBe(second?.key);
  });

  it("builds new assets from canonical search identity, not review symbol", () => {
    const draft = buildNewAssetFromSearchResult(
      {
        symbol: "SHOP.TO",
        canonicalSymbol: "SHOP",
        canonicalExchangeMic: "XTSE",
        providerId: "YAHOO",
        providerSymbol: "SHOP.TO",
        exchange: "TSX",
        exchangeMic: "XTSE",
        shortName: "Shopify Inc.",
        longName: "Shopify Inc.",
        quoteType: "EQUITY",
        index: "",
        score: 1,
        typeDisplay: "Equity",
        currency: "CAD",
      },
      "USD",
    );

    expect(draft.displayCode).toBe("SHOP");
    expect(draft.instrumentSymbol).toBe("SHOP");
    expect(draft.instrumentExchangeMic).toBe("XTSE");
    expect(draft.providerId).toBe("YAHOO");
    expect(draft.providerSymbol).toBe("SHOP.TO");
  });

  it("clears stale provider refs when applying a manual asset resolution", () => {
    const [resolved] = applyAssetResolution(
      [
        createDraft({
          symbol: "MSF.DE",
          assetCandidateKey: "MSF.DE::EQUITY::::XETR::EUR::",
          providerId: "YAHOO",
          providerSymbol: "MSF.DE",
        }),
      ],
      "MSF.DE::EQUITY::::XETR::EUR::",
      {
        kind: "INVESTMENT",
        name: "Manual Microsoft Xetra",
        displayCode: "MSF",
        isActive: true,
        quoteMode: "MANUAL",
        quoteCcy: "EUR",
        instrumentType: "EQUITY",
        instrumentSymbol: "MSF",
        instrumentExchangeMic: "XETR",
      },
      { importAssetKey: "MSF.DE::EQUITY::::XETR::EUR::" },
    );

    expect(resolved.symbol).toBe("MSF");
    expect(resolved.providerId).toBeUndefined();
    expect(resolved.providerSymbol).toBeUndefined();
  });

  it("keeps provider refs when building a new asset from a reviewed draft", () => {
    const draft = buildNewAssetFromDraft(
      createDraft({
        symbol: "XAU",
        symbolName: "Gold",
        exchangeMic: undefined,
        quoteCcy: "USD",
        instrumentType: "METAL",
        providerId: "METAL_PRICE_API",
        providerSymbol: "XAU-1KG",
      }),
    );

    expect(draft?.providerId).toBe("METAL_PRICE_API");
    expect(draft?.providerSymbol).toBe("XAU-1KG");
  });

  it("keeps provider refs when building an import asset candidate", () => {
    const candidate = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "XAU",
        quoteCcy: "USD",
        instrumentType: "METAL",
        providerId: "METAL_PRICE_API",
        providerSymbol: "XAU-1KG",
      }),
    );

    expect(candidate?.providerId).toBe("METAL_PRICE_API");
    expect(candidate?.providerSymbol).toBe("XAU-1KG");
  });

  it("requires a symbol for DRIP dividends", () => {
    const validation = validateDraft(
      createDraft({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DRIP,
        symbol: undefined,
        quantity: "1",
        unitPrice: "100",
        amount: "100",
      }),
    );

    expect(validation.status).toBe("error");
    expect(validation.errors.symbol).toEqual(["Symbol is required for DRIP dividends"]);
  });

  it("requires a symbol for dividend in kind", () => {
    const validation = validateDraft(
      createDraft({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        symbol: undefined,
        quantity: "1",
        unitPrice: "100",
        amount: "100",
      }),
    );

    expect(validation.status).toBe("error");
    expect(validation.errors.symbol).toEqual([
      "Symbol is required for dividend in kind activities",
    ]);
  });
});
