import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { usePortfolios } from "@/hooks/use-portfolios";
import type { PortfolioWithAccounts } from "@/lib/types";
import { useDashboardPortfolio } from "./use-dashboard-portfolio";

const session = vi.hoisted(() => ({ profileId: "profile-a" }));
vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => session.profileId,
  usesLegacyPreferences: () => false,
}));
vi.mock("@/hooks/use-portfolios", () => ({ usePortfolios: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

const portfolio: PortfolioWithAccounts = {
  id: "retirement",
  name: "Retirement",
  accountIds: ["brokerage"],
  sortOrder: 0,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const key = "profile:profile-a:dashboard-portfolio-id";
const mockUsePortfolios = vi.mocked(usePortfolios);
function inventory(overrides: Record<string, unknown> = {}) {
  mockUsePortfolios.mockReturnValue({
    data: [portfolio],
    isPending: false,
    isSuccess: true,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof usePortfolios>);
}

describe("useDashboardPortfolio", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    session.profileId = "profile-a";
    inventory();
  });
  it("defaults to all accounts without creating a portfolio", () => {
    const { result } = renderHook(useDashboardPortfolio);
    expect(result.current.scope).toEqual({ type: "all" });
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("remembers the selection across remounts and isolates profiles", () => {
    const hook = renderHook(useDashboardPortfolio);
    act(() => hook.result.current.setPortfolioId(portfolio.id));
    expect(hook.result.current.scope).toEqual({ type: "portfolio", portfolioId: portfolio.id });
    hook.unmount();
    const reopened = renderHook(useDashboardPortfolio);
    expect(reopened.result.current.portfolio?.name).toBe("Retirement");
    reopened.unmount();
    session.profileId = "profile-b";
    expect(renderHook(useDashboardPortfolio).result.current.scope).toEqual({ type: "all" });
  });
  it("preserves the preference while loading or when the inventory fails", () => {
    localStorage.setItem(key, JSON.stringify(portfolio.id));
    inventory({ data: undefined, isPending: true, isSuccess: false });
    const hook = renderHook(useDashboardPortfolio);
    expect(hook.result.current.isLoading).toBe(true);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(portfolio.id));
    const error = new Error("Offline");
    inventory({ data: undefined, isPending: false, isSuccess: false, error });
    hook.rerender();
    expect(hook.result.current.error).toBe(error);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(portfolio.id));
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("returns to all accounts only after confirming the selected portfolio is missing", () => {
    localStorage.setItem(key, JSON.stringify(portfolio.id));
    inventory({ data: [] });
    const { result } = renderHook(useDashboardPortfolio);
    expect(result.current.scope).toEqual({ type: "all" });
    expect(localStorage.getItem(key)).toBe("null");
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("Showing all accounts"));
  });
  it("keeps an existing portfolio with no accounts selected", () => {
    localStorage.setItem(key, JSON.stringify(portfolio.id));
    inventory({ data: [{ ...portfolio, accountIds: [] }] });
    const { result } = renderHook(useDashboardPortfolio);
    expect(result.current.scope).toEqual({ type: "portfolio", portfolioId: portfolio.id });
    expect(result.current.portfolio?.accountIds).toEqual([]);
    expect(toast.info).not.toHaveBeenCalled();
  });
});
