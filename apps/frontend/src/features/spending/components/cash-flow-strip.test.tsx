import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { describe, expect, it, vi } from "vitest";

import { CashFlowStrip } from "./cash-flow-strip";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

function renderStrip(props: {
  income: number;
  spending: number;
  saving?: number;
  fromSavings?: number;
}) {
  render(
    <FormattingProvider locale="en-US">
      <CashFlowStrip currency="USD" {...props} />
    </FormattingProvider>,
  );
}

/** The figure shown under a KPI label. */
const kpi = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe("CashFlowStrip", () => {
  it("shows net saving with its sign when more came back from savings than went in", () => {
    renderStrip({ income: 1000, spending: 500, saving: 200, fromSavings: 900 });

    expect(kpi("Saving")).toBe("−$700");
    // Still adds up: 1,000 − 500 − (−700).
    expect(kpi("Net")).toBe("+$1.2K");
  });

  it("shows a round trip as no saving at all", () => {
    renderStrip({ income: 1000, spending: 400, saving: 500, fromSavings: 500 });

    expect(kpi("Saving")).toBe("$0");
    expect(kpi("Net")).toBe("+$600");
  });

  it("shows saving without a sign when it went into savings", () => {
    renderStrip({ income: 1000, spending: 400, saving: 500 });

    expect(kpi("Saving")).toBe("$500");
    expect(kpi("Net")).toBe("+$100");
  });

  it("leaves saving out when nothing moved to or from savings", () => {
    renderStrip({ income: 1000, spending: 400 });

    expect(screen.queryByText("Saving")).not.toBeInTheDocument();
    expect(kpi("Net")).toBe("+$600");
  });
});
