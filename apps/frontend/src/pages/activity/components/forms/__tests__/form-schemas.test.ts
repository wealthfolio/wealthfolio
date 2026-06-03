import { describe, it, expect } from "vitest";
import { ACTIVITY_FORM_CONFIG } from "../../../config/activity-form-config";
import { buyFormSchema } from "../buy-form";
import { depositFormSchema } from "../deposit-form";
import { dividendFormSchema, type DividendFormValues } from "../dividend-form";
import { feeFormSchema } from "../fee-form";
import { interestFormSchema, type InterestFormValues } from "../interest-form";
import { newActivitySchema } from "../schemas";
import { sellFormSchema } from "../sell-form";
import { splitFormSchema } from "../split-form";
import { taxFormSchema } from "../tax-form";
import { transferFormSchema } from "../transfer-form";
import { withdrawalFormSchema } from "../withdrawal-form";
import { ACTIVITY_SUBTYPES, ActivityType } from "@/lib/constants";

describe("Form Schemas Validation", () => {
  describe("buyFormSchema", () => {
    it("validates a complete valid buy form", () => {
      const validData = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        fee: 5,
        comment: "Test purchase",
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when accountId is empty", () => {
      const invalidData = {
        accountId: "",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please select an account.");
      }
    });

    it("fails when assetId is empty", () => {
      const invalidData = {
        accountId: "acc-123",
        assetId: "",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please enter a symbol.");
      }
    });

    it("fails when quantity is zero or negative", () => {
      const zeroQuantity = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 0,
        unitPrice: 150.5,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(zeroQuantity);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Quantity must be greater than 0.");
      }

      const negativeQuantity = {
        ...zeroQuantity,
        quantity: -5,
      };

      const negativeResult = buyFormSchema.safeParse(negativeQuantity);
      expect(negativeResult.success).toBe(false);
    });

    it("fails when unitPrice is zero or negative", () => {
      const zeroPrice = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 0,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(zeroPrice);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Price must be greater than 0.");
      }
    });

    it("fails when fee is negative", () => {
      const negativeFee = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        fee: -5,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(negativeFee);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Fee must be non-negative.");
      }
    });

    it("coerces string numbers to numbers", () => {
      const stringNumbers = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: "10" as unknown as number,
        unitPrice: "150.5" as unknown as number,
        fee: "5" as unknown as number,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(stringNumbers);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.quantity).toBe("number");
        expect(typeof result.data.unitPrice).toBe("number");
        expect(typeof result.data.fee).toBe("number");
      }
    });

    it("defaults includeCashDeposit to false", () => {
      const validData = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeCashDeposit).toBe(false);
      }
    });
  });

  describe("sellFormSchema", () => {
    it("validates a complete valid sell form", () => {
      const validData = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 10,
        unitPrice: 150.5,
        fee: 5,
        comment: "Test sale",
        currency: "USD",
      };

      const result = sellFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when required fields are missing", () => {
      const missingFields = {
        accountId: "",
        assetId: "",
      };

      const result = sellFormSchema.safeParse(missingFields);
      expect(result.success).toBe(false);
    });

    it("fails when quantity is not positive", () => {
      const invalidQuantity = {
        accountId: "acc-123",
        assetId: "AAPL",
        activityDate: new Date(),
        quantity: 0,
        unitPrice: 150.5,
        currency: "USD",
      };

      const result = sellFormSchema.safeParse(invalidQuantity);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Quantity must be greater than 0.");
      }
    });
  });

  describe("depositFormSchema", () => {
    it("validates a complete valid deposit form", () => {
      const validData = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 1000,
        comment: "Monthly deposit",
        currency: "USD",
      };

      const result = depositFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when accountId is empty", () => {
      const invalidData = {
        accountId: "",
        activityDate: new Date(),
        amount: 1000,
        currency: "USD",
      };

      const result = depositFormSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please select an account.");
      }
    });

    it("fails when amount is zero or negative", () => {
      const zeroAmount = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 0,
        currency: "USD",
      };

      const result = depositFormSchema.safeParse(zeroAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });

    it("allows optional comment to be null", () => {
      const withNullComment = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 1000,
        comment: null,
        currency: "USD",
      };

      const result = depositFormSchema.safeParse(withNullComment);
      expect(result.success).toBe(true);
    });
  });

  describe("withdrawalFormSchema", () => {
    it("validates a complete valid withdrawal form", () => {
      const validData = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 500,
        comment: "Emergency withdrawal",
        currency: "USD",
      };

      const result = withdrawalFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when amount is not positive", () => {
      const invalidAmount = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: -100,
        currency: "USD",
      };

      const result = withdrawalFormSchema.safeParse(invalidAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });
  });

  describe("dividendFormSchema", () => {
    it("validates a complete valid dividend form", () => {
      const validData = {
        accountId: "acc-123",
        symbol: "AAPL",
        activityDate: new Date(),
        amount: 25.5,
        comment: "Q1 dividend",
        currency: "USD",
      };

      const result = dividendFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when symbol is empty", () => {
      const invalidData = {
        accountId: "acc-123",
        symbol: "",
        activityDate: new Date(),
        amount: 25.5,
        currency: "USD",
      };

      const result = dividendFormSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please enter a symbol.");
      }
    });

    it("fails when amount is not positive", () => {
      const invalidAmount = {
        accountId: "acc-123",
        symbol: "AAPL",
        activityDate: new Date(),
        amount: 0,
        currency: "USD",
      };

      const result = dividendFormSchema.safeParse(invalidAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });
  });

  describe("transferFormSchema", () => {
    describe("internal cash transfers", () => {
      it("validates a complete valid internal cash transfer", () => {
        const validData = {
          isExternal: false,
          direction: "in",
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 1000,
          comment: "Transfer to savings",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it("fails when fromAccountId is empty for internal transfer", () => {
        const invalidData = {
          isExternal: false,
          fromAccountId: "",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 1000,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("source account"),
          );
          expect(error).toBeDefined();
        }
      });

      it("fails when toAccountId is empty for internal transfer", () => {
        const invalidData = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 1000,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("destination account"),
          );
          expect(error).toBeDefined();
        }
      });

      it("fails when source and destination accounts are the same", () => {
        const sameAccount = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-123",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 1000,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(sameAccount);
        expect(result.success).toBe(false);
        if (!result.success) {
          const refinementError = result.error.issues.find(
            (issue) => issue.path.includes("toAccountId") && issue.message.includes("different"),
          );
          expect(refinementError).toBeDefined();
        }
      });

      it("fails when amount is not positive in cash mode", () => {
        const invalidAmount = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 0,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidAmount);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("enter an amount"),
          );
          expect(error).toBeDefined();
        }
      });
    });

    describe("internal securities transfers", () => {
      it("validates a complete valid internal securities transfer", () => {
        const validData = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "securities",
          assetId: "AAPL",
          quantity: 10,
          comment: "Security transfer",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it("fails when assetId is missing in securities mode", () => {
        const invalidData = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "securities",
          quantity: 10,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("select a symbol"),
          );
          expect(error).toBeDefined();
        }
      });

      it("fails when quantity is missing in securities mode", () => {
        const invalidData = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "securities",
          assetId: "AAPL",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("enter a quantity"),
          );
          expect(error).toBeDefined();
        }
      });

      it("fails when quantity is zero or negative in securities mode", () => {
        const invalidQuantity = {
          isExternal: false,
          fromAccountId: "acc-123",
          toAccountId: "acc-456",
          activityDate: new Date(),
          transferMode: "securities",
          assetId: "AAPL",
          quantity: 0,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidQuantity);
        expect(result.success).toBe(false);
        if (!result.success) {
          const quantityError = result.error.issues.find((issue) =>
            issue.message.includes("enter a quantity"),
          );
          expect(quantityError).toBeDefined();
        }
      });
    });

    describe("external transfers", () => {
      it("validates a complete valid external transfer in (cash)", () => {
        const validData = {
          isExternal: true,
          direction: "in",
          accountId: "acc-123",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 2000,
          comment: "External transfer in",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it("validates a complete valid external transfer out (cash)", () => {
        const validData = {
          isExternal: true,
          direction: "out",
          accountId: "acc-123",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 500,
          comment: "External transfer out",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it("fails when accountId is empty for external transfer", () => {
        const invalidData = {
          isExternal: true,
          direction: "in",
          accountId: "",
          activityDate: new Date(),
          transferMode: "cash",
          amount: 1000,
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        if (!result.success) {
          const error = result.error.issues.find((issue) =>
            issue.message.includes("select an account"),
          );
          expect(error).toBeDefined();
        }
      });

      it("validates external securities transfer", () => {
        const validData = {
          isExternal: true,
          direction: "in",
          accountId: "acc-123",
          activityDate: new Date(),
          transferMode: "securities",
          assetId: "AAPL",
          quantity: 5,
          unitPrice: 100,
          comment: "External securities transfer in",
          currency: "USD",
        };

        const result = transferFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });
    });
  });

  describe("splitFormSchema", () => {
    it("validates a complete valid split form", () => {
      const validData = {
        accountId: "acc-123",
        symbol: "AAPL",
        activityDate: new Date(),
        splitRatio: 2,
        comment: "2:1 stock split",
        currency: "USD",
      };

      const result = splitFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when symbol is empty", () => {
      const invalidData = {
        accountId: "acc-123",
        symbol: "",
        activityDate: new Date(),
        splitRatio: 2,
        currency: "USD",
      };

      const result = splitFormSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please enter a symbol.");
      }
    });

    it("fails when splitRatio is zero or negative", () => {
      const zeroRatio = {
        accountId: "acc-123",
        symbol: "AAPL",
        activityDate: new Date(),
        splitRatio: 0,
        currency: "USD",
      };

      const result = splitFormSchema.safeParse(zeroRatio);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Split ratio must be greater than 0.");
      }
    });

    it("accepts decimal split ratios", () => {
      const decimalRatio = {
        accountId: "acc-123",
        symbol: "AAPL",
        activityDate: new Date(),
        splitRatio: 0.5, // Reverse split
        currency: "USD",
      };

      const result = splitFormSchema.safeParse(decimalRatio);
      expect(result.success).toBe(true);
    });
  });

  describe("feeFormSchema", () => {
    it("validates a complete valid fee form", () => {
      const validData = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 25,
        comment: "Account maintenance fee",
        currency: "USD",
      };

      const result = feeFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when amount is not positive", () => {
      const invalidAmount = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 0,
        currency: "USD",
      };

      const result = feeFormSchema.safeParse(invalidAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });
  });

  describe("interestFormSchema", () => {
    it("validates a complete valid interest form", () => {
      const validData = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 15.5,
        comment: "Monthly interest",
        currency: "USD",
      };

      const result = interestFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when amount is not positive", () => {
      const invalidAmount = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: -5,
        currency: "USD",
      };

      const result = interestFormSchema.safeParse(invalidAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });
  });

  describe("taxFormSchema", () => {
    it("validates a complete valid tax form", () => {
      const validData = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 100,
        comment: "Withholding tax",
        currency: "USD",
      };

      const result = taxFormSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("fails when amount is not positive", () => {
      const invalidAmount = {
        accountId: "acc-123",
        activityDate: new Date(),
        amount: 0,
        currency: "USD",
      };

      const result = taxFormSchema.safeParse(invalidAmount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Amount must be greater than 0.");
      }
    });

    it("fails when accountId is missing", () => {
      const missingAccount = {
        accountId: "",
        activityDate: new Date(),
        amount: 100,
        currency: "USD",
      };

      const result = taxFormSchema.safeParse(missingAccount);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe("Please select an account.");
      }
    });
  });

  describe("buyFormSchema option validation", () => {
    it("fails when option fields are missing for assetType=option", () => {
      const data = {
        assetType: "option",
        accountId: "acc-123",
        activityDate: new Date(),
        quantity: 1,
        unitPrice: 5.0,
        fee: 0,
        currency: "USD",
      };

      const result = buyFormSchema.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path[0]);
        expect(paths).toContain("underlyingSymbol");
        expect(paths).toContain("strikePrice");
        expect(paths).toContain("expirationDate");
      }
    });

    it("passes when all option fields are provided", () => {
      const data = {
        assetType: "option",
        accountId: "acc-123",
        activityDate: new Date(),
        quantity: 1,
        unitPrice: 5.0,
        fee: 0,
        currency: "USD",
        underlyingSymbol: "AAPL",
        strikePrice: 150,
        expirationDate: "2025-01-17",
        optionType: "CALL",
        contractMultiplier: 100,
      };

      const result = buyFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("transferFormSchema external securities cost basis", () => {
    it("fails when unitPrice is missing for external securities transfer-in", () => {
      const data = {
        isExternal: true,
        direction: "in",
        accountId: "acc-123",
        activityDate: new Date(),
        transferMode: "securities",
        assetId: "AAPL",
        quantity: 10,
        currency: "USD",
      };

      const result = transferFormSchema.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        const error = result.error.issues.find((i) => i.message.includes("cost basis"));
        expect(error).toBeDefined();
      }
    });

    it("does not require unitPrice for external securities transfer-out", () => {
      const data = {
        isExternal: true,
        direction: "out",
        accountId: "acc-123",
        activityDate: new Date(),
        transferMode: "securities",
        assetId: "AAPL",
        quantity: 10,
        currency: "USD",
      };

      const result = transferFormSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("TRANSFER toPayload", () => {
    it("initializes cash transfers as cash even when they have a generated cash asset id", () => {
      const defaults = ACTIVITY_FORM_CONFIG.TRANSFER.getDefaults(
        {
          activityType: ActivityType.TRANSFER_IN,
          accountId: "acc-123",
          date: new Date(),
          amount: "1000",
          currency: "USD",
          assetId: "CASH:USD",
          assetSymbol: "CASH",
        },
        [],
      ) as any;

      expect(defaults.transferMode).toBe("cash");
      expect(defaults.assetId).toBeNull();
    });

    it("includes unitPrice in payload for external securities transfer-in", () => {
      const formData = {
        isExternal: true,
        direction: "in" as const,
        accountId: "acc-123",
        activityDate: new Date(),
        transferMode: "securities" as const,
        assetId: "AAPL",
        quantity: 10,
        unitPrice: 150.5,
        currency: "USD",
      };

      const payload = ACTIVITY_FORM_CONFIG.TRANSFER.toPayload(formData as any);
      expect(payload).toHaveProperty("unitPrice", 150.5);
    });

    it("omits selected existing asset id when securities symbol is cleared", () => {
      const formData = {
        isExternal: false,
        fromAccountId: "acc-123",
        toAccountId: "acc-456",
        activityDate: new Date(),
        transferMode: "cash" as const,
        amount: 1000,
        assetId: null,
        existingAssetId: "asset-stale",
        currency: "USD",
      };

      const payload = ACTIVITY_FORM_CONFIG.TRANSFER.toPayload(formData as any);
      expect(payload).not.toHaveProperty("existingAssetId");
    });

    it("omits unitPrice when not provided", () => {
      const formData = {
        isExternal: false,
        fromAccountId: "acc-123",
        activityDate: new Date(),
        transferMode: "cash" as const,
        amount: 1000,
        currency: "USD",
      };

      const payload = ACTIVITY_FORM_CONFIG.TRANSFER.toPayload(formData as any) as any;
      expect(payload.unitPrice).toBeUndefined();
    });
  });

  describe("income toPayload", () => {
    it("clears stale asset-backed dividend values when switching back to cash", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        symbol: "AAPL",
        amount: 12,
        quantity: 2,
        unitPrice: 6,
        subtype: null,
        currency: "USD",
      } satisfies DividendFormValues;

      const payload = ACTIVITY_FORM_CONFIG.DIVIDEND.toPayload(formData);

      expect(payload).toMatchObject({ subtype: null, quantity: null, unitPrice: null });
    });

    it("keeps asset-backed values for dividend in kind", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        symbol: "AAPL",
        amount: 12,
        quantity: 2,
        unitPrice: 6,
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        currency: "USD",
      } satisfies DividendFormValues;

      const payload = ACTIVITY_FORM_CONFIG.DIVIDEND.toPayload(formData);

      expect(payload).toMatchObject({
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        quantity: 2,
        unitPrice: 6,
      });
    });

    it("clears stale staking values when switching interest back to cash", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        symbol: "ETH",
        amount: 12,
        quantity: 2,
        unitPrice: 6,
        subtype: null,
        currency: "USD",
      } satisfies InterestFormValues;

      const payload = ACTIVITY_FORM_CONFIG.INTEREST.toPayload(formData);

      expect(payload).toMatchObject({ subtype: null, quantity: null, unitPrice: null });
    });

    it("keeps asset-backed values for staking rewards", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        symbol: "ETH",
        amount: 12,
        quantity: 2,
        unitPrice: 6,
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        currency: "USD",
      } satisfies InterestFormValues;

      const payload = ACTIVITY_FORM_CONFIG.INTEREST.toPayload(formData);

      expect(payload).toMatchObject({
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        quantity: 2,
        unitPrice: 6,
      });
    });
  });

  describe("asset identity payloads", () => {
    it("omits stale selected asset id for option payloads", () => {
      const payload = ACTIVITY_FORM_CONFIG.BUY.toPayload({
        accountId: "acc-123",
        activityDate: new Date(),
        assetId: "AAPL260116C00250000",
        existingAssetId: "asset-aapl-stock",
        symbolInstrumentType: "OPTION",
        quantity: 1,
        unitPrice: 10,
        fee: 0,
        currency: "USD",
      } as any);

      expect(payload).not.toHaveProperty("existingAssetId");
    });
  });

  describe("newActivitySchema extended mobile edit types", () => {
    it("accepts credit activities", () => {
      const result = newActivitySchema.safeParse({
        accountId: "acc-123",
        activityType: "CREDIT",
        activityDate: new Date(),
        amount: 25,
        currency: "USD",
        exchangeMic: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts cash interest after asset-backed fields are cleared", () => {
      const result = newActivitySchema.safeParse({
        accountId: "acc-123",
        activityType: "INTEREST",
        activityDate: new Date(),
        subtype: null,
        amount: 25,
        quantity: undefined,
        unitPrice: undefined,
        currency: "USD",
        exchangeMic: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts adjustment activities with zero unit price", () => {
      const result = newActivitySchema.safeParse({
        accountId: "acc-123",
        activityType: "ADJUSTMENT",
        activityDate: new Date(),
        assetId: "AAPL",
        quantity: 1,
        unitPrice: 0,
        currency: "USD",
        assetMetadata: {
          name: null,
          kind: null,
          exchangeMic: null,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("BUY include cash deposit", () => {
    it("passes includeCashDeposit through buy payload when enabled", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        assetId: "AAPL",
        quantity: 10,
        unitPrice: 150.5,
        fee: 5,
        comment: "Test purchase",
        quoteMode: "MARKET",
        currency: "USD",
        includeCashDeposit: true,
      };

      const payload = ACTIVITY_FORM_CONFIG.BUY.toPayload(formData as any) as any;
      expect(payload.includeCashDeposit).toBe(true);
      expect(payload.metadata).toBeUndefined();
    });

    it("does not load includeCashDeposit from existing activity metadata", () => {
      const activity = {
        accountId: "acc-123",
        date: new Date("2024-01-15T00:00:00.000Z"),
        assetSymbol: "AAPL",
        quantity: "10",
        unitPrice: "150.5",
        amount: "1505",
        fee: "5",
        currency: "USD",
        metadata: { include_cash_deposit: true },
      };

      const defaults = ACTIVITY_FORM_CONFIG.BUY.getDefaults(activity as any, [
        { value: "acc-123", label: "Account", currency: "USD" },
      ]) as any;

      expect(defaults.includeCashDeposit).toBe(false);
    });

    it("does not load includeCashDeposit from string metadata", () => {
      const activity = {
        accountId: "acc-123",
        date: new Date("2024-01-15T00:00:00.000Z"),
        assetSymbol: "AAPL",
        quantity: "10",
        unitPrice: "150.5",
        amount: "1505",
        fee: "5",
        currency: "USD",
        metadata: { include_cash_deposit: "true" },
      };

      const defaults = ACTIVITY_FORM_CONFIG.BUY.getDefaults(activity as any, [
        { value: "acc-123", label: "Account", currency: "USD" },
      ]) as any;

      expect(defaults.includeCashDeposit).toBe(false);
    });

    it("removes legacy include_cash_deposit metadata and keeps other metadata", () => {
      const formData = {
        accountId: "acc-123",
        activityDate: new Date(),
        assetId: "AAPL",
        quantity: 10,
        unitPrice: 150.5,
        fee: 5,
        comment: "Test purchase",
        quoteMode: "MARKET",
        currency: "USD",
        includeCashDeposit: false,
        existingMetadata: { include_cash_deposit: true, custom_key: "keep" },
      };

      const payload = ACTIVITY_FORM_CONFIG.BUY.toPayload(formData as any) as any;
      expect(payload.metadata).toEqual({ custom_key: "keep" });
      expect(payload.metadata.include_cash_deposit).toBeUndefined();
    });
  });
});
