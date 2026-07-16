import {
  ACTIVITY_SUBTYPES,
  ActivityType,
  InstrumentType,
  METADATA_CONTRACT_MULTIPLIER,
} from "./constants";
import {
  isCashActivity,
  isCashTransfer,
  isIncomeActivity,
  isAssetBackedIncomeActivity,
  isAssetBackedIncomeSubtype,
  isAssetIdentityRequired,
  needsImportAssetResolution,
  calculateActivityValue,
  calculateActivityCashImpact,
  canonicalizeActivitySubtype,
  formatSplitRatio,
} from "./activity-utils";
import { ActivityDetails } from "./types";

describe("Activity Utilities", () => {
  describe("isCashActivity", () => {
    it("should identify cash activities correctly", () => {
      expect(isCashActivity(ActivityType.DEPOSIT)).toBe(true);
      expect(isCashActivity(ActivityType.WITHDRAWAL)).toBe(true);
      expect(isCashActivity(ActivityType.FEE)).toBe(true);
      expect(isCashActivity(ActivityType.INTEREST)).toBe(true);
      expect(isCashActivity(ActivityType.CREDIT)).toBe(true);

      expect(isCashActivity(ActivityType.BUY)).toBe(false);
      expect(isCashActivity(ActivityType.SELL)).toBe(false);
      expect(isCashActivity(ActivityType.SPLIT)).toBe(false);
    });
  });

  describe("isIncomeActivity", () => {
    it("should identify income activities correctly", () => {
      expect(isIncomeActivity(ActivityType.DIVIDEND)).toBe(true);
      expect(isIncomeActivity(ActivityType.INTEREST)).toBe(true);

      expect(isIncomeActivity(ActivityType.BUY)).toBe(false);
      expect(isIncomeActivity(ActivityType.SELL)).toBe(false);
      expect(isIncomeActivity(ActivityType.DEPOSIT)).toBe(false);
      expect(isIncomeActivity(ActivityType.WITHDRAWAL)).toBe(false);
    });
  });

  describe("isCashTransfer", () => {
    it("should identify cash transfers correctly", () => {
      expect(isCashTransfer(ActivityType.TRANSFER_IN, "CASH:USD")).toBe(true);
      expect(isCashTransfer(ActivityType.TRANSFER_OUT, "CASH:EUR")).toBe(true);
      expect(isCashTransfer(ActivityType.TRANSFER_IN, "CASH:USD")).toBe(true);

      expect(isCashTransfer(ActivityType.TRANSFER_IN, "AAPL")).toBe(false);
      expect(isCashTransfer(ActivityType.TRANSFER_IN, "CASH:XTSE")).toBe(false);
      expect(isCashTransfer(ActivityType.TRANSFER_IN, "CASH.TO")).toBe(false);
      expect(isCashTransfer(ActivityType.DEPOSIT, "CASH:USD")).toBe(false);
    });
  });

  describe("isAssetBackedIncomeActivity", () => {
    it("should identify asset-backed income when symbol/id is non-cash", () => {
      expect(isAssetBackedIncomeActivity(ActivityType.INTEREST, "SOL", "")).toBe(true);
      expect(isAssetBackedIncomeActivity(ActivityType.INTEREST, "", "CRYPTO:SOL:CAD")).toBe(true);
      expect(isAssetBackedIncomeActivity(ActivityType.DIVIDEND, "AAPL", "AAPL")).toBe(true);
    });

    it("should treat cash-like income identifiers as non-asset-backed", () => {
      expect(isAssetBackedIncomeActivity(ActivityType.INTEREST, "CASH", "")).toBe(false);
      expect(isAssetBackedIncomeActivity(ActivityType.INTEREST, "CASH:USD", "")).toBe(false);
      expect(isAssetBackedIncomeActivity(ActivityType.INTEREST, "$CASH-CAD", "")).toBe(false);
    });

    it("should return false for non-income types", () => {
      expect(isAssetBackedIncomeActivity(ActivityType.BUY, "AAPL", "AAPL")).toBe(false);
      expect(isAssetBackedIncomeActivity(ActivityType.DEPOSIT, "SOL", "SOL")).toBe(false);
    });
  });

  describe("isAssetBackedIncomeSubtype", () => {
    it("identifies calculation subtypes that carry asset quantities", () => {
      expect(
        isAssetBackedIncomeSubtype(ActivityType.INTEREST, ACTIVITY_SUBTYPES.STAKING_REWARD),
      ).toBe(true);
      expect(isAssetBackedIncomeSubtype(ActivityType.DIVIDEND, ACTIVITY_SUBTYPES.DRIP)).toBe(true);
      expect(
        isAssetBackedIncomeSubtype(ActivityType.DIVIDEND, ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND),
      ).toBe(true);
      expect(isAssetBackedIncomeSubtype(ActivityType.INTEREST, null)).toBe(false);
      expect(isAssetBackedIncomeSubtype(ActivityType.DIVIDEND, null)).toBe(false);
    });
  });

  describe("isAssetIdentityRequired", () => {
    it("requires assets for staking rewards even though interest is normally cash-like", () => {
      expect(isAssetIdentityRequired(ActivityType.INTEREST, ACTIVITY_SUBTYPES.STAKING_REWARD)).toBe(
        true,
      );
      expect(isAssetIdentityRequired(ActivityType.INTEREST, null)).toBe(false);
    });
  });

  describe("needsImportAssetResolution", () => {
    it("treats staking rewards as asset-backed imports", () => {
      expect(needsImportAssetResolution(ActivityType.INTEREST, "STAKING_REWARD")).toBe(true);
    });

    it("treats DRIP and dividend-in-kind as asset-backed imports", () => {
      expect(needsImportAssetResolution(ActivityType.DIVIDEND, "DRIP")).toBe(true);
      expect(needsImportAssetResolution(ActivityType.DIVIDEND, "DIVIDEND_IN_KIND")).toBe(true);
    });

    it("does not force cash-only interest imports through asset resolution", () => {
      expect(needsImportAssetResolution(ActivityType.INTEREST)).toBe(false);
    });
  });

  describe("canonicalizeActivitySubtype", () => {
    it("canonicalizes option position intent aliases by activity side", () => {
      expect(canonicalizeActivitySubtype(ActivityType.BUY, "BUY_TO_OPEN")).toBe(
        ACTIVITY_SUBTYPES.POSITION_OPEN,
      );
      expect(canonicalizeActivitySubtype(ActivityType.BUY, "BTC")).toBe(
        ACTIVITY_SUBTYPES.POSITION_CLOSE,
      );
      expect(canonicalizeActivitySubtype(ActivityType.SELL, "STO")).toBe(
        ACTIVITY_SUBTYPES.POSITION_OPEN,
      );
      expect(canonicalizeActivitySubtype(ActivityType.SELL, "SELL_TO_CLOSE")).toBe(
        ACTIVITY_SUBTYPES.POSITION_CLOSE,
      );
    });

    it("canonicalizes stock short aliases by activity side", () => {
      expect(canonicalizeActivitySubtype(ActivityType.SELL, "SELL_SHORT")).toBe(
        ACTIVITY_SUBTYPES.POSITION_OPEN,
      );
      expect(canonicalizeActivitySubtype(ActivityType.SELL, "SHORT_SELL")).toBe(
        ACTIVITY_SUBTYPES.POSITION_OPEN,
      );
      expect(canonicalizeActivitySubtype(ActivityType.BUY, "BUY_TO_COVER")).toBe(
        ACTIVITY_SUBTYPES.POSITION_CLOSE,
      );
      expect(canonicalizeActivitySubtype(ActivityType.BUY, "COVER_SHORT")).toBe(
        ACTIVITY_SUBTYPES.POSITION_CLOSE,
      );
    });
  });

  describe("calculateActivityValue", () => {
    const createActivity = (overrides: Partial<ActivityDetails> = {}): ActivityDetails => ({
      id: "1",
      activityType: ActivityType.BUY,
      date: new Date(),
      quantity: "10",
      unitPrice: "100",
      amount: "0",
      fee: "10",
      currency: "USD",
      needsReview: false,
      createdAt: new Date(),
      assetId: "AAPL",
      updatedAt: new Date(),
      accountId: "account1",
      accountName: "Test Account",
      accountCurrency: "USD",
      assetSymbol: "AAPL",
      ...overrides,
    });

    it("should calculate BUY activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.BUY,
        quantity: "10",
        unitPrice: "100",
        fee: "10",
        tax: "2",
      });

      // (10 * 100) + 10 + 2 = 1012
      expect(calculateActivityValue(activity)).toBe(1012);
    });

    it("should calculate SELL activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.SELL,
        quantity: "10",
        unitPrice: "100",
        fee: "10",
        tax: "2",
      });

      // (10 * 100) - 10 - 2 = 988
      expect(calculateActivityValue(activity)).toBe(988);
    });

    it("should apply the contract multiplier for option BUY activities", () => {
      const activity = createActivity({
        activityType: ActivityType.BUY,
        instrumentType: InstrumentType.OPTION,
        quantity: "2",
        unitPrice: "3",
        fee: "1",
      });

      // (2 * 3 * 100) + 1 = 601
      expect(calculateActivityValue(activity)).toBe(601);
    });

    it("should honor a non-default contract multiplier from metadata", () => {
      const activity = createActivity({
        activityType: ActivityType.SELL,
        instrumentType: InstrumentType.OPTION,
        quantity: "2",
        unitPrice: "5",
        fee: "0",
        metadata: { [METADATA_CONTRACT_MULTIPLIER]: 10 },
      });

      // (2 * 5 * 10) - 0 = 100
      expect(calculateActivityValue(activity)).toBe(100);
    });

    it("should calculate DEPOSIT activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.DEPOSIT,
        amount: "1000",
        fee: "10",
      });

      // 1000 - 10 = 990
      expect(calculateActivityValue(activity)).toBe(990);
    });

    it("should calculate INTEREST activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.INTEREST,
        amount: "500",
        fee: "5",
      });

      // 500 - 5 = 495
      expect(calculateActivityValue(activity)).toBe(495);
    });

    it("should calculate DIVIDEND activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.DIVIDEND,
        amount: "300",
        fee: "3",
      });

      // 300 - 3 = 297
      expect(calculateActivityValue(activity)).toBe(297);
    });

    it("should derive staking reward value from quantity and FMV when amount is empty", () => {
      const activity = createActivity({
        activityType: ActivityType.INTEREST,
        subtype: ACTIVITY_SUBTYPES.STAKING_REWARD,
        quantity: "0.01",
        unitPrice: "200",
        amount: "0",
        fee: "0",
        assetSymbol: "SOL",
        assetId: "SOL",
      });

      expect(calculateActivityValue(activity)).toBe(2);
    });

    it("should derive dividend in kind value from quantity and FMV when amount is empty", () => {
      const activity = createActivity({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DIVIDEND_IN_KIND,
        quantity: "2",
        unitPrice: "50",
        amount: "0",
        fee: "0",
        assetSymbol: "AAPL",
        assetId: "AAPL",
      });

      expect(calculateActivityValue(activity)).toBe(100);
    });

    it("should calculate WITHDRAWAL activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.WITHDRAWAL,
        amount: "1000",
        fee: "10",
      });

      // 1000 + 10 = 1010
      expect(calculateActivityValue(activity)).toBe(1010);
    });

    it("should include tax in WITHDRAWAL activity value", () => {
      const activity = createActivity({
        activityType: ActivityType.WITHDRAWAL,
        amount: "1000",
        fee: "10",
        tax: "5",
      });

      // 1000 + 10 + 5 = 1015
      expect(calculateActivityValue(activity)).toBe(1015);
    });

    it("should deduct tax from CREDIT activity value", () => {
      const activity = createActivity({
        activityType: ActivityType.CREDIT,
        amount: "100",
        fee: "2",
        tax: "10",
      });

      // 100 - 2 - 10 = 88
      expect(calculateActivityValue(activity)).toBe(88);
    });

    it("should calculate FEE activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.FEE,
        fee: "10",
      });

      expect(calculateActivityValue(activity)).toBe(10);
    });

    it("should prefer fee over amount for FEE activities", () => {
      const activity = createActivity({
        activityType: ActivityType.FEE,
        fee: "10",
        amount: "25",
      });

      expect(calculateActivityValue(activity)).toBe(10);
    });

    it("should fall back to amount for FEE activities when fee is zero", () => {
      const activity = createActivity({
        activityType: ActivityType.FEE,
        fee: "0",
        amount: "25",
      });

      expect(calculateActivityValue(activity)).toBe(25);
    });

    it("should use tax for TAX activities when only tax is set", () => {
      const activity = createActivity({
        activityType: ActivityType.TAX,
        tax: "15",
        fee: "0",
        amount: "0",
      });

      expect(calculateActivityValue(activity)).toBe(15);
      expect(calculateActivityCashImpact(activity)).toBe(-15);
    });

    it("should prefer tax over fee and amount for TAX activities", () => {
      const activity = createActivity({
        activityType: ActivityType.TAX,
        tax: "15",
        fee: "10",
        amount: "25",
      });

      expect(calculateActivityValue(activity)).toBe(15);
    });

    it("should fall back to fee, then amount for TAX activities", () => {
      const withFee = createActivity({
        activityType: ActivityType.TAX,
        tax: "0",
        fee: "10",
        amount: "25",
      });

      expect(calculateActivityValue(withFee)).toBe(10);

      const withAmount = createActivity({
        activityType: ActivityType.TAX,
        tax: "0",
        fee: "0",
        amount: "25",
      });

      expect(calculateActivityValue(withAmount)).toBe(25);
    });

    it("should calculate SPLIT activity value correctly", () => {
      const activity = createActivity({
        activityType: ActivityType.SPLIT,
        amount: "2", // 2:1 split
      });

      expect(calculateActivityValue(activity)).toBe(0);
    });

    it("should calculate cash transfer activity value correctly", () => {
      const transferIn = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        assetSymbol: "CASH:USD",
        amount: "1000",
        fee: "10",
      });

      expect(calculateActivityValue(transferIn)).toBe(990);

      const transferOut = createActivity({
        activityType: ActivityType.TRANSFER_OUT,
        assetSymbol: "CASH:USD",
        amount: "1000",
        fee: "10",
      });

      expect(calculateActivityValue(transferOut)).toBe(1010);
    });

    it("should include tax in cash transfer activity values", () => {
      const transferIn = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        assetSymbol: "CASH:USD",
        amount: "1000",
        fee: "10",
        tax: "5",
      });

      // 1000 - 10 - 5 = 985
      expect(calculateActivityValue(transferIn)).toBe(985);

      const transferOut = createActivity({
        activityType: ActivityType.TRANSFER_OUT,
        assetSymbol: "CASH:USD",
        amount: "1000",
        fee: "10",
        tax: "5",
      });

      // 1000 + 10 + 5 = 1015
      expect(calculateActivityValue(transferOut)).toBe(1015);
    });

    it("treats blank-asset transfers as cash and uses amount", () => {
      const transferIn = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        assetSymbol: "",
        assetId: "",
        quantity: "0",
        unitPrice: "0",
        amount: "500",
        fee: "0",
      });

      expect(calculateActivityValue(transferIn)).toBe(500);
    });

    it("treats broker cash placeholders ($CASH-EUR, CASH-GBP, CASH_GBP) as cash and uses amount", () => {
      const placeholders = ["$CASH-EUR", "CASH-GBP", "CASH_GBP", "$CASH_CAD"];
      for (const symbol of placeholders) {
        const transferIn = createActivity({
          activityType: ActivityType.TRANSFER_IN,
          assetSymbol: symbol,
          assetId: symbol,
          quantity: "0",
          unitPrice: "0",
          amount: "750",
          fee: "0",
        });
        expect(calculateActivityValue(transferIn)).toBe(750);
      }
    });

    it("preserves amount for securities transfers missing unitPrice (legacy imports)", () => {
      const transferIn = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        assetSymbol: "AAPL",
        assetId: "AAPL",
        quantity: "10",
        unitPrice: "0",
        amount: "1500",
        fee: "0",
      });

      expect(calculateActivityValue(transferIn)).toBe(1500);
    });

    it("should calculate securities transfer value from qty × unitPrice, not amount", () => {
      // Simulates a real DB row where `amount` is stale/corrupted but
      // quantity and unitPrice are correct. For securities transfers the
      // activity value must derive from qty × unitPrice, NOT the amount field.
      const transferIn = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        assetSymbol: "FWIA",
        quantity: "2078",
        unitPrice: "7.29",
        amount: "31478832.36", // bogus value that must be ignored
        fee: "0",
      });

      expect(calculateActivityValue(transferIn)).toBeCloseTo(15148.62, 2);

      const transferOut = createActivity({
        activityType: ActivityType.TRANSFER_OUT,
        assetSymbol: "AAPL",
        quantity: "10",
        unitPrice: "150",
        amount: "999999", // bogus
        fee: "5",
      });

      // Transfer out of securities: qty × price + fee (mirrors SELL-like handling for value display)
      expect(calculateActivityValue(transferOut)).toBe(1500);
    });

    it("calculates signed cash impact for trading and cash activities", () => {
      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.BUY,
            quantity: "10",
            unitPrice: "100",
            fee: "10",
            tax: "2",
          }),
        ),
      ).toBe(-1012);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.SELL,
            quantity: "10",
            unitPrice: "100",
            fee: "10",
            tax: "2",
          }),
        ),
      ).toBe(988);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.DEPOSIT,
            amount: "500",
            fee: "0",
          }),
        ),
      ).toBe(500);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.WITHDRAWAL,
            amount: "100",
            fee: "5",
            tax: "3",
          }),
        ),
      ).toBe(-108);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.CREDIT,
            amount: "100",
            fee: "2",
            tax: "10",
          }),
        ),
      ).toBe(88);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.DIVIDEND,
            amount: "100",
            fee: "1",
            tax: "15",
          }),
        ),
      ).toBe(84);
    });

    it("does not treat securities transfers or asset-backed income as cash impact", () => {
      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.TRANSFER_IN,
            assetSymbol: "AAPL",
            assetId: "AAPL",
            quantity: "10",
            unitPrice: "100",
            amount: "0",
            fee: "0",
          }),
        ),
      ).toBe(0);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.DIVIDEND,
            subtype: ACTIVITY_SUBTYPES.DRIP,
            quantity: "1",
            unitPrice: "100",
            amount: "100",
            fee: "0",
          }),
        ),
      ).toBe(0);

      expect(
        calculateActivityCashImpact(
          createActivity({
            activityType: ActivityType.DIVIDEND,
            subtype: null,
            assetSymbol: "AAPL",
            assetId: "AAPL",
            amount: "100",
            fee: "0",
          }),
        ),
      ).toBe(100);
    });
  });

  describe("formatSplitRatio", () => {
    it("formats forward splits as N:1", () => {
      expect(formatSplitRatio(2)).toBe("2:1");
      expect(formatSplitRatio(3)).toBe("3:1");
      expect(formatSplitRatio(10)).toBe("10:1");
    });

    it("formats reverse splits as 1:N", () => {
      expect(formatSplitRatio(0.5)).toBe("1:2");
      expect(formatSplitRatio(0.2)).toBe("1:5");
      expect(formatSplitRatio(0.1)).toBe("1:10");
    });

    it("formats non-unit numerator splits correctly", () => {
      expect(formatSplitRatio(0.3)).toBe("3:10");
      expect(formatSplitRatio(1.5)).toBe("3:2");
      expect(formatSplitRatio(2 / 3)).toBe("2:3");
    });

    it("formats 1:1 split (amount=1) as 1:1", () => {
      expect(formatSplitRatio(1)).toBe("1:1");
    });

    it("returns 0:1 for invalid amounts (zero or negative)", () => {
      expect(formatSplitRatio(0)).toBe("0:1");
      expect(formatSplitRatio(-1)).toBe("0:1");
    });
  });
});
