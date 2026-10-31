import { createInstance, type i18n } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enPerformance from "@/i18n/locales/en/performance.json";
import zhPerformance from "@/i18n/locales/zh/performance.json";
import enCommon from "@/i18n/locales/en/common.json";
import zhCommon from "@/i18n/locales/zh/common.json";
import { useAccountScopeStore } from "@/lib/account-scope-store";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, AccountScope, TrackedItem } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PerformancePage from "./performance-page";
import { ALL_PORTFOLIO_ITEM } from "./performance-selection";

const mocks = vi.hoisted(() => ({
  performance: vi.fn(),
  getAccounts: vi.fn(),
  settings: { timezone: "Asia/Shanghai" } as { timezone: string } | null,
  mobile: false,
  dateRangeChange: undefined as undefined | ((range: { from?: Date; to?: Date }) => void),
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: mocks.settings }),
}));
vi.mock("@/adapters", () => ({ getAccounts: mocks.getAccounts }));
vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolios: () => ({ data: [{ id: "p", name: "Retirement" }] }),
}));
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => mocks.mobile,
}));
vi.mock("./hooks/use-performance-data", () => ({
  useCalculatePerformanceHistory: mocks.performance,
}));
vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: () => null,
}));
vi.mock("@/components/account-selector", () => ({
  AccountSelector: ({
    setSelectedAccount,
    onPortfolioSelect,
  }: {
    setSelectedAccount: (account: { id: string; name: string }) => void;
    onPortfolioSelect: (portfolio: { id: string; name: string }) => void;
  }) => (
    <>
      <button onClick={() => setSelectedAccount({ id: "a", name: "Brokerage" })}>
        Toggle comparison account
      </button>
      <button onClick={() => onPortfolioSelect({ id: "p", name: "Retirement" })}>
        Toggle comparison portfolio
      </button>
    </>
  ),
}));
vi.mock("@/components/account-selector-mobile", () => ({
  AccountSelectorMobile: () => null,
}));
vi.mock("@/components/benchmark-symbol-selector", () => ({
  BenchmarkSymbolSelector: () => null,
}));
vi.mock("@/components/benchmark-symbol-selector-mobile", () => ({
  BenchmarkSymbolSelectorMobile: () => null,
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wealthfolio/ui")>();
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    Carousel: Container,
    CarouselContent: Container,
    CarouselItem: Container,
    DateRangeSelector: ({ onChange }: { onChange: typeof mocks.dateRangeChange }) => {
      mocks.dateRangeChange = onChange;
      return null;
    },
  };
});

const accounts = [
  { id: "a", name: "Brokerage", accountType: "SECURITIES", isActive: true },
  { id: "b", name: "Hidden TFSA", accountType: "SECURITIES", isActive: false },
  {
    id: "card",
    name: "Credit Card",
    accountType: "CREDIT_CARD",
    isActive: true,
  },
].map((account) => ({
  ...account,
  isArchived: false,
  currency: "USD",
})) as Account[];
const TWR_WARNING = "Some holdings are missing valuations for part of the period.";

const resultWithWarning = {
  id: ALL_PORTFOLIO_ITEM.id,
  type: "account",
  name: ALL_PORTFOLIO_ITEM.name,
  scope: { id: ALL_PORTFOLIO_ITEM.id, currency: "USD" },
  period: { startDate: "2026-01-01", endDate: "2026-03-01" },
  mode: "timeWeighted",
  returns: {
    twr: 0.1,
    annualizedTwr: 0.2,
    irr: null,
    annualizedIrr: null,
    valueReturn: null,
  },
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
  risk: { volatility: 0.05, maxDrawdown: -0.02 },
  dataQuality: {
    status: "partial",
    warnings: [TWR_WARNING],
    notApplicableReasons: [],
  },
  series: [{ date: "2026-01-01", value: 0 }],
};

const initialState = useAccountScopeStore.getState();

function setScope(scope: AccountScope) {
  act(() => useAccountScopeStore.getState().setScope(scope));
}

function savedItems(): TrackedItem[] {
  return JSON.parse(localStorage.getItem("performance:selectedItems") ?? "[]");
}

