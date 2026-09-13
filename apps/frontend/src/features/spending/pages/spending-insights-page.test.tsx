import { render, screen, fireEvent } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SpendingInsightsPage from "./spending-insights-page";

const { insightQuery, eventsQuery, cashQuery } = vi.hoisted(() => ({
  insightQuery: vi.fn(),
  eventsQuery: vi.fn(),
  cashQuery: vi.fn(),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD", timezone: "America/Toronto" } }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({}) }));
vi.mock("../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false }),
}));
vi.mock("../hooks/use-cash-activities", () => ({
  useCashActivities: (request: unknown) => {
    cashQuery(request);
    return { data: [] };
  },
}));
vi.mock("../hooks/use-spending-insight", () => ({
  useSpendingInsight: (request: unknown, enabled?: boolean) => {
    insightQuery(request, enabled);
    return {};
  },
}));
vi.mock("../hooks/use-spending-events", () => ({
  useEventSpendingSummaries: (request: unknown) => {
    eventsQuery(request);
    return { data: [] };
  },
}));
vi.mock("../components/reports/insights/where-i-am-stage", () => ({
  WhereIAmStage: () => <div>Where stage</div>,
}));
vi.mock("../components/reports/insights/what-changed-stage", () => ({
  WhatChangedStage: () => <div>Changed stage</div>,
}));
vi.mock("../components/reports/insights/when-where-stage", () => ({
  WhenWhereStage: () => <div>When stage</div>,
}));
vi.mock("../components/reports/category-transactions-sheet", () => ({
  CategoryTransactionsSheet: () => null,
}));
vi.mock("../components/reports/heatmap-cell-sheet", () => ({ HeatmapCellSheet: () => null }));

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}
function setup(stage = "where") {
  render(
    <MemoryRouter
      initialEntries={[
        `/spending/insights?stage=${stage}&period=MTD&spendingFrom=2025-03-08&spendingTo=2025-03-10`,
      ]}
    >
      <SpendingInsightsPage />
      <Location />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("custom range in Spending Insights", () => {
  it.each(["where", "changed", "when"])(
    "retains exact custom dates and calendar-day comparison in %s",
    (stage) => {
      setup(stage);
      expect(insightQuery).toHaveBeenCalledWith(
        {
          startDate: "2025-03-08T05:00:00.000Z",
          endDate: "2025-03-11T03:59:59.999Z",
          compare: "prior",
          compareStartDate: "2025-03-05T05:00:00.000Z",
          compareEndDate: "2025-03-08T04:59:59.999Z",
        },
        undefined,
      );
      expect(eventsQuery).toHaveBeenCalledWith({
        startDate: "2025-03-08T05:00:00.000Z",
        endDate: "2025-03-11T03:59:59.999Z",
      });
      expect(cashQuery).toHaveBeenCalledWith({
        startDate: "2025-03-08T05:00:00.000Z",
        endDate: "2025-03-11T03:59:59.999Z",
      });
      expect(screen.getByTestId("spending-selected-range")).toHaveTextContent(
        "Mar 8, 2025 – Mar 10, 2025",
      );
    },
  );

  it("preserves dates when switching stage and removes them when selecting a preset", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "What changed" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "spendingFrom=2025-03-08&spendingTo=2025-03-10",
    );
    await user.click(screen.getByRole("button", { name: "YTD" }));
    expect(screen.getByTestId("location")).toHaveTextContent("period=YTD");
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    expect(screen.queryByTestId("spending-selected-range")).not.toBeInTheDocument();
  });

  it("applies a new range and clears back to the preset", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2025-01-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2025-12-31" } });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "spendingFrom=2025-01-01&spendingTo=2025-12-31",
    );
    await user.click(screen.getByRole("button", { name: "Select dates" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("location")).not.toHaveTextContent("spendingFrom");
    expect(screen.getByTestId("location")).toHaveTextContent("period=MTD");
  });
});

it.each(["where", "changed", "when"])(
  "shows the selected historical month and year in %s",
  (stage) => {
    render(
      <MemoryRouter
        initialEntries={[`/spending/insights?stage=${stage}&period=MTD&spendingMonth=2025-02`]}
      >
        <SpendingInsightsPage />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("spending-selected-range")).toHaveTextContent("February 2025");
  },
);
