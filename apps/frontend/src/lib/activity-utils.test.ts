import { ACTIVITY_SUBTYPES, ActivityStatus, ActivityType } from "./constants";
import {
  isCashActivity,
  isGarbageSymbol,
  isCashTransfer,
  isIncomeActivity,
  isAssetBackedIncomeActivity,
  isAssetBackedIncomeSubtype,
  isAssetIdentityRequired,
  needsImportAssetResolution,
  shouldResolveImportAsset,
  calculateActivityValue,
  calculateActivityCashImpact,
  canonicalizeActivitySubtype,
  formatSplitRatio,
  supportsPerformanceBoundary,
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

  describe("supportsPerformanceBoundary", () => {
    it.each([ActivityType.CREDIT, ActivityType.TRANSFER_IN, ActivityType.TRANSFER_OUT])(
      "allows an explicit boundary for %s",
      (activityType) => {
        expect(supportsPerformanceBoundary(activityType)).toBe(true);
      },
    );

    it.each([ActivityType.DEPOSIT, ActivityType.WITHDRAWAL, ActivityType.FEE, undefined])(
      "does not expose a boundary for %s",
      (activityType) => {
        expect(supportsPerformanceBoundary(activityType)).toBe(false);
      },
    );
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

    it("requires an asset only for asset-affecting adjustments", () => {
      expect(isAssetIdentityRequired(ActivityType.ADJUSTMENT, null)).toBe(false);
      expect(isAssetIdentityRequired(ActivityType.ADJUSTMENT, "CASH_SWEEP")).toBe(false);
      expect(
        isAssetIdentityRequired(ActivityType.ADJUSTMENT, ACTIVITY_SUBTYPES.OPTION_EXPIRY),
      ).toBe(true);
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

    it("resolves provider-supplied symbols for otherwise optional adjustments", () => {
      expect(needsImportAssetResolution(ActivityType.ADJUSTMENT, "CORPORATE_ACTION")).toBe(true);
      expect(isAssetIdentityRequired(ActivityType.ADJUSTMENT, "CORPORATE_ACTION")).toBe(false);
    });

    it("matches backend placeholder classification for optional-asset imports", () => {
      expect(isGarbageSymbol("----")).toBe(true);
      expect(isGarbageSymbol("$FOO")).toBe(true);
      expect(isGarbageSymbol("$CASH-USD")).toBe(false);
      expect(shouldResolveImportAsset(ActivityType.ADJUSTMENT, "CASH_SWEEP", "----")).toBe(false);
      expect(shouldResolveImportAsset(ActivityType.ADJUSTMENT, "CORPORATE_ACTION", "$FOO")).toBe(
        false,
      );
      expect(shouldResolveImportAsset(ActivityType.ADJUSTMENT, "CORPORATE_ACTION", "AAPL")).toBe(
        true,
      );
    });

    it("keeps malformed required-asset symbols in validation", () => {
      expect(shouldResolveImportAsset(ActivityType.BUY, undefined, "----")).toBe(true);
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

  describe("final cash display", () => {
    const createActivity = (overrides: Partial<ActivityDetails> = {}): ActivityDetails => ({
      id: "1",
      activityType: ActivityType.BUY,
      date: new Date(),
      quantity: "10",
      unitPrice: "100",
      amount: "100",
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

    it("uses the stored final amount and type-directed sign", () => {
      const activity = createActivity();
      expect(calculateActivityValue(activity)).toBe(100);
      expect(calculateActivityCashImpact(activity)).toBe(-100);
    });

    it("returns stored net amount as cash impact for dividend", () => {
      const activity = createActivity({
        activityType: ActivityType.DIVIDEND,
        amount: "85",
        fee: "1",
        tax: "15",
      });

      expect(calculateActivityValue(activity)).toBe(85);
      expect(calculateActivityCashImpact(activity)).toBe(85);
    });

    it("does not replace a missing final amount", () => {
      const activity = createActivity({ amount: null });

      expect(calculateActivityValue(activity)).toBe(0);
      expect(calculateActivityCashImpact(activity)).toBe(0);
    });

    it("scales the proven-negative-sell tolerance to the quote currency", () => {
      // Charges exceed gross by 2; the stored amount is off by 0.005. In a
      // two-decimal fiat that is within the minor unit, so the reversal is
      // proven and books negative...
      const sell = (currency: string) =>
        createActivity({
          activityType: ActivityType.SELL,
          quantity: "1",
          unitPrice: "1",
          fee: "3",
          amount: "2.005",
          currency,
        });
      expect(calculateActivityCashImpact(sell("USD"))).toBe(-2.005);
      // ...but in a crypto quote (8 fraction digits, mirroring the Rust
      // crypto arm) 0.005 is real money, so the reversal is NOT proven.
      expect(calculateActivityCashImpact(sell("SOL"))).toBe(2.005);
    });

    it("books only the fee for a security transfer", () => {
      const activity = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        quantity: "10",
        unitPrice: "150",
        amount: "999",
        fee: "3",
      });

      expect(calculateActivityValue(activity)).toBe(1500);
      expect(calculateActivityCashImpact(activity)).toBe(-3);
    });

    it("preserves the legacy amount fallback for an unpriced security transfer", () => {
      const activity = createActivity({
        activityType: ActivityType.TRANSFER_IN,
        unitPrice: null,
        amount: "80",
        fee: "0",
      });

      expect(calculateActivityValue(activity)).toBe(80);
      expect(calculateActivityCashImpact(activity)).toBe(0);
    });

    it("always displays splits as zero", () => {
      const activity = createActivity({
        activityType: ActivityType.SPLIT,
        amount: "2",
      });

      expect(calculateActivityValue(activity)).toBe(0);
      expect(calculateActivityCashImpact(activity)).toBe(0);
    });

    it("excludes non-posted activities", () => {
      const activity = createActivity({ status: ActivityStatus.DRAFT });

      expect(calculateActivityCashImpact(activity)).toBe(0);
    });

    it("treats credit-card interest as an outflow using page context", () => {
      const activity = createActivity({ activityType: ActivityType.INTEREST });

      expect(calculateActivityCashImpact(activity)).toBe(100);
      expect(calculateActivityCashImpact(activity, true)).toBe(-100);
    });

    it("reverses a sell only when complete economics prove charges exceeded proceeds", () => {
      const activity = createActivity({
        activityType: ActivityType.SELL,
        quantity: "1",
        unitPrice: "10",
        amount: "2",
        fee: "12",
      });

      expect(calculateActivityCashImpact(activity)).toBe(-2);
      expect(calculateActivityCashImpact({ ...activity, amount: "20" })).toBe(20);
    });

    it("uses the resolved asset multiplier when proving a negative option sell", () => {
      const activity = createActivity({
        activityType: ActivityType.SELL,
        instrumentType: "OPTION",
        assetContractMultiplier: "10",
        quantity: "1",
        unitPrice: "1",
        fee: "15",
        amount: "5",
      });

      expect(calculateActivityCashImpact(activity)).toBe(-5);
    });

    it("keeps the outflow direction within the shared epsilon", () => {
      // Same vector as negative_sell_direction_survives_sub_cent_rounding in
      // crates/core/src/portfolio/economic_events.rs — keep them identical.
      const activity = createActivity({
        activityType: ActivityType.SELL,
        quantity: "1",
        unitPrice: "10",
        amount: "2.000000005",
        fee: "12",
      });

      expect(calculateActivityCashImpact(activity)).toBe(-2.000000005);
    });

    it("treats recognized asset-income composites as cash neutral", () => {
      const activity = createActivity({
        activityType: ActivityType.DIVIDEND,
        subtype: ACTIVITY_SUBTYPES.DRIP,
      });

      expect(calculateActivityCashImpact(activity)).toBe(0);
    });

    it("treats an invalid stored amount as zero", () => {
      const activity = createActivity({ amount: "not-a-number" });

      expect(calculateActivityValue(activity)).toBe(0);
      expect(calculateActivityCashImpact(activity)).toBe(0);
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
