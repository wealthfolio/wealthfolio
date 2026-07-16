import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricDisplayProps } from "@/components/metric-display";
import type { PerformanceResult } from "@/lib/types";

import { PerformanceGrid } from "./performance-grid";

vi.mock("@/components/metric-display", () => ({
  HOLDINGS_MODE_MAX_DRAWDOWN_INFO: "holdings max drawdown",
  HOLDINGS_MODE_VOLATILITY_INFO: "holdings volatility",
  IRR_RETURN_INFO: "irr",
  MAX_DRAWDOWN_INFO: "max drawdown",
  TIME_WEIGHTED_RETURN_INFO: "twr",
  VALUE_RETURN_INFO: "value return",
  VOLATILITY_INFO: "volatility",
  MetricDisplay: ({
    label,
    value,
    annualizedValue,
    secondaryValue,
    secondaryValueLabel,
    emptyReason,
    infoText,
  }: MetricDisplayProps) => (
    <div data-testid={`metric-${label}`}>
      {label}:{value ?? "N/A"}:{annualizedValue ?? ""}:{secondaryValueLabel ?? ""}=
      {secondaryValue ?? ""}:{emptyReason ?? ""}:{infoText}
    </div>
  ),
}));

function performanceResult(overrides: Partial<PerformanceResult> = {}): PerformanceResult {
  return {
    scope: { id: "account-1", currency: "USD" },
    period: { startDate: "2026-06-01", endDate: "2026-06-30" },
    mode: "valueReturn",
    returns: {
      twr: null,
      annualizedTwr: null,
      irr: null,
      annualizedIrr: null,
      valueReturn: 0.42,
      annualizedValueReturn: null,
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
    risk: { volatility: null, maxDrawdown: null },
    dataQuality: {
      status: "partial",
      warnings: [],
      notApplicableReasons: ["Book basis is incomplete."],
    },
    basisStatus: "partialUnknown",
    summary: {
      amount: null,
      percent: null,
      method: "valueReturn",
      basis: "bookBasis",
      quality: "partial",
      amountStatus: "unavailable",
      percentStatus: "unavailable",
      basisStatus: "partialUnknown",
      reasons: ["Book basis is incomplete."],
    },
    series: [],
    isHoldingsMode: true,
    ...overrides,
  };
}

describe("PerformanceGrid", () => {
  it("does not show raw holdings value return when summary percent is unavailable", () => {
    render(<PerformanceGrid performance={performanceResult()} isHoldingsMode />);

    expect(screen.getByTestId("metric-Value Return")).toHaveTextContent(
      "Value Return:N/A::=:Book basis is incomplete.",
    );
  });

  it("shows annualized TWR and IRR for periods of at least one year", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          mode: "timeWeighted",
          period: { startDate: "2020-04-14", endDate: "2026-06-22" },
          returns: {
            twr: 1.9751,
            annualizedTwr: 0.1927,
            irr: 2.7434,
            annualizedIrr: 0.2241,
            valueReturn: null,
            annualizedValueReturn: null,
          },
          summary: {
            amount: 75_000,
            percent: 1.9751,
            method: "timeWeighted",
            basis: "marketValue",
            quality: "ok",
            amountStatus: "complete",
            percentStatus: "complete",
            basisStatus: "complete",
            reasons: [],
          },
        })}
      />,
    );

    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent("Annualized TWR:0.1927");
    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent("Cumulative TWR=1.9751");
    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent(
      "Hover the value to see cumulative TWR.",
    );
    expect(screen.getByTestId("metric-Annualized IRR")).toHaveTextContent(
      "Annualized IRR:0.2241::Period IRR=2.7434",
    );
  });

  it("keeps period TWR and IRR as primary values for shorter periods without annualized rows", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          mode: "timeWeighted",
          period: { startDate: "2026-01-01", endDate: "2026-06-30" },
          returns: {
            twr: 0.12,
            annualizedTwr: 0.25,
            irr: 0.14,
            annualizedIrr: 0.29,
            valueReturn: null,
            annualizedValueReturn: null,
          },
        })}
      />,
    );

    expect(screen.getByTestId("metric-Time Weighted Return")).toHaveTextContent(
      "Time Weighted Return:0.12::=",
    );
    expect(screen.getByTestId("metric-IRR")).toHaveTextContent("IRR:0.14::=");
  });
});
