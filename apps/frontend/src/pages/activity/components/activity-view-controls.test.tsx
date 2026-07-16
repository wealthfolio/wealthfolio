import type { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityViewControls } from "./activity-view-controls";

vi.mock("@/features/spending/components/date-range-filter", () => ({
  DateRangeFilter: () => <div data-testid="date-range-filter" />,
}));

vi.mock("@wealthfolio/ui", () => ({
  AnimatedToggleGroup: () => <div data-testid="view-toggle" />,
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
    size?: string;
    variant?: string;
  }) => <button onClick={onClick}>{children}</button>,
  FacetedFilter: ({ title }: { title?: string }) => <button>{title}</button>,
  FacetedSearchInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input aria-label="Search" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
  Icons: {
    Close: () => <span data-testid="close-icon" />,
  },
}));

const accounts = [
  {
    id: "acc_1",
    name: "Brokerage",
    currency: "USD",
  } as Account,
];

const accountScope: AccountScope = { type: "all" };
const portfolios: PortfolioWithAccounts[] = [];

describe("ActivityViewControls", () => {
  it("resets filters through the parent reset handler", async () => {
    const user = userEvent.setup();
    const onSearchQueryChange = vi.fn();
    const onAccountScopeChange = vi.fn();
    const onActivityTypesChange = vi.fn();
    const onInstrumentTypesChange = vi.fn();
    const onStatusFilterChange = vi.fn();
    const onDateRangeChange = vi.fn();
    const onResetFilters = vi.fn();

    render(
      <ActivityViewControls
        accounts={accounts}
        portfolios={portfolios}
        searchQuery=""
        onSearchQueryChange={onSearchQueryChange}
        accountScope={accountScope}
        onAccountScopeChange={onAccountScopeChange}
        selectedActivityTypes={[]}
        onActivityTypesChange={onActivityTypesChange}
        selectedInstrumentTypes={[]}
        onInstrumentTypesChange={onInstrumentTypesChange}
        statusFilter="pending"
        onStatusFilterChange={onStatusFilterChange}
        dateRange={undefined}
        onDateRangeChange={onDateRangeChange}
        onResetFilters={onResetFilters}
        viewMode="table"
        onViewModeChange={vi.fn()}
        isFetching={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /reset/i }));

    expect(onResetFilters).toHaveBeenCalledTimes(1);
    expect(onSearchQueryChange).not.toHaveBeenCalled();
    expect(onAccountScopeChange).not.toHaveBeenCalled();
    expect(onActivityTypesChange).not.toHaveBeenCalled();
    expect(onInstrumentTypesChange).not.toHaveBeenCalled();
    expect(onStatusFilterChange).not.toHaveBeenCalled();
    expect(onDateRangeChange).not.toHaveBeenCalled();
  });
});
