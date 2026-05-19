import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrivateAssetHistoricalSeries } from "@/adapters";
import { DashboardContent } from "./dashboard-content";

const mockUseNetWorth = vi.fn();
const mockUseNetWorthHistory = vi.fn();
const mockUseHoldings = vi.fn();
const mockBalance = vi.fn();

vi.mock("@/adapters", () => ({
  getPrivateAssetHistoricalSeries: vi.fn(),
}));

vi.mock("@/components/history-chart", () => ({
  HistoryChart: () => <div>history-chart</div>,
}));

vi.mock("@/hooks", () => ({
  useHapticFeedback: () => ({
    triggerHaptic: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: (...args: unknown[]) => mockUseHoldings(...args),
}));

vi.mock("@/hooks/use-latest-valuations", () => ({
  useLatestValuations: () => ({
    latestValuations: [],
  }),
}));

vi.mock("@/hooks/use-alternative-assets", () => ({
  useNetWorth: (...args: unknown[]) => mockUseNetWorth(...args),
  useNetWorthHistory: (...args: unknown[]) => mockUseNetWorthHistory(...args),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      baseCurrency: "USD",
      privateAssetsEnabled: true,
    },
  }),
}));

vi.mock("@/pages/dashboard/portfolio-update-trigger", () => ({
  PortfolioUpdateTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./accounts-summary", () => ({
  AccountsSummary: () => <div>accounts-summary</div>,
}));

vi.mock("./balance", () => ({
  default: (props: unknown) => {
    mockBalance(props);
    return <div>balance</div>;
  },
}));

vi.mock("./goals", () => ({
  default: () => <div>goals</div>,
}));

vi.mock("./top-holdings", () => ({
  default: () => <div>top-holdings</div>,
}));

vi.mock("@wealthfolio/ui", () => ({
  GainAmount: () => <div>gain-amount</div>,
  GainPercent: () => <div>gain-percent</div>,
  IntervalSelector: () => <div>interval-selector</div>,
  getInitialIntervalData: () => ({
    range: {
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-31T00:00:00Z"),
    },
    description: "3M",
  }),
  usePersistentState: <T,>(_key: string, defaultValue: T) => [defaultValue, vi.fn()] as const,
}));

vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <div>skeleton</div>,
}));

const mockGetPrivateAssetHistoricalSeries = vi.mocked(getPrivateAssetHistoricalSeries);

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardContent />
    </QueryClientProvider>,
  );
}

describe("DashboardContent", () => {
  beforeEach(() => {
    mockBalance.mockReset();
    mockUseHoldings.mockReset();
    mockGetPrivateAssetHistoricalSeries.mockReset();
    mockGetPrivateAssetHistoricalSeries.mockResolvedValue([]);

    mockUseHoldings.mockReturnValue({
      holdings: [
        {
          holdingType: "security",
          marketValue: {
            base: 1000,
          },
        },
      ],
      isLoading: false,
    });

    mockUseNetWorth.mockReturnValue({
      data: {
        assets: {
          total: "1500",
          breakdown: [
            { category: "investments", name: "Investments", value: "1000" },
            { category: "privateAssets", name: "Private Assets", value: "500" },
          ],
        },
        liabilities: {
          total: "0",
          breakdown: [],
        },
        netWorth: "1500",
        currency: "USD",
        staleAssets: [],
      },
      isLoading: false,
    });

    mockUseNetWorthHistory.mockReturnValue({
      data: [
        {
          date: "2024-01-01",
          portfolioValue: "1000",
          alternativeAssetsValue: "0",
          privateAssetsValue: "500",
          totalLiabilities: "0",
          totalAssets: "1500",
          netWorth: "1500",
          netContribution: "1000",
          currency: "USD",
        },
      ],
      isLoading: false,
    });
  });

  it("requests archived-inclusive private history for dashboard performance math", async () => {
    renderDashboard();

    await waitFor(() => {
      expect(mockGetPrivateAssetHistoricalSeries).toHaveBeenCalledWith(true);
    });
  });

  it("uses current public holdings plus private assets for the headline balance", async () => {
    mockUseNetWorth.mockReturnValue({
      data: {
        assets: {
          total: "270000",
          breakdown: [
            { category: "investments", name: "Investments", value: "0" },
            { category: "privateAssets", name: "Private Assets", value: "270000" },
          ],
        },
        liabilities: {
          total: "0",
          breakdown: [],
        },
        netWorth: "270000",
        currency: "USD",
        staleAssets: [],
      },
      isLoading: false,
    });

    mockUseNetWorthHistory.mockReturnValue({
      data: [
        {
          date: "2026-03-31",
          portfolioValue: "0",
          alternativeAssetsValue: "0",
          privateAssetsValue: "90000",
          totalLiabilities: "0",
          totalAssets: "90000",
          netWorth: "90000",
          netContribution: "0",
          currency: "USD",
        },
        {
          date: "2026-04-10",
          portfolioValue: "0",
          alternativeAssetsValue: "0",
          privateAssetsValue: "115000",
          totalLiabilities: "0",
          totalAssets: "115000",
          netWorth: "115000",
          netContribution: "0",
          currency: "USD",
        },
      ],
      isLoading: false,
    });

    renderDashboard();

    await waitFor(() => {
      expect(mockBalance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetValue: 271000,
        }),
      );
    });
  });
});
