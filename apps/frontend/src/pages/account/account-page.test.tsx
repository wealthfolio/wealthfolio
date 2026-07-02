import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { getHoldingsList } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useRecalculatePortfolioMutation } from "@/hooks/use-calculate-portfolio";
import { useCurrentValuation } from "@/hooks/use-current-account-valuations";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useValuationHistory } from "@/hooks/use-valuation-history";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  Account,
  AccountValuation,
  CurrentAccountValuation,
  Holding,
  PerformanceResult,
  Settings,
} from "@/lib/types";
import { AccountType } from "@/lib/types";
import { useActivitySearch } from "@/pages/activity/hooks/use-activity-search";
import { useCalculatePerformanceHistory } from "@/pages/performance/hooks/use-performance-data";
import AccountPage from "./account-page";

vi.mock("@/adapters", () => ({
  getContributionLimit: vi.fn(),
  getHoldingsList: vi.fn(),
  getSnapshots: vi.fn(),
  searchActivities: vi.fn(),
}));

vi.mock("@/components/action-palette", () => ({
  ActionPalette: () => <div>action-palette</div>,
}));

vi.mock("@/components/history-chart", () => ({
  HistoryChart: () => <div>history-chart</div>,
}));

vi.mock("@/components/privacy-toggle", () => ({
  PrivacyToggle: () => <button>privacy-toggle</button>,
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: vi.fn(),
}));

vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useRecalculatePortfolioMutation: vi.fn(),
}));

vi.mock("@/hooks/use-current-account-valuations", () => ({
  useCurrentValuation: vi.fn(),
}));

vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: vi.fn(),
}));

vi.mock("@/hooks/use-valuation-history", () => ({
  useValuationHistory: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: vi.fn(),
}));

vi.mock("@/pages/activity/components/activity-date-sheet", () => ({
  ActivityDateSheet: () => <div>activity-date-sheet</div>,
}));

vi.mock("@/pages/activity/components/activity-delete-modal", () => ({
  ActivityDeleteModal: () => <div>activity-delete-modal</div>,
}));

vi.mock("@/pages/activity/components/activity-form", () => ({
  ActivityForm: () => <div>activity-form</div>,
}));

vi.mock("@/pages/activity/components/activity-pagination", () => ({
  ActivityPagination: () => <div>activity-pagination</div>,
}));

vi.mock("@/pages/activity/components/activity-table/activity-table", () => ({
  default: () => <div>activity-table</div>,
}));

vi.mock("@/pages/activity/components/activity-table/activity-table-mobile", () => ({
  default: () => <div>activity-table-mobile</div>,
}));

vi.mock("@/pages/activity/components/forms/bulk-holdings-modal", () => ({
  BulkHoldingsModal: () => <div>bulk-holdings-modal</div>,
}));

vi.mock("@/pages/activity/components/mobile-forms/mobile-activity-form", () => ({
  MobileActivityForm: () => <div>mobile-activity-form</div>,
}));

vi.mock("@/pages/activity/hooks/use-activity-action-dialogs", () => ({
  useActivityActionDialogs: () => ({
    selectedActivity: undefined,
    formOpen: false,
    deleteDialogOpen: false,
    isDeleting: false,
    openForm: vi.fn(),
    closeForm: vi.fn(),
    requestDelete: vi.fn(),
    cancelDelete: vi.fn(),
    confirmDelete: vi.fn(),
    duplicateActivity: vi.fn(),
  }),
}));

vi.mock("@/pages/activity/hooks/use-activity-search", () => ({
  useActivitySearch: vi.fn(() => ({
    mode: "infinite",
    data: [],
    totalRowCount: 0,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    refetch: vi.fn(),
  })),
}));

vi.mock("@/pages/dashboard/portfolio-update-trigger", () => ({
  PortfolioUpdateTrigger: ({
    children,
    lastCalculatedAt,
    notices,
  }: {
    children: React.ReactNode;
    lastCalculatedAt?: string;
    notices?: string[];
  }) => (
    <div>
      <div data-testid="account-as-of">{lastCalculatedAt ?? ""}</div>
      <div data-testid="account-notices">{JSON.stringify(notices ?? [])}</div>
      {children}
    </div>
  ),
}));

