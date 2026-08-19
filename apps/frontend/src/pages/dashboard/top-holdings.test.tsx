import { render, screen } from "@/test/render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HoldingType } from "@/lib/constants";
import type { Holding } from "@/lib/types";
import { TopHoldings } from "./top-holdings";

vi.mock("@/components/dashboard-card", () => ({
  DashboardCard: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

vi.mock("@/components/holding-performance-percent", () => ({
  HoldingPerformancePercent: () => <span>performance</span>,
}));

vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@wealthfolio/ui")>()),
  AmountDisplay: ({ value }: { value: number }) => <span>{`amount:${value}`}</span>,
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  GainAmount: ({ value }: { value: number }) => <span>{`gain:${value}`}</span>,
  Icons: {
    ChevronRight: () => <span>chevron</span>,
    ListFilter: () => <span>filter</span>,
  },
  usePersistentState: (_key: string, defaultValue: unknown) => [defaultValue, vi.fn()],
}));

vi.mock("@wealthfolio/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const longQuantityHolding = {
  id: "LONG",
  holdingType: HoldingType.SECURITY,
  accountId: "account-1",
  quantity: 123_456_789,
  localCurrency: "CNY",
  baseCurrency: "CNY",
  marketValue: { local: 1_487_443, base: 1_487_443 },
  totalGain: { local: 381_583.22, base: 381_583.22 },
  totalGainPct: -0.2034,
  weight: 1,
  asOfDate: "2026-08-13",
} satisfies Holding;

describe("TopHoldings", () => {
  it("truncates a long quantity within the shrinkable holding details column", () => {
    render(
      <MemoryRouter>
        <TopHoldings holdings={[longQuantityHolding]} isLoading={false} baseCurrency="CNY" />
      </MemoryRouter>,
    );

    expect(screen.getByText("123,456,789 shares")).toHaveClass("truncate");
  });
});
