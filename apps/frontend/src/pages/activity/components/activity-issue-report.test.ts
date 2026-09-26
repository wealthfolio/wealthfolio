import { describe, expect, it } from "vitest";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import {
  createActivityIssueReport,
  expectedTypeForIssue,
  isSharedBrokerAccount,
} from "./activity-issue-report";

function importedActivity(overrides: Partial<ActivityDetails> = {}): ActivityDetails {
  return {
    id: "local-activity-id",
    accountId: "local-account-id",
    accountName: "Private account",
    accountCurrency: "CAD",
    activityType: ActivityType.DIVIDEND,
    date: new Date("2025-09-17"),
    createdAt: new Date("2025-09-17"),
    updatedAt: new Date("2025-09-17"),
    amount: "4210.50",
    quantity: "7",
    unitPrice: null,
    fee: null,
    currency: "CAD",
    assetId: "asset-id",
    assetSymbol: "SECRET",
    instrumentType: "BOND",
    needsReview: false,
    sourceSystem: "SNAPTRADE",
    sourceRecordId: "provider-record-id",
    comment: "Muni bond interest for Jane Doe, account 123456789",
    metadata: {
      raw_type: "DIVIDEND",
      provider_activity_id: "secret-provider-id",
      provider_signs: { amount: "negative", units: "negative" },
    },
    ...overrides,
  };
}

describe("brokerage issue reports", () => {
  it("reduces an activity to controlled mapping signals", () => {
    const report = createActivityIssueReport(
      importedActivity(),
      "provider-account-id",
      "wrong_type",
      ActivityType.INTEREST,
    );

    expect(report).toEqual({
      consent: true,
      provider: "snaptrade",
      accountId: "provider-account-id",
      issueKind: "wrong_type",
      observedType: "DIVIDEND",
      expectedType: "INTEREST",
      rawType: "DIVIDEND",
      features: {
        amountSign: "negative",
        unitsSign: "negative",
        assetClass: "bond",
        hasSymbol: true,
        descriptionTerms: ["municipal", "bond", "interest"],
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/4210|SECRET|Jane|123456789|provider-record-id/);
  });

  it("omits unknown raw type text and signs from old imports", () => {
    const report = createActivityIssueReport(
      importedActivity({
        amount: null,
        quantity: "0",
        metadata: { raw_type: "JANE_DOE" },
      }),
      "provider-account-id",
      "wrong_amount",
    );
    expect(report.rawType).toBeUndefined();
    expect(report.features.amountSign).toBeUndefined();
    expect(report.features.unitsSign).toBeUndefined();
  });

  it("accepts known punctuation provider codes", () => {
    for (const code of ["CAPITAL_GAIN_(LT)", "TRANSFER_(INCOMING)", "TRANSFER_(OUTGOING)"]) {
      const report = createActivityIssueReport(
        importedActivity({ metadata: { raw_type: code } }),
        "provider-account-id",
        "other",
      );
      expect(report.rawType).toBe(code);
    }
  });

  it("hides reporting for explicitly shared local accounts", () => {
    expect(isSharedBrokerAccount('{"owner":{"is_own_account":false}}')).toBe(true);
    expect(isSharedBrokerAccount('{"owner":{"is_own_account":true}}')).toBe(false);
    expect(isSharedBrokerAccount("invalid")).toBe(false);
  });

  it("omits a previously selected expected type for unrelated issue kinds", () => {
    expect(expectedTypeForIssue("wrong_amount", ActivityType.INTEREST)).toBeUndefined();
    expect(expectedTypeForIssue("wrong_type", ActivityType.INTEREST)).toBe(ActivityType.INTEREST);
    const report = createActivityIssueReport(
      importedActivity(),
      "provider-account-id",
      "wrong_amount",
      ActivityType.INTEREST,
    );
    expect(report).not.toHaveProperty("expectedType");
  });
});
