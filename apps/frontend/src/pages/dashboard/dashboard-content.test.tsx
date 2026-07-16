import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useHoldings } from "@/hooks/use-holdings";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { useSettingsContext } from "@/lib/settings-provider";
import { DashboardContent } from "./dashboard-content";

const uiMocks = vi.hoisted(() => ({
  intervalCode: "3M" as "3M" | "ALL",
}));

vi.mock("@/adapters", () => ({
  calculatePerformanceSummary: vi.fn(),
}));

vi.mock("@/components/history-chart", () => ({
  HistoryChart: () => <div>history-chart</div>,
}));

vi.mock("@/hooks", () => ({
  useHapticFeedback: () => ({ triggerHaptic: vi.fn() }),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: vi.fn(),
}));

vi.mock("@/hooks/use-current-account-valuations", () => ({
  useCurrentValuation: vi.fn(),
}));

vi.mock("@/hooks/use-valuation-history", () => ({
  useValuationHistory: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: vi.fn(),
}));

vi.mock("@wealthfolio/ui", () => ({
  GainAmount: ({ value }: { value: number }) => <span>{`gain-amount:${value}`}</span>,
  GainPercent: ({ value }: { value: number }) => <span>{`gain-percent:${value}`}</span>,
  getInitialIntervalData: (code?: string) =>
    code === "ALL"
      ? {
          range: { from: new Date("1970-01-01T00:00:00Z"), to: new Date("2026-06-24T00:00:00Z") },
          description: "All Time",
        }
      : {
          range: { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-06-01T00:00:00Z") },
          description: "3M",
        },
  IntervalSelector: () => <div>interval-selector</div>,
  usePersistentState: () => [uiMocks.intervalCode, vi.fn()],
}));

vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}));

vi.mock("@/pages/dashboard/portfolio-update-trigger", () => ({
  PortfolioUpdateTrigger: ({
    children,
    lastCalculatedAt,
    notices,
  }: {
    children: ReactNode;
    lastCalculatedAt?: string;
    notices?: string[];
  }) => (
    <div>
      <div data-testid="portfolio-notices">{JSON.stringify(notices ?? [])}</div>
      <div data-testid="portfolio-as-of">{lastCalculatedAt ?? ""}</div>
      {children}
    </div>
  ),
}));

vi.mock("./accounts-summary", () => ({
  AccountsSummary: () => <div>accounts-summary</div>,
}));

vi.mock("./balance", () => ({
  default: ({ targetValue, isUnavailable }: { targetValue: number; isUnavailable?: boolean }) => (
    <div>{isUnavailable ? "balance:N/A" : `balance:${targetValue}`}</div>
  ),
}));

vi.mock("./goals", () => ({
  default: () => <div>saving-goals</div>,
}));

vi.mock("./top-holdings", () => ({
  default: () => <div>top-holdings</div>,
}));

const mockUseQuery = vi.mocked(useQuery);
const mockUseCurrentValuation = vi.mocked(useCurrentValuation);
const mockUseHoldings = vi.mocked(useHoldings);
const mockUseValuationHistory = vi.mocked(useValuationHistory);
const mockUseSettingsContext = vi.mocked(useSettingsContext);

