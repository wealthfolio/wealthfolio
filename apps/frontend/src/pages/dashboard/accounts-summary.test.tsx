import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculatePerformanceSummaries } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useCurrentAccountValuations } from "@/hooks/use-current-account-valuations";
import { useLatestValuations } from "@/hooks/use-latest-valuations";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  Account,
  AccountValuation,
  CurrentAccountValuation,
  PerformanceResult,
  PerformanceSummaryScope,
  Settings,
  TrackingMode,
} from "@/lib/types";
import { AccountType } from "@/lib/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AccountsSummary } from "./accounts-summary";

vi.mock("@/adapters", () => ({
  calculatePerformanceSummaries: vi.fn(),
  performanceSummaryScopeKey: (accountIds: string[]) =>
    `accounts:${[...new Set(accountIds)].sort().join(",")}`,
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: vi.fn(),
}));

vi.mock("@/hooks/use-latest-valuations", () => ({
  useLatestValuations: vi.fn(),
}));

vi.mock("@/hooks/use-current-account-valuations", () => ({
  useCurrentAccountValuations: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol("keepPreviousData"),
  useQuery: vi.fn(),
}));

vi.mock("@wealthfolio/ui", () => ({
  PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`value:${currency}:${value}`}</span>
  ),
  GainAmount: ({
    value,
    currency,
    showSign = true,
  }: {
    value: number;
    currency: string;
    showSign?: boolean;
  }) => <span>{`gain-amount:${currency}:${showSign}:${value}`}</span>,
  GainPercent: ({ value }: { value: number }) => <span>{`gain-percent:${value}`}</span>,
}));

vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    ChevronDown: () => <span>chevron-down</span>,
    ChevronRight: () => <span>chevron-right</span>,
    ListCollapse: () => <span>list-collapse</span>,
    Group: () => <span>group</span>,
    AlertTriangle: () => <span>alert-triangle</span>,
  },
}));

vi.mock("@wealthfolio/ui/components/ui/separator", () => ({
  Separator: () => <span>|</span>,
}));

