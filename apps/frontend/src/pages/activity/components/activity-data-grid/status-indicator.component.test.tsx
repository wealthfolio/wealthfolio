import { ActivityType } from "@/lib/constants";
import { render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { StatusHeaderIndicator, StatusIndicator } from "./status-indicator";
import type { LocalTransaction } from "./types";

vi.mock("@wealthfolio/ui", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, render }: { children: ReactNode; render?: ReactElement }) =>
    render ? cloneElement(render, undefined, children) : <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function transaction(metadata?: Record<string, unknown>): LocalTransaction {
  return {
    id: "activity-1",
    accountId: "account-1",
    accountName: "Brokerage",
    accountCurrency: "USD",
    activityType: ActivityType.BUY,
    date: new Date("2026-07-29T12:01:00Z"),
    quantity: "1",
    unitPrice: "100",
    amount: "100",
    fee: null,
    currency: "USD",
    needsReview: true,
    createdAt: new Date("2026-07-29T12:01:00Z"),
    updatedAt: new Date("2026-07-29T12:01:00Z"),
    assetId: "asset-1",
    assetSymbol: "AAPL",
    metadata,
  };
}

describe("StatusIndicator", () => {
  it("shows provider-supplied reasons in the row tooltip", () => {
    render(
      <StatusIndicator
        transaction={transaction({ mapping_reasons: ["Ambiguous activity type"] })}
      />,
    );

    expect(screen.getByText("Ambiguous activity type")).toBeInTheDocument();
    expect(screen.queryByText("Newly imported &")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Needs Review: Ambiguous activity type",
      }),
    ).toBeInTheDocument();
  });

  it("shows the generic message when the provider supplied no reasons", () => {
    render(<StatusIndicator transaction={transaction()} />);

    expect(screen.getByText("Newly imported &")).toBeInTheDocument();
    expect(screen.getByText("Pending verification")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Needs Review: Newly imported & Pending verification",
      }),
    ).toBeInTheDocument();
  });

  it("gives the header indicator an accessible description", () => {
    render(<StatusHeaderIndicator hasRowsToReview />);

    expect(
      screen.getByRole("button", {
        name: "Newly imported & Pending verification",
      }),
    ).toBeInTheDocument();
  });
});
