import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";
import type { DraftActivity } from "../context";
import {
  applyAssetResolution,
  buildImportAssetCandidateFromDraft,
  buildImportAssetCandidateKey,
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

  it("preserves the existing candidate key shape when provider identity is absent", () => {
    const key = buildImportAssetCandidateKey({
      accountId: "acc-1",
      symbol: "SHOP",
      instrumentType: "EQUITY",
      quoteCcy: "CAD",
      exchangeMic: "XTSE",
    });

    expect(key).toBe("SHOP::EQUITY::::XTSE::CAD::");
  });

  it("omits default-sourced currency from asset preview candidates", () => {
    const candidate = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "VOD.L",
        instrumentType: "EQUITY",
        currency: "CAD",
        currencySource: "default",
      }),
    );

    expect(candidate?.currency).toBeUndefined();
    expect(candidate?.key).toBe(
      buildImportAssetCandidateKey({
        accountId: "acc-1",
        symbol: "VOD.L",
        instrumentType: "EQUITY",
      }),
    );
  });

  it("keeps explicit CSV currency in asset preview candidates", () => {
    const candidate = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "VOD.L",
        instrumentType: "EQUITY",
        currency: "USD",
        currencySource: "csv",
      }),
    );

    expect(candidate?.currency).toBe("USD");
    expect(candidate?.key).toBe(
      buildImportAssetCandidateKey({
        accountId: "acc-1",
        symbol: "VOD.L",
        instrumentType: "EQUITY",
        quoteCcy: "USD",
      }),
    );
  });

  it("keeps same-symbol provider variants distinct for asset preview", () => {
    const staleKey = buildImportAssetCandidateKey({
      accountId: "acc-1",
      symbol: "XAU",
      instrumentType: "METAL",
      quoteCcy: "USD",
    });
    const first = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "XAU",
        instrumentType: "METAL",
        quoteCcy: "USD",
        providerId: "METAL_PRICE_API",
        providerSymbol: "XAU-1KG",
        assetCandidateKey: staleKey,
      }),
    );
    const second = buildImportAssetCandidateFromDraft(
      createDraft({
        symbol: "XAU",
        instrumentType: "METAL",
        quoteCcy: "USD",
        providerId: "METAL_PRICE_API",
        providerSymbol: "XAU-OZ",
        assetCandidateKey: staleKey,
      }),
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.key).not.toBe(staleKey);
    expect(first?.key).not.toBe(second?.key);
  });

  it("applies provider-specific preview resolutions to stale provider-less draft keys", () => {
    const staleKey = buildImportAssetCandidateKey({
      accountId: "acc-1",
      symbol: "XAU",
      instrumentType: "METAL",
      quoteCcy: "USD",
    });
    const first = createDraft({
      rowIndex: 1,
      symbol: "XAU",
      instrumentType: "METAL",
      quoteCcy: "USD",
      providerId: "METAL_PRICE_API",
      providerSymbol: "XAU-1KG",
      assetCandidateKey: staleKey,
    });
    const second = createDraft({
      rowIndex: 2,
      symbol: "XAU",
      instrumentType: "METAL",
      quoteCcy: "USD",
      providerId: "METAL_PRICE_API",
      providerSymbol: "XAU-OZ",
      assetCandidateKey: staleKey,
    });
    const firstKey = buildImportAssetCandidateFromDraft(first)?.key;

    if (!firstKey) throw new Error("expected provider-specific candidate key");

    const resolved = applyAssetResolution(
      [first, second],
      firstKey,
      {
        kind: "INVESTMENT",
        name: "Gold 1kg",
        displayCode: "XAU",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "USD",
        instrumentType: "METAL",
        instrumentSymbol: "XAU",
        providerId: "METAL_PRICE_API",
        providerSymbol: "XAU-1KG",
      },
      { importAssetKey: firstKey },
    );

    expect(resolved[0].assetCandidateKey).toBe(firstKey);
    expect(resolved[0].importAssetKey).toBe(firstKey);
    expect(resolved[1].assetCandidateKey).toBe(staleKey);
    expect(resolved[1].importAssetKey).toBeUndefined();
  });

  it("keeps resolved no-provider previews on their original key after provider enrichment", () => {
    const previewKey = buildImportAssetCandidateKey({
      accountId: "acc-1",
      symbol: "SHOP",
      instrumentType: "EQUITY",
      quoteCcy: "CAD",
      exchangeMic: "XTSE",
    });
    const [resolved] = applyAssetResolution(
      [
        createDraft({
          symbol: "SHOP",
          instrumentType: "EQUITY",
          quoteCcy: "CAD",
          exchangeMic: "XTSE",
          assetCandidateKey: previewKey,
        }),
      ],
      previewKey,
      {
        kind: "INVESTMENT",
        name: "Shopify Inc.",
        displayCode: "SHOP",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "CAD",
        instrumentType: "EQUITY",
        instrumentSymbol: "SHOP",
        instrumentExchangeMic: "XTSE",
        providerId: "YAHOO",
        providerSymbol: "SHOP.TO",
      },
      { importAssetKey: previewKey },
    );

    expect(buildImportAssetCandidateFromDraft(resolved)?.key).toBe(previewKey);
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
