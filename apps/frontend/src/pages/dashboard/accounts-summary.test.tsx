import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculatePerformanceSummary } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useLatestValuations } from "@/hooks/use-latest-valuations";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  Account,
  AccountValuation,
  PerformanceMetrics,
  Settings,
  TrackingMode,
} from "@/lib/types";
import { AccountType } from "@/lib/types";
import { useQueries } from "@tanstack/react-query";
import { AccountsSummary } from "./accounts-summary";

vi.mock("@/adapters", () => ({
  calculatePerformanceSummary: vi.fn(),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: vi.fn(),
}));

vi.mock("@/hooks/use-latest-valuations", () => ({
  useLatestValuations: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueries: vi.fn(),
}));

vi.mock("@wealthfolio/ui", () => ({
  PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`value:${currency}:${value}`}</span>
  ),
  GainAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`gain-amount:${currency}:${value}`}</span>
  ),
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

const mockCalculatePerformanceSummary = vi.mocked(calculatePerformanceSummary);
const mockUseAccounts = vi.mocked(useAccounts);
const mockUseLatestValuations = vi.mocked(useLatestValuations);
const mockUseSettingsContext = vi.mocked(useSettingsContext);
const mockUseQueries = vi.mocked(useQueries);

const mockSettings: Settings = {
  theme: "light",
  font: "font-sans",
  baseCurrency: "USD",
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
    netContribution: overrides.netContribution ?? 0,
    cashBalanceBase: overrides.cashBalanceBase ?? overrides.cashBalance ?? 0,
    investmentMarketValueBase:
      overrides.investmentMarketValueBase ?? overrides.investmentMarketValue ?? 0,
    totalValueBase: overrides.totalValueBase ?? overrides.totalValue ?? 0,
    costBasisBase: overrides.costBasisBase ?? overrides.costBasis ?? 0,
    netContributionBase: overrides.netContributionBase ?? overrides.netContribution ?? 0,
    externalInflowBase: overrides.externalInflowBase ?? 0,
    externalOutflowBase: overrides.externalOutflowBase ?? 0,
    performanceEligibleValueBase:
      overrides.performanceEligibleValueBase ?? overrides.totalValue ?? 0,
    calculatedAt: overrides.calculatedAt ?? "2026-03-17T00:00:00Z",
  };
}

function createPerformanceMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    id: overrides.id ?? "performance-1",
    returns: overrides.returns ?? [],
    periodStartDate: overrides.periodStartDate ?? null,
    periodEndDate: overrides.periodEndDate ?? null,
    currency: overrides.currency ?? "USD",
    periodGain: overrides.periodGain ?? 0,
    periodReturn: overrides.periodReturn ?? 0,
    cumulativeTwr: overrides.cumulativeTwr ?? null,
    gainLossAmount: overrides.gainLossAmount ?? null,
    annualizedTwr: overrides.annualizedTwr ?? null,
    simpleReturn: overrides.simpleReturn ?? 0,
    annualizedSimpleReturn: overrides.annualizedSimpleReturn ?? 0,
    cumulativeModifiedDietz: overrides.cumulativeModifiedDietz ?? overrides.cumulativeMwr ?? null,
    annualizedModifiedDietz: overrides.annualizedModifiedDietz ?? overrides.annualizedMwr ?? null,
    cumulativeMwr: overrides.cumulativeMwr ?? null,
    annualizedMwr: overrides.annualizedMwr ?? null,
    volatility: overrides.volatility ?? 0,
    maxDrawdown: overrides.maxDrawdown ?? 0,
    isHoldingsMode: overrides.isHoldingsMode,
  };
}

function renderAccountsSummary({
  accounts,
  valuations,
  performanceByAccountId = {},
}: {
  accounts: Account[];
  valuations: AccountValuation[];
  performanceByAccountId?: Record<
    string,
    {
      periodGain: number | null;
      periodReturn: number | null;
    }
  >;
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

  mockUseQueries.mockImplementation(({ queries }: { queries: { queryKey: unknown[] }[] }) =>
    queries.map((query) => {
      const accountId = String(query.queryKey[2]);
      return {
        isLoading: false,
        data: performanceByAccountId[accountId],
      };
    }),
  );

  mockCalculatePerformanceSummary.mockResolvedValue(createPerformanceMetrics());

  return render(
    <MemoryRouter>
      <AccountsSummary />
    </MemoryRouter>,
  );
}

describe("AccountsSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          periodGain: 10,
          periodReturn: 0.1,
        },
        "a-zero": {
          periodGain: 0,
          periodReturn: 0,
        },
      },
    });

    await user.click(screen.getByText("Brokerage"));

    expect(screen.getAllByTestId("account-summary-secondary-metric")).toHaveLength(4);

    const positiveRow = screen.getByText("Positive Gain").closest("a");
    expect(positiveRow).not.toBeNull();
    expect(within(positiveRow as HTMLElement).getByText("value:USD:110")).toBeInTheDocument();
    expect(within(positiveRow as HTMLElement).getByText("gain-amount:USD:10")).toBeInTheDocument();
    expect(within(positiveRow as HTMLElement).getByText("gain-percent:0.1")).toBeInTheDocument();

    const zeroRow = screen.getByText("Zero Gain").closest("a");
    expect(zeroRow).not.toBeNull();
    expect(within(zeroRow as HTMLElement).getByText("value:USD:100")).toBeInTheDocument();
    expect(within(zeroRow as HTMLElement).getByText("gain-amount:USD:0")).toBeInTheDocument();
    expect(within(zeroRow as HTMLElement).getByText("gain-percent:0")).toBeInTheDocument();

    const missingRow = screen.getByText("Missing Valuation").closest("a");
    expect(missingRow).not.toBeNull();
    expect(within(missingRow as HTMLElement).getByText("value:USD:0")).toBeInTheDocument();
    expect(
      within(missingRow as HTMLElement).getByTestId("account-summary-secondary-placeholder"),
    ).toHaveTextContent("-");
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
          periodGain: 0,
          periodReturn: 0,
        },
        "a-two": {
          periodGain: 0,
          periodReturn: 0,
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
          periodGain: 25,
          periodReturn: null,
        },
        "a-good": {
          periodGain: 50,
          periodReturn: 0.5,
        },
      },
    });

    await user.click(screen.getByText("Brokerage"));

    const badRow = screen.getByText("Bad Data").closest("a");
    expect(badRow).not.toBeNull();
    expect(within(badRow as HTMLElement).getByTestId("account-summary-secondary-placeholder"));
    expect(within(badRow as HTMLElement).queryByText("gain-amount:USD:25")).not.toBeInTheDocument();

    expect(within(badRow as HTMLElement).getByText(/return % unavailable/i)).toBeInTheDocument();
  });
});
