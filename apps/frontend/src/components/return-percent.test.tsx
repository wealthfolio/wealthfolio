import type { PerformanceResult, Settings } from "@/lib/types";
import { render, screen, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnPercent } from "./return-percent";

const mocks = vi.hoisted(() => ({
  metric: "twr" as Settings["defaultReturnMetric"],
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { defaultReturnMetric: mocks.metric },
    updateSettings: mocks.updateSettings,
  }),
}));

vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: [{ id: "acc-1", name: "Brokerage" }] }),
}));

function result(
  returns: PerformanceResult["returns"],
  extra: Partial<PerformanceResult> = {},
): PerformanceResult {
  return {
    ...base(returns),
    ...extra,
  };
}

function base(returns: PerformanceResult["returns"]): PerformanceResult {
  return {
    scope: { id: "scope", currency: "USD" },
    period: { startDate: "2026-01-01", endDate: "2026-06-30" },
    returns,
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
    dataQuality: { status: "ok", warnings: [], notApplicableReasons: [] },
  };
}

const bothMethods = result({
  twr: { period: 0.05 },
  moneyWeighted: { period: 0.08 },
  returnOnCost: { unavailableReason: "Return on cost applies to full history." },
});

describe("ReturnPercent", () => {
  beforeEach(() => {
    mocks.metric = "twr";
    mocks.updateSettings.mockReset();
  });

  it("shows the chosen method and, on demand, both methods side by side", async () => {
    render(<ReturnPercent result={bothMethods} />);

    const trigger = screen.getByRole("button", { name: /^Time-weighted / });
    expect(trigger).toHaveTextContent("+5.00%");
    expect(trigger).not.toHaveTextContent("TWR");
    // Screen readers hear the figure too, not only the method.
    expect(trigger).toHaveAccessibleName("Time-weighted +5.00%: see both methods and switch");
    await userEvent.click(trigger);

    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByText(/as if you never added or withdrew money/)).toBeVisible();
    expect(within(popover).getByText("+8.00%")).toBeVisible();
    // ROI is listed only when the scope has one.
    expect(within(popover).queryByText("Return on investment (ROI)")).toBeNull();
  });

  it("follows the setting: money-weighted when chosen", () => {
    mocks.metric = "irr";
    render(<ReturnPercent result={bothMethods} />);

    expect(screen.getByRole("button", { name: /^Money-weighted / })).toHaveTextContent("+8.00%");
  });

  it("labels a stand-in and says why the chosen method is unavailable", async () => {
    // A holdings account over its full history.
    render(
      <ReturnPercent
        result={result({
          twr: {
            unavailableReason: "TWR unavailable for holdings-only scopes.",
            unavailableReasonCode: "HOLDINGS_TWR_NOT_APPLICABLE",
          },
          moneyWeighted: { unavailableReason: "MWR unavailable for holdings-only scopes." },
          returnOnCost: { period: 0.12 },
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Return on investment \(ROI\) / });
    expect(trigger).toHaveTextContent("+12.00%");
    // A stand-in carries its short label beside the figure.
    expect(trigger).toHaveTextContent("ROI");
    await userEvent.click(trigger);

    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByText(
        "Time-weighted isn't available here. Not available over the full history of an account tracked by holdings, because its deposits and withdrawals aren't recorded.",
      ),
    ).toBeVisible();
  });

  it("shows time-weighted for a holdings account's dated period when money-weighted is chosen", async () => {
    mocks.metric = "irr";
    render(
      <ReturnPercent
        result={result({
          twr: { period: 0.05 },
          moneyWeighted: {
            unavailableReason: "Money-weighted return unavailable for a holdings account.",
            unavailableReasonCode: "HOLDINGS_MONEY_WEIGHTED_NOT_APPLICABLE",
          },
          returnOnCost: {
            unavailableReason: "ROI applies over the full history.",
            unavailableReasonCode: "RETURN_ON_COST_NOT_APPLICABLE",
          },
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Time-weighted / });
    expect(trigger).toHaveTextContent("+5.00%");
    expect(trigger).toHaveTextContent("TWR");
    await userEvent.click(trigger);

    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByText(
        "Money-weighted isn't available here. Not available for an account tracked by holdings, because its deposits and withdrawals aren't recorded.",
      ),
    ).toBeVisible();
  });

  it("shows ROI for a mixed portfolio, whichever method is chosen", async () => {
    render(
      <ReturnPercent
        result={result({
          twr: {
            unavailableReason: "TWR unavailable for mixed scopes.",
            unavailableReasonCode: "MIXED_TWR_NOT_APPLICABLE",
          },
          moneyWeighted: {
            unavailableReason: "Money-weighted return unavailable for mixed scopes.",
            unavailableReasonCode: "MIXED_MONEY_WEIGHTED_NOT_APPLICABLE",
          },
          returnOnCost: { period: 0.0882 },
        })}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Return on investment \(ROI\) / });
    expect(trigger).toHaveTextContent("+8.82%");
    expect(trigger).toHaveTextContent("ROI");
    await userEvent.click(trigger);

    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByText(
        "Time-weighted isn't available here. Not available for portfolios that mix accounts tracked by holdings and by transactions.",
      ),
    ).toBeVisible();
  });

  it("shows the dates the figure covers and the amounts it is built from", async () => {
    render(
      <ReturnPercent
        result={result(bothMethods.returns, {
          amounts: {
            startValue: 10000,
            moneyIn: 2000,
            moneyOut: 500,
            gain: 600,
            endValue: 12100,
            flows: "confirmed",
          },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Time-weighted / }));
    const popover = await screen.findByRole("dialog");

    expect(within(popover).getByText("From Jan 1, 2026 to Jun 30, 2026")).toBeVisible();
    const row = (label: string) => within(popover).getByText(label).parentElement;
    expect(row("Start value")).toHaveTextContent("$10,000.00");
    expect(row("Money in")).toHaveTextContent("$2,000.00");
    expect(row("Money out")).toHaveTextContent("$500.00");
    expect(row("Gain")).toHaveTextContent("+$600.00");
    expect(row("End value")).toHaveTextContent("$12,100.00");
    // Recorded flows need no caveat, and a single account has no capital row.
    expect(within(popover).queryByText(/estimated/)).toBeNull();
    expect(within(popover).queryByText("Capital invested")).toBeNull();
  });

  it("says when the money in and out are estimated", async () => {
    render(
      <ReturnPercent
        result={result(bothMethods.returns, {
          amounts: {
            startValue: 200,
            moneyIn: 50,
            moneyOut: 0,
            gain: 20,
            endValue: 270,
            flows: "inferred",
          },
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Time-weighted / }));

    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByText("Money in and out are estimated, not recorded."),
    ).toBeVisible();
  });

  it("shows a mixed portfolio's two halves behind its ROI", async () => {
    render(
      <ReturnPercent
        result={result(
          {
            twr: { unavailableReasonCode: "MIXED_TWR_NOT_APPLICABLE" },
            moneyWeighted: { unavailableReasonCode: "MIXED_MONEY_WEIGHTED_NOT_APPLICABLE" },
            returnOnCost: { period: 0.0251 },
          },
          {
            amounts: {
              gain: 32.52,
              capital: 1295.45,
              endValue: 1327.97,
              flows: "inferred",
              parts: [
                { tracking: "TRANSACTIONS", gain: 12.52, capital: 1095.45 },
                { tracking: "HOLDINGS", gain: 20, capital: 200 },
              ],
            },
          },
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Return on investment \(ROI\) / }));
    const popover = await screen.findByRole("dialog");

    expect(within(popover).getAllByText("Capital invested")[0].parentElement).toHaveTextContent(
      "$1,295.45",
    );
    const halves = within(popover).getByRole("table");
    const transactions = within(halves).getByRole("row", { name: /^Transactions/ });
    expect(transactions).toHaveTextContent("+$12.52");
    expect(transactions).toHaveTextContent("$1,095.45");
    const holdings = within(halves).getByRole("row", { name: /^Holdings/ });
    expect(holdings).toHaveTextContent("+$20.00");
    expect(holdings).toHaveTextContent("$200.00");
    // Nothing is known about its money in and out over the full history.
    expect(within(popover).queryByText("Money in")).toBeNull();
    expect(within(popover).queryByText(/estimated/)).toBeNull();
  });

  it("names the transfers that withhold the return and links to Health", async () => {
    const transfer = (activityId: string, date: string) => ({
      activityId,
      accountId: "acc-1",
      date,
      amount: 200,
      currency: "USD",
      outflow: false,
    });
    render(
      <MemoryRouter>
        <ReturnPercent
          result={result(
            {
              twr: { unavailableReasonCode: "TWR_UNKNOWN_FLOW" },
              moneyWeighted: { unavailableReasonCode: "MONEY_WEIGHTED_UNKNOWN_FLOW" },
              returnOnCost: { unavailableReasonCode: "RETURN_ON_COST_NOT_APPLICABLE" },
            },
            {
              amounts: { startValue: 1000, endValue: 1200, flows: "missing" },
              unclassifiedTransfers: [
                transfer("t-1", "2026-03-02"),
                transfer("t-2", "2026-03-09"),
                transfer("t-3", "2026-03-16"),
                transfer("t-4", "2026-03-23"),
              ],
            },
          )}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Time-weighted / }));
    const popover = await screen.findByRole("dialog");

    expect(
      within(popover).getByText(
        "Transfers in this period that are neither matched to another account nor marked external:",
      ),
    ).toBeVisible();
    const first = within(popover).getByText("Mar 2, 2026").closest("li");
    expect(first).toHaveTextContent("Brokerage");
    expect(first).toHaveTextContent("$200.00");
    // Three are listed; the fourth is counted.
    expect(within(popover).getAllByRole("listitem")).toHaveLength(3);
    expect(within(popover).getByText("+1")).toBeVisible();
    expect(
      within(popover).getByRole("link", { name: "Review the details in the Health Center." }),
    ).toHaveAttribute("href", "/health");
    // The money in and out cannot be totalled.
    expect(within(popover).getByText("Money in").parentElement).toHaveTextContent("Unknown");
    expect(within(popover).queryByText("Gain")).toBeNull();
  });

  it("saves the method picked in the popover", async () => {
    render(<ReturnPercent result={bothMethods} />);

    await userEvent.click(screen.getByRole("button", { name: /^Time-weighted / }));
    const popover = await screen.findByRole("dialog");
    await userEvent.click(within(popover).getByRole("button", { name: "Money-weighted" }));

    expect(mocks.updateSettings).toHaveBeenCalledWith({ defaultReturnMetric: "irr" });
  });

  it("shows no untranslated engine text for an unknown reason", async () => {
    render(
      <ReturnPercent
        result={result({
          twr: { unavailableReason: "Some engine detail in English." },
          moneyWeighted: { period: 0.08 },
          returnOnCost: {},
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Money-weighted / }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).queryByText(/Some engine detail/)).toBeNull();
    expect(within(popover).getByText("Time-weighted isn't available here.")).toBeVisible();
  });

  it("reads not available when no view has a value", () => {
    render(
      <ReturnPercent
        result={result({
          twr: { unavailableReason: "No data." },
          moneyWeighted: { unavailableReason: "No data." },
          returnOnCost: { unavailableReason: "No data." },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /^Time-weighted / })).toHaveTextContent("N/A");
  });
});
