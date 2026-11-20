import type { PerformanceResult } from "@/lib/types";
import { describe, expect, it } from "vitest";

import {
  chosenReturnView,
  performancePeriodPnl,
  presentedReturn,
  returnMetricForView,
  shouldDisplayAnnualizedPerformanceReturn,
} from "./performance";

const baseResult = (): PerformanceResult => ({
  scope: { id: "account-1", currency: "CAD" },
  period: { startDate: "2026-01-01", endDate: "2026-01-31" },
  returns: {
    twr: { unavailableReason: "TWR unavailable." },
    moneyWeighted: { unavailableReason: "MWR unavailable." },
    returnOnCost: { unavailableReason: "Return on cost unavailable." },
  },
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
    basis: "bookBasis",
    quality: "partial",
    amountStatus: "unavailable",
    basisStatus: "complete",
    reasons: [],
  },
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

describe("chosenReturnView", () => {
  it("reads the setting, with legacy valueReturn as money-weighted", () => {
    expect(chosenReturnView("twr")).toBe("twr");
    expect(chosenReturnView(undefined)).toBe("twr");
    expect(chosenReturnView("irr")).toBe("moneyWeighted");
    expect(chosenReturnView("valueReturn")).toBe("moneyWeighted");
    expect(returnMetricForView("moneyWeighted")).toBe("irr");
    expect(returnMetricForView("twr")).toBe("twr");
  });
});

describe("presentedReturn", () => {
  it("shows the chosen method when it is available", () => {
    const result = baseResult();
    result.returns.twr = { period: 0.05, annualized: 0.04 };
    result.returns.moneyWeighted = { period: 0.08, annualized: 0.07 };

    expect(presentedReturn(result, "twr")).toEqual({
      view: "twr",
      value: 0.05,
      annualized: 0.04,
      isFallback: false,
      chosenUnavailableReason: null,
    });
    expect(presentedReturn(result, "moneyWeighted")?.value).toBe(0.08);
  });

  it("falls back to return on cost, labelled, when the chosen method is unavailable", () => {
    // A holdings account over its full history.
    const result = baseResult();
    result.returns.returnOnCost = { period: 0.12 };
    result.returns.moneyWeighted = { period: 0.3 };

    expect(presentedReturn(result, "twr")).toEqual({
      view: "returnOnCost",
      value: 0.12,
      annualized: null,
      isFallback: true,
      chosenUnavailableReason: "TWR unavailable.",
    });
  });

  it("falls back to the other method when there is no return on cost", () => {
    // A mixed portfolio under TWR.
    const result = baseResult();
    result.returns.moneyWeighted = { period: 0.09 };

    const presented = presentedReturn(result, "twr");
    expect(presented?.view).toBe("moneyWeighted");
    expect(presented?.isFallback).toBe(true);
  });

  it("returns null when no view has a value", () => {
    expect(presentedReturn(baseResult(), "moneyWeighted")).toBeNull();
    expect(presentedReturn(null, "twr")).toBeNull();
  });

  it("does not read summary or display reasons for the value", () => {
    const result = baseResult();
    result.summary!.amount = 25;
    result.summary!.amountStatus = "complete";
    result.dataQuality.notApplicableReasons = ["Display copy."];

    expect(presentedReturn(result, "twr")).toBeNull();
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