vi.mock("@wealthfolio/ui/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}));

vi.mock("@wealthfolio/ui/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockCalculatePerformanceSummaries = vi.mocked(calculatePerformanceSummaries);
const mockUseAccounts = vi.mocked(useAccounts);
const mockUseLatestValuations = vi.mocked(useLatestValuations);
const mockUseCurrentAccountValuations = vi.mocked(useCurrentAccountValuations);
const mockUseSettingsContext = vi.mocked(useSettingsContext);
const mockUseQuery = vi.mocked(useQuery);

const mockSettings: Settings = {
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

function createAccount(overrides: Partial<Account>): Account {
  const accountType = overrides.accountType ?? AccountType.SECURITIES;
  const trackingMode = overrides.trackingMode ?? ("TRANSACTIONS" as TrackingMode);

  return {
    id: overrides.id ?? "account-1",
    name: overrides.name ?? "Account 1",
    accountType,
    group: overrides.group,
    balance: overrides.balance ?? 0,
    currency: overrides.currency ?? "USD",
    isDefault: overrides.isDefault ?? false,
    isActive: overrides.isActive ?? true,
    isArchived: overrides.isArchived ?? false,
    trackingMode,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
    platformId: overrides.platformId,
    accountNumber: overrides.accountNumber,
    meta: overrides.meta,
    provider: overrides.provider,
    providerAccountId: overrides.providerAccountId,
  };
}

function createValuation(overrides: Partial<AccountValuation>): AccountValuation {
  return {
    id: overrides.id ?? `valuation-${overrides.accountId ?? "account-1"}`,
    accountId: overrides.accountId ?? "account-1",
    valuationDate: overrides.valuationDate ?? "2026-03-17",
    accountCurrency: overrides.accountCurrency ?? "USD",
    baseCurrency: overrides.baseCurrency ?? "USD",
    fxRateToBase: overrides.fxRateToBase ?? 1,
    cashBalance: overrides.cashBalance ?? 0,
    investmentMarketValue: overrides.investmentMarketValue ?? 0,
    totalValue: overrides.totalValue ?? 0,
    costBasis: overrides.costBasis ?? 0,
    bookBasis: overrides.bookBasis ?? overrides.costBasis ?? overrides.cashBalance ?? 0,
    netContribution: overrides.netContribution ?? 0,
    cashBalanceBase: overrides.cashBalanceBase ?? overrides.cashBalance ?? 0,
    investmentMarketValueBase:
      overrides.investmentMarketValueBase ?? overrides.investmentMarketValue ?? 0,
    totalValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 0,
    costBasisBase: overrides.costBasisBase ?? overrides.costBasis ?? 0,
    bookBasisBase: overrides.bookBasisBase ?? overrides.bookBasis ?? overrides.costBasis ?? 0,
    netContributionBase: overrides.netContributionBase ?? overrides.netContribution ?? 0,
    externalInflowBase: overrides.externalInflowBase ?? 0,
    externalOutflowBase: overrides.externalOutflowBase ?? 0,
    externalFlowSource: overrides.externalFlowSource ?? "UNKNOWN",
    performanceEligibleValueBase:
      overrides.performanceEligibleValueBase ?? overrides.totalValue ?? 0,
    valueStatus: overrides.valueStatus ?? "complete",
    basisStatus: overrides.basisStatus ?? "notApplicable",
    calculatedAt: overrides.calculatedAt ?? "2026-03-17T00:00:00Z",
  };
}

function createCurrentValuation(
  overrides: Partial<CurrentAccountValuation>,
): CurrentAccountValuation {
  return {
    accountId: overrides.accountId ?? "account-1",
    accountCurrency: overrides.accountCurrency ?? "USD",
    baseCurrency: overrides.baseCurrency ?? "USD",
    cashBalance: overrides.cashBalance ?? 0,
    investmentMarketValue: overrides.investmentMarketValue ?? 0,
    totalValue: overrides.totalValue ?? 0,
    cashBalanceBase: overrides.cashBalanceBase ?? overrides.cashBalance ?? 0,
    investmentMarketValueBase:
      overrides.investmentMarketValueBase ?? overrides.investmentMarketValue ?? 0,
    totalValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 0,
    sourceDataAsOf: overrides.sourceDataAsOf ?? "2026-03-17T11:59:00Z",
    calculatedAt: overrides.calculatedAt ?? "2026-03-17T12:00:00Z",
    warnings: overrides.warnings ?? [],
  };
}

interface PerformanceFixture {
  pnl: number | null;
  returnValue: number | null;
  dataQuality?: PerformanceResult["dataQuality"];
}

function createPerformanceResult(
  overrides: Partial<PerformanceResult> & Partial<PerformanceFixture> = {},
): PerformanceResult {
  const returnValue = overrides.returnValue ?? null;
  const pnl = overrides.pnl ?? null;

  return {
    scope: overrides.scope ?? { id: "performance-1", currency: "USD" },
    period: overrides.period ?? { startDate: null, endDate: null },
    mode: overrides.mode ?? "timeWeighted",
    returns: overrides.returns ?? {
      twr: returnValue,
      annualizedTwr: null,
      irr: null,
      annualizedIrr: null,
      valueReturn: returnValue,
    },
    attribution: overrides.attribution ?? {
      contributions: 0,
      distributions: 0,
      income: 0,
      realizedPnl: 0,
      unrealizedPnlChange: pnl ?? 0,
      fxEffect: 0,
      fees: 0,
      taxes: 0,
      residual: 0,
    },
    risk: overrides.risk ?? {
      volatility: null,
      maxDrawdown: null,
      peakDate: null,
      troughDate: null,
      recoveryDate: null,
      drawdownDurationDays: null,
    },
    dataQuality: overrides.dataQuality ?? {
      status: "ok",
      warnings: [],
      notApplicableReasons: [],
    },
    summary: overrides.summary ?? {
      amount: pnl,
      percent: returnValue,
      method: overrides.mode ?? "timeWeighted",
      basis: overrides.isMixedTrackingMode ? "mixed" : "marketValue",
      quality: overrides.dataQuality?.status ?? "ok",
      amountStatus: pnl == null ? "unavailable" : "complete",
      percentStatus: returnValue == null ? "unavailable" : "complete",
      basisStatus: overrides.basisStatus ?? "notApplicable",
      reasons: [
        ...(overrides.dataQuality?.warnings ?? []),
        ...(overrides.dataQuality?.notApplicableReasons ?? []),
      ],
    },
    basisStatus: overrides.basisStatus,
    series: overrides.series ?? [],
    isHoldingsMode: overrides.isHoldingsMode,
    isMixedTrackingMode: overrides.isMixedTrackingMode,
  };
}

function renderAccountsSummary({
  accounts,
  valuations,
  currentValuations,
  performanceByAccountId = {},
  performanceByScopeKey = {},
  isPerformanceLoading = false,
}: {
  accounts: Account[];
  valuations: AccountValuation[];
  currentValuations?: CurrentAccountValuation[];
  performanceByAccountId?: Record<string, PerformanceFixture>;
  performanceByScopeKey?: Record<string, PerformanceFixture>;
  isPerformanceLoading?: boolean;
}) {
  mockUseSettingsContext.mockReturnValue({
    settings: mockSettings,
    isLoading: false,
    isError: false,
    updateBaseCurrency: vi.fn(),
    updateSettings: vi.fn(),
    refetch: vi.fn(),
    accountsGrouped: true,
    setAccountsGrouped: vi.fn(),
  } as unknown as ReturnType<typeof useSettingsContext>);

  mockUseAccounts.mockReturnValue({
    accounts,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });

  mockUseLatestValuations.mockReturnValue({
    latestValuations: valuations,
    isLoading: false,
    error: null,
  });

  const defaultCurrentValuations = valuations.map((valuation) =>
    createCurrentValuation({
      accountId: valuation.accountId,
      accountCurrency: valuation.accountCurrency,
      baseCurrency: valuation.baseCurrency,
      cashBalance: valuation.cashBalance,
      investmentMarketValue: valuation.investmentMarketValue,
      totalValue: valuation.totalValue,
      cashBalanceBase: valuation.cashBalanceBase,
      investmentMarketValueBase: valuation.investmentMarketValueBase,
      totalValueBase: valuation.totalValueBase,
      calculatedAt: valuation.calculatedAt,
    }),
  );

  mockUseCurrentAccountValuations.mockReturnValue({
    currentAccountValuations: currentValuations ?? defaultCurrentValuations,
    isLoading: false,
    isFetching: false,
    error: null,
  });

  const performanceSummaries: Record<string, PerformanceResult> = {};
  for (const account of accounts) {
    const performance = performanceByAccountId[account.id] ?? {
      pnl: null,
      returnValue: null,
    };
    performanceSummaries[`accounts:${account.id}`] = createPerformanceResult({
      scope: { id: `accounts:${account.id}`, currency: "USD" },
      pnl: performance.pnl,
      returnValue: performance.returnValue,
      dataQuality: performance.dataQuality,
    });
  }

  const groups = new Map<string, Account[]>();
  for (const account of accounts) {
    const groupName = account.group ?? "Uncategorized";
    if (groupName === "Uncategorized") continue;
    groups.set(groupName, [...(groups.get(groupName) ?? []), account]);
  }
  for (const groupAccounts of groups.values()) {
    if (groupAccounts.length < 2) continue;
    const ids = groupAccounts.map((account) => account.id);
    const key = `accounts:${[...ids].sort().join(",")}`;
    const explicitGroupPerformance = performanceByScopeKey[key];
    const gain = ids.reduce((sum, id) => sum + (performanceByAccountId[id]?.pnl ?? 0), 0);
    const firstReturn = ids
      .map((id) => performanceByAccountId[id]?.returnValue)
      .find((value): value is number => value !== null && value !== undefined);
    performanceSummaries[key] = createPerformanceResult({
      scope: { id: key, currency: "USD" },
      pnl: explicitGroupPerformance?.pnl ?? gain,
      returnValue: explicitGroupPerformance?.returnValue ?? firstReturn ?? null,
      dataQuality: explicitGroupPerformance?.dataQuality,
    });
  }

  mockUseQuery.mockReturnValue({
    isLoading: isPerformanceLoading,
    data: performanceSummaries,
  } as unknown as ReturnType<typeof useQuery>);

  mockCalculatePerformanceSummaries.mockResolvedValue(performanceSummaries);

  return render(
    <MemoryRouter>
      <AccountsSummary />
    </MemoryRouter>,
  );
}

function getLastPerformanceScopes(): PerformanceSummaryScope[] {
  const lastCall = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1];
  const options = lastCall?.[0] as { queryKey?: unknown[] } | undefined;
  return (options?.queryKey?.[2] ?? []) as PerformanceSummaryScope[];
}

function getLastPerformanceQueryPlaceholderData(): unknown {
  const lastCall = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1];
  const options = lastCall?.[0] as { placeholderData?: unknown } | undefined;
  return options?.placeholderData;
}

describe("AccountsSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests performance for visible grouped dashboard rows only", async () => {
    const user = userEvent.setup();

    renderAccountsSummary({
      accounts: [
        createAccount({ id: "group-a-1", name: "Group A One", group: "Group A" }),
        createAccount({ id: "group-a-2", name: "Group A Two", group: "Group A" }),
        createAccount({ id: "standalone", name: "Standalone" }),
        createAccount({ id: "single-group", name: "Single Group", group: "Single Group" }),
      ],
      valuations: [
        createValuation({ accountId: "group-a-1", totalValue: 100 }),
        createValuation({ accountId: "group-a-2", totalValue: 200 }),
        createValuation({ accountId: "standalone", totalValue: 300 }),
        createValuation({ accountId: "single-group", totalValue: 400 }),
      ],
    });

    expect(getLastPerformanceScopes()).toEqual([
      { accountIds: ["group-a-1", "group-a-2"] },
      { accountIds: ["standalone"] },
      { accountIds: ["single-group"] },
    ]);

    await user.click(screen.getByText("Group A"));

    expect(getLastPerformanceScopes()).toEqual([
      { accountIds: ["group-a-1", "group-a-2"] },
      { accountIds: ["group-a-1"] },
      { accountIds: ["group-a-2"] },
      { accountIds: ["standalone"] },
      { accountIds: ["single-group"] },
    ]);
  });

  it("keeps standalone account values visible while performance is loading", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "live-account", name: "Live Account" })],
      valuations: [
        createValuation({
          accountId: "live-account",
          totalValue: 125,
          totalValueBase: 125,
        }),
      ],
      isPerformanceLoading: true,
    });

    const row = screen.getByText("Live Account").closest("a");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("value:USD:125")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByTestId("account-summary-performance-placeholder"),
    ).toBeInTheDocument();
    expect(getLastPerformanceQueryPlaceholderData()).toBe(keepPreviousData);
  });

  it("shows consistent secondary metrics for expanded grouped child rows", async () => {
    const user = userEvent.setup();

    renderAccountsSummary({
      accounts: [
        createAccount({ id: "a-positive", name: "Positive Gain", group: "Brokerage" }),
        createAccount({ id: "a-zero", name: "Zero Gain", group: "Brokerage" }),
        createAccount({ id: "a-missing", name: "Missing Valuation", group: "Brokerage" }),
      ],
      valuations: [
        createValuation({
          accountId: "a-positive",
          totalValue: 110,
          netContribution: 100,
          investmentMarketValue: 110,
          costBasis: 100,
        }),
        createValuation({
          accountId: "a-zero",
          totalValue: 100,
          netContribution: 100,
          investmentMarketValue: 100,
          costBasis: 100,
        }),
      ],
      performanceByAccountId: {
        "a-positive": {
          pnl: 10,
          returnValue: 0.1,
        },
        "a-zero": {
          pnl: 0,
          returnValue: 0,
        },
      },
      performanceByScopeKey: {
        "accounts:a-missing,a-positive,a-zero": {
          pnl: 17,
          returnValue: 0.07,
        },
      },
    });

    expect(screen.getByText("gain-amount:USD:true:17")).toBeInTheDocument();
    expect(screen.getByText("gain-percent:0.07")).toBeInTheDocument();

    await user.click(screen.getByText("Brokerage"));

    expect(screen.getAllByTestId("account-summary-secondary-metric")).toHaveLength(4);

    const positiveRow = screen.getByText("Positive Gain").closest("a");
    expect(positiveRow).not.toBeNull();
    expect(within(positiveRow as HTMLElement).getByText("value:USD:110")).toBeInTheDocument();
    expect(
      within(positiveRow as HTMLElement).getByText("gain-amount:USD:true:10"),
    ).toBeInTheDocument();
    expect(within(positiveRow as HTMLElement).getByText("gain-percent:0.1")).toBeInTheDocument();

    const zeroRow = screen.getByText("Zero Gain").closest("a");
    expect(zeroRow).not.toBeNull();
    expect(within(zeroRow as HTMLElement).getByText("value:USD:100")).toBeInTheDocument();
    expect(within(zeroRow as HTMLElement).getByText("gain-amount:USD:true:0")).toBeInTheDocument();
    expect(within(zeroRow as HTMLElement).getByText("gain-percent:0")).toBeInTheDocument();

    const missingRow = screen.getByText("Missing Valuation").closest("a");
    expect(missingRow).not.toBeNull();
    expect(within(missingRow as HTMLElement).getByText("value:USD:0")).toBeInTheDocument();
    expect(
      within(missingRow as HTMLElement).getByTestId("account-summary-secondary-placeholder"),
    ).toHaveTextContent("-");
  });

  it("uses current account valuations for displayed account values instead of stale daily valuations", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "live-account", name: "Live Account" })],
      valuations: [
        createValuation({
          accountId: "live-account",
          totalValue: 100,
          totalValueBase: 100,
        }),
      ],
      currentValuations: [
        createCurrentValuation({
          accountId: "live-account",
          totalValue: 125,
          totalValueBase: 125,
        }),
      ],
      performanceByAccountId: {
        "live-account": {
          pnl: 25,
          returnValue: 0.25,
        },
      },
    });

    const row = screen.getByText("Live Account").closest("a");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("value:USD:125")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("value:USD:100")).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("gain-percent:0.25")).toBeInTheDocument();
  });

  it("displays a foreign-currency account in its own currency, not the base currency", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "cad-account", name: "CAD Account", currency: "CAD" })],
      valuations: [
        createValuation({
          accountId: "cad-account",
          accountCurrency: "CAD",
          baseCurrency: "USD",
          totalValue: 150,
          totalValueBase: 110,
        }),
      ],
      performanceByAccountId: {
        "cad-account": {
          pnl: 10,
          returnValue: 0.08,
        },
      },
    });

    const row = screen.getByText("CAD Account").closest("a");
    expect(row).not.toBeNull();
    // Value is shown in the account's own currency (CAD), not the USD base currency.
    expect(within(row as HTMLElement).getByText("value:CAD:150")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("value:USD:110")).not.toBeInTheDocument();
    // Return percent is currency-agnostic and still shown.
    expect(within(row as HTMLElement).getByText("gain-percent:0.08")).toBeInTheDocument();
    // P&L amount is only computed in base currency for foreign accounts, so it is
    // omitted here rather than mislabeled as CAD.
    expect(within(row as HTMLElement).queryByText(/^gain-amount:/)).not.toBeInTheDocument();
  });

  it("keeps bad-data warnings for foreign-currency accounts when only base P&L is available", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "cad-account", name: "CAD Account", currency: "CAD" })],
      valuations: [
        createValuation({
          accountId: "cad-account",
          accountCurrency: "CAD",
          baseCurrency: "USD",
          totalValue: 150,
          totalValueBase: 110,
        }),
      ],
      performanceByAccountId: {
        "cad-account": {
          pnl: 10,
          returnValue: null,
        },
      },
    });

    const row = screen.getByText("CAD Account").closest("a");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("value:CAD:150")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/^gain-amount:/)).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(
        "Return % unavailable - activity history may be inconsistent.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the group header behavior unchanged when grouped totals have zero gain", async () => {
    const user = userEvent.setup();

    renderAccountsSummary({
      accounts: [
        createAccount({ id: "a-one", name: "Account One", group: "Cash Group" }),
        createAccount({ id: "a-two", name: "Account Two", group: "Cash Group" }),
      ],
      valuations: [
        createValuation({
          accountId: "a-one",
          totalValue: 100,
          netContribution: 100,
        }),
        createValuation({
          accountId: "a-two",
          totalValue: 200,
          netContribution: 200,
        }),
      ],
      performanceByAccountId: {
        "a-one": {
          pnl: 0,
          returnValue: 0,
        },
        "a-two": {
          pnl: 0,
          returnValue: 0,
        },
      },
    });

    expect(screen.queryByTestId("account-summary-secondary-metric")).not.toBeInTheDocument();

    await user.click(screen.getByText("Cash Group"));

    expect(screen.getAllByTestId("account-summary-secondary-metric")).toHaveLength(2);
  });

  it("preserves bad-data warning behavior while keeping a placeholder slot for nested rows", async () => {
    const user = userEvent.setup();

    renderAccountsSummary({
      accounts: [
        createAccount({ id: "a-bad", name: "Bad Data", group: "Brokerage" }),
        createAccount({ id: "a-good", name: "Good Data", group: "Brokerage" }),
      ],
      valuations: [
        createValuation({
          accountId: "a-bad",
          totalValue: 125,
        }),
        createValuation({
          accountId: "a-good",
          totalValue: 150,
        }),
      ],
      performanceByAccountId: {
        "a-bad": {
          pnl: 25,
          returnValue: null,
        },
        "a-good": {
          pnl: 50,
          returnValue: 0.5,
        },
      },
    });

    await user.click(screen.getByText("Brokerage"));

    const badRow = screen.getByText("Bad Data").closest("a");
    expect(badRow).not.toBeNull();
    expect(within(badRow as HTMLElement).getByTestId("account-summary-secondary-placeholder"));
    expect(
      within(badRow as HTMLElement).queryByText("gain-amount:USD:true:25"),
    ).not.toBeInTheDocument();

    expect(within(badRow as HTMLElement).getByText(/return % unavailable/i)).toBeInTheDocument();
  });

  it("uses holdings-mode copy when a holdings account has unavailable return percent", () => {
    renderAccountsSummary({
      accounts: [
        createAccount({
          id: "holdings-account",
          name: "Holdings Account",
          trackingMode: "HOLDINGS",
        }),
      ],
      valuations: [
        createValuation({
          accountId: "holdings-account",
          totalValue: 125,
        }),
      ],
      performanceByAccountId: {
        "holdings-account": {
          pnl: 25,
          returnValue: null,
        },
      },
    });

    const row = screen.getByText("Holdings Account").closest("a");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        "Return % unavailable - missing cost basis or starting holdings value.",
      ),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText(/activity history may be inconsistent/i),
    ).not.toBeInTheDocument();
  });

  it("does not flag normal transaction-mode not-applicable details as dashboard warnings", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "td-invest", name: "TD Invest" })],
      valuations: [
        createValuation({
          accountId: "td-invest",
          totalValue: 29548.37,
        }),
      ],
      performanceByAccountId: {
        "td-invest": {
          pnl: 2522.37,
          returnValue: 0.0933,
          dataQuality: {
            status: "ok",
            warnings: [],
            notApplicableReasons: [
              "Value return unavailable for transaction-mode scopes; use TWR or IRR.",
            ],
          },
        },
      },
    });

    expect(screen.getByText("TD Invest")).toBeInTheDocument();
    expect(screen.getByText("gain-percent:0.0933")).toBeInTheDocument();
    expect(
      screen.queryByText(/value return unavailable for transaction-mode/i),
    ).not.toBeInTheDocument();
  });

  it("does not show backend performance warnings on dashboard rows", () => {
    renderAccountsSummary({
      accounts: [createAccount({ id: "business", name: "Business Investment" })],
      valuations: [
        createValuation({
          accountId: "business",
          totalValue: 71438.32,
        }),
      ],
      performanceByAccountId: {
        business: {
          pnl: -17013.7,
          returnValue: -0.1923,
          dataQuality: {
            status: "partial",
            warnings: ["Backend performance warning that belongs outside dashboard rows."],
            notApplicableReasons: [],
          },
        },
      },
    });

    expect(screen.getByText("Business Investment")).toBeInTheDocument();
    expect(screen.getByText("gain-percent:-0.1923")).toBeInTheDocument();
    expect(screen.queryByText(/backend performance warning/i)).not.toBeInTheDocument();
  });
});
