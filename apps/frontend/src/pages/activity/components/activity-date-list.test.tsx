import { cleanup, render, screen } from "@testing-library/react";
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
          <ActivityDateList activities={[activity]} endingCashBalance={109.5} cashCurrency="USD" />
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
