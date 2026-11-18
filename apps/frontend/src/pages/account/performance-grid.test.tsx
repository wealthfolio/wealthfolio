import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enPerformance from "@/i18n/locales/en/performance.json";
import zhPerformance from "@/i18n/locales/zh/performance.json";
import enAccount from "@/i18n/locales/en/account.json";
import zhAccount from "@/i18n/locales/zh/account.json";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MetricDisplayProps } from "@/components/metric-display";
import type { PerformanceResult } from "@/lib/types";

import { PerformanceGrid } from "./performance-grid";

vi.mock("@/components/metric-display", () => ({
  HOLDINGS_MODE_MAX_DRAWDOWN_INFO_KEY: "performance:metric_info.holdings_max_drawdown",
  HOLDINGS_MODE_VOLATILITY_INFO_KEY: "performance:metric_info.holdings_volatility",
  MAX_DRAWDOWN_INFO_KEY: "performance:metric_info.max_drawdown",
  MONEY_WEIGHTED_RETURN_INFO_KEY: "performance:metric_info.money_weighted_return",
  RETURN_ON_COST_INFO_KEY: "performance:metric_info.return_on_cost",
  TIME_WEIGHTED_RETURN_INFO_KEY: "performance:metric_info.time_weighted_return",
  VOLATILITY_INFO_KEY: "performance:metric_info.volatility",
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
    // A holdings account over its full history whose book basis is incomplete:
    // the engine reports every return unavailable with its reason.
    returns: {
      twr: { unavailableReason: "TWR unavailable for holdings-only scopes." },
      moneyWeighted: { unavailableReason: "MWR unavailable for holdings-only scopes." },
      returnOnCost: { unavailableReason: "Book basis is incomplete." },
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
      basis: "bookBasis",
      quality: "partial",
      amountStatus: "unavailable",
      basisStatus: "partialUnknown",
      reasons: ["Book basis is incomplete."],
    },
    isHoldingsMode: true,
    ...overrides,
  };
}

describe("PerformanceGrid", () => {
  it("localizes holdings metric explanations without changing values or backend reasons", async () => {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "zh",
      fallbackLng: "en",
      resources: {
        en: { account: enAccount, performance: enPerformance },
        zh: { account: zhAccount, performance: zhPerformance },
      },
    });
    const performance = performanceResult({ risk: { volatility: 0.1, maxDrawdown: -0.2 } });
    const original = structuredClone(performance);
    render(
      <I18nextProvider i18n={i18n}>
        <PerformanceGrid performance={performance} isHoldingsMode isAllTime />
      </I18nextProvider>,
    );
    expect(screen.getByTestId(`metric-${zhAccount.volatility}`)).toHaveTextContent(
      zhPerformance.metric_info.holdings_volatility,
    );
    expect(screen.getByTestId(`metric-${zhAccount.volatility}`)).toHaveTextContent(":0.1:");
    expect(screen.getByTestId(`metric-${zhAccount.max_drawdown}`)).toHaveTextContent(
      zhPerformance.metric_info.holdings_max_drawdown,
    );
    expect(screen.getByTestId(`metric-${zhAccount.metric.return_on_cost}`)).toHaveTextContent(
      "Book basis is incomplete.",
    );
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByTestId(`metric-${enAccount.volatility}`)).toHaveTextContent(
      enPerformance.metric_info.holdings_volatility,
    );
    expect(performance).toEqual(original);
  });

  it("shows the engine's reason when a holdings return on cost is unavailable", () => {
    render(<PerformanceGrid performance={performanceResult()} isHoldingsMode isAllTime />);

    expect(screen.getByTestId("metric-Return on Investment (ROI)")).toHaveTextContent(
      "Return on Investment (ROI):N/A::=:Book basis is incomplete.",
    );
  });

  it("shows return on cost over a holdings account's full history", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          returns: {
            twr: { unavailableReason: "TWR unavailable for holdings-only scopes." },
            moneyWeighted: { unavailableReason: "MWR unavailable." },
            returnOnCost: { period: 0.42 },
          },
        })}
        isHoldingsMode
        isAllTime
      />,
    );

    expect(screen.getByTestId("metric-Return on Investment (ROI)")).toHaveTextContent(
      "Return on Investment (ROI):0.42",
    );
  });

  it("shows a holdings account's time-weighted return for a dated period", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          returns: {
            twr: { period: 0.07 },
            moneyWeighted: { period: 0.06 },
            returnOnCost: { unavailableReason: "Return on cost applies to full history." },
          },
        })}
        isHoldingsMode
      />,
    );

    expect(screen.getByTestId("metric-Time Weighted Return")).toHaveTextContent(
      "Time Weighted Return:0.07",
    );
  });

  it("keeps a dated holdings period on TWR, with its own reason, when TWR is unavailable", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          returns: {
            twr: {
              unavailableReason: "TWR unavailable because valuation coverage is unavailable.",
            },
            moneyWeighted: { unavailableReason: "MWR unavailable." },
            returnOnCost: {
              unavailableReason: "ROI applies to holdings accounts over their full history.",
            },
          },
        })}
        isHoldingsMode
      />,
    );

    expect(screen.getByTestId("metric-Time Weighted Return")).toHaveTextContent(
      "TWR unavailable because valuation coverage is unavailable.",
    );
  });

  it("follows the chosen method for a dated holdings period", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          returns: {
            twr: { period: 0.07 },
            moneyWeighted: { period: 0.06 },
            returnOnCost: { unavailableReason: "ROI applies to full history." },
          },
        })}
        isHoldingsMode
        returnView="moneyWeighted"
      />,
    );

    expect(screen.getByTestId("metric-Money-Weighted Return")).toHaveTextContent(
      "Money-Weighted Return:0.06",
    );
  });

  it("shows annualized TWR and IRR for periods of at least one year", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          period: { startDate: "2020-04-14", endDate: "2026-06-22" },
          returns: {
            twr: { period: 1.9751, annualized: 0.1927 },
            moneyWeighted: { period: 2.7434, annualized: 0.2241 },
            returnOnCost: {},
          },
          summary: {
            amount: 75_000,
            basis: "marketValue",
            quality: "ok",
            amountStatus: "complete",
            basisStatus: "complete",
            reasons: [],
          },
          isHoldingsMode: false,
        })}
      />,
    );

    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent("Annualized TWR:0.1927");
    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent("Cumulative TWR=1.9751");
    expect(screen.getByTestId("metric-Annualized TWR")).toHaveTextContent(
      "Hover the value to see cumulative TWR.",
    );
    expect(screen.getByTestId("metric-Annualized MWR")).toHaveTextContent(
      "Annualized MWR:0.2241::Cumulative MWR=2.7434",
    );
  });

  it("keeps period TWR and MWR as primary values for shorter periods without annualized rows", () => {
    render(
      <PerformanceGrid
        performance={performanceResult({
          period: { startDate: "2026-01-01", endDate: "2026-06-30" },
          returns: {
            twr: { period: 0.12, annualized: 0.25 },
            moneyWeighted: { period: 0.14, annualized: 0.29 },
            returnOnCost: {},
          },
          isHoldingsMode: false,
        })}
      />,
    );

    expect(screen.getByTestId("metric-Time Weighted Return")).toHaveTextContent(
      "Time Weighted Return:0.12::=",
    );
    expect(screen.getByTestId("metric-Money-Weighted Return")).toHaveTextContent(
      "Money-Weighted Return:0.14::=",
    );
  });
});
