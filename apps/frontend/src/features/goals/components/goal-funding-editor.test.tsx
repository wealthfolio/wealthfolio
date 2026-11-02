import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { FormattingProvider, stripBidiControls } from "@wealthfolio/ui";
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

function renderEditor(editing = false, locale = "en-US", direction: "ltr" | "rtl" = "ltr") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DirectionProvider direction={direction}>
        <FormattingProvider locale={locale}>
          <TooltipProvider>
            <GoalFundingEditor goalId="house" goalType="home" editing={editing || undefined} />
          </TooltipProvider>
        </FormattingProvider>
      </DirectionProvider>
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

it("edits goal funding with decimal commas without changing the numeric share", () => {
  renderEditor(false, "ES");
  fireEvent.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "33,3" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("33,3");
  expect(screen.getByText("66,7 % left")).toBeInTheDocument();
});

it("edits an existing share in place in RTL without retaining direction markers", async () => {
  const user = userEvent.setup();
  renderEditor(false, "ES", "rtl");
  await user.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  const input = screen.getByRole("textbox");
  await user.click(input);
  await user.keyboard("{End}{Backspace}1{Tab}");
  expect(input).toHaveValue("21");
  expect(screen.getByText((text) => stripBidiControls(text) === "79 % left")).toBeInTheDocument();
});
