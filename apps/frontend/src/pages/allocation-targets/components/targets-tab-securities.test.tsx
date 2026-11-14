import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider } from "@wealthfolio/ui";
import { TooltipProvider } from "@wealthfolio/ui/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AllocationTarget, Holding } from "@/lib/types";
import { TargetsTab } from "./targets-tab";

const SENTINEL = "__individual_securities__";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  useTaxonomy: vi.fn(),
  useAllocationTargetWeights: vi.fn(),
  useAllocationTargetAssetWeights: vi.fn(),
}));

function held(assetId: string, symbol: string, base: number, overrides: Partial<Holding> = {}) {
  return {
    id: `${assetId}-holding`,
    holdingType: "security",
    accountId: "account-1",
    assetKind: "INVESTMENT",
    instrument: { id: assetId, symbol, name: `${symbol} name`, currency: "USD" },
    quantity: 1,
    marketValue: { local: base, base },
    ...overrides,
  } as Holding;
}

const holdings = [
  held("vti", "VTI", 6000),
  held("aapl", "AAPL", 4000),
  held("usd", "CASHUSD", 9000, { holdingType: "cash" }),
  held("house", "HOUSE", 90000, { assetKind: "PROPERTY" }),
];

const taxonomy = {
  id: "asset_classes",
  name: "Asset classes",
  categories: [
    { id: "equity", taxonomyId: "asset_classes", name: "Equity", parentId: null, sortOrder: 0 },
  ],
};

