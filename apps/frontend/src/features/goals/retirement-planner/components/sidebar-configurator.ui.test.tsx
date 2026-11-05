import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetirementOverview } from "@/lib/types";
import { DEFAULT_RETIREMENT_PLAN } from "../lib/plan-adapter";
import type { RetirementPlan } from "../types";
import { SidebarConfigurator } from "./sidebar-configurator";

const privacy = vi.hoisted(() => ({ hidden: false }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: privacy.hidden }),
}));

function renderConfigurator(
  plan: RetirementPlan,
  onSavePlan: (plan: RetirementPlan) => void,
  locale = "en-US",
  direction: "ltr" | "rtl" = "ltr",
) {
  render(
    <DirectionProvider direction={direction}>
      <FormattingProvider locale={locale}>
        <TooltipProvider>
          <SidebarConfigurator
            plan={plan}
            currency="USD"
            plannerMode="traditional"
            onSavePlan={onSavePlan}
          />
        </TooltipProvider>
      </FormattingProvider>
    </DirectionProvider>,
  );
}

function saveIncomeSection() {
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  privacy.hidden = false;
});

it.each([undefined, {}])("adds distinct income streams without crypto APIs (%j)", (crypto) => {
  vi.stubGlobal("crypto", crypto);
  vi.spyOn(Date, "now").mockReturnValue(1234);
  const onSavePlan = vi.fn<(plan: RetirementPlan) => void>();
  renderConfigurator(structuredClone(DEFAULT_RETIREMENT_PLAN), onSavePlan);
  fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Income" }));
  fireEvent.click(screen.getByRole("button", { name: "Add pension fund" }));
  fireEvent.click(screen.getByRole("button", { name: "Add pension fund" }));
  saveIncomeSection();

  const streams = onSavePlan.mock.calls[0][0].incomeStreams;
  expect(streams).toHaveLength(2);
  expect(streams[0].id).toBeTruthy();
  expect(streams[1].id).toBeTruthy();
  expect(streams[1].id).not.toBe(streams[0].id);
});

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

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "Asia/Shanghai" } }),
}));

describe("SidebarConfigurator savings goals contribution note", () => {
  function renderWithGoalsMonthly(amount: number) {
    render(
      <FormattingProvider locale="en-US">
        <TooltipProvider>
          <SidebarConfigurator
            plan={structuredClone(DEFAULT_RETIREMENT_PLAN)}
            currency="USD"
            plannerMode="fire"
            onSavePlan={vi.fn()}
            retirementOverview={
              { savingsGoalsMonthlyContribution: amount } as unknown as RetirementOverview
            }
          />
        </TooltipProvider>
      </FormattingProvider>,
    );
  }

  it("shows what savings goals plan beside the retirement contribution", () => {
    renderWithGoalsMonthly(1500);
    expect(screen.getByText("Savings goals also plan $1,500.00/mo")).toBeInTheDocument();
  });

  it("masks the amounts while balances are hidden", () => {
    privacy.hidden = true;
    renderWithGoalsMonthly(1500);
    expect(screen.getByText("Savings goals also plan ••••/mo")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\s?\d/);
  });

  it("stays hidden when no savings goal plans a contribution", () => {
    renderWithGoalsMonthly(0);
    expect(screen.queryByText(/Savings goals also plan/)).not.toBeInTheDocument();
  });
});

describe("SidebarConfigurator regional inputs", () => {
  it("displays and saves investment rates with Spain's decimal separator", () => {
    const onSavePlan = vi.fn<(plan: RetirementPlan) => void>();
    renderConfigurator(structuredClone(DEFAULT_RETIREMENT_PLAN), onSavePlan, "ES");
    fireEvent.click(screen.getByRole("button", { name: "Edit Projection Assumptions" }));
    const input = screen.getByRole("textbox", { name: "Return before retirement" });
    expect(input).toHaveValue("5,8");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "6,5" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(onSavePlan.mock.calls[0][0].investment.preRetirementAnnualReturn).toBeCloseTo(0.065);
  });

  it("preserves decimal commas when editing a spending inflation override", () => {
    const onSavePlan = vi.fn<(plan: RetirementPlan) => void>();
    const plan = structuredClone(DEFAULT_RETIREMENT_PLAN);
    plan.expenses.items![0].inflationRate = 0.025;
    renderConfigurator(plan, onSavePlan, "ES");
    fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Spending" }));
    fireEvent.click(screen.getByText("Living").closest("button")!);
    const input = screen.getByPlaceholderText("Plan 2,0");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3,5" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(onSavePlan.mock.calls[0][0].expenses.items![0].inflationRate).toBeCloseTo(0.035);
  });
});

it("saves an in-place RTL edit of the localized projection return", async () => {
  const onSavePlan = vi.fn();
  const user = userEvent.setup();
  const plan = structuredClone(DEFAULT_RETIREMENT_PLAN);
  plan.investment.preRetirementAnnualReturn = 0.058;
  render(
    <DirectionProvider direction="rtl">
      <FormattingProvider locale="ES">
        <TooltipProvider>
          <SidebarConfigurator
            plan={plan}
            currency="USD"
            plannerMode="traditional"
            onSavePlan={onSavePlan}
          />
        </TooltipProvider>
      </FormattingProvider>
    </DirectionProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Edit Projection Assumptions" }));
  const input = screen.getByRole("textbox", { name: "Return before retirement" });
  await user.click(input);
  await user.keyboard("{End}{Backspace}9{Tab}");
  await user.click(screen.getAllByRole("button", { name: "Save" })[0]);
  expect(onSavePlan).toHaveBeenCalledOnce();
  expect(onSavePlan.mock.calls[0][0].investment.preRetirementAnnualReturn).toBeCloseTo(0.059);
});

it.each([
  { direction: "ltr" as const, blank: "", expected: undefined },
  { direction: "rtl" as const, blank: "\u2068 \u2069", expected: undefined },
  { direction: "ltr" as const, blank: "0", expected: 0 },
  { direction: "rtl" as const, blank: "0", expected: 0 },
])(
  "preserves empty inheritance and explicit zero for inflation overrides in $direction ($expected)",
  ({ direction, blank, expected }) => {
    const onSavePlan = vi.fn();
    const plan = structuredClone(DEFAULT_RETIREMENT_PLAN);
    plan.expenses.items![0].inflationRate = 0.025;
    renderConfigurator(plan, onSavePlan, "ES", direction);
    fireEvent.click(screen.getByRole("button", { name: "Edit Retirement Spending" }));
    fireEvent.click(screen.getByText("Living").closest("button")!);
    const input = screen.getByPlaceholderText(/Plan.*2,0/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: blank } });
    fireEvent.blur(input);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(onSavePlan).toHaveBeenCalledOnce();
    expect(onSavePlan.mock.calls[0][0].expenses.items[0].inflationRate).toBe(expected);
  },
);
