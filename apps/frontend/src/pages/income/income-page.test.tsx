import { useAccountScopeStore } from "@/lib/account-scope-store";
import type { AccountScope, IncomeSummary } from "@/lib/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    byAccount: {},
    totalIncome: 1734567.89,
    currency: "INR",
    monthlyAverage: 867283.95,
    yoyGrowth: null,
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
