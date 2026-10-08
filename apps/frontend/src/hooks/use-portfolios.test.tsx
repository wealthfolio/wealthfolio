import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { createPortfolio, getPortfolios } from "@/adapters";
import type { PortfolioWithAccounts } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { useDashboardPortfolio } from "@/pages/dashboard/use-dashboard-portfolio";
import { usePortfolioMutations, usePortfolios } from "./use-portfolios";

vi.mock("@/adapters", () => ({
  createPortfolio: vi.fn(),
  getPortfolios: vi.fn(),
  deletePortfolio: vi.fn(),
  updatePortfolioEntry: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "portfolio-create-test",
  usesLegacyPreferences: () => false,
}));

it("publishes a created portfolio before its inventory refresh completes", async () => {
  localStorage.clear();
  const created: PortfolioWithAccounts = {
    id: "new-portfolio",
    name: "Savings",
    accountIds: ["savings"],
    sortOrder: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  vi.mocked(createPortfolio).mockResolvedValue(created);
  vi.mocked(getPortfolios)
    .mockResolvedValueOnce([])
    .mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => ({
      inventory: usePortfolios(),
      mutations: usePortfolioMutations(),
      dashboard: useDashboardPortfolio(),
    }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
  await act(async () => {
    await result.current.mutations.createMutation.mutateAsync(
      {
        name: created.name,
        accountIds: created.accountIds,
      },
      { onSuccess: (portfolio) => result.current.dashboard.setPortfolioId(portfolio.id) },
    );
  });
  expect(client.getQueryData([QueryKeys.PORTFOLIOS])).toEqual([created]);
  await waitFor(() => expect(result.current.inventory.data).toEqual([created]));
  expect(result.current.dashboard.scope).toEqual({ type: "portfolio", portfolioId: created.id });
  unmount();
  client.clear();
});
