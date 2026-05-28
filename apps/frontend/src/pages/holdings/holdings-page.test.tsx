import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateAssetListRow } from "@/lib/types";
import HoldingsPage from "./holdings-page";

const mockNavigate = vi.fn();
const mockUseQuery = vi.fn();
let currentTab = "private-assets";
let isMobileViewport = false;
let privateAssetsEnabled = true;

vi.mock("@/adapters", () => ({
  getPortfolios: vi.fn().mockResolvedValue([]),
  listPrivateAssetRows: vi.fn(),
  updateAlternativeAssetMetadata: vi.fn(),
}));

vi.mock("@/components/page", () => ({
  SwipablePage: ({ views }: { views: { value: string; content: ReactNode }[] }) => (
    <div>{views.find((view) => view.value === currentTab)?.content}</div>
  ),
}));

vi.mock("@/components/account-selector", () => ({
  AccountSelector: () => null,
}));

vi.mock("@/components/action-palette", () => ({
  ActionPalette: () => null,
}));

vi.mock("@/components/classification/classification-sheet", () => ({
  ClassificationSheet: () => null,
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({
    accounts: [],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-alternative-assets", () => ({
  useAlternativeHoldings: () => ({
    data: [],
    isLoading: false,
  }),
  useDeleteAlternativeAsset: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useLinkLiability: () => ({
    mutateAsync: vi.fn(),
  }),
  useUnlinkLiability: () => ({
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({
    isBalanceHidden: false,
  }),
}));

vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({
    holdings: [],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-persistent-state", () => ({
  usePersistentState: <T,>(_: string, defaultValue: T) => [defaultValue, vi.fn()] as const,
}));

vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => isMobileViewport,
}));

vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useUpdatePortfolioMutation: () => ({
    mutate: vi.fn(),
  }),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: {
      baseCurrency: "USD",
      privateAssetsEnabled,
    },
  }),
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return actual;
});

vi.mock("@/pages/settings/private-assets/private-assets-utils", () => ({
  formatPrivateAmount: (value: number | null | undefined, currency: string) =>
    value === null || value === undefined ? "—" : `amount:${currency}:${value}`,
  formatPrivateAssetStatus: (value: string) => {
    if (value === "ACTIVE") return "Active";
    return value;
  },
  formatPrivateAssetStrategy: (value: string) => {
    if (value === "PRIVATE_EQUITY") return "Private Equity";
    return value;
  },
  formatPrivateAssetVehicleKind: (value: string) => {
    if (value === "FUND") return "Fund";
    return value;
  },
  getFreshnessBadgeClass: () => "freshness-badge",
  getStatusBadgeClass: () => "status-badge",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(`tab=${currentTab}`), vi.fn()],
}));

vi.mock("@wealthfolio/ui", () => ({
  EmptyPlaceholder: ({
    title,
    description,
    children,
  }: {
    title?: string;
    description?: string;
    children?: ReactNode;
  }) => (
    <div>
      {title ? <h2>{title}</h2> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </div>
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

vi.mock("@wealthfolio/ui/components/ui/table", () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({
    children,
    onClick,
  }: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) => (
    <tr onClick={onClick}>{children}</tr>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    ArrowRight: () => <span>arrow-right</span>,
    CreditCard: () => <span>credit-card</span>,
    Import: () => <span>import</span>,
    ListFilter: () => <span>list-filter</span>,
    Pencil: () => <span>pencil</span>,
    Plus: () => <span>plus</span>,
    Refresh: () => <span>refresh</span>,
    TrendingUp: () => <span>trending-up</span>,
    Wallet: () => <span>wallet</span>,
  },
}));

vi.mock("./components/holdings-mobile-filter-sheet", () => ({
  HoldingsMobileFilterSheet: () => null,
}));

vi.mock("./components/holdings-table", () => ({
  HoldingsTable: () => null,
}));

vi.mock("./components/holdings-table-mobile", () => ({
  HoldingsTableMobile: () => null,
}));

vi.mock("./components/alternative-holdings-table", () => ({
  AlternativeHoldingsTable: () => null,
}));

vi.mock("./components/alternative-holdings-list-mobile", () => ({
  AlternativeHoldingsListMobile: () => null,
}));

vi.mock("./components/holdings-edit-mode", () => ({
  HoldingsEditMode: () => null,
}));

vi.mock("@/pages/asset/alternative-assets", () => ({
  AlternativeAssetQuickAddModal: () => null,
  AssetDetailsSheet: () => null,
  UpdateValuationModal: () => null,
}));

function createPrivateAssetRow(overrides: Partial<PrivateAssetListRow> = {}): PrivateAssetListRow {
  return {
    assetId: overrides.assetId ?? "private-1",
    name: overrides.name ?? "Alpha Fund I",
    fundManagerName: overrides.fundManagerName ?? "Arc Capital",
    vehicleKind: overrides.vehicleKind ?? "FUND",
    strategyType: overrides.strategyType ?? "PRIVATE_EQUITY",
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? "ACTIVE",
    commitmentAmount: overrides.commitmentAmount ?? 150000,
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

describe("HoldingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentTab = "private-assets";
    isMobileViewport = false;
    privateAssetsEnabled = true;

    mockUseQuery.mockReturnValue({
      data: [createPrivateAssetRow()],
      isLoading: false,
    });
  });

  it("renders the private-assets tab and routes into the dedicated private-assets flow", async () => {
    const user = userEvent.setup();

    render(<HoldingsPage />);

    expect(
      screen.getByText("Private assets stay separate from public holdings."),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha Fund I")).toBeInTheDocument();
    expect(screen.getByText("Private Equity")).toBeInTheDocument();
    expect(screen.getByText("amount:USD:120000")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open full private assets/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/private-assets");

    await user.click(screen.getByRole("button", { name: /alpha fund i/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/private-assets/private-1");
  });

  it("keeps the private-assets tab focused on private flows on mobile", async () => {
    const user = userEvent.setup();
    isMobileViewport = true;

    render(<HoldingsPage />);

    expect(
      screen.queryByRole("button", { name: /open holdings filters/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Alpha Fund I")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open full private assets/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings/private-assets");
  });

  it("shows private investments on the investments tab when public holdings are still empty", async () => {
    const user = userEvent.setup();
    currentTab = "investments";

    render(<HoldingsPage />);

    expect(screen.getByText("No public holdings yet")).toBeInTheDocument();
    expect(screen.getByText("Private Investments")).toBeInTheDocument();
    expect(screen.getByText("Position")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getAllByText("Total Value").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Contributed").length).toBeGreaterThan(0);
    expect(screen.getByText("Commitment")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open private assets/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/holdings?tab=private-assets");
  });

  it("hides private-assets surfaces on mobile when the capability is disabled", () => {
    currentTab = "investments";
    isMobileViewport = true;
    privateAssetsEnabled = false;

    render(<HoldingsPage />);

    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.queryByText("Private Investments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open private assets/i })).not.toBeInTheDocument();
  });
});
