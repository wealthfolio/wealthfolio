import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivitySearch } from "./use-activity-search";

const adapterMocks = vi.hoisted(() => ({
  searchActivities: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useActivitySearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.searchActivities.mockResolvedValue({
      data: [],
      meta: { totalRowCount: 0 },
    });
  });

  it("does not query activities when account scope resolves to no accounts in infinite mode", async () => {
    const { result } = renderHook(
      () =>
        useActivitySearch({
          filters: { accountIds: [], activityTypes: [] },
          searchQuery: "",
          sorting: [],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(adapterMocks.searchActivities).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    expect(result.current.totalRowCount).toBe(0);
  });

  it("does not query activities when account scope resolves to no accounts in paginated mode", async () => {
    const { result } = renderHook(
      () =>
        useActivitySearch({
          mode: "paginated",
          pageIndex: 0,
          filters: { accountIds: [], activityTypes: [] },
          searchQuery: "",
          sorting: [],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(adapterMocks.searchActivities).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    expect(result.current.totalRowCount).toBe(0);
  });

  it("keeps all-account scope distinct from closed-empty scope", async () => {
    renderHook(
      () =>
        useActivitySearch({
          filters: { accountIds: undefined, activityTypes: [] },
          searchQuery: "",
          sorting: [],
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(adapterMocks.searchActivities).toHaveBeenCalledTimes(1);
    });

    expect(adapterMocks.searchActivities).toHaveBeenCalledWith(
      0,
      50,
      expect.objectContaining({ accountIds: undefined }),
      "",
      { id: "date", desc: true },
    );
  });
});