vi.mock("@/pages/holdings/components/holdings-edit-mode", () => ({
  HoldingsEditMode: () => <div>holdings-edit-mode</div>,
}));

vi.mock("@/pages/performance/hooks/use-performance-data", () => ({
  useCalculatePerformanceHistory: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@wealthfolio/ui", () => {
  const Icon = () => <span>icon</span>;
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

  return {
    AnimatedToggleGroup: ({
      items,
      onValueChange,
    }: {
      items?: { value: string; label: string }[];
      onValueChange?: (value: string) => void;
    }) => (
      <div>
        {items?.map((item) => (
          <button key={item.value} type="button" onClick={() => onValueChange?.(item.value)}>
            {item.label}
          </button>
        ))}
      </div>
    ),
    Card: Passthrough,
    CardContent: Passthrough,
    CardHeader: Passthrough,
    CardTitle: Passthrough,
    GainAmount: ({ value }: { value: number }) => <span>{`gain-amount:${value}`}</span>,
    GainPercent: ({ value }: { value: number }) => <span>{`gain-percent:${value}`}</span>,
    Icons: {
      Activity: Icon,
      ArrowRight: Icon,
      Bitcoin: Icon,
      Briefcase: Icon,
      Check: Icon,
      ChevronDown: Icon,
      Clock: Icon,
      CreditCard: Icon,
      DollarSign: Icon,
      ExternalLink: Icon,
      History: Icon,
      Holdings: Icon,
      Import: Icon,
      Pencil: Icon,
      Plus: Icon,
    },
    IntervalSelector: () => <div>interval-selector</div>,
    Page: Passthrough,
    PageContent: Passthrough,
    PageHeader: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
    PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
      <span>{`value:${currency}:${value}`}</span>
    ),
    Skeleton: () => <div>loading</div>,
    Tooltip: Passthrough,
    TooltipContent: Passthrough,
    TooltipProvider: Passthrough,
    TooltipTrigger: Passthrough,
  };
});

vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    children?: React.ReactNode;
  }) => (asChild ? <>{children}</> : <button {...props}>{children}</button>),
}));