function renderPage(seedAccounts = true, i18n?: i18n) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (seedAccounts) {
    client.setQueryData([QueryKeys.ACCOUNTS, false], accounts);
    client.setQueryData([QueryKeys.ACCOUNTS, true], accounts);
  }
  return {
    client,
    ...render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <PerformancePage />
        </QueryClientProvider>
      </StrictMode>,
      {
        wrapper: ({ children }) =>
          i18n ? <I18nextProvider i18n={i18n}>{children}</I18nextProvider> : <>{children}</>,
      },
    ),
  };
}

describe("PerformancePage shared scope", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("dir");
  });

  beforeEach(() => {
    mocks.settings = { timezone: "Asia/Shanghai" };
    mocks.mobile = false;
    localStorage.clear();
    useAccountScopeStore.setState(initialState, true);
    mocks.performance.mockReturnValue({
      data: [],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    mocks.getAccounts.mockResolvedValue(accounts);
  });

  it("updates the default range when settings arrive after the initial render", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T16:30:00Z"));
    mocks.settings = null;
    const { rerender, client } = renderPage();
    mocks.settings = { timezone: "Asia/Shanghai" };
    rerender(
      <StrictMode>
        <QueryClientProvider client={client}>
          <PerformancePage />
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dateRange: { from: new Date(2026, 0, 1), to: new Date(2027, 0, 1) },
      }),
    );
    vi.useRealTimers();
  });

  it("retains and requests a hidden account selected elsewhere", async () => {
    setScope({ type: "account", accountId: "b" });
    renderPage();
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "b"]),
    );
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: savedItems() }),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
  });

  it("requests mixed scopes and credit-card-only scopes instead of leaving the old focus", async () => {
    renderPage();
    setScope({ type: "account", accountId: "a" });
    setScope({ type: "accounts", accountIds: ["a", "card"] });
    await waitFor(() =>
      expect(savedItems().at(-1)?.accountScope).toEqual({
        type: "accounts",
        accountIds: ["a", "card"],
      }),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("accounts:a,card");
    setScope({ type: "account", accountId: "card" });
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "card"]),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("card");
  });

  it("preserves saved comparisons when the account inventory fails to load", async () => {
    const selected: TrackedItem = {
      id: "b",
      type: "account",
      name: "Hidden TFSA",
      accountScope: { type: "account", accountId: "b" },
    };
    localStorage.setItem("performance:selectedItems", JSON.stringify([selected]));
    localStorage.setItem("performance:selectedItemId", JSON.stringify("b"));
    mocks.getAccounts.mockRejectedValue(new Error("offline"));
    const { client } = renderPage(false);
    await waitFor(() =>
      expect(client.getQueryState([QueryKeys.ACCOUNTS, true])?.status).toBe("error"),
    );
    expect(savedItems()).toEqual([selected]);
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
  });

  it("applies the pending scope after the full account inventory loads", async () => {
    let resolveAccounts!: (value: Account[]) => void;
    mocks.getAccounts.mockReturnValue(
      new Promise<Account[]>((resolve) => {
        resolveAccounts = resolve;
      }),
    );
    setScope({ type: "account", accountId: "b" });
    renderPage(false);
    expect(savedItems().some((item) => item.id === "b")).toBe(false);
    await act(async () => resolveAccounts(accounts));
    await waitFor(() => expect(savedItems().some((item) => item.id === "b")).toBe(true));
  });

  it("removes a saved multi-account comparison after a member is deleted, including on remount", async () => {
    const deletedScope: TrackedItem = {
      id: "accounts:a,deleted",
      type: "account",
      name: "Brokerage + Deleted",
      accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
    };
    localStorage.setItem(
      "performance:selectedItems",
      JSON.stringify([ALL_PORTFOLIO_ITEM, deletedScope]),
    );
    localStorage.setItem("performance:selectedItemId", JSON.stringify(deletedScope.id));
    const page = renderPage();
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBeNull();
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: [ALL_PORTFOLIO_ITEM] }),
    );
    page.unmount();
    renderPage();
    expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]);
  });

  it("prunes a deleted member before requesting performance after inventory refresh", async () => {
    setScope({ type: "accounts", accountIds: ["a", "b"] });
    const { client } = renderPage();
    await waitFor(() => expect(savedItems().at(-1)?.id).toBe("accounts:a,b"));
    mocks.performance.mockClear();
    act(() =>
      client.setQueryData(
        [QueryKeys.ACCOUNTS, true],
        accounts.filter((account) => account.id !== "b"),
      ),
    );
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    for (const [request] of mocks.performance.mock.calls) {
      expect(request.selectedItems).toEqual([ALL_PORTFOLIO_ITEM]);
    }
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBeNull();
  });

  it("keeps archived members for the backend to filter rather than treating them as deleted", async () => {
    setScope({ type: "accounts", accountIds: ["a", "b"] });
    const { client } = renderPage();
    await waitFor(() => expect(savedItems().at(-1)?.id).toBe("accounts:a,b"));
    const before = savedItems();
    act(() =>
      client.setQueryData(
        [QueryKeys.ACCOUNTS, true],
        accounts.map((account) => ({
          ...account,
          isArchived: account.id === "b",
        })),
      ),
    );
    await waitFor(() =>
      expect(mocks.performance).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectedItems: before }),
      ),
    );
    expect(savedItems()).toEqual(before);
  });

  it.each([
    {
      scope: { type: "account", accountId: "a" } as AccountScope,
      id: "a",
      picker: "Toggle comparison account",
      name: "Brokerage",
    },
    {
      scope: { type: "portfolio", portfolioId: "p" } as AccountScope,
      id: "p",
      picker: "Toggle comparison portfolio",
      name: "Retirement",
    },
  ])(
    "preserves a manually re-added $scope.type after removal through its picker",
    async ({ scope, id, picker }) => {
      setScope(scope);
      renderPage();
      await waitFor(() => expect(savedItems().some((item) => item.id === id)).toBe(true));
      await userEvent.click(screen.getByRole("button", { name: picker }));
      expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();
      expect(useAccountScopeStore.getState().scope).toEqual(scope);
      await userEvent.click(screen.getByRole("button", { name: picker }));
      setScope({ type: "account", accountId: "card" });
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, id, "card"]);
    },
  );

  it.each([
    {
      scope: { type: "account", accountId: "a" } as AccountScope,
      id: "a",
      picker: "Toggle comparison account",
      name: "Brokerage",
    },
    {
      scope: { type: "portfolio", portfolioId: "p" } as AccountScope,
      id: "p",
      picker: "Toggle comparison portfolio",
      name: "Retirement",
    },
  ])(
    "preserves a manually re-added $scope.type after badge removal and remount",
    async ({ scope, id, picker, name }) => {
      setScope(scope);
      const page = renderPage();
      await waitFor(() => expect(savedItems().some((item) => item.id === id)).toBe(true));
      await userEvent.click(screen.getAllByRole("button", { name: `Remove ${name}` })[0]);
      expect(useAccountScopeStore.getState().bridgedItemId).toBeNull();
      page.unmount();
      renderPage();
      expect(savedItems().some((item) => item.id === id)).toBe(false);
      await userEvent.click(screen.getByRole("button", { name: picker }));
      setScope({ type: "account", accountId: "card" });
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, id, "card"]);
    },
  );

  it("keeps a comparison badge's select and remove buttons apart", async () => {
    setScope({ type: "account", accountId: "a" });
    renderPage();
    await waitFor(() => expect(savedItems().some((item) => item.id === "a")).toBe(true));

    for (const badge of document.querySelectorAll("[data-slot='badge']")) {
      expect(badge).not.toHaveAttribute("role", "button");
      for (const control of badge.querySelectorAll("button")) {
        expect(control.querySelector("button")).toBeNull();
      }
    }

    const [select] = screen.getAllByRole("button", {
      name: new RegExp(`^${ALL_PORTFOLIO_ITEM.name}`),
    });
    expect(select).toHaveAttribute("aria-pressed", "false");
    select.focus();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getAllByRole("button", {
        name: new RegExp(`^${ALL_PORTFOLIO_ITEM.name}`),
      })[0],
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a newly bridged selection when StrictMode replays mount-time pruning", async () => {
    localStorage.setItem(
      "performance:selectedItems",
      JSON.stringify([
        ALL_PORTFOLIO_ITEM,
        {
          id: "accounts:a,deleted",
          type: "account",
          name: "Deleted scope",
          accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
        },
      ]),
    );
    localStorage.setItem("performance:selectedItemId", JSON.stringify("accounts:a,deleted"));
    setScope({ type: "account", accountId: "b" });
    renderPage();
    await waitFor(() =>
      expect(savedItems().map((item) => item.id)).toEqual([ALL_PORTFOLIO_ITEM.id, "b"]),
    );
    expect(JSON.parse(localStorage.getItem("performance:selectedItemId")!)).toBe("b");
    expect(useAccountScopeStore.getState().bridgedItemId).toBe("b");
  });

  it("opens the TWR calculation notes from the desktop strip warning icon", async () => {
    mocks.performance.mockReturnValue({
      data: [resultWithWarning],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
      displayDateRange: "",
    });
    renderPage();
    const trigger = await screen.findByRole("button", {
      name: /calculation note for/i,
    });
    expect(screen.queryByText(TWR_WARNING)).toBeNull();
    await userEvent.click(trigger);
    expect(await screen.findByText(TWR_WARNING)).toBeInTheDocument();
  });

  it.each([false, true])(
    "shows partial P&L and its cash-FX reason in the attribution panel (mobile=%s)",
    async (mobile) => {
      mocks.mobile = mobile;
      const warning =
        "Cash FX attribution is incomplete for account a on 2026-02-01 because its exposure or valuation rate is unavailable.";
      mocks.performance.mockReturnValue({
        data: [
          {
            ...resultWithWarning,
            dataQuality: {
              status: "partial",
              warnings: [warning],
              notApplicableReasons: [],
            },
            summary: {
              amount: 25,
              amountStatus: "complete",
              percent: 0.1,
              percentStatus: "complete",
              quality: "partial",
              reasons: [warning],
            },
          },
        ],
        isLoading: false,
        hasErrors: false,
        errorMessages: [],
        displayDateRange: "",
      });
      renderPage();
      const trigger = await screen.findByRole("button", {
        name: /Partial data/i,
      });
      expect(trigger).toHaveTextContent("25");
      await userEvent.click(trigger);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("note", { name: "Partial data" })).toHaveTextContent(warning);
      expect(within(dialog).getByText("Partial data")).toBeVisible();
    },
  );

  it.each([
    { name: "complete data", quality: "ok", warnings: [], reasons: [] },
    {
      name: "holdings return inapplicability",
      quality: "partial",
      warnings: [],
      reasons: [
        "TWR unavailable for holdings-only scopes because transaction cash flows are not tracked.",
        "IRR unavailable for holdings-only scopes because transaction cash flows are not tracked.",
      ],
    },
    {
      name: "an IRR-only reason",
      quality: "partial",
      warnings: [],
      reasons: ["IRR unavailable: cash flows do not change sign."],
    },
    {
      name: "an IRR-only warning",
      quality: "partial",
      warnings: ["IRR unavailable: cash flows do not change sign."],
      reasons: [],
    },
  ])("keeps complete P&L unmarked with $name", async ({ quality, warnings, reasons }) => {
    mocks.performance.mockReturnValue({
      data: [
        {
          ...resultWithWarning,
          dataQuality: {
            status: quality,
            warnings,
            notApplicableReasons: reasons,
          },
          summary: {
            amount: 25,
            amountStatus: "complete",
            percent: 0.1,
            percentStatus: "complete",
            quality,
            reasons: [...warnings, ...reasons],
          },
        },
      ],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
      displayDateRange: "",
    });
    renderPage();
    const trigger = await screen.findByRole("button", {
      name: /Gain \/ loss/i,
    });
    expect(trigger).toHaveTextContent("25");
    expect(screen.queryByText("Partial data")).toBeNull();
    await userEvent.click(trigger);
    expect(within(await screen.findByRole("dialog")).queryByRole("note")).toBeNull();
  });

  it.each([
    [false, false, "all-time mixed scopes", "ltr"],
    [true, false, "all-time mixed scopes", "rtl"],
    [false, true, "all-time mixed scopes", "rtl"],
    [true, true, "all-time mixed scopes", "ltr"],
    [false, false, "mixed scopes", "rtl"],
    [true, false, "mixed scopes", "ltr"],
    [false, true, "mixed scopes", "ltr"],
    [true, true, "mixed scopes", "rtl"],
  ] as const)(
    "separates mixed-scope return limitations from P&L warnings (mobile=%s, incomplete cash FX=%s, scope=%s, dir=%s)",
    async (mobile, incompleteCashFx, seriesScope, direction) => {
      mocks.mobile = mobile;
      document.documentElement.dir = direction;
      const mixedScopeWarning =
        "This scope mixes transaction-mode and holdings-mode accounts, so TWR and IRR are unavailable. The return is a value return over account-level components.";
      const seriesWarning = `Return series unavailable for ${seriesScope} because transaction and holdings components use different baselines.`;
      const cashFxWarning =
        "Cash FX attribution is incomplete for account a on 2026-02-01 because its exposure or valuation rate is unavailable.";
      const warnings = [
        mixedScopeWarning,
        seriesWarning,
        ...(incompleteCashFx ? [cashFxWarning] : []),
      ];
      const reasons = [
        "TWR unavailable for mixed transaction and holdings scopes.",
        "IRR unavailable for mixed transaction and holdings scopes.",
      ];
      mocks.performance.mockReturnValue({
        data: [
          {
            ...resultWithWarning,
            mode: "valueReturn",
            isMixedTrackingMode: true,
            series: [],
            dataQuality: {
              status: "partial",
              warnings,
              notApplicableReasons: reasons,
            },
            summary: {
              amount: 0,
              amountStatus: "complete",
              percent: 0,
              percentStatus: "complete",
              quality: "partial",
              reasons: [...warnings, ...reasons],
            },
          },
        ],
        isLoading: false,
        hasErrors: false,
        errorMessages: [],
        displayDateRange: "All Time",
      });
      renderPage();
      const trigger = await screen.findByRole("button", {
        name: /Gain\s*\/\s*loss/i,
      });
      expect(trigger).toHaveTextContent("0.00");
      if (!incompleteCashFx) expect(screen.queryByText("Partial data")).toBeNull();
      await userEvent.click(trigger);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(seriesWarning)).toBeNull();
      if (incompleteCashFx) {
        expect(within(dialog).getByRole("note", { name: "Partial data" })).toHaveTextContent(
          cashFxWarning,
        );
      } else {
        expect(within(dialog).queryByRole("note")).toBeNull();
        expect(within(dialog).queryByText("Partial data")).toBeNull();
      }
      await userEvent.click(within(dialog).getByRole("button", { name: "Close attribution" }));
      await userEvent.click(
        screen.getByRole("button", {
          name: /calculation notes? for value(?: return)?$/i,
        }),
      );
      expect(await screen.findByText(seriesWarning)).toBeVisible();
    },
  );

  it("does not present an unavailable P&L as a partial subtotal", async () => {
    mocks.performance.mockReturnValue({
      data: [
        {
          ...resultWithWarning,
          summary: {
            amount: null,
            amountStatus: "unavailable",
            percent: null,
            percentStatus: "unavailable",
            quality: "partial",
            reasons: [TWR_WARNING],
          },
        },
      ],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
      displayDateRange: "",
    });
    renderPage();
    await screen.findByRole("button", { name: /calculation note for/i });
    expect(screen.queryByRole("button", { name: /Gain \/ loss|Partial data/i })).toBeNull();
  });

  it("does not request unvalidated persisted scopes during a cold load", async () => {
    const staleItem: TrackedItem = {
      id: "accounts:a,deleted",
      type: "account",
      name: "Deleted scope",
      accountScope: { type: "accounts", accountIds: ["a", "deleted"] },
    };
    localStorage.setItem("performance:selectedItems", JSON.stringify([staleItem]));
    let resolveAccounts!: (value: Account[]) => void;
    mocks.getAccounts.mockReturnValue(
      new Promise<Account[]>((resolve) => {
        resolveAccounts = resolve;
      }),
    );
    mocks.performance.mockClear();
    renderPage(false);
    expect(savedItems()).toEqual([staleItem]);
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: [] }),
    );
    await act(async () => resolveAccounts(accounts));
    await waitFor(() => expect(savedItems()).toEqual([ALL_PORTFOLIO_ITEM]));
    for (const [request] of mocks.performance.mock.calls) {
      expect(request.selectedItems.some((item: TrackedItem) => item.id === staleItem.id)).toBe(
        false,
      );
    }
  });
  it("defaults to the configured day and preserves a saved historical range", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-12-31T16:30:00Z"));
      const first = renderPage();
      expect(mocks.performance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dateRange: { from: new Date(2026, 0, 1), to: new Date(2027, 0, 1) },
        }),
      );
      first.unmount();
      const range = { from: new Date(2024, 0, 1), to: new Date(2024, 1, 1) };
      localStorage.setItem("performance:dateRange", JSON.stringify(range));
      renderPage();
      expect(mocks.performance).toHaveBeenLastCalledWith(
        expect.objectContaining({ dateRange: range }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PerformancePage built-in display labels", () => {
  async function language() {
    const i18n = createInstance();
    await i18n.use(initReactI18next).init({
      lng: "zh",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: {
        en: { common: enCommon, performance: enPerformance },
        zh: { common: zhCommon, performance: zhPerformance },
      },
    });
    return i18n;
  }

  beforeEach(() => {
    localStorage.clear();
    useAccountScopeStore.setState(initialState, true);
    mocks.mobile = false;
    mocks.settings = { timezone: "Asia/Shanghai" };
    mocks.getAccounts.mockResolvedValue(accounts);
    mocks.performance.mockReturnValue({
      data: [],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
  });

  it("translates only the synthetic portfolio and retains raw persisted comparison names", async () => {
    const i18n = await language();
    const items: TrackedItem[] = [
      ALL_PORTFOLIO_ITEM,
      {
        id: "a",
        type: "account",
        name: "All Portfolio",
        accountScope: { type: "account", accountId: "a" },
      },
    ];
    localStorage.setItem("performance:selectedItems", JSON.stringify(items));
    renderPage(true, i18n);
    expect(
      await screen.findAllByRole("button", {
        name: new RegExp(`^${zhPerformance.all_portfolio}`),
      }),
    ).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^All Portfolio/ })).toHaveLength(2);
    expect(
      screen.getAllByRole("button", {
        name: i18n.t("performance:remove_item", {
          name: zhPerformance.all_portfolio,
        }),
      }),
    ).toHaveLength(2);
    expect(savedItems()).toEqual(items);
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedItems: items }),
    );
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getAllByRole("button", { name: /^All Portfolio/ })).toHaveLength(4);
    expect(savedItems()).toEqual(items);
  });

  it("localizes mobile metric explanations while retaining raw calculation notes", async () => {
    const i18n = await language();
    mocks.mobile = true;
    mocks.performance.mockReturnValue({
      data: [resultWithWarning],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    renderPage(true, i18n);
    await userEvent.click(
      await screen.findByRole("button", {
        name: i18n.t("common:component.calculation_note_for", {
          label: zhPerformance.metric.twr_short,
        }),
      }),
    );
    expect(screen.getByText(zhPerformance.metric_info.time_weighted_return)).toBeInTheDocument();
    expect(screen.getByText(TWR_WARNING)).toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByText(enPerformance.metric_info.time_weighted_return)).toBeInTheDocument();
    expect(screen.getByText(TWR_WARNING)).toBeInTheDocument();
  });

  it("localizes the metric help and updates it when language changes without rewriting warnings", async () => {
    const i18n = await language();
    const data = {
      ...resultWithWarning,
      returns: { ...resultWithWarning.returns, irr: 0.08 },
    };
    const original = structuredClone(data);
    mocks.performance.mockReturnValue({
      data: [data],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    renderPage(true, i18n);
    await userEvent.click(
      await screen.findByRole("button", {
        name: zhPerformance.help.aria_label,
      }),
    );
    for (const key of [
      "time_weighted_return",
      "money_weighted_return",
      "annualized_return",
      "volatility",
      "max_drawdown",
    ] as const) {
      expect(screen.getByText(zhPerformance.metric_info[key])).toBeInTheDocument();
      expect(screen.queryByText(enPerformance.metric_info[key])).not.toBeInTheDocument();
    }
    expect(screen.getByText(TWR_WARNING)).toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByText(enPerformance.metric_info.time_weighted_return)).toBeInTheDocument();
    expect(
      screen.queryByText(zhPerformance.metric_info.time_weighted_return),
    ).not.toBeInTheDocument();
    expect(data).toEqual(original);
  });

  it.each([
    {
      raw: "IRR unavailable for holdings-only scopes because transaction cash flows are not tracked.",
      known: true,
    },
    { raw: "MWR provider detail: keep this wording.", known: false },
  ])("localizes only the exact known MWR reason ($known)", async ({ raw, known }) => {
    const i18n = await language();
    const data = {
      ...resultWithWarning,
      dataQuality: {
        status: "partial",
        warnings: [],
        notApplicableReasons: [raw],
      },
    };
    const original = structuredClone(data);
    mocks.performance.mockReturnValue({
      data: [data],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    renderPage(true, i18n);
    const label = known ? zhPerformance.exclusion.holdings_not_mwr : raw;
    expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    if (known)
      expect(
        screen.queryByText(
          "MWR unavailable for holdings-only scopes because transaction cash flows are not tracked.",
        ),
      ).not.toBeInTheDocument();
    await act(() => i18n.changeLanguage("en"));
    expect(
      screen.getAllByText(known ? enPerformance.exclusion.holdings_not_mwr : raw).length,
    ).toBeGreaterThan(0);
    expect(data).toEqual(original);
  });
});

describe("PerformancePage period shared with the dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-31T04:00:00Z"));
    mocks.settings = { timezone: "Asia/Shanghai" };
    mocks.mobile = false;
    localStorage.clear();
    useAccountScopeStore.setState(initialState, true);
    mocks.performance.mockReturnValue({
      data: [],
      isLoading: false,
      hasErrors: false,
      errorMessages: [],
    });
    mocks.getAccounts.mockResolvedValue(accounts);
    return () => vi.useRealTimers();
  });

  it("shows the range Investments shows", () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "6M" }));
    renderPage();
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dateRange: { from: new Date(2025, 8, 30), to: new Date(2026, 2, 31) },
      }),
    );
  });

  it("shows a week for the dashboard's 1D, which Performance does not offer", () => {
    localStorage.setItem("dashboard-period", JSON.stringify({ kind: "portfolio", code: "1D" }));
    renderPage();
    expect(mocks.performance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dateRange: { from: new Date(2026, 2, 24), to: new Date(2026, 2, 31) },
      }),
    );
    expect(JSON.parse(localStorage.getItem("dashboard-period")!)).toEqual({
      kind: "portfolio",
      code: "1D",
    });
  });

  it("shares a range picked here, as a preset when it matches one", () => {
    renderPage();
    act(() =>
      mocks.dateRangeChange?.({
        from: new Date(2025, 2, 31),
        to: new Date(2026, 2, 31),
      }),
    );
    expect(JSON.parse(localStorage.getItem("dashboard-period")!)).toEqual({
      kind: "portfolio",
      code: "1Y",
    });
    expect(JSON.parse(localStorage.getItem("dashboard-interval")!)).toBe("1Y");

    act(() =>
      mocks.dateRangeChange?.({
        from: new Date(2023, 2, 31),
        to: new Date(2026, 2, 31),
      }),
    );
    expect(JSON.parse(localStorage.getItem("dashboard-period")!)).toEqual({
      kind: "range",
      from: "2023-03-31",
      to: "2026-03-31",
    });
  });
});
