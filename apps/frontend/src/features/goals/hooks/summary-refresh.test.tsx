import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@/test/render";
import { invalidateAfterGoalSummariesUpdated } from "@/lib/query-invalidation";
import { QueryKeys } from "@/lib/query-keys";
import { useGoals } from "./use-goals";

const mocks = vi.hoisted(() => ({ getGoals: vi.fn(), overview: vi.fn() }));
vi.mock("@/adapters", () => ({ getGoals: mocks.getGoals, getSaveUpOverview: mocks.overview }));
it("reads cached summaries on mount and updates after the post-write event", async () => {
  mocks.getGoals.mockResolvedValue([
    { id: "g", statusLifecycle: "active", statusHealth: "on_track" },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useGoals, { wrapper });
  await waitFor(() => expect(result.current.active).toHaveLength(1));
  expect(mocks.overview).not.toHaveBeenCalled();
  await act(async () => {
    await client.invalidateQueries({ queryKey: [QueryKeys.GOALS] });
  });
  expect(result.current.active).toHaveLength(1);
  mocks.getGoals.mockResolvedValue([
    { id: "g", statusLifecycle: "active", statusHealth: "at_risk" },
  ]);
  act(() => invalidateAfterGoalSummariesUpdated(client, { goalIds: ["g"], inputsChanged: false }));
  await waitFor(() => expect(result.current.atRisk).toHaveLength(1));
  expect(result.current.active).toHaveLength(0);
  client.clear();
});
