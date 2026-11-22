import { render, screen } from "@/test/render";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/asset-logo-registry", () => ({
  useAssetLogoOverride: () => ({}),
}));

const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: privacy.isBalanceHidden }),
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

const AXIS_FUND_NAME = "Axis Children's Fund - Direct Plan - Growth Option";

function securityHolding(
  id: string,
  instrument: Partial<NonNullable<Holding["instrument"]>>,
  marketValue = 100,
): Holding {
  return {
    ...longQuantityHolding,
    id,
    quantity: 1,
    marketValue: { local: marketValue, base: marketValue },
    instrument: {
      id: `asset-${id}`,
      symbol: id,
      currency: "INR",
      quoteMode: "MARKET",
      ...instrument,
    },
  };
}

function renderCard(holdings: Holding[]) {
  return render(
    <MemoryRouter>
      <TopHoldings holdings={holdings} isLoading={false} baseCurrency="INR" />
    </MemoryRouter>,
  );
}

describe("TopHoldings", () => {
  beforeEach(() => {
    privacy.isBalanceHidden = false;
  });

  it("truncates a long quantity within the shrinkable holding details column", () => {
    render(
      <MemoryRouter>
        <TopHoldings holdings={[longQuantityHolding]} isLoading={false} baseCurrency="CNY" />
      </MemoryRouter>,
    );

    expect(screen.getByText("123,456,789 shares")).toHaveClass("truncate");
  });

  it("hides the share count when balances are hidden", () => {
    privacy.isBalanceHidden = true;

    render(
      <MemoryRouter>
        <TopHoldings holdings={[longQuantityHolding]} isLoading={false} baseCurrency="CNY" />
      </MemoryRouter>,
    );

    expect(screen.queryByText("123,456,789 shares")).not.toBeInTheDocument();
    expect(screen.getByText("•••• shares")).toBeInTheDocument();
  });

  it("labels an AMFI scheme-code fund by its name and initials in symbol mode", () => {
    renderCard([securityHolding("135762", { name: AXIS_FUND_NAME, preferredProvider: "AMFI" })]);

    expect(screen.getByText(AXIS_FUND_NAME)).toHaveAttribute("dir", "auto");
    expect(screen.queryByText("135762")).not.toBeInTheDocument();
    expect(screen.getByTitle("135762")).toHaveTextContent(/^ACF$/);
  });

  it("keeps other holdings' symbols, including numeric exchange tickers", () => {
    renderCard([
      securityHolding("7203", {
        name: "Toyota Motor Corp",
        exchangeMic: "XTKS",
        preferredProvider: "AMFI",
      }),
      securityHolding("VFIAX", { name: "Vanguard 500 Index Fund Admiral" }, 200),
      securityHolding("AXISCF", { name: AXIS_FUND_NAME, preferredProvider: "AMFI" }, 100),
    ]);

    expect(screen.getAllByText("7203")).toHaveLength(2);
    expect(screen.getByText("VFIAX")).toBeInTheDocument();
    expect(screen.getByText("AXISCF")).toBeInTheDocument();
    expect(screen.getByTitle("7203")).toHaveTextContent(/^7203$/);
    expect(screen.getByTitle("VFIAX")).toHaveTextContent(/^VFIA$/);
    expect(screen.getByTitle("AXISCF")).toHaveTextContent(/^AXIS$/);
  });

  it("keeps the scheme code for an AMFI fund with no stored name", () => {
    renderCard([securityHolding("135762", { name: "  ", preferredProvider: "AMFI" })]);

    expect(screen.getByText("135762")).toBeInTheDocument();
    expect(screen.getByTitle("135762")).toHaveTextContent(/^1357$/);
  });

  it.each(["2030 - Direct Plan", " - Direct Plan"])(
    "keeps the digits in the avatar when %j yields no initials",
    (name) => {
      renderCard([securityHolding("135762", { name, preferredProvider: "AMFI" })]);

      expect(screen.getByText(name.trim())).toBeInTheDocument();
      expect(screen.getByTitle("135762")).toHaveTextContent(/^1357$/);
    },
  );

  it("shows up to four Unicode initials in the stacked avatars", () => {
    const holdings = Array.from({ length: 9 }, (_, index) =>
      securityHolding(`STOCK${index}`, { name: `Stock ${index}` }, 1000 - index),
    );
    holdings.push(
      securityHolding(
        "120503",
        { name: "ßeta 30 Épargne (Growth) 𐐨ther Delta Fonds", preferredProvider: "AMFI" },
        1,
      ),
    );

    renderCard(holdings);

    expect(
      screen.queryByText("ßeta 30 Épargne (Growth) 𐐨ther Delta Fonds"),
    ).not.toBeInTheDocument();
    expect(screen.getByTitle("120503")).toHaveTextContent(/^ßÉ𐐀D$/);
  });
});