vi.mock("@wealthfolio/ui/components/ui/command", () => ({
  Command: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CommandInput: () => <input aria-label="command-input" />,
  CommandItem: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@wealthfolio/ui/components/ui/popover", () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@wealthfolio/ui/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@wealthfolio/ui/components/ui/sheet", () => ({
  Sheet: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: ({
      children,
      to,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
      children?: React.ReactNode;
      to: string;
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useNavigate: () => vi.fn(),
    useParams: () => ({ id: "account-1" }),
  };
});

vi.mock("./account-contribution-limit", () => ({
  AccountContributionLimit: () => <div>contribution-limit</div>,
}));

vi.mock("./account-holdings", () => ({
  default: () => <div>account-holdings</div>,
}));

vi.mock("./account-metrics", () => ({
  default: () => <div>account-metrics</div>,
}));

vi.mock("./account-snapshot-history", () => ({
  default: () => <div>snapshot-history</div>,
}));

const mockUseAccounts = vi.mocked(useAccounts);
const mockUseCurrentValuation = vi.mocked(useCurrentValuation);
const mockUseIsMobileViewport = vi.mocked(useIsMobileViewport);
const mockUseValuationHistory = vi.mocked(useValuationHistory);
const mockUseSettingsContext = vi.mocked(useSettingsContext);
const mockUseCalculatePerformanceHistory = vi.mocked(useCalculatePerformanceHistory);
const mockUseActivitySearch = vi.mocked(useActivitySearch);
const mockUseQuery = vi.mocked(useQuery);
const mockUseRecalculatePortfolioMutation = vi.mocked(useRecalculatePortfolioMutation);

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseSettingsContext.mockReturnValue({
      settings: createSettings(),
    } as unknown as ReturnType<typeof useSettingsContext>);

    mockUseAccounts.mockReturnValue({
      accounts: [createAccount()],
      isLoading: false,
    } as unknown as ReturnType<typeof useAccounts>);

    mockUseIsMobileViewport.mockReturnValue(false);

    mockUseRecalculatePortfolioMutation.mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useRecalculatePortfolioMutation>);

    mockUseCalculatePerformanceHistory.mockReturnValue({
      data: [createPerformanceResult()],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    } as unknown as ReturnType<typeof useCalculatePerformanceHistory>);

    mockUseQuery.mockImplementation((options: unknown) => {
      const queryKey = (options as { queryKey?: unknown[] })?.queryKey;
      if (Array.isArray(queryKey) && queryKey[0] === "holdings") {
        return {
          data: [createCashHolding()],
          isLoading: false,
          error: null,
        } as ReturnType<typeof useQuery>;
      }

      return {
        data: [],
        isLoading: false,
        error: null,
      } as ReturnType<typeof useQuery>;
    });

    vi.mocked(getHoldingsList).mockResolvedValue([createCashHolding()]);
  });

  it("displays live current account valuation instead of stale historical valuation", () => {
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [createHistoricalValuation({ totalValue: 100 })],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: {
        summary: createCurrentSummary({ totalValueBase: 125 }),
        accounts: [createCurrentAccountValuation({ totalValue: 125 })],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    } as unknown as ReturnType<typeof useCurrentValuation>);

    render(<AccountPage />);

    expect(screen.getByText("value:USD:125")).toBeInTheDocument();
    expect(screen.queryByText("value:USD:100")).not.toBeInTheDocument();
  });

  it("does not use stale historical timestamp when live current valuation has no source data", () => {
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [
        createHistoricalValuation({
          totalValue: 100,
          calculatedAt: "2026-03-17T10:00:00Z",
        }),
      ],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: {
        summary: createCurrentSummary({ sourceDataAsOf: null }),
        accounts: [createCurrentAccountValuation({ sourceDataAsOf: null, totalValue: 0 })],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    } as unknown as ReturnType<typeof useCurrentValuation>);

    render(<AccountPage />);

    expect(screen.getByTestId("account-as-of")).toHaveTextContent("");
  });

  it("uses account-level current valuation notices in the account header", () => {
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [createHistoricalValuation({ totalValue: 100 })],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: {
        summary: {
          ...createCurrentSummary({ totalValueBase: 125 }),
          warnings: ["Summary notice"],
        },
        accounts: [
          createCurrentAccountValuation({
            totalValue: 125,
            warnings: ["Some exchange rates are missing, so this value may be approximate."],
          }),
        ],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    } as unknown as ReturnType<typeof useCurrentValuation>);

    render(<AccountPage />);

    expect(screen.getByTestId("account-notices")).toHaveTextContent(
      "Some exchange rates are missing, so this value may be approximate.",
    );
    expect(screen.getByTestId("account-notices")).not.toHaveTextContent("Summary notice");
  });

  it("adds an activities tab to the account detail area", () => {
    mockUseValuationHistory.mockReturnValue({
      valuationHistory: [createHistoricalValuation({ totalValue: 100 })],
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useValuationHistory>);
    mockUseCurrentValuation.mockReturnValue({
      currentValuation: {
        summary: createCurrentSummary({ totalValueBase: 125 }),
        accounts: [createCurrentAccountValuation({ totalValue: 125 })],
      },
      isLoading: false,
      isFetching: false,
      error: null,
    } as unknown as ReturnType<typeof useCurrentValuation>);

    render(<AccountPage />);

    expect(screen.getByText("Activities")).toBeInTheDocument();
    expect(mockUseActivitySearch.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "infinite",
      filters: { accountIds: [] },
    });

    fireEvent.click(screen.getByRole("button", { name: "Activities" }));

    expect(mockUseActivitySearch.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "infinite",
      filters: { accountIds: ["account-1"] },
    });
    expect(screen.getByRole("link", { name: /Explore/i })).toHaveAttribute(
      "href",
      "/activities?account=account-1",
    );
  });
});

