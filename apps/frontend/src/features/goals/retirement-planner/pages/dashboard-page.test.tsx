import { fireEvent, render, screen, within } from "@testing-library/react";
import { createAmountFormatting, FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetirementOverview } from "@/lib/types";
import { DEFAULT_RETIREMENT_PLAN } from "../lib/plan-adapter";
import DashboardPage from "./dashboard-page";

vi.mock("../components/sidebar-configurator", () => ({ SidebarConfigurator: () => null }));
vi.mock("../components/retirement-snapshot-table", () => ({ RetirementSnapshotTable: () => null }));

const privacy = vi.hoisted(() => ({ hidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: privacy.hidden }),
}));

function renderOverview(lean: number | null, fat: number | null) {
  const overview = {
    analysisMode: "fire",
    status: "on_track",
    successStatus: "on_track",
    fiAge: 50,
    retirementStartAge: 50,
    portfolioNow: 100_000,
    portfolioAtGoalAge: 400_000,
    netFireTarget: 500_000,
    requiredCapitalAtGoalAge: 400_000,
    requiredCapitalReachable: true,
    leanRequiredCapitalAtGoalAge: lean,
    fatRequiredCapitalAtGoalAge: fat,
    shortfallAtGoalAge: 0,
    surplusAtGoalAge: 0,
    coastAmountToday: 50_000,
    targetReconciliation: {
      inflationFactorToTarget: 2,
      requiredCapitalNominal: 400_000,
      requiredCapitalTodayValue: 200_000,
    },
    trajectory: [],
  } as unknown as RetirementOverview;
  render(
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <DashboardPage
          plan={DEFAULT_RETIREMENT_PLAN}
          plannerMode="fire"
          isLoading={false}
          portfolioData={{ totalValue: 100_000, holdings: [], isLoading: false, error: null }}
          retirementOverview={overview}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
}
function renderWithGoalMilestones() {
  const trajectory = [34, 35, 36, 37].map((age) => ({
    age,
    year: 2026 + age - 34,
    phase: "accumulation",
    portfolioStart: 400_000 + (age - 34) * 40_000,
    portfolioEnd: 440_000 + (age - 34) * 40_000,
    requiredCapital: 800_000,
    netWithdrawalFromPortfolio: 0,
    annualContribution: 38_400,
    annualIncome: 0,
    annualExpenses: 0,
  }));
  const overview = {
    analysisMode: "fire",
    status: "on_track",
    successStatus: "on_track",
    fiAge: 50,
    retirementStartAge: 50,
    portfolioNow: 400_000,
    portfolioAtGoalAge: 400_000,
    requiredCapitalAtGoalAge: 800_000,
    requiredCapitalReachable: true,
    coastAmountToday: 50_000,
    trajectory,
  } as unknown as RetirementOverview;
  render(
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <DashboardPage
          plan={DEFAULT_RETIREMENT_PLAN}
          plannerMode="fire"
          isLoading={false}
          portfolioData={{ totalValue: 400_000, holdings: [], isLoading: false, error: null }}
          retirementOverview={overview}
          goalMilestones={[
            {
              id: "home",
              title: "Home Down Payment",
              goalType: "home",
              targetAmount: 80_000,
              targetDate: "2029-01-23",
              statusHealth: "on_track",
              age: 36,
            },
          ]}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
}

function milestone(name: string) {
  return within(screen.getByText(name, { exact: true }).closest<HTMLElement>(".p-4")!);
}

describe("retirement spending milestones", () => {
  it("uses calculated scenario targets and converts their value basis", () => {
    const formatting = createAmountFormatting("en-US");
    renderOverview(120_000, 800_000);
    expect(
      milestone("Lean FIRE").getByText(formatting.formatCompactAmount(60_000, "USD")),
    ).toBeInTheDocument();
    expect(
      milestone("Fat FIRE").getByText(formatting.formatCompactAmount(400_000, "USD")),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Nominal", { exact: true }));
    expect(
      milestone("Lean FIRE").getByText(formatting.formatCompactAmount(120_000, "USD")),
    ).toBeInTheDocument();
    expect(
      milestone("Fat FIRE").getByText(formatting.formatCompactAmount(800_000, "USD")),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "You're projected to reach financial independence at age 50.",
    );
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("—");
  });

  it("distinguishes a valid zero target from an unavailable target", () => {
    renderOverview(0, null);
    expect(milestone("Lean FIRE").getByText("DONE")).toBeInTheDocument();
    expect(milestone("Fat FIRE").getByText("—")).toBeInTheDocument();
    expect(milestone("Fat FIRE").queryByText("DONE")).not.toBeInTheDocument();
  });
});

describe("savings goal milestones on the trajectory chart", () => {
  it("lets the legend entry show and hide them", () => {
    renderWithGoalMilestones();
    const toggle = screen.getByRole("button", { name: "Savings goals" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});

describe("hidden balances", () => {
  afterEach(() => {
    privacy.hidden = false;
  });

  it("masks every amount and keeps the ages", () => {
    privacy.hidden = true;
    renderOverview(120_000, 800_000);
    expect(milestone("Lean FIRE").getByText("••••")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("age 50");
  });
});
