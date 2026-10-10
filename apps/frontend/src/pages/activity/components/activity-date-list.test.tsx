import { render, screen } from "@/test/render";
import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ActivityDateList } from "./activity-date-list";

vi.mock("@/components/ticker-avatar", () => ({ TickerAvatar: () => null }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "UTC" } }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

const exchange: ActivityDetails = {
  id: "fx",
  accountId: "account",
  accountName: "Account",
  accountCurrency: "USD",
  activityType: ActivityType.FX_EXCHANGE,
  status: ActivityStatus.POSTED,
  amount: "100",
  currency: "USD",
  destinationAmount: "92",
  destinationCurrency: "EUR",
  date: new Date("2025-01-03T12:00:00Z"),
  createdAt: new Date("2025-01-03T12:00:00Z"),
  updatedAt: new Date("2025-01-03T12:00:00Z"),
  quantity: null,
  unitPrice: null,
  fee: null,
  needsReview: false,
  assetId: "",
  assetSymbol: "",
};

describe("ActivityDateList currency exchanges", () => {
  it("shows both cash sides without inventing a single-currency running balance", () => {
    render(
      <ActivityDateList activities={[exchange]} endingCashBalance={1001.2} cashCurrency="USD" />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByTestId("fx-exchange-amount")).toHaveTextContent("100");
    expect(screen.getByTestId("fx-exchange-amount")).toHaveTextContent("92");
    expect(screen.getByRole("note")).toHaveTextContent("a currency exchange");
    expect(screen.queryByText("Starting cash")).not.toBeInTheDocument();
    expect(screen.queryByText("Running cash")).not.toBeInTheDocument();
  });

  it("preserves the existing single-currency audit for ordinary cash activity", () => {
    render(
      <ActivityDateList
        activities={[
          {
            ...exchange,
            activityType: ActivityType.DEPOSIT,
            destinationAmount: undefined,
            destinationCurrency: undefined,
          },
        ]}
        endingCashBalance={1000}
        cashCurrency="USD"
      />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText("Starting cash")).toBeInTheDocument();
    expect(screen.getByText("Running cash")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
