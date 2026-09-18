import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { CashActivity } from "../../types/cash-activity";
import { HeatmapCellSheet } from "./heatmap-cell-sheet";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [
      { id: "cash", name: "Checking", accountType: "CASH" },
      { id: "card", name: "Credit card", accountType: "CREDIT_CARD" },
    ],
  }),
}));

function activity(id: string, overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id,
    accountId: "cash",
    activityType: "WITHDRAWAL",
    activityDate: "2026-09-14T12:00:00Z",
    amount: "100",
    currency: "USD",
    notes: id,
    cashFlowBucket: "spending",
    assignments: [],
    splits: [],
    netAmount: -100,
    ...overrides,
  } as CashActivity;
}

function renderSheet(activities: CashActivity[]) {
  return render(
    <MemoryRouter>
      <FormattingProvider locale="en-US" uiLocale="en" timezone="UTC">
        <HeatmapCellSheet
          open
          onOpenChange={vi.fn()}
          activities={activities}
          dayLabel="Mon"
          hour={12}
          endHour={15}
          timezone="UTC"
          currency="USD"
        />
      </FormattingProvider>
    </MemoryRouter>,
  );
}

function weeklyHeader(note: string) {
  return screen.getByText(note).closest("section")!.querySelector("header")!;
}

describe("HeatmapCellSheet spending subtotals", () => {
  it("uses included split portions in each week's subtotal and preserves ledger amounts", () => {
    renderSheet([
      activity("Partial split", { visibleSpendingAmount: 40 }),
      activity("Earlier purchase", {
        activityDate: "2026-09-07T12:00:00Z",
        amount: "25",
        visibleSpendingAmount: 25,
      }),
    ]);

    expect(screen.getByText("Total").parentElement).toHaveTextContent("$65");
    expect(weeklyHeader("Partial split")).toHaveTextContent("1 · $40");
    expect(weeklyHeader("Earlier purchase")).toHaveTextContent("1 · $25");
    expect(screen.getByText("Partial split").closest("li")).toHaveTextContent("100");
  });

  it("matches the header's positive spending total while keeping non-spending rows visible", () => {
    renderSheet([
      activity("Purchase", { visibleSpendingAmount: 40 }),
      activity("Income", { activityType: "DEPOSIT", visibleSpendingAmount: 0 }),
      activity("Refund", { activityType: "CREDIT", visibleSpendingAmount: -20 }),
    ]);

    expect(screen.getByText("Total").parentElement).toHaveTextContent("$40");
    expect(weeklyHeader("Purchase")).toHaveTextContent("3 · $40");
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Refund")).toBeInTheDocument();
  });

  it("uses account-aware classification when older rows lack the filtered amount", () => {
    renderSheet([
      activity("Card interest", { accountId: "card", activityType: "INTEREST" }),
      activity("Card payment", { accountId: "card", activityType: "TRANSFER_IN" }),
      activity("Cash income", { activityType: "DEPOSIT" }),
    ]);

    expect(screen.getByText("Total").parentElement).toHaveTextContent("$100");
    expect(weeklyHeader("Card interest")).toHaveTextContent("3 · $100");
  });
});
