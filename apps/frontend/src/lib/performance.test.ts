import type { PerformanceResult } from "@/lib/types";
import { describe, expect, it } from "vitest";

import {
  performancePeriodPnl,
  performanceSummaryReturn,
  shouldDisplayAnnualizedPerformanceReturn,
  simpleReturnFromNetContribution,
} from "./performance";

const baseResult = (): PerformanceResult => ({
  scope: { id: "account-1", currency: "CAD" },
  period: { startDate: "2026-01-01", endDate: "2026-01-31" },
  mode: "valueReturn",
  returns: { valueReturn: null },
  attribution: {
    contributions: 0,
    distributions: 0,
    income: 0,
    realizedPnl: 0,
    unrealizedPnlChange: 0,
    fxEffect: 0,
    fees: 0,
    taxes: 0,
    residual: 0,
  },
  risk: {},
  dataQuality: {
    status: "partial",
    warnings: [],
    notApplicableReasons: [],
  },
  basisStatus: "complete",
  summary: {
    amount: null,
    percent: null,
    method: "valueReturn",
    basis: "bookBasis",
    quality: "partial",
    amountStatus: "unavailable",
    percentStatus: "unavailable",
    basisStatus: "complete",
    reasons: [],
  },
  series: [],
});

describe("performancePeriodPnl", () => {
  it("returns null when backend marks amount unavailable", () => {
    const result = baseResult();
    result.summary!.amount = 25;
    result.summary!.amountStatus = "unavailable";

    expect(performancePeriodPnl(result)).toBeNull();
  });

  it("does not fall back to attribution when summary amount is unavailable", () => {
    const result = baseResult();
    result.attribution.income = 10;
    result.attribution.residual = 99;

    expect(performancePeriodPnl(result)).toBeNull();
  });

  it("uses backend typed summary amount when complete", () => {
    const result = baseResult();
    result.attribution.income = 10;
    result.summary!.amount = 25;
    result.summary!.amountStatus = "complete";

    expect(performancePeriodPnl(result)).toBe(25);
  });

  it("does not infer availability from display reasons", () => {
    const result = baseResult();
    result.attribution.income = 10;
    result.dataQuality.notApplicableReasons = ["Display copy says basis is incomplete."];

    expect(performancePeriodPnl(result)).toBeNull();
  });

  it("keeps typed mixed-scope summary amount when aggregate basis is partial", () => {
    const result = baseResult();
    result.basisStatus = "partialUnknown";
    result.summary!.amount = 25;
    result.summary!.amountStatus = "complete";
    result.summary!.basis = "mixed";
    result.summary!.basisStatus = "partialUnknown";

    expect(performancePeriodPnl(result)).toBe(25);
  });
});

describe("performanceSummaryReturn", () => {
  it("uses backend summary percent when complete", () => {
    const result = baseResult();
    result.mode = "valueReturn";
    result.returns = {
      twr: 0.99,
      annualizedTwr: null,
      irr: null,
      annualizedIrr: null,
      valueReturn: 0.12,
      annualizedValueReturn: null,
    };
    result.summary!.percent = 0.08;
    result.summary!.percentStatus = "complete";

    expect(performanceSummaryReturn(result)).toBe(0.08);
  });

  it("does not fall back to returns when summary percent is unavailable", () => {
    const result = baseResult();
    result.returns = { valueReturn: 0.12, twr: 0.99 };
    result.summary!.percent = 0.08;
    result.summary!.percentStatus = "unavailable";

    expect(performanceSummaryReturn(result)).toBeNull();
  });

  it("does not infer summary percent availability from display reasons", () => {
    const result = baseResult();
    result.returns = { valueReturn: 0.12 };
    result.dataQuality.notApplicableReasons = ["Display copy says summary percent is unavailable."];
    result.summary!.percent = null;
    result.summary!.percentStatus = "unavailable";
    result.summary!.reasons = ["Display copy says basis is incomplete."];

    expect(performanceSummaryReturn(result)).toBeNull();
  });

  it("uses holdings summary percent only when backend marks it complete", () => {
    const result = baseResult();
    result.isHoldingsMode = true;
    result.basisStatus = "partialUnknown";
    result.returns = { valueReturn: 0.12 };
    result.summary!.percent = 0.12;
    result.summary!.percentStatus = "complete";
    result.summary!.basisStatus = "partialUnknown";

    expect(performanceSummaryReturn(result)).toBe(0.12);
  });
});

describe("simpleReturnFromNetContribution", () => {
  it("divides return amount by net contribution", () => {
    expect(simpleReturnFromNetContribution(75_000, 188_000)).toBeCloseTo(0.3989, 4);
  });

  it("returns null when net contribution is not positive", () => {
    expect(simpleReturnFromNetContribution(75_000, 0)).toBeNull();
    expect(simpleReturnFromNetContribution(75_000, -100)).toBeNull();
  });
});

describe("shouldDisplayAnnualizedPerformanceReturn", () => {
  it("uses annualized display for periods of at least one year", () => {
    const result = baseResult();
    result.period = { startDate: "2025-06-22", endDate: "2026-06-22" };

    expect(shouldDisplayAnnualizedPerformanceReturn(result)).toBe(true);
  });

  it("keeps period returns for periods under one year", () => {
    const result = baseResult();
    result.period = { startDate: "2026-01-01", endDate: "2026-06-30" };

    expect(shouldDisplayAnnualizedPerformanceReturn(result)).toBe(false);
  });
});
