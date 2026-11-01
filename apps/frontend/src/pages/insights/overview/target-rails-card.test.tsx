import { describe, expect, it, vi } from "vitest";

import type { AllocationTarget, DriftReport, DriftRow } from "@/lib/types";
import { render, screen, within } from "@/test/render";
import { DirectionProvider } from "@wealthfolio/ui";

import { TargetRailsCard } from "./target-rails-card";

vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: undefined }) }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

function row(
  categoryId: string,
  categoryName: string,
  status: DriftRow["status"],
  currentValue: number,
  targetValue: number,
): DriftRow {
  return {
    categoryId,
    categoryName,
    color: "",
    currentBps: currentValue,
    targetBps: targetValue,
    driftBps: currentValue - targetValue,
    currentValue,
    targetValue,
    // As the drift service computes it: current minus target.
    valueDelta: currentValue - targetValue,
    effectiveBandBps: 100,
    status,
    isRequired: true,
    isZeroCurrent: false,
    isCash: false,
  };
}

const target = {
  id: "target-1",
  name: "Global",
  taxonomyId: "asset_classes",
  driftBandBps: 100,
} as AllocationTarget;

const report: DriftReport = {
  targetId: "target-1",
  scopeType: "all",
  totalValue: 10000,
  baseCurrency: "USD",
  maxDriftBps: 1200,
  outOfBandCount: 2,
  deployableCash: 0,
  rows: [
    row("EQUITY", "Equity", "overweight", 7200, 6000),
    row("FIXED_INCOME", "Fixed Income", "underweight", 2800, 4000),
  ],
};

describe("TargetRailsCard", () => {
  it("states how far each category sits from its target, without telling the user what to do", () => {
    render(
      <TargetRailsCard
        targets={[target]}
        selectedTargetId="target-1"
        onTargetChange={vi.fn()}
        driftReport={report}
      />,
    );

    const section = screen.getByText("Differences from target").parentElement!;
    const lineFor = (name: string) => within(section).getByText(name).closest("div")!;

    expect(lineFor("Equity")).toHaveTextContent(/1\.2K above target$/);
    expect(lineFor("Fixed Income")).toHaveTextContent(/1\.2K below target$/);
    expect(section).not.toHaveTextContent(/\b(add|trim)\b/i);
  });

  it.each(["ltr", "rtl"] as const)(
    "keeps the selected pill visible without moving focus in %s",
    (direction) => {
      const other = { ...target, id: "target-2", name: "Income" };
      const props = { selectedTargetId: target.id, onTargetChange: vi.fn(), driftReport: report };
      const { rerender } = render(
        <DirectionProvider direction={direction}>
          <TargetRailsCard {...props} targets={[target, other]} />
        </DirectionProvider>,
      );
      const selector = screen.getByRole("group", { name: "Select target" });
      selector.scrollLeft = direction === "rtl" ? -200 : 200;
      const button = within(selector).getByRole("button", { name: "Income" });
      button.focus();
      rerender(
        <DirectionProvider direction={direction}>
          <TargetRailsCard {...props} selectedTargetId={other.id} targets={[other, target]} />
        </DirectionProvider>,
      );
      expect(selector.scrollLeft).toBe(0);
      expect(within(selector).getAllByRole("button")[0]).toBe(button);
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(within(selector).getByRole("button", { name: "Global" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    },
  );
});