const baseTarget: AllocationTarget = {
  id: "target-1",
  name: "My target",
  scopeType: "all",
  taxonomyId: "asset_classes",
  targetType: "category",
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
const assetTarget: AllocationTarget = {
  ...baseTarget,
  id: "target-2",
  name: "My stocks",
  taxonomyId: SENTINEL,
  targetType: "asset",
};

vi.mock("@/hooks/use-taxonomies", () => ({
  useTaxonomies: () => ({ data: [taxonomy] }),
  useTaxonomy: mocks.useTaxonomy,
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: [{ id: "account-1", name: "Brokerage", isActive: true }] }),
}));
vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: () => ({ holdings, isComplete: true }),
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-portfolio-allocations", () => ({
  usePortfolioAllocations: () => ({ isLoading: false }),
}));
vi.mock("@/pages/asset/hooks/use-assets", () => ({
  useAssets: () => ({
    assets: [{ id: "gone", kind: "INVESTMENT", displayCode: "GONE", name: "Sold off" }],
  }),
}));
vi.mock("../hooks/use-allocation-target-mutations", () => ({
  useDeleteAllocationTarget: () => ({}),
  useAllocationTargetWeights: mocks.useAllocationTargetWeights,
  useAllocationTargetAssetWeights: mocks.useAllocationTargetAssetWeights,
  useSaveAllocationTargetWithWeights: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
vi.mock("../hooks/use-target-constraints", () => ({
  useTargetConstraints: () => ({ constraints: [], isLoading: false, saveConstraints: vi.fn() }),
}));
vi.mock("@/components/account-filter-selector", () => ({ AccountScopeSelector: () => null }));

beforeEach(() => {
  mocks.save.mockReset().mockImplementation(async ({ id }: { id: string | null }) => ({
    target: id === assetTarget.id ? assetTarget : baseTarget,
  }));
  mocks.useTaxonomy.mockReset().mockImplementation((id: string | null) => ({
    data: id ? taxonomy : undefined,
    isLoading: false,
  }));
  // As the real hook: nothing is read without a target id.
  mocks.useAllocationTargetWeights.mockReset().mockImplementation((id: string | null) => ({
    data: id ? [{ categoryId: "equity", targetBps: 10000, isLocked: false }] : undefined,
    isLoading: false,
  }));
  mocks.useAllocationTargetAssetWeights
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false });
});

function renderTab(props: { target?: AllocationTarget; create?: boolean }) {
  const targets = props.target ? [props.target] : [];
  return render(
    <FormattingProvider locale="en-US">
      <TooltipProvider>
        <TargetsTab
          targets={targets}
          selectedTargetId={props.target?.id ?? null}
          editorMode={props.create ? "create" : undefined}
          accountScope={{ type: "all" }}
          onTargetChange={vi.fn()}
        />
      </TooltipProvider>
    </FormattingProvider>,
  );
}

async function startSecuritiesTarget() {
  const user = userEvent.setup();
  renderTab({ create: true });
  await user.click(screen.getByRole("button", { name: /Individual securities/ }));
  return user;
}

describe("individual securities target: creating", () => {
  it("offers the type next to the taxonomies and switches the editor to securities", async () => {
    const user = userEvent.setup();
    renderTab({ create: true });
    expect(screen.getByRole("button", { name: /Asset classes/ })).toBeInTheDocument();
    expect(screen.queryByText("VTI")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Individual securities/ }));

    expect(screen.getByRole("button", { name: /Individual securities/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("VTI")).toBeInTheDocument();
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    // Taxonomy presets do not apply to securities.
    expect(screen.queryByText(/example weights/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Equal weight" })).toBeInTheDocument();
  });

  it("lists neither cash nor alternative assets", async () => {
    await startSecuritiesTarget();
    await screen.findByText("VTI");
    expect(screen.queryByText("CASHUSD")).not.toBeInTheDocument();
    expect(screen.queryByText("HOUSE")).not.toBeInTheDocument();
  });

  it("never loads the sentinel as a taxonomy", async () => {
    await startSecuritiesTarget();
    await screen.findByText("VTI");
    expect(mocks.useTaxonomy).not.toHaveBeenCalledWith(SENTINEL);
    expect(mocks.useTaxonomy).toHaveBeenLastCalledWith(null);
  });

  it("starts from the current allocation of the securities held", async () => {
    await startSecuritiesTarget();
    const total = (await screen.findByText("Total")).parentElement!;
    expect(total).toHaveTextContent("100.0%");
    expect(screen.getByRole("button", { name: "Create target" })).toBeEnabled();
  });

  it("only saves weights that add up to 10000 bps", async () => {
    const user = await startSecuritiesTarget();
    await screen.findByText("VTI");

    await user.click(screen.getByRole("button", { name: "Build from scratch" }));
    expect(await screen.findByText(/100\.0% unallocated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create target" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Equal weight" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create target" })).toBeEnabled(),
    );
  });

  it("saves the type, the sentinel taxonomy and only asset weights", async () => {
    const user = await startSecuritiesTarget();
    await screen.findByText("VTI");
    await user.click(screen.getByRole("button", { name: "Equal weight" }));
    await user.click(screen.getByRole("button", { name: "Create target" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const request = mocks.save.mock.calls[0][0];
    expect(request.id).toBeNull();
    expect(request.input).toMatchObject({ targetType: "asset", taxonomyId: SENTINEL });
    expect(request.weights).toEqual([]);
    expect(request.assetWeights).toEqual([
      { assetId: "vti", targetBps: 5000, isLocked: false, isRequired: true },
      { assetId: "aapl", targetBps: 5000, isLocked: false, isRequired: true },
    ]);
  });

  it("goes back to a taxonomy target when a taxonomy is chosen again", async () => {
    const user = await startSecuritiesTarget();
    await screen.findByText("VTI");
    await user.click(screen.getByRole("button", { name: /Asset classes/ }));
    expect(screen.getByRole("button", { name: /Individual securities/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText("VTI")).not.toBeInTheDocument();
    expect(mocks.useTaxonomy).toHaveBeenLastCalledWith("asset_classes");
  });
});

describe("individual securities target: editing", () => {
  beforeEach(() => {
    mocks.useAllocationTargetAssetWeights.mockReturnValue({
      data: [
        { assetId: "vti", targetBps: 7000, isLocked: false },
        { assetId: "gone", targetBps: 3000, isLocked: true },
      ],
      isLoading: false,
    });
  });

  it("loads the saved weights, keeps a sold security and adds the others at zero", async () => {
    renderTab({ target: assetTarget });
    expect(await screen.findByText("VTI")).toBeInTheDocument();
    expect(screen.getByText("GONE")).toBeInTheDocument();
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("Total").parentElement).toHaveTextContent("100.0%");
    // Only the weights of the target's own kind are read.
    expect(mocks.useAllocationTargetWeights).toHaveBeenCalledWith(null);
    expect(mocks.useAllocationTargetAssetWeights).toHaveBeenCalledWith(assetTarget.id);
    expect(mocks.useTaxonomy).not.toHaveBeenCalledWith(SENTINEL);
  });

  it("says the type cannot change and offers no other", async () => {
    renderTab({ target: assetTarget });
    expect(
      await screen.findByText(/cannot be changed after the target is created/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Individual securities/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Asset classes/ })).not.toBeInTheDocument();
  });

  it("saves the changed weights without the securities left at zero", async () => {
    const user = userEvent.setup();
    renderTab({ target: assetTarget });
    await screen.findByText("VTI");
    const name = screen.getByPlaceholderText("Target name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save target" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const request = mocks.save.mock.calls[0][0];
    expect(request.id).toBe(assetTarget.id);
    expect(request.input).toMatchObject({ targetType: "asset", taxonomyId: SENTINEL });
    expect(request.weights).toEqual([]);
    expect(request.assetWeights).toEqual([
      { assetId: "vti", targetBps: 7000, isLocked: false, isRequired: true },
      { assetId: "gone", targetBps: 3000, isLocked: true, isRequired: true },
    ]);
  });

  it("keeps a security locked at zero", async () => {
    mocks.useAllocationTargetAssetWeights.mockReturnValue({
      data: [
        { assetId: "vti", targetBps: 10000, isLocked: false },
        { assetId: "aapl", targetBps: 0, isLocked: true },
      ],
      isLoading: false,
    });
    const user = userEvent.setup();
    renderTab({ target: assetTarget });
    await screen.findByText("VTI");
    await user.type(screen.getByPlaceholderText("Target name"), "!");
    await user.click(screen.getByRole("button", { name: "Save target" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0].assetWeights).toEqual([
      { assetId: "vti", targetBps: 10000, isLocked: false, isRequired: true },
      { assetId: "aapl", targetBps: 0, isLocked: true, isRequired: true },
    ]);
  });
});

describe("category target: unchanged", () => {
  it("keeps taxonomy choices, offers no securities type and says the type is fixed", async () => {
    renderTab({ target: baseTarget });
    expect(
      await screen.findByText(/cannot be changed after the target is created/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Asset classes/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Individual securities/ })).not.toBeInTheDocument();
    expect(mocks.useAllocationTargetAssetWeights).toHaveBeenCalledWith(null);
    expect(mocks.useTaxonomy).toHaveBeenLastCalledWith("asset_classes");
  });

  it("saves category weights and no asset weights", async () => {
    const user = userEvent.setup();
    renderTab({ target: baseTarget });
    const name = await screen.findByPlaceholderText("Target name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save target" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const request = mocks.save.mock.calls[0][0];
    expect(request.input).toMatchObject({ targetType: "category", taxonomyId: "asset_classes" });
    expect(request.weights).toEqual([
      { categoryId: "equity", targetBps: 10000, isLocked: false, isRequired: true },
    ]);
    expect(request.assetWeights).toBeUndefined();
  });

  it("shows the securities option when a new target is started", () => {
    renderTab({ create: true });
    const section = screen.getByText("Allocation type").closest("section")!;
    expect(within(section).getByRole("button", { name: /Individual securities/ })).toBeEnabled();
  });
});
