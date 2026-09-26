import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoldingType } from "@/lib/constants";
import type {
  Account,
  AllocationTarget,
  AllocationWorksheetResult,
  CalculatedAdjustments,
  DriftReport,
  Holding,
} from "@/lib/types";
import { render, screen, waitFor, within } from "@/test/render";

import { AllocationWorksheetTab } from "./allocation-worksheet-tab";

const { generateMock, previewMock, accountsRef, heldAccountIds } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  previewMock: vi.fn(),
  accountsRef: { current: [] as Account[] },
  /** Which accounts record VTI, which decides whether an increase is placed for the user (§6). */
  heldAccountIds: { current: ["acc-1"] as string[] },
}));

vi.mock("../hooks/use-calculated-adjustments", () => ({
  useCalculatedAdjustments: () => ({ mutateAsync: generateMock, isPending: false }),
}));
vi.mock("../hooks/use-allocation-worksheet", () => ({
  useAllocationWorksheet: () => ({ mutateAsync: previewMock, isPending: false, reset: vi.fn() }),
}));
vi.mock("@/adapters", () => ({
  getHoldingsList: vi.fn((filter: { accountId: string }) =>
    Promise.resolve(holdingsFor(filter.accountId)),
  ),
  getAssetTaxonomyAssignments: vi.fn(() => Promise.resolve([])),
  canonicalizeEligibleAssetIds: (ids?: readonly string[]) =>
    ids === undefined ? undefined : [...new Set(ids)].sort(),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: accountsRef.current, isLoading: false }),
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-sync-market-data", () => ({
  useSyncMarketDataMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomy: () => ({ data: undefined, dataUpdatedAt: 0 }),
}));
vi.mock("@/pages/asset/hooks/use-assets", () => ({
  useAssets: () => ({
    assets: [{ id: "vti", kind: "INVESTMENT", isActive: true, displayCode: "VTI", name: "VTI" }],
    isLoading: false,
  }),
}));
vi.mock("@/pages/asset/hooks/use-latest-quotes", () => ({
  useLatestQuotes: () => ({ data: {}, dataUpdatedAt: 0, isFetched: true }),
}));
vi.mock("@/pages/settings/general/exchange-rates/use-exchange-rate", () => ({
  useExchangeRates: () => ({ dataUpdatedAt: 0 }),
}));

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

function account(id: string, name: string): Account {
  return { id, name, isActive: true } as Account;
}

function holdingsFor(accountId: string): Holding[] {
  if (!heldAccountIds.current.includes(accountId)) return [];
  return [
    {
      id: `${accountId}-vti`,
      accountId,
      holdingType: HoldingType.SECURITY,
      instrument: { id: "vti", symbol: "VTI", name: "Total market", currency: "USD" },
      quantity: 10,
      marketValue: { local: 1000, base: 1000 },
    } as Holding,
  ];
}

