import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingType } from "@/lib/constants";
import type { Holding, PrivateAssetListRow } from "@/lib/types";
import { TopHoldings } from "./top-holdings";

const mockNavigate = vi.fn();
const mockUseQuery = vi.fn();

vi.mock("@/adapters", () => ({
  listPrivateAssetRows: vi.fn(),
}));

vi.mock("@/components/ticker-avatar", () => ({
  TickerAvatar: ({ symbol }: { symbol: string }) => <span>{`avatar:${symbol}`}</span>,
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      privateAssetsEnabled: true,
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mockNavigate,
}));

vi.mock("@wealthfolio/ui", () => ({
  AmountDisplay: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`amount:${currency}:${value}`}</span>
  ),
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  GainAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`gain-amount:${currency}:${value}`}</span>
  ),
  GainPercent: ({ value }: { value: number }) => <span>{`gain-percent:${value}`}</span>,
  Icons: {
    ChevronRight: () => <span>chevron-right</span>,
    ListFilter: () => <span>list-filter</span>,
  },
  usePersistentState: (key: string, defaultValue: unknown) => {
    if (key === "holdings-show-total-return") return [true, vi.fn()];
    if (key === "holdings-widget-sort-by") return ["value", vi.fn()];
    return [defaultValue, vi.fn()];
  },
}));

vi.mock("@wealthfolio/ui/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@wealthfolio/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}));

function createHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: overrides.id ?? "holding-1",
    holdingType: overrides.holdingType ?? HoldingType.SECURITY,
    accountId: overrides.accountId ?? "account-1",
    instrument: overrides.instrument ?? {
      id: "public-asset-1",
      symbol: "AAPL",
      name: "Apple Inc.",
      currency: "USD",
      quoteMode: "MARKET",
    },
    assetKind: overrides.assetKind ?? "INVESTMENT",
    quantity: overrides.quantity ?? 10,
    localCurrency: overrides.localCurrency ?? "USD",
    baseCurrency: overrides.baseCurrency ?? "USD",
    marketValue: overrides.marketValue ?? { local: 5000, base: 5000 },
    costBasis: overrides.costBasis ?? { local: 4000, base: 4000 },
    unrealizedGain: overrides.unrealizedGain ?? { local: 1000, base: 1000 },
    unrealizedGainPct: overrides.unrealizedGainPct ?? 0.25,
    dayChange: overrides.dayChange ?? { local: 100, base: 100 },
    dayChangePct: overrides.dayChangePct ?? 0.02,
    weight: overrides.weight ?? 0.5,
    asOfDate: overrides.asOfDate ?? "2026-04-14",
  };
}

function createPrivateRow(overrides: Partial<PrivateAssetListRow> = {}): PrivateAssetListRow {
  return {
    assetId: overrides.assetId ?? "private-1",
    name: overrides.name ?? "Alpha Fund I",
    fundManagerName: overrides.fundManagerName ?? "Arc Capital",
    vehicleKind: overrides.vehicleKind ?? "FUND",
    strategyType: overrides.strategyType ?? "PRIVATE_EQUITY",
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? "ACTIVE",
    commitmentAmount: overrides.commitmentAmount ?? null,
    freshnessState: overrides.freshnessState ?? "STALE",
    latestSnapshot: overrides.latestSnapshot ?? {
      id: "snapshot-1",
      privateAssetId: "private-1",
      contributedAmount: 100000,
      distributedAmount: 10000,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 120000,
      asOfDate: "2026-04-10",
      valueSourceType: "STATEMENT",
      notes: null,
      createdAt: "2026-04-10T00:00:00Z",
    },
  };
}

describe("TopHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders mixed public and private investments with truthful routing", async () => {
    const user = userEvent.setup();

    mockUseQuery.mockReturnValue({
      data: [createPrivateRow()],
      isLoading: false,
    });

    render(<TopHoldings holdings={[createHolding()]} isLoading={false} baseCurrency="USD" />);

    expect(screen.getByText("Top Investments")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view all/i })).not.toBeInTheDocument();
    expect(screen.getByText("Alpha Fund I")).toBeInTheDocument();
    expect(screen.getByText("Private Equity • Arc Capital")).toBeInTheDocument();
    expect(screen.getByText(/Stale • Apr 10, 2026/)).toBeInTheDocument();

    await user.click(screen.getByText("Alpha Fund I"));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/private-assets/private-1");

    await user.click(screen.getByText("AAPL"));
    expect(mockNavigate).toHaveBeenCalledWith("/holdings/public-asset-1");
  });
});
