import { AccountType } from "@/lib/constants";
import type { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import type { InputHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityMobileFilterSheet } from "./activity-mobile-filter-sheet";

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    className: _className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => <button onClick={onClick}>{children}</button>,
  Calendar: () => <div data-testid="calendar" />,
  Icons: {
    PlusCircle: () => <span data-testid="plus-circle-icon" />,
  },
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <span data-testid="separator" />,
}));

vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className: _className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Check: () => <span data-testid="check-icon" />,
    Folder: () => <span data-testid="folder-icon" />,
  },
}));

vi.mock("@wealthfolio/ui/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const createdAt = new Date("2026-01-01T00:00:00Z");

function account(id: string, name: string): Account {
  return {
    id,
    name,
    accountType: AccountType.SECURITIES,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    createdAt,
    updatedAt: createdAt,
  };
}

const accounts = [account("acc_1", "Brokerage"), account("acc_2", "IRA")];

const portfolios: PortfolioWithAccounts[] = [
  {
    id: "pf_1",
    name: "Long Term",
    description: undefined,
    sortOrder: 0,
    accountIds: ["acc_1", "acc_2"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("ActivityMobileFilterSheet", () => {
  it("preserves portfolio scope when applying without changing account selection", async () => {
    const user = userEvent.setup();
    const accountScope: AccountScope = { type: "portfolio", portfolioId: "pf_1" };
    const setFilters = vi.fn();

    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountScope={accountScope}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="all"
        selectedInstrumentTypes={[]}
        setFilters={setFilters}
        hasActiveFilters={false}
        onResetFilters={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(setFilters).toHaveBeenCalledWith({
      activityTypes: [],
      dateRange: undefined,
      accountScope,
      statusFilter: "all",
      instrumentTypes: [],
    });
  });

  it("offers a reset that clears filters the sheet has no control for", async () => {
    const user = userEvent.setup();
    const onResetFilters = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={onOpenChange}
        accountScope={{ type: "all" }}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="all"
        selectedInstrumentTypes={[]}
        setFilters={vi.fn()}
        hasActiveFilters
        onResetFilters={onResetFilters}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(onResetFilters).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the reset when nothing is filtered", () => {
    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountScope={{ type: "all" }}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="all"
        selectedInstrumentTypes={[]}
        setFilters={vi.fn()}
        hasActiveFilters={false}
        onResetFilters={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("applies a status chosen in the sheet, so the review filter can be left", async () => {
    const user = userEvent.setup();
    const setFilters = vi.fn();

    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountScope={{ type: "all" }}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="pending"
        selectedInstrumentTypes={[]}
        setFilters={setFilters}
        hasActiveFilters
        onResetFilters={vi.fn()}
      />,
    );

    await user.click(screen.getByText("All Activities"));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(setFilters).toHaveBeenCalledWith(expect.objectContaining({ statusFilter: "all" }));
  });

  /**
   * The rows used to be clickable `li` elements, so keyboard and switch users
   * could not change any filter in this sheet.
   */
  it("exposes filter options as keyboard-operable buttons", async () => {
    const user = userEvent.setup();
    const setFilters = vi.fn();

    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountScope={{ type: "all" }}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="all"
        selectedInstrumentTypes={[]}
        setFilters={setFilters}
        hasActiveFilters={false}
        onResetFilters={vi.fn()}
      />,
    );

    const pending = screen.getByRole("button", { name: "Pending Review" });
    expect(pending).toHaveAttribute("aria-pressed", "false");

    pending.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(setFilters).toHaveBeenCalledWith(expect.objectContaining({ statusFilter: "pending" }));
  });

  it("marks the selected option as pressed", () => {
    render(
      <ActivityMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountScope={{ type: "all" }}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={[]}
        dateRange={undefined}
        statusFilter="pending"
        selectedInstrumentTypes={[]}
        setFilters={vi.fn()}
        hasActiveFilters
        onResetFilters={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Pending Review" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
