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
  otherFunding: {} as Record<string, { goalId: string; accountId: string; sharePercent: number }[]>,
  mutations: { saveFundingMutation: { mutate: () => undefined, isPending: false } },
}));

vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getGoalFunding: (goalId: string) => Promise.resolve(data.otherFunding[goalId] ?? []),
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

it("restores the existing account share when its draft is empty", () => {
  renderEditor(false, "ES");
  fireEvent.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  const input = screen.getByRole("textbox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("20");
  expect(screen.getByText("80 % left")).toBeInTheDocument();
});

it("enables Save while a valid share is still being typed", async () => {
  const save = vi.spyOn(data.mutations.saveFundingMutation, "mutate");
  save.mockClear();
  const user = userEvent.setup();
  renderEditor(false, "ES");
  await user.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  const saveButton = screen.getByRole("button", { name: "Save" });
  const input = screen.getByRole("textbox");
  await user.tripleClick(input);
  await user.keyboard("abc");
  expect(saveButton).toBeDisabled();
  await user.tripleClick(input);
  await user.keyboard("7,25");
  // Browsers drop a click on a disabled button even if the blur it causes enables it.
  expect(saveButton).toBeEnabled();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledWith([
    expect.objectContaining({ accountId: "acct-1", sharePercent: 7.25 }),
  ]);
});

it("saves the typed share even if the click arrives before the input blurs", () => {
  const save = vi.spyOn(data.mutations.saveFundingMutation, "mutate");
  save.mockClear();
  renderEditor(false, "ES");
  fireEvent.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "7,25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith([
    expect.objectContaining({ accountId: "acct-1", sharePercent: 7.25 }),
  ]);
});

it("keeps Save disabled after Escape or when the typed share becomes invalid", async () => {
  const user = userEvent.setup();
  renderEditor(false, "ES");
  await user.click(screen.getByRole("button", { name: "Edit Account Shares" }));
  const saveButton = screen.getByRole("button", { name: "Save" });
  const input = screen.getByRole("textbox");
  await user.tripleClick(input);
  await user.keyboard("7a");
  expect(saveButton).toBeDisabled();
  await user.tripleClick(input);
  await user.keyboard("30");
  expect(saveButton).toBeEnabled();
  await user.keyboard("{Escape}");
  expect(input).toHaveValue("20");
  expect(saveButton).toBeDisabled();
});

it("enables Save while typing a share that clears another goal's overage", async () => {
  const goals = data.goals;
  data.goals = [...goals, { id: "car", goalType: "car", title: "Car", statusLifecycle: "active" }];
  data.otherFunding = { car: [{ goalId: "car", accountId: "acct-1", sharePercent: 50 }] };
  const save = vi.spyOn(data.mutations.saveFundingMutation, "mutate");
  save.mockClear();
  try {
    const user = userEvent.setup();
    renderEditor(false, "ES");
    await user.click(screen.getByRole("button", { name: "Edit Account Shares" }));
    const saveButton = screen.getByRole("button", { name: "Save" });
    const input = screen.getByRole("textbox");
    await user.tripleClick(input);
    await user.keyboard("80{Tab}");
    expect(await screen.findByText(/30\s%\sover/)).toBeInTheDocument();
    expect(saveButton).toBeDisabled();
    await user.tripleClick(input);
    await user.keyboard("30");
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({ accountId: "acct-1", sharePercent: 30 }),
    ]);
  } finally {
    data.goals = goals;
    data.otherFunding = {};
  }
});

it.each(["ltr", "rtl"] as const)(
  "preserves a fallback share through a region change, continued typing and save in %s",
  async (direction) => {
    const save = vi.spyOn(data.mutations.saveFundingMutation, "mutate");
    save.mockClear();
    const user = userEvent.setup();
    const client = new QueryClient();
    const view = (locale: string) => (
      <QueryClientProvider client={client}>
        <DirectionProvider direction={direction}>
          <FormattingProvider locale={locale}>
            <TooltipProvider>
              <GoalFundingEditor goalId="house" goalType="home" />
            </TooltipProvider>
          </FormattingProvider>
        </DirectionProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(view("ES"));
    await user.click(screen.getByRole("button", { name: "Edit Account Shares" }));
    const input = screen.getByRole("textbox");
    await user.click(input);
    fireEvent.change(input, { target: { value: "12.34" } });
    rerender(view("US"));
    expect(input).toHaveValue("12.34");
    await user.keyboard("{End}5{Tab}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ sharePercent: 12.345 })]);
  },
);
