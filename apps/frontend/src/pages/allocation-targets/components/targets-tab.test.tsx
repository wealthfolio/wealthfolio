import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { Activity } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AllocationTarget, AllocationTargetConstraint, Holding } from "@/lib/types";
import { TargetsTab } from "./targets-tab";

const { saveConstraints, saveTarget, holdingsRef } = vi.hoisted(() => ({
  saveConstraints: vi.fn(),
  saveTarget: vi.fn(),
  holdingsRef: { current: [] as Holding[] },
}));

const target: AllocationTarget = {
  id: "target-1",
  name: "My target",
  scopeType: "all",
  taxonomyId: "asset_classes",
  triggerType: "threshold",
  driftBandBps: 100,
  bandType: "absolute",
  relativeFactorBps: 2000,
  rebalanceGoal: "nearest_band",
  minTradeAmount: "0",
  wholeSharesOnly: false,
  allowSells: true,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
const existing: AllocationTargetConstraint = {
  id: "existing-constraint",
  targetId: target.id,
  subjectType: "account",
  subjectId: "old-account",
  action: "sell",
  effect: "block",
  createdAt: "2026-10-01",
  updatedAt: "2026-10-01",
};
const taxonomy = {
  id: "asset_classes",
  name: "Asset classes",
  categories: [{ id: "equity", name: "Equity", parentId: null }],
};
const weights = [{ categoryId: "equity", targetBps: 10000, isLocked: false }];

vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomies: () => ({ data: [taxonomy] }),
  useTaxonomy: () => ({ data: taxonomy, isLoading: false }),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: [{ id: "account-1", name: "New account", isActive: true }] }),
}));
vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({ holdings: holdingsRef.current, isComplete: true }),
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-portfolio-allocations", () => ({
  usePortfolioAllocations: () => ({ isLoading: false }),
}));
vi.mock("../hooks/use-allocation-target-mutations", () => ({
  useDeleteAllocationTarget: () => ({}),
  useAllocationTargetWeights: () => ({ data: weights, isLoading: false }),
  useSaveAllocationTargetWithWeights: () => ({ mutateAsync: saveTarget, isPending: false }),
}));
vi.mock("../hooks/use-target-constraints", () => ({
  useTargetConstraints: () => ({ constraints: [existing], isLoading: false, saveConstraints }),
}));
vi.mock("./target-weight-editor", () => ({ TargetWeightEditor: () => null }));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  holdingsRef.current = [];
});

it("can protect a known holding even when its market value is unavailable", async () => {
  holdingsRef.current = [
    {
      id: "unpriced",
      holdingType: "security",
      quantity: 1,
      instrument: { id: "unpriced", symbol: "UNPRICED", name: "Unknown price" },
      marketValue: { local: null, base: null },
    } as Holding,
  ];
  const user = userEvent.setup();
  render(
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <TargetsTab
          targets={[target]}
          selectedTargetId={target.id}
          accountScope={{ type: "all" }}
          onTargetChange={vi.fn()}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Add asset" }));
  await user.click(screen.getByRole("button", { name: /UNPRICED/ }));
  expect(screen.getByRole("button", { name: "Remove UNPRICED" })).toBeInTheDocument();
});

it.each([undefined, {}])(
  "saves a new sell-protection constraint without crypto APIs (%j)",
  async (crypto) => {
    vi.stubGlobal("crypto", crypto);
    saveTarget.mockReset().mockResolvedValue({ target, weights });
    saveConstraints.mockReset().mockResolvedValue([]);
    const user = userEvent.setup();
    render(
      <FormattingProvider locale="en-US">
        <TooltipProvider>
          <TargetsTab
            targets={[target]}
            selectedTargetId={target.id}
            accountScope={{ type: "all" }}
            onTargetChange={vi.fn()}
          />
        </TooltipProvider>
      </FormattingProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.click(screen.getByRole("button", { name: "New account" }));
    await user.click(screen.getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(saveConstraints).toHaveBeenCalledTimes(1));
    const saved = saveConstraints.mock.calls[0][0] as AllocationTargetConstraint[];
    expect(saved[0]).toEqual(existing);
    expect(saved[1]).toMatchObject({
      targetId: target.id,
      subjectType: "account",
      subjectId: "account-1",
      action: "sell",
      effect: "block",
    });
    expect(saved[1].id).toBeTruthy();
    expect(saved[1].id).not.toBe(existing.id);
  },
);

it("keeps an edited target as it was when its phone screen comes back", async () => {
  // On a phone, a screen left for another tab is a hidden <Activity>.
  const targets = [target];
  const scope = { type: "all" as const };
  const onTargetChange = vi.fn();
  const tab = (hidden: boolean) => (
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <TargetsTab
            targets={targets}
            selectedTargetId={target.id}
            accountScope={scope}
            onTargetChange={onTargetChange}
          />
        </Activity>
      </TooltipProvider>
    </FormattingProvider>
  );
  const user = userEvent.setup();
  const { rerender } = render(tab(false));
  const name = screen.getByPlaceholderText("Target name");
  await user.clear(name);
  await user.type(name, "Retirement mix");
  expect(screen.getByRole("button", { name: "Save target" })).toBeEnabled();

  rerender(tab(true));
  rerender(tab(false));

  expect(screen.getByPlaceholderText("Target name")).toHaveValue("Retirement mix");
  expect(screen.getByRole("button", { name: "Save target" })).toBeEnabled();
});

it.each(["ltr", "rtl"] as const)(
  "displays and saves a Spain turnover cap in %s",
  async (direction) => {
    const cappedTarget = { ...target, maxTurnoverBps: 1250 };
    saveTarget.mockReset().mockResolvedValue({ target: cappedTarget, weights });
    saveConstraints.mockReset().mockResolvedValue([]);
    render(
      <DirectionProvider direction={direction}>
        <FormattingProvider locale="ES">
          <TooltipProvider>
            <TargetsTab
              targets={[cappedTarget]}
              selectedTargetId={target.id}
              accountScope={{ type: "all" }}
              onTargetChange={vi.fn()}
            />
          </TooltipProvider>
        </FormattingProvider>
      </DirectionProvider>,
    );
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("No limit");
    expect(input).toHaveValue("12,5");
    await user.click(input);
    await user.keyboard("{End}{Backspace}6");
    await user.click(screen.getByRole("button", { name: "Save target" }));
    await waitFor(() =>
      expect(saveTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ maxTurnoverBps: 1260 }),
        }),
      ),
    );
  },
);

