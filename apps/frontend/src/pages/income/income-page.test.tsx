import { useAccountScopeStore } from "@/lib/account-scope-store";
import type { AccountScope, IncomeByAsset, IncomeSummary } from "@/lib/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@wealthfolio/ui";
import { findTooltip } from "@/test/tooltip";
import IncomePage from "./income-page";

const mocks = vi.hoisted(() => ({
  getIncomeSummary: vi.fn(),
  useQuery: vi.fn(),
  isBalanceHidden: false,
}));

vi.mock("@/adapters", () => ({ getIncomeSummary: mocks.getIncomeSummary }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: mocks.isBalanceHidden }),
}));

// jsdom has no layout: give the charts a fixed size so Recharts draws them,
// and skip the pie's entry animation so its slices exist right away.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    Pie: (props: ComponentProps<typeof actual.Pie>) => (
      <actual.Pie {...props} isAnimationActive={false} />
    ),
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<{ width: number; height: number }>, {
            width: 900,
            height: 500,
          })
        : null,
  };
});

// Stub the popover-driven selector so the scope can be read and changed directly.
vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: ({
    value,
    onChange,
  }: {
    value: AccountScope;
    onChange: (scope: AccountScope) => void;
  }) => (
    <button
      data-testid="account-scope-selector"
      data-scope={JSON.stringify(value)}
      onClick={() => onChange({ type: "account", accountId: "acc-2" })}
    >
      scope
    </button>
  ),
}));

const initialState = useAccountScopeStore.getState();

function renderPage() {
  return render(<IncomePage />);
}

function selectorScope(): AccountScope {
  return JSON.parse(screen.getAllByTestId("account-scope-selector")[0].dataset.scope ?? "null");
}

describe("IncomePage account scope", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.isBalanceHidden = false;
    mocks.getIncomeSummary.mockResolvedValue([]);
    // No summaries: renders the empty state, which still shows the selector.
    mocks.useQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it("renders the scope held in the shared store", () => {
    useAccountScopeStore.getState().setScope({ type: "account", accountId: "acc-1" });

    renderPage();

    expect(selectorScope()).toEqual({ type: "account", accountId: "acc-1" });
  });

  it("publishes a scope change to the shared store", async () => {
    renderPage();

    await userEvent.click(screen.getAllByTestId("account-scope-selector")[0]);

    expect(useAccountScopeStore.getState().scope).toEqual({
      type: "account",
      accountId: "acc-2",
    });
  });

  it("keeps the scope when the page unmounts on a tab switch", async () => {
    const { unmount } = renderPage();
    await userEvent.click(screen.getAllByTestId("account-scope-selector")[0]);

    // Switching insights tabs unmounts the inactive view on desktop.
    unmount();
    renderPage();

    expect(selectorScope()).toEqual({ type: "account", accountId: "acc-2" });
  });

  it("queries income for the shared scope", () => {
    useAccountScopeStore.getState().setScope({ type: "portfolio", portfolioId: "p-1" });

    renderPage();

    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining([{ type: "portfolio", portfolioId: "p-1" }]),
      }),
    );
  });
});

describe("IncomePage with Hide Balance", () => {
  const summary: IncomeSummary = {
    period: "ALL",
    byMonth: { "2026-08": 500000, "2026-09": 1234567.89 },
    byType: { DIVIDEND: 1734567.89 },
    byAsset: {},
    byCurrency: { INR: 1234567.89, USD: 2500 },
    byCurrencyBase: { INR: 1234567.89, USD: 500000 },
    byAccount: {},
    totalIncome: 1734567.89,
    currency: "INR",
    monthlyAverage: 867283.95,
    yoyGrowth: null,
    unconvertedCurrencies: [],
  };

  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });
  });

  function yAxisTicks(container: HTMLElement): string[] {
    return Array.from(
      container.querySelectorAll(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value"),
      (tick) => tick.textContent ?? "",
    );
  }

  // Hovers the INR slice and returns the pie chart, which holds its tooltip.
  function hoverInrSlice(container: HTMLElement) {
    const slice = container.querySelector('[name="INR"]')?.closest(".recharts-pie-sector");
    expect(slice).toBeInstanceOf(Element);
    fireEvent.mouseEnter(slice!);
    return within(slice!.closest<HTMLElement>("[data-chart]")!);
  }

  it("shows the history chart's axes and the currency pie tooltip when amounts are visible", () => {
    mocks.isBalanceHidden = false;
    const { container } = renderPage();

    expect(yAxisTicks(container)).toEqual(["0", "500K", "1M", "1.5M", "0", "1M", "2M", "3M"]);
    expect(hoverInrSlice(container).getByText("1,234,567.89")).toBeInTheDocument();
  });

  it("masks the history chart's axes", () => {
    mocks.isBalanceHidden = true;
    const { container } = renderPage();

    expect(yAxisTicks(container)).toEqual(Array(8).fill("••"));
  });

  it("masks the currency pie tooltip", () => {
    mocks.isBalanceHidden = true;
    const { container } = renderPage();

    const pie = hoverInrSlice(container);
    expect(pie.getByText("INR")).toBeInTheDocument();
    expect(pie.getByText("••••")).toBeInTheDocument();
    expect(pie.queryByText(/\d/)).not.toBeInTheDocument();
  });
});

