import { act, renderHook, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  useIsSavingProviderSettings,
  useUpdateMarketDataProviderSettings,
} from "./use-market-data-settings";

const adapter = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@/adapters", () => ({
  deleteSecret: vi.fn(),
  getMarketDataProviderSettings: vi.fn().mockResolvedValue([]),
  setSecret: vi.fn(),
  updateMarketDataProviderSettings: adapter.update,
}));

describe("useIsSavingProviderSettings", () => {
  it("stays true until every overlapping save finishes", async () => {
    const finish: (() => void)[] = [];
    adapter.update.mockImplementation(() => new Promise<void>((resolve) => finish.push(resolve)));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        save: useUpdateMarketDataProviderSettings(),
        saving: useIsSavingProviderSettings(),
      }),
      { wrapper },
    );

    act(() => {
      result.current.save.mutate({ providerId: "YAHOO", priority: 1, enabled: true });
      result.current.save.mutate({ providerId: "AMFI", priority: 15, enabled: true });
    });
    await waitFor(() => expect(finish).toHaveLength(2));
    expect(result.current.saving).toBe(true);

    // The later save finishes first. The mutation's own isPending, which follows only
    // the latest call, turns false while the earlier save is still running.
    act(() => finish[1]());
    await waitFor(() => expect(result.current.save.isPending).toBe(false));
    expect(result.current.saving).toBe(true);

    act(() => finish[0]());
    await waitFor(() => expect(result.current.saving).toBe(false));
  });
});
