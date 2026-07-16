import { describe, expect, it } from "vitest";
import { ACTIVITY_SUBTYPES, AccountType, ActivityType, ImportFormat } from "@/lib/constants";
import { createDraftActivities, draftToActivityImport } from "./draft-utils";
import { getActivityImportProfileForAccountType } from "./activity-import-profile";
import { applyAssetResolution } from "./asset-review-utils";

const headers = [
  ImportFormat.DATE,
  ImportFormat.ACTIVITY_TYPE,
  ImportFormat.AMOUNT,
  ImportFormat.CURRENCY,
];

const baseMapping = {
  fieldMappings: {
    [ImportFormat.DATE]: ImportFormat.DATE,
    [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
    [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
    [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
  },
  activityMappings: {},
  symbolMappings: {},
  accountMappings: {},
};

const parseConfig = {
  dateFormat: "auto",
  decimalSeparator: "auto",
  thousandsSeparator: "auto",
  defaultCurrency: "USD",
};

function createSingleDraft(row: string[]) {
  const [draft] = createDraftActivities([row], headers, baseMapping, parseConfig, "account-1");
  expect(draft).toBeDefined();
  return draft;
}

function createSingleDraftWithMapping(row: string[], activityMappings: Record<string, string[]>) {
  const [draft] = createDraftActivities(
    [row],
    headers,
    { ...baseMapping, activityMappings },
    parseConfig,
    "account-1",
  );
  expect(draft).toBeDefined();
  return draft;
}

describe("createDraftActivities explicit activity mapping", () => {
  it("uses the resolved asset currency for security rows when the CSV has no currency column", () => {
    const [draft] = createDraftActivities(
      [["2026-06-30", "BUY", "KWEB", "10", "28.50", "285.00", "0"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.AMOUNT,
        ImportFormat.FEE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.FEE]: ImportFormat.FEE,
        },
        activityMappings: {
          [ActivityType.BUY]: ["BUY"],
        },
      },
      { ...parseConfig, defaultCurrency: "CAD" },
      "account-1",
    );

    expect(draft.currency).toBe("CAD");
    expect(draft.currencySource).toBe("default");

    const [resolved] = applyAssetResolution(
      [draft],
      draft.assetCandidateKey ?? "",
      {
        kind: "INVESTMENT",
        name: "KraneShares CSI China Internet ETF",
        displayCode: "KWEB",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "USD",
        instrumentType: "EQUITY",
        instrumentSymbol: "KWEB",
        instrumentExchangeMic: "ARCX",
      },
      { importAssetKey: draft.assetCandidateKey },
    );

    expect(resolved.currency).toBe("USD");
    expect(resolved.currencySource).toBe("resolved");
    expect(draftToActivityImport(resolved).currency).toBe("USD");
  });

  it("does not serialize quote-unit asset currency when the CSV has no currency column", () => {
    const [draft] = createDraftActivities(
      [["2026-06-30", "BUY", "VOD.L", "10", "75.00", "750.00", "0"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.AMOUNT,
        ImportFormat.FEE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.FEE]: ImportFormat.FEE,
        },
        activityMappings: {
          [ActivityType.BUY]: ["BUY"],
        },
      },
      { ...parseConfig, defaultCurrency: "USD" },
      "account-1",
    );

    const [resolved] = applyAssetResolution(
      [draft],
      draft.assetCandidateKey ?? "",
      {
        kind: "INVESTMENT",
        name: "Vodafone Group Public Limited Company",
        displayCode: "VOD.L",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "GBp",
        instrumentType: "EQUITY",
        instrumentSymbol: "VOD",
        instrumentExchangeMic: "XLON",
      },
      { importAssetKey: draft.assetCandidateKey },
    );

    expect(resolved.currency).toBe("USD");
    expect(resolved.currencySource).toBe("default");
    expect(resolved.quoteCcy).toBe("GBp");
    expect(draftToActivityImport(resolved).currency).toBe("");
  });

  it("preserves an explicit CSV currency even when the resolved asset quote currency differs", () => {
    const [draft] = createDraftActivities(
      [["2026-06-30", "BUY", "KWEB", "10", "28.50", "285.00", "0", "CAD"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.AMOUNT,
        ImportFormat.FEE,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.FEE]: ImportFormat.FEE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: {
          [ActivityType.BUY]: ["BUY"],
        },
      },
      { ...parseConfig, defaultCurrency: "CAD" },
      "account-1",
    );

    expect(draft.currency).toBe("CAD");
    expect(draft.currencySource).toBe("csv");

    const [resolved] = applyAssetResolution(
      [draft],
      draft.assetCandidateKey ?? "",
      {
        kind: "INVESTMENT",
        name: "KraneShares CSI China Internet ETF",
        displayCode: "KWEB",
        isActive: true,
        quoteMode: "MARKET",
        quoteCcy: "USD",
        instrumentType: "EQUITY",
        instrumentSymbol: "KWEB",
        instrumentExchangeMic: "ARCX",
      },
      { importAssetKey: draft.assetCandidateKey },
    );

    expect(resolved.currency).toBe("CAD");
    expect(resolved.currencySource).toBe("csv");
    expect(resolved.quoteCcy).toBe("USD");
    expect(draftToActivityImport(resolved).currency).toBe("CAD");
  });

  it("carries provider config from symbol mapping into the final import payload", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "BUY", "SHOP.TO", "1", "100", "CAD"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: {
          [ActivityType.BUY]: ["BUY"],
        },
        symbolMappings: {
          "SHOP.TO": "SHOP",
        },
        symbolMappingMeta: {
          "SHOP.TO": {
            exchangeMic: "XTSE",
            quoteCcy: "CAD",
            instrumentType: "EQUITY",
            providerId: "YAHOO",
            providerSymbol: "SHOP.TO",
          },
        },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.providerId).toBe("YAHOO");
    expect(draft.providerSymbol).toBe("SHOP.TO");
    expect(draftToActivityImport(draft).providerId).toBe("YAHOO");
    expect(draftToActivityImport(draft).providerSymbol).toBe("SHOP.TO");
  });

  it("falls back to the selected account when a CSV account value is not valid", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "DEPOSIT", "1000.00", "USD", "stale-account"]],
      [...headers, ImportFormat.ACCOUNT],
      {
        ...baseMapping,
        fieldMappings: {
          ...baseMapping.fieldMappings,
          [ImportFormat.ACCOUNT]: ImportFormat.ACCOUNT,
        },
      },
      parseConfig,
      "account-1",
      new Set(["account-1"]),
    );

    expect(draft.accountId).toBe("account-1");
  });

  it("keeps a CSV account value when it is a valid account id", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "DEPOSIT", "1000.00", "USD", "account-2"]],
      [...headers, ImportFormat.ACCOUNT],
      {
        ...baseMapping,
        fieldMappings: {
          ...baseMapping.fieldMappings,
          [ImportFormat.ACCOUNT]: ImportFormat.ACCOUNT,
        },
      },
      parseConfig,
      "account-1",
      new Set(["account-1", "account-2"]),
    );

    expect(draft.accountId).toBe("account-2");
  });

  it("keeps explicitly mapped withdrawal labels when amount is positive", () => {
    const draft = createSingleDraftWithMapping(["2024-03-15", "WITHDRAWAL", "1000.00", "USD"], {
      [ActivityType.WITHDRAWAL]: ["WITHDRAWAL"],
    });

    expect(draft.activityType).toBe(ActivityType.WITHDRAWAL);
    expect(draft.amount).toBe("1000.00");
  });

  it("keeps explicitly mapped deposit labels when amount is negative", () => {
    const draft = createSingleDraftWithMapping(["2024-03-15", "DEPOSIT", "-1000.00", "USD"], {
      [ActivityType.DEPOSIT]: ["DEPOSIT"],
    });

    expect(draft.activityType).toBe(ActivityType.DEPOSIT);
    expect(draft.amount).toBe("1000.00");
  });

  it("uses a tax column as the cash amount for standalone tax activities", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "TAX", "", "USD", "-58.22"]],
      [...headers, ImportFormat.TAX],
      {
        ...baseMapping,
        fieldMappings: {
          ...baseMapping.fieldMappings,
          [ImportFormat.TAX]: ImportFormat.TAX,
        },
        activityMappings: {
          [ActivityType.TAX]: ["TAX"],
        },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.activityType).toBe(ActivityType.TAX);
    expect(draft.amount).toBe("58.22");
    expect(draft.tax).toBeUndefined();

    const payload = draftToActivityImport(draft);
    expect(payload.amount).toBe("58.22");
    expect(payload.tax).toBeUndefined();
  });

  it("does not infer transfer direction from sign", () => {
    const draft = createSingleDraftWithMapping(["2024-03-15", "TRANSFER", "-250.00", "USD"], {
      [ActivityType.TRANSFER_IN]: ["TRANSFER"],
    });

    expect(draft.activityType).toBe(ActivityType.TRANSFER_IN);
    expect(draft.amount).toBe("250.00");
  });

  it("infers Wealthsimple cash movement direction from signed amount", () => {
    const drafts = createDraftActivities(
      [
        ["2022-11-01", "TRANSFER", "-1000", "CAD"],
        ["2023-04-04", "TRANSFER_TF", "-500", "CAD"],
        ["2025-01-03", "MoneyMovement", "400", "CAD"],
      ],
      headers,
      {
        ...baseMapping,
        activityMappings: {
          [ActivityType.DEPOSIT]: ["TRANSFER", "TRANSFER_TF", "MoneyMovement"],
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(3);
    expect(drafts[0].activityType).toBe(ActivityType.WITHDRAWAL);
    expect(drafts[0].amount).toBe("1000");
    expect(drafts[1].activityType).toBe(ActivityType.WITHDRAWAL);
    expect(drafts[1].amount).toBe("500");
    expect(drafts[2].activityType).toBe(ActivityType.DEPOSIT);
    expect(drafts[2].amount).toBe("400");
  });

  it("infers Wealthsimple trade direction from subtype before generic Trade mapping", () => {
    const drafts = createDraftActivities(
      [
        ["2025-08-07", "Trade", "SELL", "AAPL", "-170", "36541.5", "USD"],
        ["2025-08-08", "Trade", "BUY", "AAPL", "10", "-2000", "USD"],
        ["2025-08-09", "Trade", "", "MSFT", "-2", "600", "USD"],
        ["2025-08-10", "Trade", "STO", "AAPL251219C00200000", "1", "500", "USD"],
      ],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SUBTYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: {
          [ActivityType.BUY]: ["Trade", "BUY"],
          [ActivityType.SELL]: ["SELL"],
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(4);
    expect(drafts[0].activityType).toBe(ActivityType.SELL);
    expect(drafts[0].subtype).toBeUndefined();
    expect(drafts[0].quantity).toBe("170");
    expect(drafts[0].amount).toBe("36541.5");
    expect(drafts[1].activityType).toBe(ActivityType.BUY);
    expect(drafts[1].subtype).toBeUndefined();
    expect(drafts[1].quantity).toBe("10");
    expect(drafts[1].amount).toBe("2000");
    expect(drafts[2].activityType).toBe(ActivityType.SELL);
    expect(drafts[2].quantity).toBe("2");
    expect(drafts[2].amount).toBe("600");
    expect(drafts[3].activityType).toBe(ActivityType.SELL);
    expect(drafts[3].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    expect(drafts[3].quantity).toBe("1");
    expect(drafts[3].amount).toBe("500");
  });

  it("infers stock short intent from raw activity type aliases", () => {
    const drafts = createDraftActivities(
      [
        ["2024-03-15", "SELL_SHORT", "AAPL", "1", "200", "USD"],
        ["2024-03-16", "BUY_TO_COVER", "AAPL", "1", "180", "USD"],
      ],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0].activityType).toBe(ActivityType.SELL);
    expect(drafts[0].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    expect(drafts[1].activityType).toBe(ActivityType.BUY);
    expect(drafts[1].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_CLOSE);
  });

  it("preserves raw stock short intent when mapped subtype column is blank", () => {
    const drafts = createDraftActivities(
      [
        ["2024-03-15", "SELL_SHORT", "AAPL", "1", "200", "USD", ""],
        ["2024-03-16", "BUY_TO_COVER", "AAPL", "1", "180", "USD", "   "],
      ],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0].activityType).toBe(ActivityType.SELL);
    expect(drafts[0].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    expect(drafts[1].activityType).toBe(ActivityType.BUY);
    expect(drafts[1].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_CLOSE);
  });

  it("infers Wealthsimple FxExchange transfer direction from signed amount", () => {
    const drafts = createDraftActivities(
      [
        ["2026-01-07", "FxExchange", "32.93", "CAD"],
        ["2026-01-07", "FxExchange", "-24.33", "USD"],
      ],
      headers,
      {
        ...baseMapping,
        activityMappings: {
          [ActivityType.TRANSFER_IN]: ["FxExchange"],
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0].activityType).toBe(ActivityType.TRANSFER_IN);
    expect(drafts[0].amount).toBe("32.93");
    expect(drafts[0].subtype).toBe("FXEXCHANGE");
    expect(drafts[0].isExternal).toBe(false);
    expect(drafts[1].activityType).toBe(ActivityType.TRANSFER_OUT);
    expect(drafts[1].amount).toBe("24.33");
    expect(drafts[1].subtype).toBe("FXEXCHANGE");
    expect(drafts[1].isExternal).toBe(false);
    expect(draftToActivityImport(drafts[0]).subtype).toBe("FXEXCHANGE");
    expect(draftToActivityImport(drafts[1]).subtype).toBe("FXEXCHANGE");
  });

  it("infers Wealthsimple internal security transfer direction from signed quantity", () => {
    const drafts = createDraftActivities(
      [
        ["2025-03-02", "InternalSecurityTransfer", "MSFT", "10.0172", "3976.728228", "USD"],
        ["2023-02-20", "InternalSecurityTransfer", "MSFT", "-10", "-2580.6", "USD"],
      ],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: {
          [ActivityType.TRANSFER_OUT]: ["InternalSecurityTransfer"],
        },
      },
      parseConfig,
      "account-1",
    );

    expect(drafts).toHaveLength(2);
    expect(drafts[0].activityType).toBe(ActivityType.TRANSFER_IN);
    expect(drafts[0].quantity).toBe("10.0172");
    expect(drafts[0].amount).toBe("3976.728228");
    expect(drafts[0].isExternal).toBe(false);
    expect(drafts[1].activityType).toBe(ActivityType.TRANSFER_OUT);
    expect(drafts[1].quantity).toBe("10");
    expect(drafts[1].amount).toBe("2580.6");
    expect(drafts[1].isExternal).toBe(false);
  });

  it("does not serialize stale external flags for non-transfer rows", () => {
    const draft = createSingleDraftWithMapping(["2024-03-15", "TRANSFER", "250.00", "USD"], {
      [ActivityType.TRANSFER_IN]: ["TRANSFER"],
    });

    expect(draft.isExternal).toBe(true);
    expect(
      draftToActivityImport({
        ...draft,
        activityType: ActivityType.CREDIT,
      }).isExternal,
    ).toBeUndefined();
  });

  it("accepts a positive split ratio from the amount column", () => {
    const [draft] = createDraftActivities(
      [["2024-05-15", "SPLIT", "NVDA", "3", "USD"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: { [ActivityType.SPLIT]: ["SPLIT"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.amount).toBe("3");
    expect(draft.errors).toEqual({});
  });

  it("keeps Wealthsimple split rows in review when the ratio amount is blank", () => {
    const [draft] = createDraftActivities(
      [["2020-08-31", "SPLIT", "AAPL", "3", "", ""]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: { [ActivityType.SPLIT]: ["SPLIT"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.activityType).toBe(ActivityType.SPLIT);
    expect(draft.quantity).toBe("3");
    expect(draft.amount).toBeUndefined();
    expect(draft.status).toBe("error");
    expect(draft.errors.amount).toEqual(["Amount (split ratio) must be greater than 0"]);
  });

  it("rejects zero split ratios", () => {
    const [draft] = createDraftActivities(
      [["2024-05-15", "SPLIT", "NVDA", "0", "USD"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: { [ActivityType.SPLIT]: ["SPLIT"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("error");
    expect(draft.errors.amount).toEqual(["Amount (split ratio) must be greater than 0"]);
  });

  it("marks rows as invalid until the activity type is explicitly mapped", () => {
    const draft = createSingleDraft(["2024-03-15", "WITHDRAWAL", "1000.00", "USD"]);

    expect(draft.activityType).toBeUndefined();
    expect(draft.status).toBe("error");
    expect(draft.errors.activityType).toContain("Activity type is required");
  });

  it("accepts dividend in kind with amount instead of unit price", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "DIVIDEND", "AAPL", "2", "100", "USD", ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.DIVIDEND]: ["DIVIDEND"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.errors).toEqual({});
    expect(draft.status).toBe("valid");
  });

  it("keeps mismatched known subtype labels as inert metadata", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "DIVIDEND", "AAPL", "100", "USD", ACTIVITY_SUBTYPES.STAKING_REWARD]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.DIVIDEND]: ["DIVIDEND"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.errors.subtype).toBeUndefined();
    expect(draft.subtype).toBe(ACTIVITY_SUBTYPES.STAKING_REWARD);
    expect(draftToActivityImport(draft).subtype).toBe(ACTIVITY_SUBTYPES.STAKING_REWARD);
  });

  it("preserves unknown provider subtype labels without separator normalization", () => {
    const providerSubtype = "Broker Label-Test";
    const [draft] = createDraftActivities(
      [["2024-03-15", "DIVIDEND", "AAPL", "100", "USD", providerSubtype]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.DIVIDEND]: ["DIVIDEND"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.errors.subtype).toBeUndefined();
    expect(draft.subtype).toBe(providerSubtype);
    expect(draftToActivityImport(draft).subtype).toBe(providerSubtype);
  });

  it("clears broker subtype labels that mirror the activity type", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "DIVIDEND", "AAPL", "100", "USD", "DIVIDEND"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.DIVIDEND]: ["DIVIDEND"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.subtype).toBeUndefined();
    expect(draftToActivityImport(draft).subtype).toBeUndefined();
  });

  it("canonicalizes position intent subtype aliases without treating them as errors", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "BUY", "AAPL251219C00200000", "1", "5", "USD", "BUY_TO_OPEN"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.BUY]: ["BUY"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.errors.subtype).toBeUndefined();
    expect(draft.subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    expect(draftToActivityImport(draft).subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
  });

  it("canonicalizes stock short subtype aliases", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "SELL", "AAPL", "1", "200", "USD", "SELL_SHORT"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.UNIT_PRICE,
        ImportFormat.CURRENCY,
        ImportFormat.SUBTYPE,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.UNIT_PRICE]: ImportFormat.UNIT_PRICE,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
          [ImportFormat.SUBTYPE]: ImportFormat.SUBTYPE,
        },
        activityMappings: { [ActivityType.SELL]: ["SELL"] },
      },
      parseConfig,
      "account-1",
    );

    expect(draft.status).toBe("valid");
    expect(draft.subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    expect(draftToActivityImport(draft).subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
  });

  it("rejects investment activities for credit card imports", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "BUY", "1000.00", "USD"]],
      headers,
      {
        ...baseMapping,
        activityMappings: {
          [ActivityType.BUY]: ["BUY"],
        },
      },
      parseConfig,
      "card-1",
      new Set(["card-1"]),
      new Map([["card-1", AccountType.CREDIT_CARD]]),
    );

    expect(draft.status).toBe("error");
    expect(draft.errors.activityType).toContain(
      "Credit card imports only support charges, payments, refunds, fees, and interest",
    );
  });

  it("accepts charges for credit card imports", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "CHARGE", "1000.00", "USD"]],
      headers,
      {
        ...baseMapping,
        activityMappings: {
          [ActivityType.WITHDRAWAL]: ["CHARGE"],
        },
      },
      parseConfig,
      "card-1",
      new Set(["card-1"]),
      new Map([["card-1", AccountType.CREDIT_CARD]]),
    );

    expect(draft.activityType).toBe(ActivityType.WITHDRAWAL);
    expect(draft.errors.activityType).toBeUndefined();
  });

  it("ignores stale investment columns for transaction import profiles", () => {
    const [draft] = createDraftActivities(
      [["2024-03-15", "PURCHASE", "Starbucks", "1", "1000.00", "USD"]],
      [
        ImportFormat.DATE,
        ImportFormat.ACTIVITY_TYPE,
        ImportFormat.SYMBOL,
        ImportFormat.QUANTITY,
        ImportFormat.AMOUNT,
        ImportFormat.CURRENCY,
      ],
      {
        ...baseMapping,
        fieldMappings: {
          [ImportFormat.DATE]: ImportFormat.DATE,
          [ImportFormat.ACTIVITY_TYPE]: ImportFormat.ACTIVITY_TYPE,
          [ImportFormat.SYMBOL]: ImportFormat.SYMBOL,
          [ImportFormat.QUANTITY]: ImportFormat.QUANTITY,
          [ImportFormat.AMOUNT]: ImportFormat.AMOUNT,
          [ImportFormat.CURRENCY]: ImportFormat.CURRENCY,
        },
        activityMappings: {
          [ActivityType.WITHDRAWAL]: ["PURCHASE"],
        },
      },
      parseConfig,
      "card-1",
      new Set(["card-1"]),
      new Map([["card-1", AccountType.CREDIT_CARD]]),
      { importProfile: getActivityImportProfileForAccountType(AccountType.CREDIT_CARD) },
    );

    expect(draft.activityType).toBe(ActivityType.WITHDRAWAL);
    expect(draft.symbol).toBeUndefined();
    expect(draft.quantity).toBeUndefined();
    expect(draft.assetCandidateKey).toBeUndefined();
    expect(draft.amount).toBe("1000.00");
    expect(draft.status).toBe("valid");
  });
});
