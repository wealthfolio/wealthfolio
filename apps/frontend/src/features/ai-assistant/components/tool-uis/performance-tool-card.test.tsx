import { render, screen } from "@/test/render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toolUi = vi.hoisted(() => ({
  render: undefined as ((props: { result: unknown; args?: unknown }) => ReactNode) | undefined,
}));
const privacy = vi.hoisted(() => ({ isBalanceHidden: false }));
vi.mock("@assistant-ui/react", () => ({
  makeAssistantToolUI: (config: { render: typeof toolUi.render }) => {
    toolUi.render = config.render;
    return () => null;
  },
}));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => privacy,
}));
import "./performance-tool-ui";

/** A year to date whose return the engine could not compute. */
function resultWithoutReturn(amount: number) {
  return {
    id: "all",
    periodStartDate: "2026-01-01",
    periodEndDate: "2026-11-13",
    currency: "USD",
    mode: "timeWeighted",
    basisStatus: "notApplicable",
    summary: {
      amount,
      method: "timeWeighted",
      basis: "marketValue",
      quality: "partial",
      amountStatus: "complete",
      percentStatus: "unavailable",
      basisStatus: "notApplicable",
      reasons: [],
    },
    returns: { valueReturn: 0.1 },
    risk: { volatility: 0.1, maxDrawdown: -0.06 },
    dataQuality: { status: "partial", warnings: [], notApplicableReasons: [] },
  };
}

function amountElement(text: RegExp) {
  return screen.getByText(text);
}

describe("the performance card's period amount", () => {
  beforeEach(() => {
    privacy.isBalanceHidden = false;
  });

  it("shows a gain in the gain colour when the return is unavailable", () => {
    render(<>{toolUi.render?.({ result: resultWithoutReturn(54654) })}</>);

    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(amountElement(/54,654/)).toHaveClass("text-gain");
  });

  it("shows a loss in the loss colour when the return is unavailable", () => {
    render(<>{toolUi.render?.({ result: resultWithoutReturn(-1200) })}</>);

    expect(amountElement(/1,200/)).toHaveClass("text-loss");
  });

  it("stays muted while balances are hidden", () => {
    privacy.isBalanceHidden = true;
    render(<>{toolUi.render?.({ result: resultWithoutReturn(54654) })}</>);

    const hidden = screen.getAllByText("•••••")[0];
    expect(hidden).toHaveClass("text-muted-foreground");
  });
});
