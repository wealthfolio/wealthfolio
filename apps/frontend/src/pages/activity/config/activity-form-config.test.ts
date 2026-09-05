import { describe, expect, it } from "vitest";
import { ActivityType } from "@/lib/constants";
import type { AccountSelectOption } from "../components/forms/fields";
import type { ActivityDetails } from "@/lib/types";
import { mapActivityTypeToPicker } from "../utils/activity-form-utils";
import { ACTIVITY_FORM_CONFIG, hasActivityForm } from "./activity-form-config";

const accounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Test Account", currency: "USD" },
];

describe("ACTIVITY_FORM_CONFIG.EXCHANGE.getDefaults", () => {
  it("returns empty defaults when creating (no activity)", () => {
    const defaults = ACTIVITY_FORM_CONFIG.EXCHANGE.getDefaults(undefined, accounts);
    expect(defaults).toMatchObject({
      fromAssetId: "",
      toAssetId: "",
      fee: 0,
    });
  });

  it("maps own asset to 'from' and counterpart to 'to' when editing the EXCHANGE_OUT leg", () => {
    const activity: Partial<ActivityDetails> = {
      accountId: "acc-1",
      date: new Date("2026-02-01T10:00:00.000Z"),
      subtype: "EXCHANGE_OUT",
      assetId: "aapl-id",
      assetSymbol: "AAPL",
      quantity: "3",
      currency: "USD",
      counterpartAssetId: "googl-id",
      counterpartAssetSymbol: "GOOGL",
      counterpartQuantity: "2",
      counterpartCurrency: "USD",
      counterpartFee: "5",
      counterpartActivityDate: "2026-02-03T10:00:00.000Z",
      comment: "note",
    };

    const defaults = ACTIVITY_FORM_CONFIG.EXCHANGE.getDefaults(activity, accounts) as Record<
      string,
      unknown
    >;

    expect(defaults.fromAssetId).toBe("AAPL");
    expect(defaults.fromExistingAssetId).toBe("aapl-id");
    expect(defaults.fromQuantity).toBe(3);
    expect(defaults.toAssetId).toBe("GOOGL");
    expect(defaults.toExistingAssetId).toBe("googl-id");
    expect(defaults.toQuantity).toBe(2);
    // Editing the OUT leg: activityDate is this (own) leg's date, toActivityDate
    // is the counterpart (IN) leg's own date.
    expect(defaults.activityDate).toEqual(new Date("2026-02-01T10:00:00.000Z"));
    expect(defaults.toActivityDate).toEqual(new Date("2026-02-03T10:00:00.000Z"));
    // Editing the OUT leg: the fee belongs to the counterpart (IN) leg.
    expect(defaults.fee).toBe(5);
    expect(defaults.comment).toBe("note");
  });

  it("maps own asset to 'to' and counterpart to 'from' when editing the EXCHANGE_IN leg", () => {
    const activity: Partial<ActivityDetails> = {
      accountId: "acc-1",
      date: new Date("2026-02-03T10:00:00.000Z"),
      subtype: "EXCHANGE_IN",
      assetId: "googl-id",
      assetSymbol: "GOOGL",
      quantity: "2",
      currency: "USD",
      fee: "5",
      counterpartAssetId: "aapl-id",
      counterpartAssetSymbol: "AAPL",
      counterpartQuantity: "3",
      counterpartCurrency: "USD",
      counterpartActivityDate: "2026-02-01T10:00:00.000Z",
    };

    const defaults = ACTIVITY_FORM_CONFIG.EXCHANGE.getDefaults(activity, accounts) as Record<
      string,
      unknown
    >;

    expect(defaults.fromAssetId).toBe("AAPL");
    expect(defaults.fromExistingAssetId).toBe("aapl-id");
    expect(defaults.fromQuantity).toBe(3);
    expect(defaults.toAssetId).toBe("GOOGL");
    expect(defaults.toExistingAssetId).toBe("googl-id");
    expect(defaults.toQuantity).toBe(2);
    // Editing the IN leg directly: activityDate (from/closing) comes from the
    // counterpart (OUT) leg, toActivityDate is this (own) leg's own date.
    expect(defaults.activityDate).toEqual(new Date("2026-02-01T10:00:00.000Z"));
    expect(defaults.toActivityDate).toEqual(new Date("2026-02-03T10:00:00.000Z"));
    // Editing the IN leg directly: its own fee is used.
    expect(defaults.fee).toBe(5);
  });
});

describe("hasActivityForm", () => {
  it("accepts every type the picker can offer", () => {
    for (const pickerType of [
      ActivityType.BUY,
      ActivityType.SELL,
      ActivityType.DEPOSIT,
      ActivityType.WITHDRAWAL,
      ActivityType.DIVIDEND,
      "TRANSFER",
      ActivityType.SPLIT,
      ActivityType.FEE,
      ActivityType.INTEREST,
      ActivityType.TAX,
      ActivityType.CREDIT,
    ]) {
      expect(hasActivityForm(pickerType)).toBe(true);
    }
  });

  it("accepts ADJUSTMENT, which is editable without being offered for creation", () => {
    expect(hasActivityForm(ActivityType.ADJUSTMENT)).toBe(true);
  });

  it("rejects a stored type that has no editor", () => {
    // A needs-review row imported by sync arrives as UNKNOWN, which carries no
    // classification and so has nothing to edit — the caller must offer the
    // picker rather than pin it.
    expect(hasActivityForm(ActivityType.UNKNOWN)).toBe(false);
  });

  it("rejects an absent type", () => {
    expect(hasActivityForm(undefined)).toBe(false);
    expect(hasActivityForm("")).toBe(false);
  });

  it("agrees with the picker mapping for both transfer legs", () => {
    // TRANSFER_IN/OUT are stored types with no form of their own; the picker
    // alias is what has one, so the two helpers have to be used together.
    expect(hasActivityForm(ActivityType.TRANSFER_IN)).toBe(false);
    expect(hasActivityForm(mapActivityTypeToPicker(ActivityType.TRANSFER_IN))).toBe(true);
    expect(hasActivityForm(mapActivityTypeToPicker(ActivityType.TRANSFER_OUT))).toBe(true);
  });
});
