import { calculatePerformanceSummary } from "@/adapters";
import { useHoldings } from "@/hooks/use-holdings";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { useSettingsContext } from "@/lib/settings-provider";
import type { PerformanceResult } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardContent } from "./dashboard-content";

const mocks = vi.hoisted(() => ({
  calculatePerformanceSummary: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  calculatePerformanceSummary: mocks.calculatePerformanceSummary,
}));

vi.mock("@/components/history-chart", () => ({
  HistoryChart: () => <div data-testid="history-chart" />,
}));

vi.mock("@/hooks", () => ({
  useHapticFeedback: () => ({ triggerHaptic: vi.fn() }),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: vi.fn(),
}));

vi.mock("@/hooks/use-valuation-history", () => ({
  useValuationHistory: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: vi.fn(),
}));

vi.mock("@/pages/dashboard/portfolio-update-trigger", () => ({
  PortfolioUpdateTrigger: ({ children, notices }: { children: ReactNode; notices?: string[] }) => (
    <div data-testid="portfolio-update-trigger">
      <div data-testid="portfolio-notices">{JSON.stringify(notices ?? [])}</div>
      {children}
    </div>
  ),
}));

vi.mock("./accounts-summary", () => ({
  AccountsSummary: () => <div data-testid="accounts-summary" />,
}));

vi.mock("./balance", () => ({
  default: ({ targetValue }: { targetValue: number }) => (
    <div data-testid="dashboard-balance">{`balance:${targetValue}`}</div>
  ),
}));

vi.mock("./goals", () => ({
  default: () => <div data-testid="saving-goals" />,
}));

vi.mock("./top-holdings", () => ({
  default: () => <div data-testid="top-holdings" />,
}));

vi.mock("@wealthfolio/ui", () => ({
  GainAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span data-testid="dashboard-gain-amount">{`gain-amount:${currency}:${value}`}</span>
  ),
  GainPercent: ({ value }: { value: number }) => (
    <span data-testid="dashboard-gain-percent">{`gain-percent:${value}`}</span>
  ),
  getInitialIntervalData: () => ({
    description: "year to date",
    range: { from: new Date(2026, 0, 1), to: new Date(2026, 5, 7) },
  }),
  IntervalSelector: () => <div data-testid="interval-selector" />,
  usePersistentState: () => ["YTD", vi.fn()],
}));

vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}));

const mockCalculatePerformanceSummary = vi.mocked(calculatePerformanceSummary);
const mockUseHoldings = vi.mocked(useHoldings);
const mockUseValuationHistory = vi.mocked(useValuationHistory);
const mockUseSettingsContext = vi.mocked(useSettingsContext);

function createPerformanceResult(
  overrides: Partial<PerformanceResult> = {},
): PerformanceResult {
  return {
    scope: { id: "portfolio:all", currency: "USD" },
    period: { startDate: "2026-01-01", endDate: "2026-06-07" },
    mode: "timeWeighted",
    returns: {
      twr: 0.1267,
      annualizedTwr: null,
      irr: null,
      annualizedIrr: null,
      valueReturn: null,
      annualizedValueReturn: null,
    },
    attribution: {
      contributions: 0,
      distributions: 0,
      income: 0,
      realizedPnl: 0,
      unrealizedPnlChange: 12.34,
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
      status: "ok",
      warnings: [],
      notApplicableReasons: [],
    },
    series: [],
    ...overrides,
  };
}

function renderDashboardContent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardContent />
    </QueryClientProvider>,
  );
}

describe("DashboardContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseSettingsContext.mockReturnValue({
      settings: { baseCurrency: "USD" },
    } as ReturnType<typeof useSettingsContext>);

    mockUseHoldings.mockReturnValue({
      holdings: [
        {
          holdingType: "security",
          marketValue: { base: 200 },
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useHoldings>);

    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [
        {
          valuationDate: "2026-01-01",
          totalValueBase: 100,
          netContributionBase: 0,
          baseCurrency: "USD",
          calculatedAt: "2026-06-07T00:00:00Z",
        },
        {
          valuationDate: "2026-06-07",
          totalValueBase: 200,
          netContributionBase: 50,
          baseCurrency: "USD",
          calculatedAt: "2026-06-07T00:00:00Z",
        },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useValuationHistory>);

    mockCalculatePerformanceSummary.mockResolvedValue(createPerformanceResult());
  });

  it("uses backend headline performance summary for the dashboard return", async () => {
    renderDashboardContent();

    await waitFor(() => {
      expect(mockCalculatePerformanceSummary).toHaveBeenCalledWith({
        itemType: "account",
        itemId: "portfolio:all",
        startDate: "2026-01-01",
        endDate: "2026-06-07",
        filter: { type: "all" },
        profile: "headline",
      });
    });

    expect(await screen.findByTestId("dashboard-gain-amount")).toHaveTextContent(
      "gain-amount:USD:12.34",
    );
    expect(screen.getByTestId("dashboard-gain-percent")).toHaveTextContent("gain-percent:0.1267");
  });

  it("does not pass backend performance warnings to dashboard header notices", async () => {
    mockCalculatePerformanceSummary.mockResolvedValue(
      createPerformanceResult({
        dataQuality: {
          status: "partial",
          warnings: ["Backend performance warning that belongs in Health Center."],
          notApplicableReasons: [],
        },
      }),
    );

    renderDashboardContent();

    expect(await screen.findByTestId("portfolio-notices")).toHaveTextContent("[]");
    expect(screen.queryByText(/backend performance warning/i)).not.toBeInTheDocument();
  });
});