/** An in-memory stand-in: the test environment's storage has no `clear`. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

function acknowledgeDisclosure() {
  vi.stubGlobal("localStorage", memoryStorage());
  localStorage.setItem(
    "wealthfolio:rebalancing-worksheet-disclosure:v2",
    JSON.stringify({ version: 2 }),
  );
}

const profile: AllocationTarget = {
  id: "target-1",
  name: "Balanced",
  scopeType: "all",
  taxonomyId: "asset_classes",
  triggerType: "manual",
  driftBandBps: 500,
  bandType: "absolute",
  relativeFactorBps: 10000,
  rebalanceGoal: "exact_target",
  minTradeAmount: "0",
  wholeSharesOnly: false,
  allowSells: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const driftReport: DriftReport = {
  targetId: profile.id,
  scopeType: "all",
  totalValue: 3000,
  baseCurrency: "USD",
  maxDriftBps: 0,
  outOfBandCount: 0,
  rows: [],
  deployableCash: 2000,
};

const calculated: CalculatedAdjustments = {
  mode: "invest_cash",
  rule: "current_holding_proportions",
  adjustments: [
    {
      lineId: "calc:vti:unassigned",
      direction: "increase",
      assetId: "vti",
      symbol: "VTI",
      accountId: null,
      amount: 1200,
      quantity: 12,
      unitPrice: 100,
      isBelowMinimum: false,
    },
  ],
  unresolved: [],
  scaling: {},
  remainingCash: 0,
  fundingShortfalls: [],
};

const previewResult: AllocationWorksheetResult = {
  targetId: profile.id,
  targetName: profile.name,
  baseCurrency: "USD",
  calculatedAt: "2026-01-01T00:00:00Z",
  sourceFingerprint: "fingerprint",
  resolvedAccountIds: ["acc-1"],
  observedTrackedCash: 2000,
  trackedCashToUse: 0,
  externalContribution: 0,
  increaseTotal: 0,
  reductionTotal: 0,
  cashRemaining: 0,
  maxDifferenceBpsBefore: 0,
  maxDifferenceBpsAfter: 0,
  lines: [],
  categories: [],
  accountFunding: [],
  warnings: [],
  sourceRecords: [],
};

async function renderWorksheet() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Providers = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(
    <AllocationWorksheetTab
      profile={profile}
      driftReport={driftReport}
      accountScope={{ type: "all" }}
      sourceVersion="source-1"
      isSourceLoading={false}
    />,
    { wrapper: Providers },
  );
  await screen.findByRole("button", { name: /Recalculate from target/ });
  return user;
}

async function calculateFromTarget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Allocate by current holding proportions/ }));
  await user.click(screen.getByRole("button", { name: /Recalculate from target/ }));
  await waitFor(() => expect(screen.getByLabelText("Change for VTI")).toHaveValue("1200"));
}

describe("AllocationWorksheetTab regeneration (§5)", () => {
  beforeEach(() => {
    acknowledgeDisclosure();
    accountsRef.current = [account("acc-1", "Brokerage")];
    heldAccountIds.current = ["acc-1"];
    generateMock.mockReset().mockResolvedValue(calculated);
    previewMock.mockReset().mockResolvedValue(previewResult);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not calculate adjustments until an allocation rule is chosen", async () => {
    await renderWorksheet();

    expect(screen.getByRole("button", { name: /Recalculate from target/ })).toBeDisabled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("prefills the worksheet when the user recalculates from target", async () => {
    const user = await renderWorksheet();
    // The cash to deploy follows what the chosen accounts record, which the
    // core reports rather than the drift report.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Cash to deploy" })).toHaveValue("2000"),
    );

    await calculateFromTarget(user);

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.lastCall?.[0]).toMatchObject({
      targetId: "target-1",
      mode: "invest_cash",
      rule: "current_holding_proportions",
      cash: { trackedCashToUse: 2000, externalContribution: {} },
      selectedAccountIds: ["acc-1"],
      eligibleAssetIds: undefined,
    });
  });

  it("previews an edited line without calculating adjustments again", async () => {
    const user = await renderWorksheet();
    await calculateFromTarget(user);
    previewMock.mockClear();

    const input = screen.getByLabelText("Change for VTI");
    await user.clear(input);
    await user.type(input, "500");

    await waitFor(() => expect(previewMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("restores the calculated adjustments on reset without calculating again", async () => {
    const user = await renderWorksheet();
    await calculateFromTarget(user);

    const input = screen.getByLabelText("Change for VTI");
    await user.clear(input);
    await user.type(input, "5");
    await user.click(screen.getByRole("button", { name: /Reset to calculated adjustments/ }));

    expect(screen.getByLabelText("Change for VTI")).toHaveValue("1200");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("marks the worksheet out of date when an input changes, and leaves it alone", async () => {
    const user = await renderWorksheet();
    await calculateFromTarget(user);

    const cashInput = screen.getByRole("textbox", { name: "Cash to deploy" });
    await user.clear(cashInput);
    await user.type(cashInput, "100");

    expect(await screen.findByText(/Inputs changed since these adjustments/)).toBeInTheDocument();
    expect(screen.getByLabelText("Change for VTI")).toHaveValue("1200");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("AllocationWorksheetTab account allocation (§6)", () => {
  beforeEach(() => {
    acknowledgeDisclosure();
    heldAccountIds.current = ["acc-1"];
    generateMock.mockReset().mockResolvedValue(calculated);
    previewMock.mockReset().mockResolvedValue(previewResult);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves an increase unallocated when several accounts could receive it", async () => {
    accountsRef.current = [account("acc-1", "Brokerage"), account("acc-2", "Retirement")];
    // Both record the security, so placing it would be a choice between them.
    heldAccountIds.current = ["acc-1", "acc-2"];
    const user = await renderWorksheet();

    await calculateFromTarget(user);
    // The empty worksheet may be previewed on mount, before the calculation.
    previewMock.mockClear();

    const allocation = screen
      .getByText("Account allocation")
      .closest<HTMLElement>("[data-account-allocation]")!;
    expect(within(allocation).getByText("$1,200.00 remaining")).toBeInTheDocument();
    expect(within(allocation).getByLabelText("Amount for Brokerage")).toHaveValue("");
    expect(within(allocation).getByLabelText("Amount for Retirement")).toHaveValue("");
    // Wait past the preview debounce, or the check below cannot fail.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("places an increase in the only account recording the security", async () => {
    // A fact about where the security sits, not a choice between accounts (§6).
    accountsRef.current = [account("acc-1", "Brokerage"), account("acc-2", "Retirement")];
    heldAccountIds.current = ["acc-1"];
    const user = await renderWorksheet();

    await calculateFromTarget(user);

    const allocation = screen
      .getByText("Account allocation")
      .closest<HTMLElement>("[data-account-allocation]")!;
    expect(within(allocation).getByText("Fully allocated")).toBeInTheDocument();
    expect(within(allocation).getByLabelText("Amount for Brokerage")).toHaveValue("1200");
    expect(within(allocation).getByLabelText("Amount for Retirement")).toHaveValue("");
  });

  it("previews a worksheet with no adjustments instead of refusing it", async () => {
    accountsRef.current = [account("acc-1", "Brokerage")];
    await renderWorksheet();

    await waitFor(() => expect(previewMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(previewMock.mock.lastCall?.[0]).toMatchObject({
      lines: [],
      selectedAccountIds: ["acc-1"],
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("leaves an account the user removed out of the calculation", async () => {
    accountsRef.current = [account("acc-1", "Brokerage"), account("acc-2", "Retirement")];
    const user = await renderWorksheet();

    await user.click(screen.getByRole("button", { name: "Retirement" }));
    await user.click(
      screen.getByRole("button", { name: /Allocate by current holding proportions/ }),
    );
    await user.click(screen.getByRole("button", { name: /Recalculate from target/ }));

    await waitFor(() => expect(generateMock).toHaveBeenCalled());
    expect(generateMock.mock.lastCall?.[0]).toMatchObject({ selectedAccountIds: ["acc-1"] });
  });

  it("caps the cash to deploy at what the chosen accounts record", async () => {
    accountsRef.current = [account("acc-1", "Brokerage")];
    const user = await renderWorksheet();
    const cashInput = screen.getByRole("textbox", { name: "Cash to deploy" });
    await waitFor(() => expect(cashInput).toHaveValue("2000"));

    await user.clear(cashInput);
    await user.type(cashInput, "5000");
    await user.tab();

    expect(cashInput).toHaveValue("2000");
    await waitFor(() =>
      expect(previewMock.mock.lastCall?.[0]).toMatchObject({
        cash: { trackedCashToUse: 2000 },
      }),
    );
  });

  it("asks for cash not yet recorded per account only when several are in scope", async () => {
    accountsRef.current = [account("acc-1", "Brokerage")];
    await renderWorksheet();
    expect(screen.getByRole("textbox", { name: "Cash not yet recorded" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cash not yet recorded in/)).not.toBeInTheDocument();
  });
});
