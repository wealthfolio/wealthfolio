import { QueryKeys } from "@/lib/query-keys";
import type { ContributionLimit } from "@/lib/types";
import { act, renderHook } from "@/test/render";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useContributionLimitMutations,
  useContributionLimitProgress,
} from "./use-contribution-limit-mutations";

const adapters = vi.hoisted(() => ({
  createContributionLimit: vi.fn(),
  updateContributionLimit: vi.fn(),
  deleteContributionLimit: vi.fn(),
  calculateDepositsForLimit: vi.fn(),
  logger: { error: vi.fn() },
}));
vi.mock("@/adapters", () => adapters);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

const limit: ContributionLimit = {
  id: "limit",
  groupName: "Retirement",
  contributionYear: 2026,
  limitAmount: 24_000,
  accountIds: "current,hidden",
};

describe("contribution limit cache invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapters.createContributionLimit.mockResolvedValue(limit);
    adapters.updateContributionLimit.mockResolvedValue(limit);
    adapters.deleteContributionLimit.mockResolvedValue(undefined);
  });

  it.each(["create", "update", "delete"] as const)(
    "%s invalidates both settings and account-card progress caches",
    async (action) => {
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
      });
      const settingsKey = [QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, limit.id];
      const accountCardKey = [
        QueryKeys.CONTRIBUTION_LIMIT_PROGRESS,
        "current",
        limit.contributionYear,
        limit.id,
      ];
      const limitsKey = [QueryKeys.CONTRIBUTION_LIMITS];
      const detailsKey = [QueryKeys.CONTRIBUTION_LIMIT_DETAILS, limit.id];
      for (const key of [settingsKey, accountCardKey, limitsKey, detailsKey]) {
        client.setQueryData(key, {});
      }
      client.setQueryData([QueryKeys.ACCOUNTS, false], []);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(useContributionLimitMutations, { wrapper });

      await act(async () => {
        if (action === "create")
          await result.current.addContributionLimitMutation.mutateAsync(limit);
        else if (action === "update")
          await result.current.updateContributionLimitMutation.mutateAsync({
            id: limit.id,
            updatedLimit: limit,
          });
        else await result.current.deleteContributionLimitMutation.mutateAsync(limit.id);
      });

      for (const key of [settingsKey, accountCardKey, limitsKey, detailsKey]) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      }
      expect(client.getQueryState([QueryKeys.ACCOUNTS, false])?.isInvalidated).toBe(false);
    },
  );

  it("does not refetch a deleted limit while its progress query is still mounted", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData([QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, limit.id], {
      total: 0,
      baseCurrency: "USD",
      byAccount: {},
    });
    client.setQueryData([QueryKeys.CONTRIBUTION_LIMIT_DETAILS, limit.id], {});
    const fetchDetails = vi.fn().mockRejectedValue(new Error("Limit not found"));
    // The list refresh can take longer than progress refetching. Until it ends,
    // the deleted limit's card still observes this query, whose API now errors.
    adapters.calculateDepositsForLimit.mockRejectedValue(new Error("Limit not found"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        useContributionLimitProgress(limit.id);
        useQuery({
          queryKey: [QueryKeys.CONTRIBUTION_LIMIT_DETAILS, limit.id],
          queryFn: fetchDetails,
        });
        return useContributionLimitMutations();
      },
      { wrapper },
    );

    await act(async () => {
      await result.current.deleteContributionLimitMutation.mutateAsync(limit.id);
    });

    expect(adapters.calculateDepositsForLimit).not.toHaveBeenCalled();
    expect(fetchDetails).not.toHaveBeenCalled();
  });
});
