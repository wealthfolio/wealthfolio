import { createAmountFormatting } from "@wealthfolio/ui";
import { describe, expect, it } from "vitest";
import {
  createActivityAmountFormatter,
  estimateDraftAmount,
  formatActivityAmount,
} from "./activity-table-utils";

describe("estimateDraftAmount", () => {
  it("shows a stated amount verbatim", () => {
    expect(
      estimateDraftAmount({ activityType: "BUY", amount: 123, quantity: 10, unitPrice: 100 }),
    ).toBe(123);
  });

  it("previews trade totals with the shared trade-final mirror", () => {
    expect(estimateDraftAmount({ activityType: "BUY", quantity: 10, unitPrice: 100, fee: 5 })).toBe(
      1005,
    );
    // SELL subtracts charges - the defect the old draft-side synthesis had.
    expect(
      estimateDraftAmount({ activityType: "SELL", quantity: 10, unitPrice: 100, fee: 5 }),
    ).toBe(995);
    // Options price at their contract multiplier.
    expect(estimateDraftAmount({ activityType: "BUY", quantity: 1, unitPrice: 2 }, "OPTION")).toBe(
      200,
    );
  });

  it("never invents a total for non-trades", () => {
    expect(
      estimateDraftAmount({ activityType: "DEPOSIT", quantity: 1, unitPrice: 100 }),
    ).toBeUndefined();
  });
});

describe("formatActivityAmount", () => {
  const formatter = createActivityAmountFormatter(
    createAmountFormatting("en-US", undefined, { INR: "IN" }),
  );

  it("formats each amount with its currency's format", () => {
    expect(formatActivityAmount(1234567.89, formatter, false, "INR")).toBe("12,34,567.89 INR");
    expect(formatActivityAmount(-1234567.89, formatter, false, "USD")).toBe("1,234,567.89 USD");
  });

  it("can leave out the currency code", () => {
    expect(formatActivityAmount(1234567.89, formatter, false, "INR", { showCurrency: false })).toBe(
      "12,34,567.89",
    );
  });

  it("hides amounts and marks missing ones", () => {
    expect(formatActivityAmount(1234567.89, formatter, true, "INR")).toBe("******");
    expect(formatActivityAmount(null, formatter, false, "INR")).toBe("-");
  });
});
