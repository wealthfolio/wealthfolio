import { formatDraftErrors } from "./import/utils/draft-validation-messages";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import zhActivity from "@/i18n/locales/zh/activity.json";
import zhAsset from "@/i18n/locales/zh/asset.json";
import { AccountType, ActivityType } from "@/lib/constants";
import type { LatestQuoteSnapshot } from "@/lib/types";
import { getNoQuoteReasonText } from "../asset/asset-utils";
import { updateValuationSchema } from "../asset/alternative-assets/components/update-valuation-schema";
import { formatActivityFieldName } from "./utils/validation-labels";
import { validateDraft } from "./import/utils/draft-utils";
import {
  getActivityImportProfileForAccountType,
  getActivityTypeLabelForImportProfile,
} from "./import/utils/activity-import-profile";

beforeEach(async () => {
  i18n.addResourceBundle("zh", "activity", zhActivity, true, true);
  i18n.addResourceBundle("zh", "asset", zhAsset, true, true);
  await i18n.changeLanguage("zh");
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("financial display translation paths", () => {
  it("localizes imported card labels without changing the profile or activity codes", async () => {
    const profile = getActivityImportProfileForAccountType(AccountType.CREDIT_CARD);
    const before = structuredClone(profile);
    expect(getActivityTypeLabelForImportProfile(ActivityType.WITHDRAWAL, profile, i18n.t)).toBe(
      "消费",
    );
    expect(getActivityTypeLabelForImportProfile(ActivityType.TRANSFER_IN, profile, i18n.t)).toBe(
      "还款",
    );
    expect(profile).toEqual(before);
    await i18n.changeLanguage("en");
    expect(getActivityTypeLabelForImportProfile(ActivityType.WITHDRAWAL, profile, i18n.t)).toBe(
      "Charge",
    );
  });

  it("localizes validation text while keeping the same status and field keys", async () => {
    const draft = { activityType: ActivityType.BUY, quantity: "0", unitPrice: "-1" };
    const chinese = validateDraft(draft);
    expect(chinese.status).toBe("error");
    expect(chinese.errors.activityDate).toEqual(["Date is required"]);
    expect(
      formatDraftErrors(
        i18n.t,
        chinese.errors.activityDate,
        chinese.localErrorMessages.activityDate,
      ),
    ).toEqual([zhActivity.validation.date_is_required]);
    expect(
      formatDraftErrors(i18n.t, chinese.errors.quantity, chinese.localErrorMessages.quantity),
    ).toEqual([zhActivity.validation.quantity_must_be_greater_than_0]);
    expect(formatActivityFieldName("rows[0].unitPrice")).toBe(zhActivity.field_price);
    expect(formatActivityFieldName("unrecognizedField")).toBe("unrecognizedField");
    await i18n.changeLanguage("en");
    const english = validateDraft(draft);
    expect(Object.keys(chinese.errors)).toEqual(Object.keys(english.errors));
    expect(english.errors.activityDate).toEqual(["Date is required"]);
    expect(draft).toEqual({ activityType: ActivityType.BUY, quantity: "0", unitPrice: "-1" });
  });

  it("translates known quote reason codes but preserves unknown and provider details", async () => {
    const snapshot: LatestQuoteSnapshot = {
      quote: null,
      isStale: true,
      effectiveMarketDate: "2026-10-26",
      quoteDate: null,
      noQuoteReason: { code: "MANUAL_PRICING", message: "Quote mode is Manual" },
    };
    expect(getNoQuoteReasonText(snapshot)).toBe("报价模式为手动");
    for (const code of ["LAST_ERROR", "UNKNOWN_PROVIDER_REASON"]) {
      expect(
        getNoQuoteReasonText({ ...snapshot, noQuoteReason: { code, message: "API HTTP 429" } }),
      ).toBe("API HTTP 429");
    }
    await i18n.changeLanguage("en");
    expect(getNoQuoteReasonText(snapshot)).toBe("Quote mode is Manual");
  });

  it("returns valuation message keys without relaxing the zero-value and notes limits", () => {
    const schema = updateValuationSchema;
    expect(schema.safeParse({ value: 0, date: new Date(), notes: "x".repeat(500) }).success).toBe(
      true,
    );
    const date = new Date();
    expect(schema.parse({ value: "12.5", date, notes: "Unchanged" })).toEqual({
      value: 12.5,
      date,
      notes: "Unchanged",
    });
    const missingDate = schema.safeParse({ value: 0 });
    expect(missingDate.success).toBe(false);
    if (!missingDate.success)
      expect(missingDate.error.issues[0]?.message).toBe("activity:validation.date_is_required");
    const nonNumeric = schema.safeParse({ value: "invalid", date });
    expect(nonNumeric.success).toBe(false);
    if (!nonNumeric.success)
      expect(nonNumeric.error.issues[0]?.message).toBe("asset:updateValuation.validation.number");
    const invalid = schema.safeParse({ value: -1, date: new Date(), notes: "x".repeat(501) });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map((issue) => issue.message)).toEqual([
        "asset:updateValuation.validation.non_negative",
        "asset:updateValuation.validation.notes",
      ]);
    }
  });
});
