import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActionPaletteGroup } from "@/components/action-palette";
import { DashboardActions } from "./dashboard-actions";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  update: vi.fn(),
  rebuild: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: "/", search: "?tab=spending", key: "origin" }),
}));
vi.mock("@/components/action-palette", () => ({
  ActionPalette: ({ groups }: { groups: ActionPaletteGroup[] }) => (
    <div>
      {groups.flatMap((group) =>
        group.items.map((item) => (
          <button key={item.label} onClick={item.onClick} aria-pressed={item.checked}>
            {item.label}
          </button>
        )),
      )}
    </div>
  ),
}));
vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useUpdatePortfolioMutation: () => ({ mutate: mocks.update }),
  useRecalculatePortfolioMutation: () => ({ mutate: mocks.rebuild }),
}));
vi.mock("@/hooks/use-health", () => ({ useRunHealthChecks: () => ({ mutate: mocks.verify }) }));
vi.mock("@/features/devices-sync", () => ({ syncService: {} }));
vi.mock("@/features/devices-sync/hooks", () => ({
  useSyncStatus: () => ({ syncState: "disabled" }),
}));
vi.mock("@/features/wealthfolio-connect", () => ({ hasBrokerSync: () => false }));
vi.mock("@/features/wealthfolio-connect/hooks", () => ({
  useSyncBrokerData: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/wealthfolio-connect/providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => ({ isEnabled: false, isConnected: false }),
}));

beforeEach(() => vi.clearAllMocks());

it("exposes comparison as a checked Spending action without navigating", () => {
  const toggle = vi.fn();
  const { rerender } = render(<DashboardActions view="spending" onCompareToggle={toggle} />);
  const action = screen.getByRole("button", { name: "Compare to prior period" });
  expect(action).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(action);
  expect(toggle).toHaveBeenCalledOnce();
  expect(mocks.navigate).not.toHaveBeenCalled();
  rerender(<DashboardActions view="spending" compareEnabled onCompareToggle={toggle} />);
  expect(action).toHaveAttribute("aria-pressed", "true");
  rerender(<DashboardActions view="investments" compareEnabled onCompareToggle={toggle} />);
  expect(screen.queryByRole("button", { name: "Compare to prior period" })).not.toBeInTheDocument();
});

it("opens asset management from Net Worth and omits full-history refresh", () => {
  const addAsset = vi.fn();
  const addLiability = vi.fn();
  render(<DashboardActions onAddAsset={addAsset} onAddLiability={addLiability} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/holdings?tab=assets");
  expect(screen.queryByRole("button", { name: /Refresh full history/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add Asset" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Liability" }));
  expect(addAsset).toHaveBeenCalledOnce();
  expect(addLiability).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /Update prices/i }));
  fireEvent.click(screen.getByRole("button", { name: "Verify Data" }));
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.verify).toHaveBeenCalledOnce();
});

it("preserves the Investments menu", () => {
  render(<DashboardActions />);
  expect(screen.queryByRole("button", { name: "Manage" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Refresh full history/i }));
  expect(mocks.rebuild).toHaveBeenCalledOnce();
});

it.each(["investments", "net-worth", "spending"] as const)(
  "opens expense and income from the %s overflow menu",
  (view) => {
    render(<DashboardActions view={view} spendingEnabled />);
    for (const [label, type] of [
      ["Add expense", "WITHDRAWAL"],
      ["Add income", "DEPOSIT"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(mocks.navigate).toHaveBeenLastCalledWith(`/spending/transactions/new?type=${type}`, {
        replace: false,
        state: {
          backgroundLocation: expect.objectContaining({ pathname: "/", search: "?tab=spending" }),
        },
      });
    }
  },
);

it("hides expense and income when Spending is disabled", () => {
  render(<DashboardActions />);
  expect(screen.queryByRole("button", { name: "Add expense" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add income" })).not.toBeInTheDocument();
});

it("keeps the full Spending picker and paired Transfer form available", () => {
  render(<DashboardActions view="spending" spendingEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith(
    "/spending/transactions/new?type=TRANSFER",
    expect.any(Object),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));
  expect(mocks.navigate).toHaveBeenLastCalledWith("/spending/transactions/new", expect.any(Object));
  expect(screen.queryByRole("button", { name: /Refresh full history/i })).not.toBeInTheDocument();
});
