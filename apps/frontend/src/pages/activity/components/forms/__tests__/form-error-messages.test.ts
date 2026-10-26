import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { buyFormSchema, createBuyFormSchema } from "../buy-form";
import { createDepositFormSchema, depositFormSchema } from "../deposit-form";
import { dividendFormSchema } from "../dividend-form";
import { createTransferFormSchema, transferFormSchema } from "../transfer-form";
import {
  bulkHoldingRowSchema,
  cashActivitySchema,
  createActivitySchemas,
  tradeActivitySchema,
} from "../schemas";

// Returns the translation key, so tests can tell which message was chosen.
const t = ((key: string) => key) as unknown as TFunction;

const activityDate = new Date("2024-03-04T00:00:00Z");
const buy = {
  accountId: "acc-123",
  assetId: "AAPL",
  activityDate,
  quantity: 10,
  unitPrice: 150.5,
  fee: 5,
  tax: 2,
  currency: "USD",
};
const deposit = { accountId: "acc-123", activityDate, amount: 1000, currency: "USD" };

function messagesAt(schema: ZodType, input: Record<string, unknown>, field: string) {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.path.join(".") === field)
    .map((issue) => issue.message);
}

describe("activity form error messages", () => {
  it("asks for a date when it is missing", () => {
    expect(messagesAt(buyFormSchema, { ...buy, activityDate: undefined }, "activityDate")).toEqual([
      "Please select a date.",
    ]);
    expect(
      messagesAt(depositFormSchema, { ...deposit, activityDate: undefined }, "activityDate"),
    ).toEqual(["Please select a date."]);
  });

  it("shows the number message when a number field is missing", () => {
    expect(messagesAt(buyFormSchema, { ...buy, quantity: undefined }, "quantity")).toEqual([
      "Quantity must be a number.",
    ]);
    expect(messagesAt(depositFormSchema, { ...deposit, amount: undefined }, "amount")).toEqual([
      "Amount must be a number.",
    ]);
  });

  it("shows the number message for text that is not a number", () => {
    expect(messagesAt(buyFormSchema, { ...buy, unitPrice: "abc" }, "unitPrice")).toEqual([
      "Price must be a number.",
    ]);
    expect(messagesAt(buyFormSchema, { ...buy, fee: "abc" }, "fee")).toEqual([
      "Fee must be a number.",
    ]);
    expect(
      messagesAt(dividendFormSchema, { ...deposit, symbol: "AAPL", tax: "abc" }, "tax"),
    ).toEqual(["Withholding tax must be a number."]);
    expect(
      messagesAt(
        transferFormSchema,
        { isExternal: true, accountId: "acc-123", activityDate, currency: "USD", amount: "abc" },
        "amount",
      ),
    ).toEqual(["Amount must be a number."]);
  });

  it("keeps the range message for numbers out of range", () => {
    expect(messagesAt(buyFormSchema, { ...buy, quantity: 0 }, "quantity")).toEqual([
      "Quantity must be greater than 0.",
    ]);
    expect(messagesAt(buyFormSchema, { ...buy, fee: -1 }, "fee")).toEqual([
      "Fee must be non-negative.",
    ]);
    expect(messagesAt(depositFormSchema, { ...deposit, amount: -1 }, "amount")).toEqual([
      "Amount must be non-negative.",
    ]);
  });

  it("uses the translated messages", () => {
    const buySchema = createBuyFormSchema(t);
    expect(messagesAt(buySchema, { ...buy, activityDate: undefined }, "activityDate")).toEqual([
      "activity:form.err_select_date",
    ]);
    expect(messagesAt(buySchema, { ...buy, quantity: "abc" }, "quantity")).toEqual([
      "activity:form.err_quantity_number",
    ]);
    expect(messagesAt(buySchema, { ...buy, quantity: -1 }, "quantity")).toEqual([
      "activity:form.err_quantity_gt_zero",
    ]);
    expect(
      messagesAt(createDepositFormSchema(t), { ...deposit, amount: undefined }, "amount"),
    ).toEqual(["activity:form.err_amount_number"]);
  });

  it("keeps the shared activity schema messages", () => {
    expect(
      messagesAt(tradeActivitySchema, { ...buy, activityType: "BUY", quantity: "abc" }, "quantity"),
    ).toEqual(["Quantity must be a number."]);
    expect(
      messagesAt(
        cashActivitySchema,
        { ...deposit, activityType: "DEPOSIT", amount: undefined },
        "amount",
      ),
    ).toEqual(["Amount must be a positive number."]);
    expect(
      messagesAt(
        bulkHoldingRowSchema,
        { id: "row-1", ticker: "AAPL", sharesOwned: "abc", averageCost: 1, symbolQuoteCcy: "USD" },
        "sharesOwned",
      ),
    ).toEqual(["Shares must be a number."]);
  });

  it("gives fields that used zod's built-in text their own messages", () => {
    const buySchema = createBuyFormSchema(t);
    expect(messagesAt(buySchema, { ...buy, currency: undefined }, "currency")).toEqual([
      "activity:form.err_currency_required",
    ]);
    expect(messagesAt(buySchema, { ...buy, strikePrice: 0 }, "strikePrice")).toEqual([
      "activity:form.err_strike_gt_zero",
    ]);
    expect(
      messagesAt(buySchema, { ...buy, contractMultiplier: NaN }, "contractMultiplier"),
    ).toEqual(["activity:form.err_multiplier_number"]);
    expect(messagesAt(buySchema, { ...buy, contractMultiplier: 0 }, "contractMultiplier")).toEqual([
      "activity:form.err_multiplier_gt_zero",
    ]);
    expect(
      messagesAt(
        createTransferFormSchema(t),
        { isExternal: true, accountId: "acc-123", activityDate, currency: "USD", transferRate: 0 },
        "transferRate",
      ),
    ).toEqual(["activity:form.err_transfer_rate_gt_zero"]);
  });

  it("translates the mobile and bulk holdings messages", () => {
    const schemas = createActivitySchemas(t);
    const trade = { ...buy, activityType: "BUY" };
    expect(messagesAt(schemas.newActivity, { ...trade, quantity: 0 }, "quantity")).toEqual([
      "activity:form.err_quantity_gt_zero",
    ]);
    expect(messagesAt(schemas.newActivity, { ...trade, currency: undefined }, "currency")).toEqual([
      "activity:form.err_currency_required",
    ]);
    expect(
      messagesAt(
        schemas.newActivity,
        { ...deposit, activityType: "DEPOSIT", amount: undefined },
        "amount",
      ),
    ).toEqual(["activity:form.err_amount_positive_number"]);
    expect(
      messagesAt(
        schemas.bulkHoldingRow,
        { id: "row-1", ticker: "", sharesOwned: 1, averageCost: 1, symbolQuoteCcy: "USD" },
        "ticker",
      ),
    ).toEqual(["activity:form.err_ticker_required"]);
  });
});
