import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetails } from "@/lib/types";
import { ActivityType } from "@/lib/constants";
import { ActivityDateList } from "./activity-date-list";

vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));

afterEach(cleanup);

describe("cash audit ledger", () => {
  it.each(["HUF", "IDR", "IQD", "USD", "KWD"])(
    "does not shift the starting %s balance by reversing an unproven SELL",
    (currency) => {
      const activity = {
        id: "sell",
        accountId: "account",
        activityType: ActivityType.SELL,
        date: new Date("2026-05-01T12:00:00Z"),
        assetSymbol: "TEST",
        assetId: "test-asset",
        quantity: "10",
        unitPrice: "0.05",
        fee: "10.5",
        tax: "0",
        amount: "9.5",
        currency,
      } as ActivityDetails;

      render(
        <MemoryRouter>
          <ActivityDateList
            activities={[activity]}
            endingCashBalance={109.5}
            cashCurrency="USD"
          />
        </MemoryRouter>,
      );

      // USD display isolates the calculation from Intl's display precision.
      expect(screen.getByText("$100.00")).toBeInTheDocument();
      expect(screen.queryByText("$119.00")).not.toBeInTheDocument();
      expect(screen.getByText("+$9.50")).toBeInTheDocument();
      expect(screen.getAllByText("$109.50")).toHaveLength(2);
    },
  );
});

describe("negative cash actions", () => {
  const buy = {
    id: "buy-1",
    accountId: "acc-1",
    activityType: ActivityType.BUY,
    date: new Date("2025-01-02T10:00:00Z"),
    assetId: "AAPL",
    assetSymbol: "AAPL",
    quantity: "10",
    unitPrice: "100",
    amount: "1000",
    fee: "0",
    currency: "USD",
  } as ActivityDetails;

  function renderList(onStopTrackingCash?: () => void) {
    render(
      <MemoryRouter>
        <ActivityDateList
          activities={[buy]}
          endingCashBalance={-1000}
          cashCurrency="USD"
          onStopTrackingCash={onStopTrackingCash}
        />
      </MemoryRouter>,
    );
  }

  it("offers to stop tracking cash next to adding a deposit", () => {
    const onStopTrackingCash = vi.fn();
    renderList(onStopTrackingCash);
    expect(screen.getByRole("link", { name: "Add deposit" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Stop tracking cash" }));
    expect(onStopTrackingCash).toHaveBeenCalledTimes(1);
  });

  it("does not offer it where the account cannot stop tracking cash", () => {
    renderList();
    expect(screen.getByRole("link", { name: "Add deposit" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Stop tracking cash" }),
    ).not.toBeInTheDocument();
  });
});