describe("DashboardContent", () => {
  beforeEach(() => {
    uiMocks.intervalCode = "3M";
    vi.clearAllMocks();
  });

  function mockCurrentValuation(totalValueBase = 125) {
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: {
        summary: {
          scopeId: "all",
          baseCurrency: "USD",
          cashBalanceBase: 25,
          investmentMarketValueBase: totalValueBase - 25,
          totalValueBase,
          holdingsCount: 2,
          accountCount: 1,
          currencySplit: [],
          cashCurrencySplit: [],
          sourceDataAsOf: "2026-06-01T12:30:00Z",
          calculatedAt: "2026-06-01T13:00:00Z",
          warnings: [],
        },
        accounts: [],
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useCurrentValuation>);
  }

  it("does not pass backend performance warnings to dashboard header notices", () => {
    mockCurrentValuation(125);
    mockUseHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [
        {
          valuationDate: "2026-06-01",
          totalValueBase: 1000,
          netContributionBase: 900,
          baseCurrency: "USD",
          calculatedAt: "2026-06-01T12:00:00Z",
        },
      ],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as unknown as ReturnType<typeof useSettingsContext>);
    mockUseQuery.mockReturnValue({
      isLoading: false,
      data: {
        scope: { id: "portfolio:all", currency: "USD" },
        period: { startDate: "2026-03-01", endDate: "2026-06-01" },
        mode: "timeWeighted",
        returns: {
          twr: 0.1,
          annualizedTwr: null,
          irr: null,
          annualizedIrr: null,
          valueReturn: 0.1,
        },
        attribution: {
          contributions: 0,
          distributions: 0,
          income: 0,
          realizedPnl: 0,
          unrealizedPnlChange: 100,
          fxEffect: 0,
          fees: 0,
          taxes: 0,
          residual: 0,
        },
        risk: {
          volatility: null,
          maxDrawdown: null,
          peakDate: null,
          troughDate: null,
          recoveryDate: null,
          drawdownDurationDays: null,
        },
        dataQuality: {
          status: "partial",
          warnings: ["Backend performance warning that belongs in Health Center."],
          notApplicableReasons: [],
        },
        series: [],
      },
    } as unknown as ReturnType<typeof useQuery>);

    render(<DashboardContent />);

    expect(screen.getByTestId("portfolio-notices")).toHaveTextContent("[]");
    expect(screen.queryByText(/backend performance warning/i)).not.toBeInTheDocument();
  });

  it("uses scoped current valuation for the dashboard headline", () => {
    mockCurrentValuation(125);
    mockUseHoldings.mockReturnValue({
      holdings: [
        {
          holdingType: "security",
          marketValue: { base: 100, local: 100 },
        },
      ],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as unknown as ReturnType<typeof useSettingsContext>);
    mockUseQuery.mockReturnValue({
      isLoading: false,
      data: null,
    } as unknown as ReturnType<typeof useQuery>);

    render(<DashboardContent />);

    expect(screen.getByText("balance:125")).toBeInTheDocument();
    expect(screen.queryByText("balance:100")).not.toBeInTheDocument();
    expect(screen.getByTestId("portfolio-as-of")).toHaveTextContent("2026-06-01T12:30:00Z");
    expect(screen.getByTestId("portfolio-as-of")).not.toHaveTextContent("2026-06-01T13:00:00Z");
  });

  it("requests all-time valuation history without the 1970 sentinel range", () => {
    uiMocks.intervalCode = "ALL";
    mockCurrentValuation(125);
    mockUseHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as unknown as ReturnType<typeof useSettingsContext>);
    mockUseQuery.mockReturnValue({
      isLoading: false,
      data: null,
    } as unknown as ReturnType<typeof useQuery>);

    render(<DashboardContent />);

    expect(mockUseValuationHistory).toHaveBeenCalledWith(undefined);
  });

  it("starts dashboard performance queries while valuation history is loading", () => {
    mockCurrentValuation(125);
    mockUseHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [
        {
          valuationDate: "2026-06-01",
          totalValueBase: 1000,
          netContributionBase: 900,
          baseCurrency: "USD",
          calculatedAt: "2026-06-01T12:00:00Z",
        },
      ],
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as unknown as ReturnType<typeof useSettingsContext>);
    mockUseQuery.mockReturnValue({
      isLoading: false,
      data: null,
    } as unknown as ReturnType<typeof useQuery>);

    render(<DashboardContent />);

    const performanceQueryOptions = mockUseQuery.mock.calls[0]?.[0] as
      | { enabled?: boolean; placeholderData?: unknown }
      | undefined;
    expect(performanceQueryOptions?.enabled).toBe(true);
    expect(performanceQueryOptions?.placeholderData).toBe(keepPreviousData);
    expect(screen.getByText("accounts-summary")).toBeInTheDocument();
  });

  it("does not render a failed current valuation as zero", () => {
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: undefined,
      isLoading: false,
      error: new Error("current valuation failed"),
    } as unknown as ReturnType<typeof useCurrentValuation>);
    mockUseHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [
        {
          valuationDate: "2026-06-01",
          totalValueBase: 1000,
          netContributionBase: 900,
          baseCurrency: "USD",
          calculatedAt: "2026-06-01T12:00:00Z",
        },
      ],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as unknown as ReturnType<typeof useSettingsContext>);
    mockUseQuery.mockReturnValue({
      isLoading: false,
      data: null,
    } as unknown as ReturnType<typeof useQuery>);

    render(<DashboardContent />);

    expect(screen.getByText("balance:N/A")).toBeInTheDocument();
    expect(screen.queryByText("balance:0")).not.toBeInTheDocument();
    expect(screen.getByTestId("portfolio-as-of")).toHaveTextContent("");
  });
});
