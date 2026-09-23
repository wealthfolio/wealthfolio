import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergeRestoreOperation,
  type RestoreOperation,
  useRestoreOperation,
} from "./use-restore-operation";

type RestoreHandler = (event: { payload: RestoreOperation }) => void;

const adapterMocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  getDeviceSyncRestore: vi.fn(),
  startDeviceSyncRestore: vi.fn(),
  approveDeviceSyncRestore: vi.fn(),
  retryDeviceSyncRestore: vi.fn(),
  cancelDeviceSyncRestore: vi.fn(),
  listenDeviceSyncRestore: vi.fn(),
  handlers: [] as RestoreHandler[],
}));

vi.mock("@/adapters", () => adapterMocks);

function op(overrides: Partial<RestoreOperation> = {}): RestoreOperation {
  return {
    operationId: "op-1",
    revision: 1,
    phase: "transferring",
    snapshot: null,
    error: null,
    replaced: false,
    ...overrides,
  };
}

/** Delivers a runtime event, as another tab or window would cause. */
function emit(operation: RestoreOperation) {
  act(() => adapterMocks.handlers.forEach((handler) => handler({ payload: operation })));
}

// React Query notifies observers on a timer, after the triggering call returns.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("mergeRestoreOperation", () => {
  it("keeps the newer revision of the same operation", () => {
    const newer = op({ revision: 5, phase: "awaiting_consent" });
    expect(mergeRestoreOperation(newer, op({ revision: 4 }))).toBe(newer);
    const next = op({ revision: 6, phase: "replacing" });
    expect(mergeRestoreOperation(newer, next)).toBe(next);
  });

  it("ignores late events from an older attempt", () => {
    const current = op({ operationId: "op-2", revision: 9, phase: "transferring" });
    const stale = op({ operationId: "op-1", revision: 8, phase: "cancelled" });
    expect(mergeRestoreOperation(current, stale)).toBe(current);
  });

  it("accepts a new attempt after a finished one, even with a reset revision", () => {
    const finished = op({ revision: 30, phase: "cancelled" });
    const restarted = op({ operationId: "op-2", revision: 1, phase: "transferring" });
    expect(mergeRestoreOperation(finished, restarted)).toBe(restarted);
  });
});

describe("useRestoreOperation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.handlers = [];
    adapterMocks.listenDeviceSyncRestore.mockImplementation((handler: RestoreHandler) => {
      adapterMocks.handlers.push(handler);
      return Promise.resolve(() => {
        adapterMocks.handlers = adapterMocks.handlers.filter((h) => h !== handler);
        return Promise.resolve();
      });
    });
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(op({ phase: "awaiting_consent" }));
  });

  it("reads state without starting work and follows events from other tabs", async () => {
    const { result } = renderHook(() => useRestoreOperation(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.operation?.phase).toBe("awaiting_consent"));
    await waitFor(() => expect(adapterMocks.handlers).toHaveLength(1));

    // Another tab approved; this tab follows without calling approve itself.
    emit(op({ revision: 3, phase: "replacing" }));
    await waitFor(() => expect(result.current.operation?.phase).toBe("replacing"));
    emit(op({ revision: 2, phase: "awaiting_consent" }));
    await settle();
    expect(result.current.operation?.phase).toBe("replacing");

    expect(adapterMocks.startDeviceSyncRestore).not.toHaveBeenCalled();
    expect(adapterMocks.approveDeviceSyncRestore).not.toHaveBeenCalled();
  });

  // Review finding: a slow poll wrote an older state over a newer event.
  it("never lets a poll roll back a newer event", async () => {
    const { result } = renderHook(() => useRestoreOperation(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.operation?.phase).toBe("awaiting_consent"));
    await waitFor(() => expect(adapterMocks.handlers).toHaveLength(1));

    emit(op({ revision: 3, phase: "replacing" }));
    await waitFor(() => expect(result.current.operation?.phase).toBe("replacing"));
    // The next poll (working operations poll every 2s) answers with an older revision.
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      op({ revision: 2, phase: "awaiting_consent" }),
    );
    const pollsBefore = adapterMocks.getDeviceSyncRestore.mock.calls.length;
    await waitFor(
      () =>
        expect(adapterMocks.getDeviceSyncRestore.mock.calls.length).toBeGreaterThan(pollsBefore),
      { timeout: 3_000 },
    );
    await settle();

    expect(result.current.operation?.phase).toBe("replacing");
  });

  // Review finding: after a server restart revisions start again, so a new
  // operation with a lower revision was ignored until the page reloaded.
  it("takes a different operation from a poll even with a lower revision", async () => {
    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      op({ operationId: "op-before-restart", revision: 9, phase: "transferring" }),
    );
    const { result } = renderHook(() => useRestoreOperation(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.operation?.operationId).toBe("op-before-restart"));

    adapterMocks.getDeviceSyncRestore.mockResolvedValue(
      op({ operationId: "op-after-restart", revision: 1, phase: "awaiting_consent" }),
    );
    await waitFor(() => expect(result.current.operation?.operationId).toBe("op-after-restart"), {
      timeout: 3_000,
    });
  });

  it("records command results as the authoritative state", async () => {
    adapterMocks.cancelDeviceSyncRestore.mockResolvedValue(op({ revision: 4, phase: "cancelled" }));
    const { result } = renderHook(() => useRestoreOperation(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.operation).not.toBeNull());

    await act(async () => {
      await result.current.cancel.mutateAsync("op-1");
    });

    expect(adapterMocks.cancelDeviceSyncRestore).toHaveBeenCalledWith("op-1");
    await waitFor(() => expect(result.current.operation?.phase).toBe("cancelled"));
  });

  it("stops listening when disabled", async () => {
    const { rerender } = renderHook(({ enabled }) => useRestoreOperation({ enabled }), {
      wrapper: wrapper(),
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(adapterMocks.handlers).toHaveLength(1));
    rerender({ enabled: false });
    await waitFor(() => expect(adapterMocks.handlers).toHaveLength(0));
  });
});
