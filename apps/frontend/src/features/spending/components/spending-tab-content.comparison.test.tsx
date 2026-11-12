import { render, screen, fireEvent } from "@/test/render";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "@/context/privacy-context";
import type { MonthlyReport } from "../types/report";
import SpendingTabContent from "./spending-tab-content";

const mocks = vi.hoisted(() => ({
  priorLoading: false,
  priorError: false,
  refetchPrior: vi.fn(),
  refetchCurrent: vi.fn(),
  reportQuery: vi.fn(),
  chartRows: [] as Record<string, unknown>[],
}));

function report(year: number, outflow: number): MonthlyReport {
  return {
    baseCurrency: "USD",
    current: { income: 0, outflow, saved: 0, net: -outflow, count: 1 },
    prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
    byDay: [{ date: `${year}-01-05`, income: 0, outflow }],
    byDayByCategory: [],
    spendingBreakdown: [],
    incomeBreakdown: [],
    savingsBreakdown: [],
  };
}

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD", timezone: "UTC" } }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: { categories: [] } }) }));
vi.mock("../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ accountIds: ["cash"], excludedCategoryIds: [], isLoading: false }),
}));
vi.mock("../hooks/use-spending-report", () => ({
  useSpendingReport: (request: { startDate: string; endDate: string }) => {
    mocks.reportQuery(request);
    return request.startDate.startsWith("2024")
      ? {
          data: mocks.priorLoading || mocks.priorError ? undefined : report(2024, 20),
          isLoading: mocks.priorLoading,
          isError: mocks.priorError,
          refetch: mocks.refetchPrior,
        }
      : { data: report(2025, 80), isLoading: false, isError: false, refetch: mocks.refetchCurrent };
  },
}));
vi.mock("../hooks/use-budget", () => ({ useBudget: () => ({ data: undefined }) }));
vi.mock("../hooks/use-cash-activities", () => ({
  useCashActivities: () => ({ data: [] }),
  useUncategorizedCount: () => ({ data: 0 }),
}));
vi.mock("../hooks/use-categorization-rules", () => ({
  useCategorizationRules: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/pages/dashboard/balance", () => ({ default: () => null }));
vi.mock("./budget-line-chart-card", () => ({ BudgetLineChartCard: () => null }));
vi.mock("./cash-flow-strip", () => ({ CashFlowStrip: () => null }));
vi.mock("./events-card", () => ({ EventsCard: () => null }));
vi.mock("./recent-activity-card", () => ({ RecentActivityCard: () => null }));
vi.mock("./spending-delta-line", () => ({ SpendingDeltaLine: () => null }));
vi.mock("./spending-period-toggle", () => ({ SpendingPeriodSelector: () => null }));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data, children }: { data: Record<string, unknown>[]; children: ReactNode }) => {
    mocks.chartRows = data;
    return <div>{children}</div>;
  },
  Tooltip: ({ content }: { content: (props: unknown) => ReactNode }) => (
    <div data-testid="comparison-tooltip">
      {content({ active: true, payload: [{ payload: mocks.chartRows[0] }] })}
    </div>
  ),
  Bar: ({ dataKey, onClick }: { dataKey: string; onClick: (row: unknown) => void }) => (
    <button onClick={() => onClick({ payload: mocks.chartRows[0] })}>{dataKey}</button>
  ),
  Cell: () => null,
  ReferenceLine: () => null,
  Treemap: () => null,
  XAxis: () => null,
}));

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function setup(compareEnabled = true) {
  return render(
    <MemoryRouter initialEntries={["/dashboard?tab=spending"]}>
      <PrivacyProvider>
        <SpendingTabContent compareEnabled={compareEnabled} />
        <Location />
      </PrivacyProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("dashboard-period", JSON.stringify({ kind: "year", year: 2025 }));
  mocks.priorLoading = false;
  mocks.priorError = false;
  mocks.refetchPrior.mockClear();
  mocks.refetchCurrent.mockClear();
  mocks.reportQuery.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

it("shows both amounts and their difference, and opens the prior bucket's exact dates", () => {
  setup();
  const tooltip = screen.getByTestId("comparison-tooltip");
  expect(tooltip).toHaveTextContent("$80.00");
  expect(tooltip).toHaveTextContent("$20.00");
  expect(tooltip).toHaveTextContent("Difference");
  expect(tooltip).toHaveTextContent("$60.00");
  fireEvent.click(screen.getByRole("button", { name: "priorValue" }));
  expect(screen.getByTestId("location")).toHaveTextContent(
    "/activities?tab=spending&from=2024-01-01&to=2024-01-31",
  );
});

it("masks selected, prior and difference amounts when balances are hidden", () => {
  localStorage.setItem("privacy-settings", "true");
  setup();
  const tooltip = screen.getByTestId("comparison-tooltip");
  expect(tooltip).not.toHaveTextContent("$80.00");
  expect(tooltip).not.toHaveTextContent("$20.00");
  expect(tooltip).not.toHaveTextContent("$60.00");
  expect(tooltip.textContent?.match(/••••/g)).toHaveLength(3);
});

it("waits for the prior report and retries its failure without retrying the current report", () => {
  mocks.priorLoading = true;
  const view = setup();
  expect(screen.queryByRole("button", { name: "value" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "priorValue" })).not.toBeInTheDocument();
  mocks.priorLoading = false;
  mocks.priorError = true;
  view.rerender(
    <MemoryRouter>
      <PrivacyProvider>
        <SpendingTabContent compareEnabled />
      </PrivacyProvider>
    </MemoryRouter>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load spending data.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.refetchPrior).toHaveBeenCalledOnce();
  expect(mocks.refetchCurrent).not.toHaveBeenCalled();
});

it("keeps the selected report visible when comparison is off and the prior report failed", () => {
  mocks.priorError = true;
  setup(false);
  expect(screen.getByRole("button", { name: "value" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "priorValue" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});

it("preserves the prior calendar block for an Insights window shared with Spending", () => {
  localStorage.setItem(
    "dashboard-period",
    JSON.stringify({
      kind: "range",
      from: "2026-04-01",
      to: "2026-06-30",
      presetWindow: {
        preset: { kind: "spending", code: "3M" },
        anchor: "2026-09-15",
        offset: -1,
        alignment: "calendar",
      },
    }),
  );
  setup();
  expect(mocks.reportQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-03-31T23:59:59.999Z",
    }),
  );
});
