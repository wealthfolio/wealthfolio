import { shouldInvalidateAfterPortfolioUpdate } from "@/lib/query-invalidation";
import { QueryKeys } from "@/lib/query-keys";
import type { ContributionLimit } from "@/lib/types";
import { act, render, renderHook } from "@/test/render";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
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
      for (const key of [settingsKey, accountCardKey, detailsKey]) {
        client.setQueryData(key, {});
      }
      client.setQueryData(limitsKey, [limit]);
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

  function renderLimitCards() {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const kept: ContributionLimit = { ...limit, id: "kept", groupName: "Kept" };
    client.setQueryData([QueryKeys.CONTRIBUTION_LIMITS], [limit, kept]);
    for (const id of [limit.id, kept.id]) {
      client.setQueryData([QueryKeys.CONTRIBUTION_LIMIT_PROGRESS, id], {
        total: 0,
        baseCurrency: "USD",
        byAccount: {},
      });
    }
    // Each list refresh is held until the test resolves it.
    let resolveList: (limits: ContributionLimit[]) => void = () => undefined;
    const fetchLimits = vi.fn(
      () =>
        new Promise<ContributionLimit[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    adapters.calculateDepositsForLimit.mockImplementation(async (id: string) => {
      if (id === limit.id) throw new Error("Limit not found");
      return { total: 0, baseCurrency: "USD", byAccount: {} };
    });
    const view: { mutations?: ReturnType<typeof useContributionLimitMutations> } = {};
    function Card({ id }: { id: string }) {
      useContributionLimitProgress(id);
      return null;
    }
    function List() {
      view.mutations = useContributionLimitMutations();
      const { data } = useQuery({
        queryKey: [QueryKeys.CONTRIBUTION_LIMITS],
        queryFn: fetchLimits,
      });
      return (
        <>
          {data?.map((item) => (
            <Card key={item.id} id={item.id} />
          ))}
        </>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <List />
      </QueryClientProvider>,
    );
    // The server's portfolio-update-complete event; it settles only once the
    // held list refresh does, so it is not awaited here.
    const portfolioUpdateEnds = () =>
      act(async () => {
        void client.invalidateQueries({
          predicate: (query) => shouldInvalidateAfterPortfolioUpdate(query.queryKey),
        });
      });
    return {
      client,
      kept,
      view,
      portfolioUpdateEnds,
      resolveList: (l: ContributionLimit[]) => resolveList(l),
    };
  }

  it.each(["after the delete answers", "before the delete answers"] as const)(
    "does not refetch a deleted card's progress when the portfolio update ends %s",
    async (timing) => {
      const { kept, view, portfolioUpdateEnds, resolveList } = renderLimitCards();
      let answerDelete: () => void = () => undefined;
      adapters.deleteContributionLimit.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            answerDelete = resolve;
          }),
      );

      let deleted: Promise<void> | undefined;
      await act(async () => {
        deleted = view.mutations?.deleteContributionLimitMutation.mutateAsync(limit.id);
        // React Query notifies on the next tick; the server's event comes later.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (timing === "before the delete answers") await portfolioUpdateEnds();
      await act(async () => {
        answerDelete();
        await deleted;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (timing === "after the delete answers") await portfolioUpdateEnds();
      await act(async () => resolveList([kept]));

      expect(adapters.calculateDepositsForLimit).not.toHaveBeenCalledWith(limit.id);
      expect(vi.mocked(toast)).not.toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    },
  );

  it("shows the server's list again when a delete fails, without a limit deleted meanwhile", async () => {
    const { client, kept, view, resolveList } = renderLimitCards();
    let failA: () => void = () => undefined;
    adapters.deleteContributionLimit.mockImplementation((id: string) =>
      id === limit.id
        ? new Promise<void>((_, reject) => {
            failA = () => reject(new Error("offline"));
          })
        : Promise.resolve(),
    );

    // Delete A, and B while A is pending; B succeeds, then A fails.
    let deletingA: Promise<void> | undefined;
    await act(async () => {
      deletingA = view.mutations?.deleteContributionLimitMutation
        .mutateAsync(limit.id)
        .catch(() => undefined);
      await view.mutations?.deleteContributionLimitMutation.mutateAsync(kept.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      failA();
      await deletingA;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryData([QueryKeys.CONTRIBUTION_LIMITS])).toEqual([]);
    await act(async () => resolveList([limit]));

    expect(client.getQueryData([QueryKeys.CONTRIBUTION_LIMITS])).toEqual([limit]);
    expect(adapters.calculateDepositsForLimit).not.toHaveBeenCalledWith(kept.id);
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
