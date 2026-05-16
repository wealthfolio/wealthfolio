import { describe, expect, it } from "vitest";
import { ACTIVITY_SUBTYPES, ActivityType, ImportFormat } from "@/lib/constants";
import { createDraftActivities, draftToActivityImport } from "./draft-utils";

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

  it("does not infer transfer direction from sign", () => {
    const draft = createSingleDraftWithMapping(["2024-03-15", "TRANSFER", "-250.00", "USD"], {
      [ActivityType.TRANSFER_IN]: ["TRANSFER"],
    });

    expect(draft.activityType).toBe(ActivityType.TRANSFER_IN);
    expect(draft.amount).toBe("250.00");
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

  it("allows unknown provider subtype labels without treating them as semantic subtype errors", () => {
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
    expect(draft.subtype).toBe("BUY_TO_OPEN");
    expect(draftToActivityImport(draft).subtype).toBe("BUY_TO_OPEN");
  });
});
