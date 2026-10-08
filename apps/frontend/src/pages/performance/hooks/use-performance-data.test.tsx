import type { PerformanceResult, TrackedItem } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@/test/render";
import type { ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { comparablePerformanceChartData } from "../performance-chart-series";
import { useCalculatePerformanceHistory } from "./use-performance-data";

const mocks = vi.hoisted(() => ({
  calculatePerformanceHistory: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  calculatePerformanceHistory: mocks.calculatePerformanceHistory,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function performanceResult(
  dates: string[],
  mode: PerformanceResult["mode"] = "timeWeighted",
): PerformanceResult {
  return {
    scope: { id: "scope", currency: "USD" },
    period: { startDate: dates[0] ?? null, endDate: dates.at(-1) ?? null },
    mode,
    returns: { twr: 0, annualizedTwr: 0, irr: null, annualizedIrr: null, valueReturn: 0 },
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
    risk: { volatility: 0, maxDrawdown: 0 },
    dataQuality: { status: "ok", warnings: [], notApplicableReasons: [] },
    series: dates.map((date) => ({ date, value: 0 })),
    isHoldingsMode: false,
    isMixedTrackingMode: false,
  };
}

/** Start dates the benchmark was requested with, in call order. */
function symbolStarts(): (string | undefined)[] {
  return (mocks.calculatePerformanceHistory.mock.calls as [string, string, string?][])
    .filter(([itemType]) => itemType === "symbol")
    .map(([, , startDate]) => startDate);
}

describe("useCalculatePerformanceHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calculatePerformanceHistory.mockResolvedValue({
      scope: { id: "portfolio:all", currency: "USD" },
      period: { startDate: "2026-03-09", endDate: "2026-03-10" },
      mode: "timeWeighted",
      returns: {
        twr: 0,
        annualizedTwr: 0,
        irr: null,
        annualizedIrr: null,
        valueReturn: 0,
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
      risk: {
        volatility: 0,
        maxDrawdown: 0,
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
      // Return data starts on a later date than requested start to ensure
      // the hook does not mutate the query start date.
      series: [{ date: "2026-03-09", value: 0 }],
      isHoldingsMode: false,
      isMixedTrackingMode: false,
    });
  });

  it("keeps using the user-selected start date for performance queries", async () => {
    const selectedFrom = new Date(2026, 2, 4);
    const selectedTo = new Date(2026, 2, 10);

    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [
            {
              id: "portfolio:all",
              type: "account",
              name: "Total Portfolio",
              accountScope: { type: "all" },
            },
          ],
          dateRange: {
            from: selectedFrom,
            to: selectedTo,
          },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    const calls = mocks.calculatePerformanceHistory.mock.calls as [
      string,
      string,
      string,
      string,
    ][];
    const starts = calls.map(([, , start]) => start);
    const ends = calls.map(([, , , end]) => end);

    expect(starts.every((s) => s === "2026-03-04")).toBe(true);
    expect(ends.every((e) => e === "2026-03-10")).toBe(true);
    expect(starts.some((s) => s === "2026-03-09")).toBe(false);
  });

  it("does not invent a scoped account filter when an account item has no accountScope", async () => {
    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "acc-1", type: "account", name: "Brokerage" }],
          dateRange: {
            from: new Date(2026, 2, 4),
            to: new Date(2026, 2, 10),
          },
          trackingMode: "TRANSACTIONS",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    expect(mocks.calculatePerformanceHistory).toHaveBeenCalledWith(
      "account",
      "acc-1",
      "2026-03-04",
      "2026-03-10",
      "TRANSACTIONS",
      undefined,
    );
  });

  it("allows all-time performance queries without explicit dates", async () => {
    const { result } = renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "portfolio:all", type: "account", name: "Total Portfolio" }],
          dateRange: undefined,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    expect(mocks.calculatePerformanceHistory).toHaveBeenCalledWith(
      "account",
      "portfolio:all",
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result.current.displayDateRange).toBe("All Time");
  });

  it("does not query when the date range is only partially populated", async () => {
    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "portfolio:all", type: "account", name: "Total Portfolio" }],
          dateRange: {
            from: new Date(2026, 2, 4),
            to: undefined,
          },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).not.toHaveBeenCalled();
    });
  });
});

