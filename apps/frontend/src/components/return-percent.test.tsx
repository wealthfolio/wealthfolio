import type { PerformanceResult, Settings } from "@/lib/types";
import { render, screen, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
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

function result(returns: PerformanceResult["returns"]): PerformanceResult {
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
