import { render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";

import type { NetSummary } from "../types/cash-activity";
import { TransactionsFilterBar } from "./transactions-filter-bar";

const EMPTY: NetSummary = { byCurrency: [], converted: null };

function net(
  byCurrency: NetSummary["byCurrency"],
  converted?: NetSummary["converted"],
): NetSummary {
  return { byCurrency, converted: converted ?? null };
}

function renderBar(
  nets: { selectedNet?: NetSummary; filteredNet?: NetSummary | null },
  overrides: { isMobile?: boolean } = {},
) {
  return render(
    <TransactionsFilterBar
      searchInput=""
      onSearchInputChange={vi.fn()}
      statusFilter="all"
      onStatusFilterChange={vi.fn()}
      dateRange={undefined}
      onDateRangeChange={vi.fn()}
      selectedAccounts={new Set()}
      onAccountsChange={vi.fn()}
      selectedTypes={new Set()}
      onTypesChange={vi.fn()}
      selectedCategories={new Set()}
      onCategoriesChange={vi.fn()}
      selectedSubcategories={new Set()}
      onSubcategoriesChange={vi.fn()}
      selectedEvents={new Set()}
      selectedPayees={new Set()}
      onPayeesChange={vi.fn()}
      onEventsChange={vi.fn()}
      amountRange={{ min: null, max: null }}
      onAmountRangeChange={vi.fn()}
      accountOptions={[]}
      typeOptions={[]}
      categoryOptions={[]}
      subcategoryOptions={[]}
      eventOptions={[]}
      payeeOptions={[]}
      hasEvents={false}
      filtersActive={false}
      onClearAll={vi.fn()}
      visibleCount={2}
      totalCount={2}
      selectedNet={nets.selectedNet ?? EMPTY}
      filteredNet={nets.filteredNet ?? null}
      isRefreshing={false}
      isMobile={overrides.isMobile}
    />,
  );
}

describe("TransactionsFilterBar net readouts", () => {
  it("shows neither readout when there is nothing to report", () => {
    renderBar({});

    expect(screen.queryByText("Selected net")).not.toBeInTheDocument();
    expect(screen.queryByText("Filtered net")).not.toBeInTheDocument();
  });

  it("shows the selected net on its own", () => {
    renderBar({ selectedNet: net([{ currency: "USD", amount: -131.5 }]) });

    expect(screen.getByText("Selected net")).toBeInTheDocument();
    // The pill names the currency beside the figure, so the figure itself
    // carries no symbol.
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("131.50")).toBeInTheDocument();
    expect(screen.queryByText("Filtered net")).not.toBeInTheDocument();
  });

  it("shows both readouts at once", () => {
    renderBar({
      selectedNet: net([{ currency: "USD", amount: -20 }]),
      filteredNet: net([{ currency: "USD", amount: 500 }]),
    });

    expect(screen.getByText("Selected net")).toBeInTheDocument();
    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("20.00")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
  });

  it("lists one figure per currency rather than converting", () => {
    renderBar({
      filteredNet: net([
        { currency: "USD", amount: -60 },
        { currency: "EUR", amount: 60 },
      ]),
    });

    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
    expect(screen.getAllByText("60.00")).toHaveLength(2);
  });

  it("leads with the converted figure and keeps the breakdown beside it", () => {
    renderBar({
      filteredNet: net(
        [
          { currency: "USD", amount: -60 },
          { currency: "EUR", amount: -40 },
        ],
        { currency: "USD", amount: -104 },
      ),
    });

    // The converted headline carries its symbol; the pills stay unsymbolled, so
    // the "$" is what distinguishes it from the breakdown.
    expect(screen.getByText("$104.00")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
  });

  it("shows the breakdown alone when conversion was withheld", () => {
    renderBar({
      filteredNet: net([
        { currency: "USD", amount: -60 },
        { currency: "JPY", amount: -400 },
      ]),
    });

    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("JPY")).toBeInTheDocument();
    // No symbol anywhere means no converted headline was rendered.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  /** The readouts used to render only on desktop. */
  it("renders the readouts on mobile too", () => {
    renderBar({ filteredNet: net([{ currency: "USD", amount: 500 }]) }, { isMobile: true });

    expect(screen.getByText("Filtered net")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
  });
});
