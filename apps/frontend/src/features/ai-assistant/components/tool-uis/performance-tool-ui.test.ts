import { describe, expect, it } from "vitest";

import {
  normalizePerformanceToolResult,
  performanceToolPeriodPnl,
} from "./performance-tool-semantics";

describe("performance AI tool semantics", () => {
  it("suppresses period P&L when backend marks basis partially unknown", () => {
    const parsed = normalizePerformanceToolResult(
      {
        scope: { id: "holdings", currency: "CAD" },
        period: { startDate: "2026-01-01", endDate: "2026-01-31" },
        mode: "valueReturn",
        basisStatus: "partialUnknown",
        returns: { valueReturn: null },
        attribution: {
          income: 0,
          realizedPnl: 0,
          unrealizedPnlChange: 125,
          fxEffect: 0,
          fees: 0,
          taxes: 0,
          residual: 0,
        },
        dataQuality: { status: "partial", warnings: [], notApplicableReasons: [] },
      },
      "CAD",
    );

    expect(parsed).not.toBeNull();
    expect(performanceToolPeriodPnl(parsed!)).toBeNull();
  });

  it("uses typed mixed-scope summary amount even when aggregate basis is partial", () => {
    const parsed = normalizePerformanceToolResult(
      {
        scope: { id: "mixed", currency: "CAD" },
        period: { startDate: "2026-01-01", endDate: "2026-01-31" },
        mode: "valueReturn",
        basisStatus: "partialUnknown",
        summary: {
          amount: 42,
          percent: null,
          amountStatus: "complete",
          percentStatus: "unavailable",
        },
        returns: { valueReturn: null },
        attribution: {
          income: 0,
          realizedPnl: 0,
          unrealizedPnlChange: 999,
          fxEffect: 0,
          fees: 0,
          taxes: 0,
          residual: 0,
        },
        dataQuality: { status: "partial", warnings: [], notApplicableReasons: [] },
      },
      "CAD",
    );

    expect(parsed).not.toBeNull();
    expect(performanceToolPeriodPnl(parsed!)).toBe(42);
  });

  it("accepts legacy headline payloads as summary compatibility", () => {
    const parsed = normalizePerformanceToolResult(
      {
        scope: { id: "mixed", currency: "CAD" },
        mode: "valueReturn",
        headline: {
          amount: 42,
          componentCoverage: { amountComplete: true, percentComplete: false, components: [] },
        },
      },
      "CAD",
    );

    expect(parsed).not.toBeNull();
    expect(performanceToolPeriodPnl(parsed!)).toBe(42);
  });
});
