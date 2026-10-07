import { describe, it, expect } from "vitest";
import {
  applyMobileIncomeUpdateClears,
  validateTransferFields,
  type TransferValidationInput,
} from "../mobile-activity-form";
import { getMobileActivityAssetId } from "../mobile-activity-utils";

const base: TransferValidationInput = {
  activityType: "TRANSFER_OUT",
  transferMode: "cash",
  isExternal: true,
  direction: "out",
  toAccountId: "",
  amount: 1000,
  sourceCurrency: "USD",
  destinationCurrency: "USD",
  assetId: null,
  quantity: null,
  unitPrice: null,
};

describe("validateTransferFields", () => {
  // ── Non-transfer types are always valid ──────────────────────────
  it("returns null for non-transfer activity types", () => {
    expect(validateTransferFields({ ...base, activityType: "BUY" })).toBeNull();
    expect(validateTransferFields({ ...base, activityType: "DEPOSIT" })).toBeNull();
    expect(validateTransferFields({ ...base, activityType: "DIVIDEND" })).toBeNull();
  });

  // ── Fallback defaults (new transfer, fields undefined) ───────────
  describe("fallback defaults for new transfers", () => {
    it("defaults transferMode to cash and rejects missing amount", () => {
      const result = validateTransferFields({
        activityType: "TRANSFER_OUT",
        // transferMode, isExternal, direction all undefined — simulates new form
        amount: undefined,
      });
      expect(result).toEqual({ field: "amount", message: "Please enter an amount." });
    });

    it("defaults isExternal to false and rejects missing toAccountId", () => {
      const result = validateTransferFields({
        activityType: "TRANSFER_OUT",
        amount: 500,
        // isExternal undefined → false, toAccountId undefined
      });
      expect(result).toEqual({
        field: "toAccountId",
        message: "Please select a destination account.",
      });
    });

    it("passes when new transfer has amount and toAccountId", () => {
      const result = validateTransferFields({
        activityType: "TRANSFER_OUT",
        amount: 500,
        toAccountId: "acc-2",
        sourceCurrency: "USD",
        destinationCurrency: "USD",
      });
      expect(result).toBeNull();
    });
  });

  // ── Cash transfers ───────────────────────────────────────────────
  describe("cash transfers", () => {
    it("rejects missing amount", () => {
      const result = validateTransferFields({
        ...base,
        transferMode: "cash",
        amount: undefined,
      });
      expect(result).toEqual({ field: "amount", message: "Please enter an amount." });
    });

    it("rejects zero amount", () => {
      const result = validateTransferFields({ ...base, transferMode: "cash", amount: 0 });
      expect(result).toEqual({ field: "amount", message: "Please enter an amount." });
    });

    it("rejects negative amount", () => {
      const result = validateTransferFields({ ...base, transferMode: "cash", amount: -100 });
      expect(result).toEqual({ field: "amount", message: "Please enter an amount." });
    });

    it("accepts valid external cash transfer", () => {
      expect(validateTransferFields(base)).toBeNull();
    });

    it("accepts valid internal cash transfer", () => {
      const result = validateTransferFields({
        ...base,
        isExternal: false,
        toAccountId: "acc-2",
        amount: 500,
      });
      expect(result).toBeNull();
    });
  });

  // ── Securities transfers ─────────────────────────────────────────
  describe("securities transfers", () => {
    const securitiesBase: TransferValidationInput = {
      ...base,
      transferMode: "securities",
      assetId: "AAPL",
      quantity: 10,
      unitPrice: 150,
      amount: null,
    };

    it("rejects missing assetId", () => {
      const result = validateTransferFields({ ...securitiesBase, assetId: null });
      expect(result).toEqual({ field: "assetId", message: "Please select a symbol." });
    });

    it("rejects empty assetId", () => {
      const result = validateTransferFields({ ...securitiesBase, assetId: "  " });
      expect(result).toEqual({ field: "assetId", message: "Please select a symbol." });
    });

    it("rejects missing quantity", () => {
      const result = validateTransferFields({ ...securitiesBase, quantity: null });
      expect(result).toEqual({ field: "quantity", message: "Please enter a quantity." });
    });

    it("rejects zero quantity", () => {
      const result = validateTransferFields({ ...securitiesBase, quantity: 0 });
      expect(result).toEqual({ field: "quantity", message: "Please enter a quantity." });
    });

    it("rejects negative quantity", () => {
      const result = validateTransferFields({ ...securitiesBase, quantity: -5 });
      expect(result).toEqual({ field: "quantity", message: "Please enter a quantity." });
    });

    it("accepts external transfer out without unitPrice", () => {
      const result = validateTransferFields({
        ...securitiesBase,
        isExternal: true,
        direction: "out",
        unitPrice: null,
      });
      expect(result).toBeNull();
    });

    it("rejects external transfer in without unitPrice", () => {
      const result = validateTransferFields({
        ...securitiesBase,
        isExternal: true,
        direction: "in",
        unitPrice: null,
      });
      expect(result).toEqual({ field: "unitPrice", message: "Please enter a cost basis." });
    });

    it("rejects external transfer in with zero unitPrice", () => {
      const result = validateTransferFields({
        ...securitiesBase,
        isExternal: true,
        direction: "in",
        unitPrice: 0,
      });
      expect(result).toEqual({ field: "unitPrice", message: "Please enter a cost basis." });
    });

    it("accepts external transfer in with valid unitPrice", () => {
      const result = validateTransferFields({
        ...securitiesBase,
        isExternal: true,
        direction: "in",
        unitPrice: 150,
      });
      expect(result).toBeNull();
    });

    it("accepts valid internal securities transfer (no unitPrice needed)", () => {
      const result = validateTransferFields({
        ...securitiesBase,
        isExternal: false,
        toAccountId: "acc-2",
        unitPrice: null,
      });
      expect(result).toBeNull();
    });
  });

  // ── Internal transfer toAccountId ────────────────────────────────
  describe("internal transfer destination account", () => {
    it("rejects internal transfer without toAccountId", () => {
      const result = validateTransferFields({
        ...base,
        isExternal: false,
        toAccountId: "",
      });
      expect(result).toEqual({
        field: "toAccountId",
        message: "Please select a destination account.",
      });
    });

    it("rejects internal transfer with undefined toAccountId", () => {
      const result = validateTransferFields({
        ...base,
        isExternal: false,
        toAccountId: undefined,
      });
      expect(result).toEqual({
        field: "toAccountId",
        message: "Please select a destination account.",
      });
    });

    it("does not require toAccountId for external transfers", () => {
      const result = validateTransferFields({
        ...base,
        isExternal: true,
        toAccountId: "",
      });
      expect(result).toBeNull();
    });
  });

  // ── Both TRANSFER_IN and TRANSFER_OUT ────────────────────────────
  describe("works for both activity types", () => {
    it("validates TRANSFER_IN the same as TRANSFER_OUT", () => {
      const outResult = validateTransferFields({
        ...base,
        activityType: "TRANSFER_OUT",
        amount: null,
      });
      const inResult = validateTransferFields({
        ...base,
        activityType: "TRANSFER_IN",
        amount: null,
      });
      expect(outResult).toEqual(inResult);
    });
  });
});