describe("IncomePage top dividend sources", () => {
  // Cash interest outweighs the one dividend, as in issue #2157.
  const cash = {
    assetId: "CASH",
    // What the backend sends for income without an asset; AssetKind has no CASH.
    kind: "CASH" as IncomeByAsset["kind"],
    symbol: "CASH",
    name: "Cash",
    income: 2610,
    dividendIncome: 0,
  } as const;
  const aapl = {
    assetId: "AAPL",
    kind: "INVESTMENT",
    symbol: "AAPL",
    name: "Apple Inc.",
    income: 100,
    dividendIncome: 100,
  } as const;
  const summaryWith = (
    byAsset: IncomeSummary["byAsset"],
    byType: IncomeSummary["byType"],
  ): IncomeSummary => ({
    period: "ALL",
    byMonth: { "2026-03": 2710 },
    byType,
    byAsset,
    byCurrency: { USD: 2710 },
    byCurrencyBase: { USD: 2710 },
    byAccount: {},
    totalIncome: Object.values(byType).reduce((sum, value) => sum + value, 0),
    currency: "USD",
    monthlyAverage: 2710,
    yoyGrowth: null,
    unconvertedCurrencies: [],
  });
  const card = () =>
    screen.getByText("Top 10 Dividend Sources").closest<HTMLElement>('[data-slot="card"]')!;

  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.isBalanceHidden = false;
  });

  it("shows its empty state when there is interest but no dividend", () => {
    const summary = summaryWith({ CASH: cash }, { INTEREST: 2610 });
    mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });

    renderPage();

    expect(within(card()).getByText("No dividend income recorded")).toBeInTheDocument();
    expect(within(card()).queryByText("CASH")).not.toBeInTheDocument();
  });

  it("ranks, lists and sizes assets by their dividends alone", async () => {
    const summary = summaryWith({ CASH: cash, AAPL: aapl }, { INTEREST: 2610, DIVIDEND: 100 });
    mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });

    render(
      <TooltipProvider delay={0}>
        <IncomePage />
      </TooltipProvider>,
    );

    expect(within(card()).queryByText("CASH")).not.toBeInTheDocument();
    // The symbol label; the ticker avatar's fallback letters repeat it.
    expect(within(card()).getByText("AAPL", { selector: "bdi" })).toBeInTheDocument();
    const bars = card().querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(bars).toHaveLength(1);
    expect(bars[0].style.width).toBe("100%");

    // The tooltip renders outside the card, so its scroll area can't clip it.
    await userEvent.hover(bars[0]);
    const tooltip = await findTooltip();
    expect(card()).not.toContainElement(tooltip);
    expect(tooltip).toHaveTextContent("AAPL");
    expect(tooltip).toHaveTextContent("Apple Inc.");
  });

  it("orders mixed-income assets by dividends and uses dividend amounts", () => {
    const msft = {
      ...aapl,
      assetId: "MSFT",
      symbol: "MSFT",
      name: "Microsoft",
      income: 200,
      dividendIncome: 200,
    };
    const summary = summaryWith(
      { AAPL: { ...aapl, income: 1000 }, MSFT: msft },
      { DIVIDEND: 300, OTHER_INCOME: 900 },
    );
    mocks.useQuery.mockReturnValue({ data: [summary], isLoading: false, error: null });

    renderPage();

    const symbols = within(card()).getAllByText(/^(AAPL|MSFT)$/, { selector: "bdi" });
    expect(symbols.map((symbol) => symbol.textContent)).toEqual(["MSFT", "AAPL"]);
    expect(symbols[0].closest(".justify-between")).toHaveTextContent("$200.00");
    expect(symbols[1].closest(".justify-between")).toHaveTextContent("$100.00");
    const bars = card().querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(bars).toHaveLength(2);
    expect(parseFloat(bars[0].style.width)).toBeCloseTo((200 / 300) * 100);
    expect(parseFloat(bars[1].style.width)).toBeCloseTo((100 / 300) * 100);
  });
});
