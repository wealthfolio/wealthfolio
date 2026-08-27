import { fireEvent, render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETIREMENT_PLAN } from "../lib/plan-adapter";
import type { RetirementPlan } from "../types";
import { SidebarConfigurator } from "./sidebar-configurator";

function renderConfigurator(plan: RetirementPlan, onSavePlan: (plan: RetirementPlan) => void) {
  render(
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <SidebarConfigurator
          plan={plan}
          currency="USD"
          plannerMode="traditional"
          onSavePlan={onSavePlan}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
}

function saveIncomeSection() {
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
}

describe("SidebarConfigurator pension fund returns", () => {
  it("leaves a newly added fund return unset so it inherits the plan net return", () => {
    const onSavePlan = vi.fn<(plan: RetirementPlan) => void>();
    renderConfigurator(structuredClone(DEFAULT_RETIREMENT_PLAN), onSavePlan);

    fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Income" }));
    fireEvent.click(screen.getByRole("button", { name: "Add pension fund" }));
    saveIncomeSection();

    const savedPlan = onSavePlan.mock.calls[0][0];
    expect(savedPlan.incomeStreams[0].accumulationReturn).toBeUndefined();
  });

  it("leaves an unset return inherited when switching an income stream to a fund", () => {
    const onSavePlan = vi.fn<(plan: RetirementPlan) => void>();
    const plan: RetirementPlan = {
      ...structuredClone(DEFAULT_RETIREMENT_PLAN),
      incomeStreams: [
        {
          id: "pension",
          label: "Pension",
          streamType: "db",
          startAge: 65,
          adjustForInflation: true,
          monthlyAmount: 1_000,
        },
      ],
    };
    renderConfigurator(plan, onSavePlan);

    fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Income" }));
    fireEvent.click(screen.getByText("Pension").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Fund" }));
    saveIncomeSection();

    const savedPlan = onSavePlan.mock.calls[0][0];
    expect(savedPlan.incomeStreams[0].streamType).toBe("dc");
    expect(savedPlan.incomeStreams[0].accumulationReturn).toBeUndefined();
  });

  it("keeps a negative inherited payout return available in the control", () => {
    const plan: RetirementPlan = {
      ...structuredClone(DEFAULT_RETIREMENT_PLAN),
      investment: {
        ...structuredClone(DEFAULT_RETIREMENT_PLAN.investment),
        retirementAnnualReturn: 0.01,
        annualInvestmentFeeRate: 0.03,
      },
      incomeStreams: [
        {
          id: "drawdown",
          label: "RRSP",
          streamType: "dc",
          startAge: 65,
          adjustForInflation: false,
          currentValue: 100_000,
          payoutRate: 0.05,
          payoutMode: "drawdown",
        },
      ],
    };
    renderConfigurator(plan, vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Income" }));
    fireEvent.click(screen.getByText("RRSP").closest("button")!);
    const row = screen.getByText("Fund return during payout").closest(".py-4")!;
    const slider = row.querySelector<HTMLInputElement>('input[type="range"]')!;

    expect(Number(slider.value)).toBeCloseTo(-0.02);
  });
});