it.each(["101", "-1", "invalid"])("does not save invalid turnover cap %s", async (value) => {
  saveTarget.mockReset();
  render(
    <FormattingProvider locale="ES">
      <TooltipProvider>
        <TargetsTab
          targets={[target]}
          selectedTargetId={target.id}
          accountScope={{ type: "all" }}
          onTargetChange={vi.fn()}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
  const user = userEvent.setup();
  const input = screen.getByPlaceholderText("No limit");
  await user.type(input, value);
  expect(screen.getByRole("button", { name: "Save target" })).toBeDisabled();
  expect(saveTarget).not.toHaveBeenCalled();
});

it("preserves an edited turnover cap across a region change", async () => {
  const cappedTarget = { ...target, maxTurnoverBps: 1250 };
  const targets = [cappedTarget];
  const scope = { type: "all" as const };
  const onTargetChange = vi.fn();
  saveTarget.mockReset().mockResolvedValue({ target: cappedTarget, weights });
  saveConstraints.mockReset().mockResolvedValue([]);
  const tab = (locale: string) => (
    <FormattingProvider locale={locale}>
      <TooltipProvider>
        <TargetsTab
          targets={targets}
          selectedTargetId={target.id}
          accountScope={scope}
          onTargetChange={onTargetChange}
        />
      </TooltipProvider>
    </FormattingProvider>
  );
  const { rerender } = render(tab("ES"));
  const user = userEvent.setup();
  const input = screen.getByPlaceholderText("No limit");
  await user.click(input);
  await user.keyboard("{End}{Backspace}6");
  rerender(tab("US"));
  expect(input).toHaveValue("12.6");
  await user.click(screen.getByRole("button", { name: "Save target" }));
  await waitFor(() =>
    expect(saveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ maxTurnoverBps: 1260 }),
      }),
    ),
  );
});

it("clears a turnover cap instead of saving zero when its draft is empty", async () => {
  const cappedTarget = { ...target, maxTurnoverBps: 1250 };
  saveTarget.mockReset().mockResolvedValue({ target: cappedTarget, weights });
  saveConstraints.mockReset().mockResolvedValue([]);
  render(
    <FormattingProvider locale="ES">
      <TooltipProvider>
        <TargetsTab
          targets={[cappedTarget]}
          selectedTargetId={target.id}
          accountScope={{ type: "all" }}
          onTargetChange={vi.fn()}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
  const user = userEvent.setup();
  await user.clear(screen.getByPlaceholderText("No limit"));
  await user.click(screen.getByRole("button", { name: "Save target" }));
  await waitFor(() =>
    expect(saveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ maxTurnoverBps: null }),
      }),
    ),
  );
});