describe("useCalculatePerformanceHistory all-time benchmarks", () => {
  const TODAY = "2026-10-08";
  // The backend gives a symbol requested without a start date its last year.
  const YEAR_AGO = "2025-10-08";
  const ONE_YEAR: DateRange = { from: new Date(2025, 9, 8), to: new Date(2026, 9, 8) };
  const ACCOUNT: TrackedItem = { id: "acc-1", type: "account", name: "Brokerage" };
  const ACCOUNT_2: TrackedItem = { id: "acc-2", type: "account", name: "Savings" };
  const BENCHMARK: TrackedItem = { id: "^GSPC", type: "symbol", name: "S&P 500" };
  const BENCHMARK_2: TrackedItem = { id: "^NDX", type: "symbol", name: "Nasdaq 100" };

  type Response = PerformanceResult | Error | Promise<PerformanceResult>;

  /** Answers each item id; a benchmark's answer may depend on the requested start. */
  function backend(responses: Record<string, Response | ((startDate?: string) => Response)>) {
    mocks.calculatePerformanceHistory.mockImplementation(
      (_itemType: string, itemId: string, startDate?: string) => {
        const entry = responses[itemId];
        const response = typeof entry === "function" ? entry(startDate) : entry;
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
    );
  }

  /** Calendar days from `from` to `to`, inclusive; `weekdays` keeps Monday to Friday. */
  function days(from: string, to: string, weekdays = false): string[] {
    const dates: string[] = [];
    const end = new Date(`${to}T00:00:00Z`);
    for (
      const day = new Date(`${from}T00:00:00Z`);
      day <= end;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const weekday = day.getUTCDay();
      if (!weekdays || (weekday !== 0 && weekday !== 6)) dates.push(day.toISOString().slice(0, 10));
    }
    return dates;
  }

  /** A benchmark quoted on weekdays since `inception`, served the way the backend does. */
  function benchmarkFrom(inception: string) {
    const quotes = days(inception, TODAY, true);
    return (startDate?: string) =>
      performanceResult(
        quotes.filter((date) => date >= (startDate ?? YEAR_AGO)),
        "symbolPriceBased",
      );
  }

  function deferred() {
    let resolve!: (result: PerformanceResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PerformanceResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  interface HookProps {
    selectedItems: TrackedItem[];
    dateRange: DateRange | undefined;
  }

  /** Renders the hook for ALL unless another range is given. */
  function renderHistory(selectedItems: TrackedItem[], dateRange?: DateRange) {
    const initialProps: HookProps = { selectedItems, dateRange };
    return renderHook((props: HookProps) => useCalculatePerformanceHistory(props), {
      initialProps,
      wrapper: createWrapper(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests the benchmark from the start of the account history", async () => {
    backend({
      "acc-1": performanceResult(["2023-03-28", "2023-03-29"]),
      "^GSPC": benchmarkFrom("2020-01-01"),
    });

    renderHistory([ACCOUNT, BENCHMARK]);

    await waitFor(() => expect(symbolStarts()).toHaveLength(1));
    expect(symbolStarts()).toEqual(["2023-03-28"]);
  });

  it("requests the benchmark from the earliest of several accounts", async () => {
    backend({
      "acc-1": performanceResult(["2022-01-03", "2022-01-04"]),
      "acc-2": performanceResult(["2015-06-01", "2015-06-02"]),
      "^GSPC": benchmarkFrom("2010-01-01"),
    });

    renderHistory([ACCOUNT, ACCOUNT_2, BENCHMARK]);

    await waitFor(() => expect(symbolStarts()).toHaveLength(1));
    expect(symbolStarts()).toEqual(["2015-06-01"]);
  });

  it("keeps the backend default when only benchmarks are selected", async () => {
    backend({ "^GSPC": benchmarkFrom("2020-01-01") });

    renderHistory([BENCHMARK]);

    await waitFor(() => expect(symbolStarts()).toHaveLength(1));
    expect(symbolStarts()).toEqual([undefined]);
  });

  it("reports loading while the benchmark waits for the accounts and while it loads", async () => {
    const account = deferred();
    const benchmark = deferred();
    backend({ "acc-1": account.promise, "^GSPC": benchmark.promise });

    // Every render's loading flag: one `false` before the benchmark arrives would
    // let the page flag the benchmark as not plotted.
    const loadingByRender: boolean[] = [];
    const { result } = renderHook(
      () => {
        const history = useCalculatePerformanceHistory({
          selectedItems: [ACCOUNT, BENCHMARK],
          dateRange: undefined,
        });
        loadingByRender.push(history.isLoading);
        return history;
      },
      { wrapper: createWrapper() },
    );

    expect(result.current.isLoading).toBe(true);
    expect(symbolStarts()).toEqual([]);

    account.resolve(performanceResult(["2023-03-28", "2023-03-29"]));
    await waitFor(() => expect(symbolStarts()).toEqual(["2023-03-28"]));
    expect(result.current.isLoading).toBe(true);

    benchmark.resolve(performanceResult(["2023-03-28", "2023-03-29"], "symbolPriceBased"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data.map((item) => item?.id)).toEqual(["acc-1", "^GSPC"]);
    expect(loadingByRender.indexOf(false)).toBe(loadingByRender.length - 1);
  });

  it("starts from the accounts that loaded when another account fails", async () => {
    backend({
      "acc-1": new Error("account failed"),
      "acc-2": performanceResult(["2020-02-03", "2020-02-04"]),
      "^GSPC": benchmarkFrom("2010-01-01"),
    });

    const { result } = renderHistory([ACCOUNT, ACCOUNT_2, BENCHMARK]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(symbolStarts()).toEqual(["2020-02-03"]);
    expect(result.current.errorMessages).toEqual(["account failed"]);
  });

  it.each([
    ["every account fails", new Error("account failed")],
    ["every account has an empty series", performanceResult([])],
  ])("keeps the backend default when %s", async (_case, accountResponse) => {
    backend({ "acc-1": accountResponse, "^GSPC": benchmarkFrom("2020-01-01") });

    const { result } = renderHistory([ACCOUNT, BENCHMARK]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(symbolStarts()).toEqual([undefined]);
  });

  it("returns results in the order the items were selected", async () => {
    backend({
      "acc-1": performanceResult(["2023-03-28", "2023-03-29"]),
      "acc-2": performanceResult(["2024-01-02", "2024-01-03"]),
      "^GSPC": benchmarkFrom("2020-01-01"),
      "^NDX": benchmarkFrom("2021-01-01"),
    });

    const { result } = renderHistory([BENCHMARK, ACCOUNT, BENCHMARK_2, ACCOUNT_2]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data.map((item) => item?.id)).toEqual([
      "^GSPC",
      "acc-1",
      "^NDX",
      "acc-2",
    ]);
    expect(result.current.queries.map((query) => query.data?.series[0]?.date)).toEqual([
      "2023-03-28",
      "2023-03-28",
      "2023-03-28",
      "2024-01-02",
    ]);
  });

  it("hides a benchmark's earlier result while it waits for an added account", async () => {
    const account = deferred();
    backend({ "acc-1": account.promise, "^GSPC": benchmarkFrom("2020-01-01") });

    const { result, rerender } = renderHistory([BENCHMARK]);
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ selectedItems: [ACCOUNT, BENCHMARK], dateRange: undefined });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toEqual([]);

    account.resolve(performanceResult(["2023-03-28", "2023-03-29"]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const benchmark = result.current.data.find((item) => item?.id === "^GSPC");
    expect(benchmark?.series[0]?.date).toBe("2023-03-28");
  });

  it("hides a benchmark's earlier error while it waits for an added account", async () => {
    const account = deferred();
    backend({ "acc-1": account.promise, "^GSPC": new Error("benchmark failed") });

    const { result, rerender } = renderHistory([BENCHMARK]);
    await waitFor(() => expect(result.current.hasErrors).toBe(true));

    rerender({ selectedItems: [ACCOUNT, BENCHMARK], dateRange: undefined });

    expect(result.current.hasErrors).toBe(false);
    expect(result.current.errorMessages).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it("waits for the account's all-time result when switching from 1Y to ALL", async () => {
    const allTimeAccount = deferred();
    backend({
      "acc-1": (startDate) =>
        startDate ? performanceResult(["2025-10-08", "2025-10-09"]) : allTimeAccount.promise,
      "^GSPC": benchmarkFrom("2020-01-01"),
    });
    const { result, rerender } = renderHistory([ACCOUNT, BENCHMARK], ONE_YEAR);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(symbolStarts()).toEqual(["2025-10-08"]);

    rerender({ selectedItems: [ACCOUNT, BENCHMARK], dateRange: undefined });
    await waitFor(() =>
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalledWith(
        "account",
        "acc-1",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    expect(result.current.isLoading).toBe(true);
    expect(symbolStarts()).toEqual(["2025-10-08"]);

    allTimeAccount.resolve(performanceResult(["2023-03-28", "2023-03-29"]));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(symbolStarts()).toEqual(["2025-10-08", "2023-03-28"]);
    const benchmark = result.current.data.find((item) => item?.id === "^GSPC");
    expect(benchmark?.series[0]?.date).toBe("2023-03-28");
  });

  it("reuses the cached all-time results when switching back to ALL", async () => {
    backend({
      "acc-1": performanceResult(["2023-03-28", "2023-03-29"]),
      "^GSPC": benchmarkFrom("2020-01-01"),
    });
    const { result, rerender } = renderHistory([ACCOUNT, BENCHMARK]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    rerender({ selectedItems: [ACCOUNT, BENCHMARK], dateRange: ONE_YEAR });
    await waitFor(() => expect(symbolStarts()).toContain("2025-10-08"));
    rerender({ selectedItems: [ACCOUNT, BENCHMARK], dateRange: undefined });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(symbolStarts()).toEqual(["2023-03-28", "2025-10-08"]);
    const benchmark = result.current.data.find((item) => item?.id === "^GSPC");
    expect(benchmark?.series[0]?.date).toBe("2023-03-28");
  });

  it.each([
    ["on a weekday", "2023-03-28", "2020-01-01", "2023-03-28"],
    ["on a weekend", "2023-04-01", "2020-01-01", "2023-04-03"],
    ["before the benchmark's first quote", "2023-03-28", "2024-01-02", "2024-01-02"],
  ])(
    "charts the account history against the benchmark when the account starts %s",
    async (_case, accountStart, benchmarkInception, chartStart) => {
      backend({
        "acc-1": performanceResult(days(accountStart, TODAY)),
        "^GSPC": benchmarkFrom(benchmarkInception),
      });

      const { result } = renderHistory([ACCOUNT, BENCHMARK]);
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const chart = comparablePerformanceChartData(result.current.data, "twr", ACCOUNT.id);
      expect(chart.map((series) => series.id)).toEqual(["acc-1", "^GSPC"]);
      expect(chart[0].returns[0].date).toBe(chartStart);
      expect(symbolStarts()).toEqual([accountStart]);
    },
  );
});