describe("applyMobileIncomeUpdateClears", () => {
  it("sends explicit clears when an existing staking reward is switched back to cash interest", () => {
    const data: Record<string, unknown> = {
      activityType: "INTEREST",
      subtype: null,
    };

    applyMobileIncomeUpdateClears(data, true);

    expect(data.quantity).toBeNull();
    expect(data.unitPrice).toBeNull();
  });

  it("sends explicit clears when an existing dividend in kind is switched back to cash dividend", () => {
    const data: Record<string, unknown> = {
      activityType: "DIVIDEND",
      subtype: null,
      assetId: "AAPL",
    };

    applyMobileIncomeUpdateClears(data, true);

    expect(data.quantity).toBeNull();
    expect(data.unitPrice).toBeNull();
    expect(data.assetId).toBe("AAPL");
  });

  it("does not clear asset-backed income or creates", () => {
    const stakingUpdate: Record<string, unknown> = {
      activityType: "INTEREST",
      subtype: "STAKING_REWARD",
      quantity: 0.01,
      unitPrice: 200,
    };
    const cashCreate: Record<string, unknown> = {
      activityType: "INTEREST",
      subtype: null,
      quantity: undefined,
      unitPrice: undefined,
    };

    applyMobileIncomeUpdateClears(stakingUpdate, true);
    applyMobileIncomeUpdateClears(cashCreate, false);

    expect(stakingUpdate.quantity).toBe(0.01);
    expect(stakingUpdate.unitPrice).toBe(200);
    expect(cashCreate.quantity).toBeUndefined();
    expect(cashCreate.unitPrice).toBeUndefined();
  });
});

describe("getMobileActivityAssetId", () => {
  it("uses assetId when assetSymbol is blank", () => {
    expect(getMobileActivityAssetId({ assetSymbol: "", assetId: "AAPL" })).toBe("AAPL");
    expect(getMobileActivityAssetId({ assetSymbol: "  ", assetId: "MSFT" })).toBe("MSFT");
  });

  it("returns undefined when both identifiers are blank", () => {
    expect(getMobileActivityAssetId({ assetSymbol: "", assetId: "" })).toBeUndefined();
  });
});
