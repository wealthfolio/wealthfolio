import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePostLoginConnectSync } from "./use-post-login-connect-sync";

const adapterMocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const connectMocks = vi.hoisted(() => ({
  useWealthfolioConnect: vi.fn(),
}));

const authServiceMocks = vi.hoisted(() => ({
  postLoginBootstrap: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  toast: {
    loading: vi.fn(),
  },
}));

vi.mock("react-i18next", () => {
  const t = (key: string) =>
    key === "connect:sync.syncingBrokerData" ? "Syncing broker data..." : key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("@/adapters", () => adapterMocks);
vi.mock("../providers/wealthfolio-connect-provider", () => connectMocks);
vi.mock("../services/auth-service", () => authServiceMocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => toastMocks);

const brokerStartedResult = {
  brokerSync: { status: "started" },
  deviceSync: { status: "skipped", reason: "not_enrolled" },
};

const skippedResult = {
  brokerSync: { status: "skipped", reason: "no_connections" },
  deviceSync: { status: "skipped", reason: "not_enrolled" },
};

function mockConnectContext(overrides: Record<string, unknown> = {}) {
  connectMocks.useWealthfolioConnect.mockReturnValue({
    isConnected: true,
    isInitializing: false,
    postLoginSyncRequest: {
      id: "request-1",
      userId: "user-1",
      createdAt: Date.now(),
      source: "auth-callback",
    },
    session: {
      user: {
        id: "user-1",
      },
    },
    user: {
      id: "user-1",
    },
    consumePostLoginSyncRequest: vi.fn(),
    ...overrides,
  });
}

describe("usePostLoginConnectSync", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    authServiceMocks.postLoginBootstrap.mockResolvedValue(brokerStartedResult);
    mockConnectContext();
  });

  it("does not call bootstrap while disabled or not ready", () => {
    const { rerender } = renderHook(({ enabled }) => usePostLoginConnectSync({ enabled }), {
      initialProps: { enabled: false },
    });

    expect(authServiceMocks.postLoginBootstrap).not.toHaveBeenCalled();

    mockConnectContext({ isInitializing: true });
    rerender({ enabled: true });

    expect(authServiceMocks.postLoginBootstrap).not.toHaveBeenCalled();

    mockConnectContext({ isInitializing: false, isConnected: false });
    rerender({ enabled: true });

    expect(authServiceMocks.postLoginBootstrap).not.toHaveBeenCalled();
  });

  it("consumes a matching login request and calls bootstrap once", async () => {
    const consumePostLoginSyncRequest = vi.fn();
    mockConnectContext({ consumePostLoginSyncRequest });

    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    await waitFor(() => {
      expect(consumePostLoginSyncRequest).toHaveBeenCalledWith("request-1");
    });
    expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
  });

  it("does not start the same request twice across rerenders", async () => {
    const { rerender } = renderHook(() => usePostLoginConnectSync({ enabled: true }));

    await waitFor(() => {
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
    });
    rerender();

    expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
  });

  it("consumes stale requests from a different user without bootstrapping", () => {
    const consumePostLoginSyncRequest = vi.fn();
    mockConnectContext({
      consumePostLoginSyncRequest,
      user: { id: "user-2" },
      session: { user: { id: "user-2" } },
    });

    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    expect(consumePostLoginSyncRequest).toHaveBeenCalledWith("request-1");
    expect(authServiceMocks.postLoginBootstrap).not.toHaveBeenCalled();
    expect(adapterMocks.logger.debug).toHaveBeenCalledWith(
      "Discarded stale post-login sync request",
    );
  });

  it("shows a broker sync toast only when broker bootstrap starts", async () => {
    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    await waitFor(() => {
      expect(toastMocks.toast.loading).toHaveBeenCalledWith("Syncing broker data...", {
        id: "broker-sync-start",
      });
    });
  });

  it("does not show a broker sync toast for skipped broker and device bootstrap", async () => {
    authServiceMocks.postLoginBootstrap.mockResolvedValue(skippedResult);

    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    await waitFor(() => {
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
    });
    expect(toastMocks.toast.loading).not.toHaveBeenCalled();
    expect(adapterMocks.logger.warn).not.toHaveBeenCalled();
  });

  it("logs unexpected skipped errors without showing a broker sync toast", async () => {
    authServiceMocks.postLoginBootstrap.mockResolvedValue({
      brokerSync: { status: "skipped", reason: "error" },
      deviceSync: { status: "skipped", reason: "error" },
    });

    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    await waitFor(() => {
      expect(adapterMocks.logger.warn).toHaveBeenCalledWith(
        "Post-login broker sync bootstrap skipped due to an unexpected error",
      );
    });
    expect(adapterMocks.logger.warn).toHaveBeenCalledWith(
      "Post-login device sync bootstrap skipped due to an unexpected error",
    );
    expect(toastMocks.toast.loading).not.toHaveBeenCalled();
  });

  it("logs bootstrap rejection and keeps the request pending", async () => {
    const consumePostLoginSyncRequest = vi.fn();
    authServiceMocks.postLoginBootstrap.mockRejectedValue(new Error("network down"));
    mockConnectContext({ consumePostLoginSyncRequest });

    renderHook(() => usePostLoginConnectSync({ enabled: true }));

    expect(consumePostLoginSyncRequest).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(adapterMocks.logger.warn).toHaveBeenCalledWith(
        "Post-login sync bootstrap failed: network down",
      );
    });
  });
  it.each(["rejection", "broker-error", "device-error"])(
    "retries %s and consumes the unchanged request only after recovery",
    async (failure) => {
      vi.useFakeTimers();
      const consume = vi.fn();
      mockConnectContext({ consumePostLoginSyncRequest: consume });
      if (failure === "rejection") {
        authServiceMocks.postLoginBootstrap.mockRejectedValueOnce(new Error("offline"));
      } else {
        authServiceMocks.postLoginBootstrap.mockResolvedValueOnce({
          ...skippedResult,
          [failure === "broker-error" ? "brokerSync" : "deviceSync"]: {
            status: "skipped",
            reason: "error",
          },
        });
      }
      renderHook(() => usePostLoginConnectSync({ enabled: true }));
      await act(() => vi.advanceTimersByTimeAsync(59_999));
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
      expect(consume).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(2);
      expect(consume).toHaveBeenCalledWith("request-1");
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["logout", "account-change", "inactive-subscription", "unmount"])(
    "cancels scheduled retries on %s",
    async (change) => {
      vi.useFakeTimers();
      authServiceMocks.postLoginBootstrap.mockRejectedValue(new Error("offline"));
      const { rerender, unmount } = renderHook(() => usePostLoginConnectSync({ enabled: true }));
      await act(() => vi.advanceTimersByTimeAsync(0));
      if (change === "unmount") {
        unmount();
      } else {
        mockConnectContext(
          change === "logout"
            ? { isConnected: false }
            : change === "account-change"
              ? { user: { id: "user-2" }, session: { user: { id: "user-2" } } }
              : { userInfo: { team: { subscription_status: null } } },
        );
        rerender();
      }
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores an in-flight failure after logout", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    authServiceMocks.postLoginBootstrap.mockReturnValueOnce(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const consume = vi.fn();
    mockConnectContext({ consumePostLoginSyncRequest: consume });
    const { rerender } = renderHook(() => usePostLoginConnectSync({ enabled: true }));
    mockConnectContext({ isConnected: false });
    rerender();
    await act(async () => {
      reject(new Error("late failure"));
    });
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it("reuses an in-flight request across effect restarts", async () => {
    let resolve!: (result: typeof skippedResult) => void;
    authServiceMocks.postLoginBootstrap.mockReturnValueOnce(
      new Promise((resolvePromise) => {
        resolve = resolvePromise;
      }),
    );
    const { rerender } = renderHook(() => usePostLoginConnectSync({ enabled: true }));
    const consume = vi.fn();
    mockConnectContext({ consumePostLoginSyncRequest: consume });
    rerender();
    expect(authServiceMocks.postLoginBootstrap).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(skippedResult);
    });
    expect(consume).toHaveBeenCalledWith("request-1");
  });
});
