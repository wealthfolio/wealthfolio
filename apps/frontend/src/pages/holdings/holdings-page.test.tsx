import { useAccountScopeStore } from "@/lib/account-scope-store";
import type { AccountScope } from "@/lib/types";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HoldingsPage } from "./holdings-page";

const mocks = vi.hoisted(() => ({
  useAccounts: vi.fn(),
  useHoldingsWithClosedProbe: vi.fn(),
}));

vi.mock("@/hooks/use-accounts", () => ({ useAccounts: mocks.useAccounts }));
vi.mock("@/hooks/use-holdings", () => ({
  useHoldingsWithClosedProbe: mocks.useHoldingsWithClosedProbe,
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: () => ({ data: [] }) }));
vi.mock("@/hooks/use-alternative-assets", () => ({
  useAlternativeHoldings: () => ({ data: [], isLoading: false }),
  useDeleteAlternativeAsset: () => ({ mutate: vi.fn() }),
  useLinkLiability: () => ({ mutate: vi.fn() }),
  useUnlinkLiability: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useUpdatePortfolioMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/adapters", () => ({ updateAlternativeAssetMetadata: vi.fn() }));

// Render only the active view's actions + content, as SwipablePage does on desktop.
vi.mock("@/components/page", () => ({
  SwipablePage: ({ views }: { views: { actions?: unknown; content?: unknown }[] }) => (
    <div>
      <div data-testid="toolbar-actions">{views[0]?.actions as React.ReactNode}</div>
      <div>{views[0]?.content as React.ReactNode}</div>
    </div>
  ),
}));

vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: ({
    value,
    onChange,
  }: {
    value: AccountScope;
    onChange: (scope: AccountScope) => void;
  }) => (
    <button
      data-testid="account-scope-selector"
      data-scope={JSON.stringify(value)}
      onClick={() => onChange({ type: "all" })}
    >
      scope
    </button>
  ),
}));

vi.mock("@/components/action-palette", () => ({ ActionPalette: () => null }));
vi.mock("@/components/classification/classification-sheet", () => ({
  ClassificationSheet: () => null,
}));
vi.mock("@/pages/asset/alternative-assets", () => ({
  AlternativeAssetQuickAddModal: () => null,
  AssetDetailsSheet: () => null,
  UpdateValuationModal: () => null,
}));
vi.mock("./components/holdings-table", () => ({ HoldingsTable: () => null }));
vi.mock("./components/holdings-table-mobile", () => ({ HoldingsTableMobile: () => null }));
vi.mock("./components/alternative-holdings-table", () => ({
  AlternativeHoldingsTable: () => null,
}));
vi.mock("./components/alternative-holdings-list-mobile", () => ({
  AlternativeHoldingsListMobile: () => null,
}));
vi.mock("./components/holdings-edit-mode", () => ({
  HoldingsEditMode: () => <div data-testid="holdings-edit-mode" />,
}));

const manualAccount = {
  id: "acc-1",
  name: "Manual Brokerage",
  accountType: "SECURITIES",
  currency: "USD",
  trackingMode: "HOLDINGS",
  isActive: true,
};

const initialState = useAccountScopeStore.getState();

function renderPage() {
  return render(
    <MemoryRouter>
      <HoldingsPage />
    </MemoryRouter>,
  );
}

function selectorScope(): AccountScope {
  return JSON.parse(screen.getByTestId("account-scope-selector").dataset.scope ?? "null");
}

function toolbarUpdateButton() {
  return within(screen.getByTestId("toolbar-actions")).queryByRole("button", { name: /update/i });
}

describe("HoldingsPage account scope", () => {
  beforeEach(() => {
    useAccountScopeStore.setState(initialState, true);
    mocks.useAccounts.mockReturnValue({ accounts: [manualAccount], isLoading: false });
    mocks.useHoldingsWithClosedProbe.mockReturnValue({
      holdings: [],
      isLoading: false,
      hasHiddenClosedPositions: false,
    });
  });

  it("applies a scope selected on another page when mounting", () => {
    useAccountScopeStore.getState().setScope({ type: "account", accountId: "acc-1" });

    renderPage();

    expect(selectorScope()).toEqual({ type: "account", accountId: "acc-1" });
    // The account is derived from the shared scope, so its edit affordance shows.
    expect(toolbarUpdateButton()).toBeInTheDocument();
  });

  it("publishes a scope change to the shared store", async () => {
    useAccountScopeStore.getState().setScope({ type: "account", accountId: "acc-1" });
    renderPage();

    await userEvent.click(screen.getByTestId("account-scope-selector"));

    expect(useAccountScopeStore.getState().scope).toEqual({ type: "all" });
    expect(toolbarUpdateButton()).not.toBeInTheDocument();
  });
});
