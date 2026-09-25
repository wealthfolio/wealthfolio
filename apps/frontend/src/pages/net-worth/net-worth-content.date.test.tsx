import type { useNetWorthHistory } from "@/hooks/use-alternative-assets";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  useNetWorth: vi.fn(),
  useNetWorthHistory: vi.fn<(options: Parameters<typeof useNetWorthHistory>[0]) => unknown>(),
}));
const settingsMock = vi.hoisted(() => ({ timezone: "Asia/Shanghai" }));
const intervalMocks = vi.hoisted(() => ({ period: "ALL" as "ALL" | "1M" | "YTD" }));

vi.mock("@/hooks/use-alternative-assets", () => queryMocks);
vi.mock("@/hooks/use-portfolio-allocations", () => ({
  usePortfolioAllocations: () => ({ allocations: undefined }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/lib/net-worth-category-label", () => ({
  getNetWorthCategoryLabel: (_t: unknown, _category: string, name: string) => name,
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { baseCurrency: "USD", timezone: settingsMock.timezone },
  }),
}));
vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/pages/dashboard/balance", () => ({ default: () => <div /> }));
vi.mock("@/pages/holdings/components/allocation-detail-sheet", () => ({
  AllocationDetailSheet: () => null,
}));
vi.mock("./components/breakdown-table", () => ({ BreakdownTable: () => <div /> }));
vi.mock("./components/category-detail-sheet", () => ({ CategoryDetailSheet: () => null }));
vi.mock("./components/momentum-card", () => ({ MomentumCard: () => null }));
vi.mock("./components/velocity-card", () => ({
  VelocityCard: ({ trailingYearMonthly }: { trailingYearMonthly?: number }) => (
    <span data-testid="trailing-average">{trailingYearMonthly ?? "none"}</span>
  ),
}));
vi.mock("./net-worth-chart", () => ({ NetWorthChart: () => null }));
vi.mock("@wealthfolio/ui", async () => {
  const { getInitialIntervalData } =
    await import("@wealthfolio/ui/components/financial/interval-selector");
  return {
    GainAmount: ({ value }: { value: number }) => <span data-testid="change-amount">{value}</span>,
    GainPercent: ({ value }: { value: number }) => (
      <span data-testid="change-percent">{value}</span>
    ),
    IntervalSelector: ({
      onIntervalSelect,
    }: {
      onIntervalSelect: (code: string, description: string, range: unknown) => void;
    }) => (
      <button
        onClick={() => {
          const interval = getInitialIntervalData("1M");
          onIntervalSelect(interval.code, interval.description, interval.range);
        }}
      >
        1M
      </button>
    ),
    getInitialIntervalData,
    useNumberFormatting: () => ({
      formatDecimal: (value: number) =>
        new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value),
    }),
    usePersistentState: () => useState(intervalMocks.period),
  };
});
vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: { TrendingUp: () => null },
}));
vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({ Skeleton: () => null }));
vi.mock("@wealthfolio/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { NetWorthContent } from "./net-worth-content";

function latestEnabledHistoryCall() {
  return queryMocks.useNetWorthHistory.mock.calls
    .filter(([options]) => options.enabled)
    .at(-1)?.[0];
}

function latestEnabledHistoryCalls(count: number) {
  return queryMocks.useNetWorthHistory.mock.calls
    .filter(([options]) => options.enabled)
    .slice(-count)
    .map(([options]) => options);
}

describe("NetWorthContent current-date queries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00+08:00"));
    settingsMock.timezone = "Asia/Shanghai";
    intervalMocks.period = "ALL";
    queryMocks.useNetWorth.mockReturnValue({
      data: {
        netWorth: "100",
        assets: { total: "100", breakdown: [] },
        liabilities: { total: "0", breakdown: [] },
        currency: "USD",
        staleAssets: [],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    queryMocks.useNetWorthHistory.mockReturnValue({ data: [], isLoading: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    ["Asia/Shanghai", "2026-09-15T16:30:00Z", "2026-09-16"],
    ["America/Los_Angeles", "2026-09-16T01:30:00Z", "2026-09-15"],
  ])("uses the configured %s day for the summary and chart", (timezone, instant, day) => {
    settingsMock.timezone = timezone;
    vi.setSystemTime(new Date(instant));
    render(<NetWorthContent />);
    expect(latestEnabledHistoryCall()?.endDate).toBe(day);
    expect(queryMocks.useNetWorth).toHaveBeenLastCalledWith({ date: day });
  });

  it("keeps the summary and rolling range aligned on the next render", () => {
    intervalMocks.period = "1M";
    vi.setSystemTime(new Date("2026-09-15T23:59:59+08:00"));
    const { rerender } = render(<NetWorthContent />);
    vi.setSystemTime(new Date("2026-09-16T00:00:01+08:00"));
    rerender(<NetWorthContent />);
    expect(queryMocks.useNetWorth).toHaveBeenLastCalledWith({ date: "2026-09-16" });
    expect(latestEnabledHistoryCalls(2)[0]).toMatchObject({
      startDate: "2026-08-16",
      endDate: "2026-09-16",
    });
    expect(latestEnabledHistoryCalls(2).map(({ endDate }) => endDate)).toEqual([
      "2026-09-16",
      "2026-09-16",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the configured day when a new period is selected", () => {
    queryMocks.useNetWorthHistory.mockReturnValue({
      data: [{ date: "2026-09-15", netWorth: "100" }],
      isLoading: false,
    });
    vi.setSystemTime(new Date("2026-09-15T16:30:00Z"));
    render(<NetWorthContent />);
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    expect(latestEnabledHistoryCalls(2)[0]).toMatchObject({
      startDate: "2026-08-16",
      endDate: "2026-09-16",
    });
  });

  it("clamps the rolling month at month end", () => {
    intervalMocks.period = "1M";
    vi.setSystemTime(new Date("2026-03-31T12:00:00+08:00"));
    render(<NetWorthContent />);
    expect(latestEnabledHistoryCalls(2)[0]).toMatchObject({
      startDate: "2026-02-28",
      endDate: "2026-03-31",
    });
  });

  it("updates the day when the configured timezone changes", () => {
    vi.setSystemTime(new Date("2026-09-15T16:30:00Z"));
    const { rerender } = render(<NetWorthContent />);
    settingsMock.timezone = "America/Los_Angeles";
    rerender(<NetWorthContent />);
    expect(queryMocks.useNetWorth).toHaveBeenLastCalledWith({ date: "2026-09-15" });
    expect(latestEnabledHistoryCall()?.endDate).toBe("2026-09-15");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { series: [-100000, -80000], amount: 20000, percent: null },
    { series: [-100, 100], amount: 200, percent: null },
    { series: [100, -100], amount: -200, percent: null },
    { series: [100, -50, 150], amount: 50, percent: 0.5 },
    { series: [0, 100], amount: 100, percent: null },
    { series: [100, 150], amount: 50, percent: 0.5 },
    { series: [100, 0], amount: -100, percent: -1 },
  ])(
    "displays the unchanged amount with the appropriate percentage for $series",
    ({ series, amount, percent }) => {
      queryMocks.useNetWorthHistory.mockReturnValue({
        data: series.map((netWorth, index) => ({
          date: `2026-09-${10 + index}`,
          netWorth: String(netWorth),
        })),
        isLoading: false,
      });
      render(<NetWorthContent />);
      expect(screen.getByTestId("change-amount")).toHaveTextContent(String(amount));
      if (percent === null) expect(screen.queryByTestId("change-percent")).not.toBeInTheDocument();
      else expect(screen.getByTestId("change-percent")).toHaveTextContent(String(percent));
    },
  );

  it.each([{ series: [100, 12330] }, { series: [100, -50, 12330] }])(
    "keeps the growth multiple for $series",
    ({ series }) => {
      queryMocks.useNetWorthHistory.mockReturnValue({
        data: series.map((netWorth, index) => ({
          date: `2026-09-${10 + index}`,
          netWorth: String(netWorth),
        })),
        isLoading: false,
      });
      render(<NetWorthContent />);
      expect(screen.getByText("123.3×")).toBeInTheDocument();
      expect(screen.getByTestId("change-amount")).toHaveTextContent("12230");
    },
  );

  it.each([
    { start: "2026-03-15", available: false },
    { start: "2025-09-15", available: true },
  ])(
    "only offers a 12-month comparison with a full year of history ($start)",
    ({ start, available }) => {
      intervalMocks.period = "1M";
      queryMocks.useNetWorthHistory.mockImplementation(({ startDate }) => ({
        data: [
          { date: startDate === "2026-08-15" ? startDate : start, netWorth: "100" },
          { date: "2026-09-15", netWorth: "110" },
        ],
        isLoading: false,
      }));
      render(<NetWorthContent />);
      if (available) expect(screen.getByTestId("trailing-average")).not.toHaveTextContent("none");
      else expect(screen.getByTestId("trailing-average")).toHaveTextContent("none");
    },
  );
});
