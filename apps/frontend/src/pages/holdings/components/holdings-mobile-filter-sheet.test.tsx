import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { HoldingsMobileFilterSheet } from "./holdings-mobile-filter-sheet";

vi.mock("@wealthfolio/ui", () => ({
  AnimatedToggleGroup: () => null,
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Check: () => <span />,
    CreditCard: () => <span />,
    Folder: () => <span />,
    Wallet: () => <span />,
  },
}));

vi.mock("@wealthfolio/ui/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

describe("HoldingsMobileFilterSheet", () => {
  it("places cash under asset type and hides unsupported closed status", () => {
    render(
      <HoldingsMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        showAccountScope={false}
        sortBy="marketValue"
        setSortBy={vi.fn()}
        performanceMode="pnl"
        setPerformanceMode={vi.fn()}
        visibilityFilters={["open"]}
        setVisibilityFilters={vi.fn()}
        showClosedPositions={false}
        typeOptions={[{ value: "CASH", label: "Cash" }]}
      />,
    );

    const assetTypeSection = screen.getByText("Asset Type").parentElement;

    expect(assetTypeSection).not.toBeNull();
    expect(within(assetTypeSection!).getByText("Cash")).toBeInTheDocument();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
    expect(screen.queryByText("Closed")).not.toBeInTheDocument();
  });

  it("exposes the selected position status to assistive technology", () => {
    render(
      <HoldingsMobileFilterSheet
        open
        onOpenChange={vi.fn()}
        accountFilter={{ type: "all" }}
        onAccountScopeChange={vi.fn()}
        accounts={[]}
        portfolios={[]}
        selectedTypes={[]}
        setSelectedTypes={vi.fn()}
        showAccountScope={false}
        sortBy="marketValue"
        setSortBy={vi.fn()}
        performanceMode="pnl"
        setPerformanceMode={vi.fn()}
        visibilityFilters={["closed"]}
        setVisibilityFilters={vi.fn()}
        showClosedPositions
      />,
    );

    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "true");
  });
});
