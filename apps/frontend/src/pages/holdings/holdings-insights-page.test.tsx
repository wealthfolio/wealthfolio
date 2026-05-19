import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioAllocations, PrivateAssetListRow } from "@/lib/types";
import HoldingsInsightsPage from "./holdings-insights-page";

const mockNavigate = vi.fn();
const mockUseQuery = vi.fn();
const mockUseHoldings = vi.fn();
const mockUsePortfolioAllocations = vi.fn();

vi.mock("@/adapters", () => ({
  getPortfolios: vi.fn().mockResolvedValue([]),
  listPrivateAssetRows: vi.fn(),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: (...args: unknown[]) => mockUseHoldings(...args),
}));

vi.mock("@/hooks/use-portfolio-allocations", () => ({
  usePortfolioAllocations: (...args: unknown[]) => mockUsePortfolioAllocations(...args),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      baseCurrency: "USD",
      privateAssetsEnabled: true,
    },
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@/pages/settings/private-assets/private-assets-utils", () => ({
  formatPrivateAssetStrategy: (value: string) => {
    if (value === "PRIVATE_EQUITY") return "Private Equity";
    return value;
  },
  getFreshnessBadgeClass: () => "freshness-badge",
}));

vi.mock("@wealthfolio/ui", () => ({
  EmptyPlaceholder: ({
    title,
    description,
    children,
  }: {
    title: string;
    description?: string;
    children?: ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {children}
    </div>
  ),
  PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`amount:${currency}:${value}`}</span>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/badge", () => ({
  Badge: ({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Import: () => <span>import</span>,
    Plus: () => <span>plus</span>,
    TrendingUp: () => <span>trending-up</span>,
    Wallet: () => <span>wallet</span>,
  },
}));

vi.mock("./components/allocation-detail-sheet", () => ({
  AllocationDetailSheet: () => null,
}));

vi.mock("./components/cash-holdings-widget", () => ({
  CashHoldingsWidget: () => <div>cash-holdings-widget</div>,
}));

vi.mock("./components/compact-allocation-strip", () => ({
  CompactAllocationStrip: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("./components/composition-chart", () => ({
  PortfolioComposition: () => <div>portfolio-composition</div>,
}));

vi.mock("./components/currency-chart", () => ({
  HoldingCurrencyChart: () => <div>holding-currency-chart</div>,
}));

vi.mock("./components/drillable-account-chart", () => ({
  DrillableAccountChart: () => <div>drillable-account-chart</div>,
}));

vi.mock("./components/drillable-donut-chart", () => ({
  DrillableDonutChart: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("./components/sectors-chart", () => ({
  SectorsChart: () => <div>sectors-chart</div>,
}));

vi.mock("./components/segmented-allocation-bar", () => ({
  SegmentedAllocationBar: ({ title }: { title: string }) => <div>{title}</div>,
}));

function createEmptyAllocations(): PortfolioAllocations {
  const emptyTaxonomy = {
    taxonomyId: "empty",
    taxonomyName: "Empty",
    color: "var(--chart-1)",
    categories: [],
  };

  return {
    assetClasses: emptyTaxonomy,
    sectors: emptyTaxonomy,
    regions: emptyTaxonomy,
    riskCategory: emptyTaxonomy,
    securityTypes: emptyTaxonomy,
    customGroups: [],
    totalValue: 0,
  };
}

function createPrivateAssetRow(overrides: Partial<PrivateAssetListRow> = {}): PrivateAssetListRow {
  return {
    assetId: overrides.assetId ?? "private-1",
    name: overrides.name ?? "Alpha Fund I",
    fundManagerName: overrides.fundManagerName ?? "Arc Capital",
    vehicleKind: overrides.vehicleKind ?? "FUND",
    strategyType: overrides.strategyType ?? "PRIVATE_EQUITY",
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? "ACTIVE",
    commitmentAmount: overrides.commitmentAmount ?? null,
    freshnessState: overrides.freshnessState ?? "CURRENT",
    latestSnapshot: overrides.latestSnapshot ?? {
      id: "snapshot-1",
      privateAssetId: "private-1",
      contributedAmount: 100000,
      distributedAmount: 0,
      cashFlowType: "TOTAL_TO_DATE",
      currentValue: 120000,
      asOfDate: "2026-04-10",
      valueSourceType: "STATEMENT",
      notes: null,
      createdAt: "2026-04-10T00:00:00Z",
    },
  };
}

describe("HoldingsInsightsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
    });

    mockUsePortfolioAllocations.mockReturnValue({
      allocations: createEmptyAllocations(),
      isLoading: false,
    });

    mockUseQuery.mockReturnValue({
      data: [createPrivateAssetRow()],
      isLoading: false,
    });
  });

  it("shows portfolio-level private assets instead of the old empty state", async () => {
    const user = userEvent.setup();

    render(<HoldingsInsightsPage />);

    expect(screen.queryByText("No holdings yet")).not.toBeInTheDocument();
    expect(screen.getByText("Private Assets")).toBeInTheDocument();
    expect(screen.getByText("Private Strategies")).toBeInTheDocument();
    expect(screen.getByText("amount:USD:120000")).toBeInTheDocument();
    expect(screen.getByText("Current 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /manage/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/private-assets");
  });
});
