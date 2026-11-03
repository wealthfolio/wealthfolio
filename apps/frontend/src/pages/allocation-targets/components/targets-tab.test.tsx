import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { Activity } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AllocationTarget, AllocationTargetConstraint } from "@/lib/types";
import { TargetsTab } from "./targets-tab";

const { saveConstraints, saveTarget } = vi.hoisted(() => ({
  saveConstraints: vi.fn(),
  saveTarget: vi.fn(),
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
vi.mock("@/hooks/use-holdings", () => ({ useHoldings: () => ({ holdings: [] }) }));
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

afterEach(() => vi.unstubAllGlobals());

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
