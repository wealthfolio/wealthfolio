import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { useAccounts } from "@/hooks/use-accounts";
import type { PortfolioWithAccounts } from "@/lib/types";
import { DashboardPortfolioSelector } from "./dashboard-portfolio-selector";

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: vi.fn() }));
vi.mock("@/hooks/use-portfolios", () => ({
  usePortfolioMutations: () => ({
    createMutation: { isPending: false, mutate: vi.fn() },
    updateMutation: { isPending: false, mutate: vi.fn() },
  }),
}));
vi.mock("@/components/account-filter-selector", () => ({
  AccountScopeSelector: ({ onEditPortfolio }: { onEditPortfolio: () => void }) => (
    <button onClick={onEditPortfolio}>Edit portfolio</button>
  ),
}));

it("waits for accounts before initialising an editor's existing membership", async () => {
  const portfolio: PortfolioWithAccounts = {
    id: "retirement",
    name: "Retirement",
    accountIds: ["brokerage", "savings"],
    sortOrder: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  vi.mocked(useAccounts).mockReturnValue({
    accounts: [],
    isLoading: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAccounts>);
  const props = {
    scope: { type: "portfolio" as const, portfolioId: portfolio.id },
    portfolio,
    onSelect: vi.fn(),
  };
  const { rerender } = render(<DashboardPortfolioSelector {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit portfolio" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  vi.mocked(useAccounts).mockReturnValue({
    accounts: [
      { id: "brokerage", name: "Brokerage", currency: "USD" },
      { id: "savings", name: "Savings", currency: "USD" },
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAccounts>);
  rerender(<DashboardPortfolioSelector {...props} />);
  const editor = screen.getByRole("dialog", { name: "Edit portfolio" });
  expect(within(editor).getByRole("checkbox", { name: /Brokerage/ })).toBeChecked();
  expect(within(editor).getByRole("checkbox", { name: /Savings/ })).toBeChecked();
  expect(within(editor).getByRole("button", { name: "Save" })).toBeEnabled();
  expect(within(editor).queryByText(/deleted account/i)).not.toBeInTheDocument();
});
