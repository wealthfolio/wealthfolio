import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalFundingEditor } from "./goal-funding-editor";

// Stable references, as React Query returns: the editor resets its draft when these change.
const data = vi.hoisted(() => ({
  hidden: false,
  accounts: [{ id: "acct-1", name: "Saving account", accountType: "CASH" }],
  valuation: {
    accounts: [{ accountId: "acct-1", totalValueBase: 100_000, baseCurrency: "USD" }],
  },
  goals: [{ id: "house", goalType: "home", title: "House", statusLifecycle: "active" }],
  fundingRules: [{ id: "r1", goalId: "house", accountId: "acct-1", sharePercent: 20 }],
  mutations: { saveFundingMutation: { mutate: () => undefined, isPending: false } },
}));

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: data.hidden }),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: data.accounts }),
}));
vi.mock("@/hooks/use-current-account-valuations", () => ({
  useCurrentValuation: () => ({ currentValuation: data.valuation }),
}));
vi.mock("../hooks/use-goals", () => ({
  useGoals: () => ({ goals: data.goals }),
}));
vi.mock("../hooks/use-goal-detail", () => ({
  useGoalDetail: () => ({ fundingRules: data.fundingRules }),
  useGoalPlanMutations: () => data.mutations,
}));

function renderEditor() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FormattingProvider locale="en-US">
        <TooltipProvider>
          <GoalFundingEditor goalId="house" goalType="home" />
        </TooltipProvider>
      </FormattingProvider>
    </QueryClientProvider>,
  );
}

describe("GoalFundingEditor amounts", () => {
  beforeEach(() => {
    data.hidden = false;
  });

  it("shows the money a share counts beside its percentage", () => {
    renderEditor();
    expect(screen.getByText("Saving account")).toBeInTheDocument();
    expect(screen.getByText("$20K")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
  });

  it("hides the amounts while balances are hidden", () => {
    data.hidden = true;
    renderEditor();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.queryByText("$20K")).not.toBeInTheDocument();
  });
});
