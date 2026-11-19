import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { AccountValuation, CurrentValuationSplit } from "@/lib/types";
import { act, render, screen, waitFor, within } from "@/test/render";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountMetrics from "./account-metrics";

const mocks = vi.hoisted(() => ({ createActivity: vi.fn() }));

vi.mock("@/adapters", () => mocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));
vi.mock("./performance-grid", () => ({ PerformanceGrid: () => null }));

function createValuation(overrides: Partial<AccountValuation> = {}): AccountValuation {
  return {
    id: "valuation-1",
    accountId: "account-1",
    valuationDate: "2026-06-01",
    accountCurrency: "HKD",
    baseCurrency: "HKD",
    fxRateToBase: 1,
    cashBalance: 1780,
    investmentMarketValue: 0,
    totalValue: 1780,
    costBasis: 0,
    bookBasis: 0,
    netContribution: 0,
    cashBalanceBase: 1780,
    investmentMarketValueBase: 0,
    totalValueBase: 1780,
    costBasisBase: 0,
    bookBasisBase: 0,
    netContributionBase: 0,
    externalInflowBase: 0,
    externalOutflowBase: 0,
    externalFlowSource: "UNKNOWN",
    performanceEligibleValueBase: 0,
    valueStatus: "complete",
    basisStatus: "notApplicable",
    calculatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

const cashCurrencySplit = [
  { currency: "HKD", valueLocal: 1000, valueBase: 1000, percentage: 56.18 },
  { currency: "USD", valueLocal: 100, valueBase: 780, percentage: 43.82 },
];

function renderMetrics(props: Partial<ComponentProps<typeof AccountMetrics>> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const metricsProps = { valuation: createValuation(), cashCurrencySplit, ...props };
  const result = render(<AccountMetrics {...metricsProps} />, { wrapper: Wrapper });
  return {
    ...result,
    rerenderMetrics: (nextProps: Partial<ComponentProps<typeof AccountMetrics>>) =>
      result.rerender(<AccountMetrics {...metricsProps} {...nextProps} />),
  };
}

describe("cash balance editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createActivity.mockResolvedValue({ id: "adjustment-1" });
  });

  it("keeps the open dialog and its draft while a refetch shows the skeleton", async () => {
    const user = userEvent.setup();
    const { rerenderMetrics } = renderMetrics();

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.click(screen.getByRole("combobox", { name: "Currency" }));
    await user.click(await screen.findByRole("option", { name: "USD" }));
    await user.clear(screen.getByLabelText("New balance"));
    await user.type(screen.getByLabelText("New balance"), "150");

    // A portfolio update refetches valuations, which the page reports as loading.
    rerenderMetrics({ isLoading: true });
    rerenderMetrics({ isLoading: false });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Currency" })).toHaveTextContent("USD");
    expect(within(dialog).getByLabelText("New balance")).toHaveValue("150");
  });

  it("adjusts USD from its native balance, not the converted HKD total", async () => {
    const user = userEvent.setup();
    renderMetrics();

    expect(screen.getByTestId("account-cash-balance-value").querySelector("input")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.click(screen.getByRole("combobox", { name: "Currency" }));
    await user.click(await screen.findByRole("option", { name: "USD" }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("New balance");
    expect(input).toHaveValue("100");
    await user.clear(input);
    expect(input).toHaveValue("");
    await user.type(input, "110");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.createActivity).toHaveBeenCalledTimes(1));
    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        activityType: "DEPOSIT",
        currency: "USD",
        amount: 10,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("defaults to the held currency even when it differs from the account currency", async () => {
    const user = userEvent.setup();
    renderMetrics({
      valuation: createValuation({ cashBalance: 780 }),
      cashCurrencySplit: [cashCurrencySplit[1]],
    });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    expect(screen.getByRole("combobox", { name: "Currency" })).toHaveTextContent("USD");
    expect(screen.getByLabelText("New balance")).toHaveValue("100");
  });

  it.each<{ split: CurrentValuationSplit[] | undefined }>([
    { split: undefined },
    { split: [{ currency: "USD", valueBase: 780, percentage: 100 }] },
    { split: [{ currency: "USD", valueLocal: null, valueBase: 780, percentage: 100 }] },
    { split: [{ currency: "USD", valueLocal: NaN, valueBase: 780, percentage: 100 }] },
    { split: [{ currency: "USD", valueLocal: Infinity, valueBase: 780, percentage: 100 }] },
    { split: [{ currency: "", valueLocal: 100, valueBase: 780, percentage: 100 }] },
  ])("disables adjustment instead of guessing unavailable native balances (%j)", ({ split }) => {
    renderMetrics({ cashCurrencySplit: split });
    expect(screen.getByRole("button", { name: "Adjust cash balance" })).toBeDisabled();
  });

  it("disables adjustment when current valuation failed even with cached balances", () => {
    renderMetrics({ balanceEditDisabled: true });
    expect(screen.getByRole("button", { name: "Adjust cash balance" })).toBeDisabled();
  });

  it("blocks saving an open draft when current valuation becomes unavailable", async () => {
    const user = userEvent.setup();
    const { rerenderMetrics } = renderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]] });
    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.clear(screen.getByLabelText("New balance"));
    await user.type(screen.getByLabelText("New balance"), "110");

    rerenderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]], balanceEditDisabled: true });

    expect(screen.getByLabelText("New balance")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Cash balances are unavailable/)).toBeInTheDocument();
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it("keeps adjustment hidden for holdings-mode and liability balances", () => {
    renderMetrics({ hideBalanceEdit: true });
    expect(screen.queryByRole("button", { name: "Adjust cash balance" })).not.toBeInTheDocument();
  });

  it("allows a loaded empty account to start from zero in its account currency", async () => {
    const user = userEvent.setup();
    renderMetrics({ valuation: createValuation({ cashBalance: 0 }), cashCurrencySplit: [] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    expect(screen.getByRole("combobox", { name: "Currency" })).toHaveTextContent("HKD");
    expect(screen.getByLabelText("New balance")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("New balance"), "50");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "HKD", activityType: "DEPOSIT", amount: 50 }),
      ),
    );
  });

  it("offers all held currencies plus the missing account currency, not just four chips", async () => {
    const user = userEvent.setup();
    const currencies = ["USD", "EUR", "JPY", "GBP", "CAD"];
    renderMetrics({
      cashCurrencySplit: currencies.map((currency) => ({
        currency,
        valueLocal: 100,
        valueBase: 780,
        percentage: 20,
      })),
    });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.click(screen.getByRole("combobox", { name: "Currency" }));
    expect(await screen.findAllByRole("option")).toHaveLength(6);
    await user.click(screen.getByRole("option", { name: "CAD" }));
    expect(screen.getByLabelText("New balance")).toHaveValue("100");
    await user.click(screen.getByRole("combobox", { name: "Currency" }));
    await user.click(await screen.findByRole("option", { name: "HKD" }));
    expect(screen.getByLabelText("New balance")).toHaveValue("0");
  });

  it("does not interpret a blank balance as zero, but supports an explicit withdrawal to zero", async () => {
    const user = userEvent.setup();
    renderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]] });
    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    const input = screen.getByLabelText("New balance");

    await user.clear(input);
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.createActivity).not.toHaveBeenCalled();
    await user.type(input, "0");
    expect(screen.getByText("Withdrawal: 100 USD")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "USD", activityType: "WITHDRAWAL", amount: 100 }),
      ),
    );
  });

  it("can correct an existing negative balance to zero without allowing a new negative target", async () => {
    const user = userEvent.setup();
    renderMetrics({ cashCurrencySplit: [{ ...cashCurrencySplit[1], valueLocal: -5 }] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    expect(screen.getByText("-5 USD")).toBeInTheDocument();
    const input = screen.getByLabelText("New balance");
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(input, "0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "USD", activityType: "DEPOSIT", amount: 5 }),
      ),
    );
  });

  it("previews and persists a fractional adjustment without rounding to currency minor units", async () => {
    const user = userEvent.setup();
    renderMetrics({ cashCurrencySplit: [{ ...cashCurrencySplit[1], valueLocal: 100.00000001 }] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    expect(screen.getByText("100.00000001 USD")).toBeInTheDocument();
    const input = screen.getByLabelText("New balance");
    await user.clear(input);
    await user.type(input, "100");
    expect(screen.getByText("Withdrawal: 0.00000001 USD")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: "USD",
          activityType: "WITHDRAWAL",
          amount: 0.00000001,
        }),
      ),
    );
  });

  it("keeps the draft on a refresh and computes the difference from the latest native balance", async () => {
    const user = userEvent.setup();
    const { rerenderMetrics } = renderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    const input = screen.getByLabelText("New balance");
    await user.clear(input);
    await user.type(input, "110");
    rerenderMetrics({ cashCurrencySplit: [{ ...cashCurrencySplit[1], valueLocal: 105 }] });
    expect(input).toHaveValue("110");
    expect(screen.getByText("Deposit: 5 USD")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.createActivity).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "USD", activityType: "DEPOSIT", amount: 5 }),
      ),
    );
  });

  it("initializes a fresh draft when reopened", async () => {
    const user = userEvent.setup();
    const { rerenderMetrics } = renderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.clear(screen.getByLabelText("New balance"));
    await user.type(screen.getByLabelText("New balance"), "999");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    rerenderMetrics({ cashCurrencySplit: [{ ...cashCurrencySplit[1], valueLocal: 105 }] });
    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));

    expect(screen.getByLabelText("New balance")).toHaveValue("105");
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it("keeps the selected currency and target after a create failure and allows an explicit retry", async () => {
    const user = userEvent.setup();
    mocks.createActivity.mockRejectedValueOnce(new Error("Create failed"));
    renderMetrics();

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.click(screen.getByRole("combobox", { name: "Currency" }));
    await user.click(await screen.findByRole("option", { name: "USD" }));
    const input = screen.getByLabelText("New balance");
    await user.clear(input);
    await user.type(input, "110");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Error updating balance");
    expect(input).toHaveValue("110");
    expect(screen.getByRole("combobox", { name: "Currency" })).toHaveTextContent("USD");
    expect(mocks.createActivity).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.createActivity).toHaveBeenCalledTimes(2);
  });

  it("waits for persistence and prevents duplicate submissions or dismissal while saving", async () => {
    const user = userEvent.setup();
    let finishSave!: (activity: { id: string }) => void;
    mocks.createActivity.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    renderMetrics({ cashCurrencySplit: [cashCurrencySplit[1]] });

    await user.click(screen.getByRole("button", { name: "Adjust cash balance" }));
    await user.clear(screen.getByLabelText("New balance"));
    await user.type(screen.getByLabelText("New balance"), "110");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.dblClick(save);
    expect(save).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Currency" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.createActivity).toHaveBeenCalledTimes(1);

    act(() => {
      finishSave({ id: "adjustment-1" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
