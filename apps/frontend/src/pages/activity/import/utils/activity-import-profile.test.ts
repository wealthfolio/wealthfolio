import { describe, expect, it } from "vitest";
import { AccountType, ActivityType, ImportFormat } from "@/lib/constants";
import {
  DEFAULT_ACTIVITY_IMPORT_PROFILE,
  activityTypeAllowedForImportProfile,
  getActivityImportProfileForImportContext,
  getActivityImportProfileForAccountType,
  getActivityTypeLabelForImportProfile,
  getDefaultActivityMappingsForImportProfile,
  mergeActivityMappingsForImportProfile,
  sanitizeImportMappingForProfile,
} from "./activity-import-profile";

describe("activity import profiles", () => {
  it("keeps investment imports as the default profile", () => {
    const profile = getActivityImportProfileForAccountType(AccountType.SECURITIES);

    expect(profile).toBe(DEFAULT_ACTIVITY_IMPORT_PROFILE);
    expect(profile.assetResolutionEnabled).toBe(true);
    expect(profile.requiredMappingFields).toContain(ImportFormat.SYMBOL);
  });

  it("uses a transaction profile for cash and credit card accounts", () => {
    const cash = getActivityImportProfileForAccountType(AccountType.CASH);
    const creditCard = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);

    expect(cash.kind).toBe("transaction");
    expect(creditCard.kind).toBe("transaction");
    expect(cash.assetResolutionEnabled).toBe(false);
    expect(creditCard.assetResolutionEnabled).toBe(false);
    expect(cash.visibleMappingFields).not.toContain(ImportFormat.SYMBOL);
    expect(creditCard.requiredMappingFields).toEqual([
      ImportFormat.DATE,
      ImportFormat.ACTIVITY_TYPE,
      ImportFormat.AMOUNT,
    ]);
  });

  it("limits credit card imports to card transaction types", () => {
    const profile = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);

    expect(activityTypeAllowedForImportProfile(ActivityType.WITHDRAWAL, profile)).toBe(true);
    expect(activityTypeAllowedForImportProfile(ActivityType.TRANSFER_IN, profile)).toBe(true);
    expect(activityTypeAllowedForImportProfile(ActivityType.BUY, profile)).toBe(false);
    expect(activityTypeAllowedForImportProfile(ActivityType.TRANSFER_OUT, profile)).toBe(false);
  });

  it("uses credit-card labels for credit card transaction imports", () => {
    const creditCard = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);
    const cash = getActivityImportProfileForAccountType(AccountType.CASH);

    expect(getActivityTypeLabelForImportProfile(ActivityType.WITHDRAWAL, creditCard)).toBe(
      "Charge",
    );
    expect(getActivityTypeLabelForImportProfile(ActivityType.TRANSFER_IN, creditCard)).toBe(
      "Payment",
    );
    expect(getActivityTypeLabelForImportProfile(ActivityType.WITHDRAWAL, cash)).toBe("Withdrawal");
  });

  it("includes transaction-specific default aliases", () => {
    const profile = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);
    const mappings = getDefaultActivityMappingsForImportProfile(profile);
    const cashMappings = getDefaultActivityMappingsForImportProfile(
      getActivityImportProfileForAccountType(AccountType.CASH),
    );

    expect(mappings[ActivityType.WITHDRAWAL]).toContain("PURCHASE");
    expect(mappings[ActivityType.TRANSFER_IN]).toContain("PAYMENT");
    expect(mappings[ActivityType.CREDIT]).toContain("REFUND");
    expect(mappings[ActivityType.CREDIT]).toContain("CASHBACK");
    expect(mappings[ActivityType.CREDIT]).toContain("REIMBURSEMENT");
    expect(cashMappings[ActivityType.CREDIT]).toContain("CASHBACK");
    expect(cashMappings[ActivityType.CREDIT]).toContain("EXPENSE REIMBURSEMENT");
    expect(mappings[ActivityType.BUY]).toBeUndefined();
  });

  it("removes stale investment fields and symbol mappings from transaction mappings", () => {
    const profile = getActivityImportProfileForAccountType(AccountType.CASH);
    const sanitized = sanitizeImportMappingForProfile(
      {
        fieldMappings: {
          [ImportFormat.DATE]: "Date",
          [ImportFormat.SYMBOL]: "Merchant",
          [ImportFormat.QUANTITY]: "Quantity",
          [ImportFormat.AMOUNT]: "Amount",
        },
        activityMappings: {
          [ActivityType.BUY]: ["PURCHASE"],
          [ActivityType.WITHDRAWAL]: ["DEBIT"],
        },
        symbolMappings: {
          Starbucks: "SBUX",
        },
        symbolMappingMeta: {
          Starbucks: { symbolName: "Starbucks" },
        },
      },
      profile,
    );

    expect(sanitized.fieldMappings).toEqual({
      [ImportFormat.DATE]: "Date",
      [ImportFormat.AMOUNT]: "Amount",
    });
    expect(sanitized.activityMappings).toEqual({
      [ActivityType.WITHDRAWAL]: ["DEBIT"],
    });
    expect(sanitized.symbolMappings).toEqual({});
    expect(sanitized.symbolMappingMeta).toEqual({});
  });

  it("infers a transaction profile from mapped row accounts when no default account is selected", () => {
    const profile = getActivityImportProfileForImportContext({
      accounts: [
        { id: "brokerage-1", accountType: AccountType.SECURITIES },
        { id: "card-1", accountType: AccountType.CREDIT_CARD },
      ],
      headers: ["Date", "Account", "Merchant", "Amount"],
      parsedRows: [["2024-01-15", "Visa", "Starbucks", "12.50"]],
      fieldMappings: {
        [ImportFormat.ACCOUNT]: "Account",
      },
      accountMappings: {
        Visa: "card-1",
      },
    });

    expect(profile).toBe(getActivityImportProfileForAccountType(AccountType.CREDIT_CARD));
  });

  it("keeps transaction defaults when merging an old template for a credit card account", () => {
    const profile = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);
    const merged = mergeActivityMappingsForImportProfile(
      {
        [ActivityType.BUY]: ["Purchase"],
        [ActivityType.WITHDRAWAL]: ["Card Sale"],
      },
      profile,
    );

    expect(merged[ActivityType.BUY]).toBeUndefined();
    expect(merged[ActivityType.WITHDRAWAL]).toEqual(
      expect.arrayContaining(["PURCHASE", "Card Sale"]),
    );
    expect(merged[ActivityType.TRANSFER_IN]).toContain("PAYMENT");
  });
});
