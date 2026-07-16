import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AccountValuation, PerformanceResult } from "@/lib/types";
import AccountMetrics from "./account-metrics";

vi.mock("@/pages/account/performance-grid", () => ({
  PerformanceGrid: () => <div>performance-grid</div>,
}));

vi.mock("./use-balance-update", () => ({
  useBalanceUpdate: () => ({
    updateBalance: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@wealthfolio/ui", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const Icon = () => <span>icon</span>;

  return {
    Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
    Card: Passthrough,
    CardContent: Passthrough,
    CardFooter: Passthrough,
    CardHeader: Passthrough,
    CardTitle: Passthrough,
    GainAmount: ({ value }: { value: number }) => <span>{`gain-amount:${value}`}</span>,
    GainPercent: ({ value }: { value: number }) => <span>{`gain-percent:${value}`}</span>,
    Icons: {
      Check: Icon,
      Close: Icon,
      Pencil: Icon,
      Spinner: Icon,
    },
    MoneyInput: () => <input aria-label="money" />,
    PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
      <span>{`value:${currency}:${value}`}</span>
    ),
    Separator: () => <span>|</span>,
    Skeleton: () => <div>loading</div>,
    Tooltip: Passthrough,
    TooltipContent: Passthrough,
    TooltipProvider: Passthrough,
    TooltipTrigger: Passthrough,
  };
});

function createValuation(overrides: Partial<AccountValuation> = {}): AccountValuation {
  return {
    id: "valuation-1",
    accountId: "account-1",
    valuationDate: "2026-06-01",
    accountCurrency: "USD",
    baseCurrency: "USD",
    fxRateToBase: 1,
    cashBalance: 0,
    investmentMarketValue: 0,
    totalValue: 0,
    costBasis: 0,
    bookBasis: 0,
    netContribution: 0,
    cashBalanceBase: 0,
    investmentMarketValueBase: 0,
    totalValueBase: 0,
    costBasisBase: 0,
    bookBasisBase: 0,
    netContributionBase: 0,
    externalInflowBase: 0,
    externalOutflowBase: 0,
    externalFlowSource: "UNKNOWN",
    performanceEligibleValueBase: 0,
    valueStatus: "complete",
    basisStatus: "notApplicable",
    calculatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function createPerformance(overrides: Partial<PerformanceResult> = {}): PerformanceResult {
  return {
    scope: { id: "account-1", currency: "USD" },
    period: { startDate: "2026-06-01", endDate: "2026-06-30" },
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
    dataQuality: { status: "partial", warnings: [], notApplicableReasons: [] },
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
    ...overrides,
  };
}

describe("AccountMetrics", () => {
  it("shows unrealized P&L after cost basis for transaction accounts with complete basis", () => {
    render(
      <AccountMetrics
        valuation={createValuation({
          investmentMarketValue: 125,
          costBasis: 100,
          cashBalance: 75,
          totalValue: 200,
          netContribution: 160,
          basisStatus: "complete",
        })}
        cashCurrencySplit={[
          { currency: "USD", valueBase: 50, valueLocal: 50, percentage: 66.67 },
          { currency: "CAD", valueBase: 25, valueLocal: 34, percentage: 33.33 },
        ]}
      />,
    );

    const costBasis = screen.getByText("Cost Basis");
    const allTimeReturn = screen.getByText("All-time Return");
    const unrealizedPnl = screen.getByText("Unrealized P&L");

    expect(costBasis).toBeInTheDocument();
    expect(allTimeReturn).toBeInTheDocument();
    expect(unrealizedPnl).toBeInTheDocument();
    expect(
      costBasis.compareDocumentPosition(allTimeReturn) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      allTimeReturn.compareDocumentPosition(unrealizedPnl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("gain-amount:40")).toBeInTheDocument();
    expect(screen.getByText("gain-amount:25")).toBeInTheDocument();
    expect(screen.queryByText("gain-percent:0.25")).not.toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("value:USD:50")).toBeInTheDocument();
    expect(screen.getByText("CAD")).toBeInTheDocument();
    expect(screen.getByText("value:CAD:34")).toBeInTheDocument();
  });

  it("does not show unrealized P&L when cost basis is incomplete", () => {
    render(
      <AccountMetrics
        valuation={createValuation({
          investmentMarketValue: 125,
          costBasis: 100,
          basisStatus: "partialUnknown",
        })}
      />,
    );

    expect(screen.getByText("Unrealized P&L")).toBeInTheDocument();
    expect(screen.getAllByText("N/A").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("gain-amount:25")).not.toBeInTheDocument();
    expect(screen.queryByText(/gain-percent:/)).not.toBeInTheDocument();
  });

  it("does not derive holdings P&L from raw valuation amounts", () => {
    render(
      <AccountMetrics
        valuation={createValuation({
          investmentMarketValue: 125,
          totalValue: 125,
          bookBasis: 0,
          costBasis: 0,
        })}
        isHoldingsMode
      />,
    );

    expect(screen.getByText("Book Value")).toBeInTheDocument();
    expect(screen.getByText("Period P&L")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.queryByText(/gain-amount:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/gain-percent:/)).not.toBeInTheDocument();
  });

  it("uses backend summary for holdings P&L and return", () => {
    render(
      <AccountMetrics
        valuation={createValuation({
          investmentMarketValue: 100,
          cashBalance: 50,
          totalValue: 150,
          bookBasis: 100,
          costBasis: 50,
          performanceEligibleValueBase: 150,
        })}
        performance={createPerformance({
          summary: {
            amount: 50,
            percent: 0.5,
            method: "valueReturn",
            basis: "bookBasis",
            quality: "ok",
            amountStatus: "complete",
            percentStatus: "complete",
            basisStatus: "complete",
            reasons: [],
          },
        })}
        isHoldingsMode
      />,
    );

    expect(screen.getAllByText("value:USD:100")).toHaveLength(2);
    expect(screen.getByText("Book Value")).toBeInTheDocument();
    expect(screen.getByText("Period P&L")).toBeInTheDocument();
    expect(screen.getByText("gain-amount:50")).toBeInTheDocument();
    expect(screen.getByText("gain-percent:0.5")).toBeInTheDocument();
  });

  it("shows unavailable holdings P&L when backend summary marks amount unavailable", () => {
    render(
      <AccountMetrics
        valuation={createValuation({
          investmentMarketValue: 100,
          cashBalance: 50,
          totalValue: 150,
          bookBasis: 100,
          costBasis: 100,
          performanceEligibleValueBase: 100,
        })}
        performance={createPerformance()}
        isHoldingsMode
      />,
    );

    expect(screen.getByText("Book Value")).toBeInTheDocument();
    expect(screen.getByText("Period P&L")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.queryByText(/gain-amount:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/gain-percent:/)).not.toBeInTheDocument();
  });
});