function createSettings(): Settings {
  return {
    theme: "light",
    font: "font-sans",
    language: "en",
    baseCurrency: "USD",
    defaultReturnMetric: "twr",
    timezone: "America/Chicago",
    instanceId: "test-instance",
    onboardingCompleted: true,
    autoUpdateCheckEnabled: true,
    menuBarVisible: true,
    syncEnabled: false,
  };
}

function createAccount(): Account {
  return {
    id: "account-1",
    name: "Brokerage",
    accountType: AccountType.SECURITIES,
    group: "Investments",
    balance: 0,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function createCashHolding(): Holding {
  return {
    id: "USD",
    accountId: "account-1",
    holdingType: "cash",
    quantity: 1,
    marketValue: { local: 1, base: 1 },
  } as Holding;
}

function createHistoricalValuation(overrides: Partial<AccountValuation> = {}): AccountValuation {
  const id = overrides.id ?? "valuation-1";
  return {
    accountId: "account-1",
    valuationDate: "2026-03-17",
    accountCurrency: "USD",
    baseCurrency: "USD",
    fxRateToBase: 1,
    cashBalance: 0,
    investmentMarketValue: overrides.totalValue ?? 100,
    totalValue: overrides.totalValue ?? 100,
    costBasis: 0,
    bookBasis: 0,
    netContribution: 0,
    cashBalanceBase: 0,
    investmentMarketValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 100,
    totalValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 100,
    costBasisBase: 0,
    bookBasisBase: 0,
    netContributionBase: 0,
    externalInflowBase: 0,
    externalOutflowBase: 0,
    externalFlowSource: "UNKNOWN",
    performanceEligibleValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 100,
    valueStatus: "complete",
    basisStatus: "complete",
    calculatedAt: overrides.calculatedAt ?? "2026-03-17T10:00:00Z",
    ...overrides,
    id,
  };
}

function createCurrentAccountValuation(
  overrides: Partial<CurrentAccountValuation> = {},
): CurrentAccountValuation {
  return {
    accountId: "account-1",
    accountCurrency: "USD",
    baseCurrency: "USD",
    cashBalance: 0,
    investmentMarketValue: overrides.totalValue ?? 125,
    totalValue: overrides.totalValue ?? 125,
    cashBalanceBase: 0,
    investmentMarketValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 125,
    totalValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 125,
    sourceDataAsOf: overrides.sourceDataAsOf ?? "2026-03-17T12:00:00Z",
    calculatedAt: "2026-03-17T12:05:00Z",
    warnings: [],
    ...overrides,
  };
}

function createCurrentSummary(overrides: {
  totalValueBase?: number;
  sourceDataAsOf?: string | null;
}) {
  const totalValueBase = overrides.totalValueBase ?? 125;
  return {
    scopeId: "account:account-1",
    baseCurrency: "USD",
    cashBalanceBase: 0,
    investmentMarketValueBase: totalValueBase,
    totalValueBase,
    holdingsCount: 1,
    accountCount: 1,
    currencySplit: [],
    cashCurrencySplit: [],
    sourceDataAsOf: overrides.sourceDataAsOf ?? "2026-03-17T12:00:00Z",
    calculatedAt: "2026-03-17T12:05:00Z",
    warnings: [],
  };
}

function createPerformanceResult(): PerformanceResult {
  return {
    scope: { id: "account-1", currency: "USD" },
    mode: "valueReturn",
    returns: { valueReturn: null },
    attribution: {
      contributions: 0,
      distributions: 0,
      income: 0,
      realizedPnl: 0,
      unrealizedPnlChange: 0,
      fxEffect: 0,
      fees: 0,
      taxes: 0,
      residual: 0,
    },
    risk: {},
    dataQuality: { status: "ok", warnings: [] },
    series: [],
    period: { startDate: null, endDate: null },
  };
}
