import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { BackendError } from "@/lib/backend-error";
import { invoke as webInvoke } from "../../../adapters/web/core";
import { installProfileSession } from "@/features/profiles/session";
import { usePostLoginConnectSync } from "../hooks/use-post-login-connect-sync";
import { WealthfolioConnectProvider, useWealthfolioConnect } from "./wealthfolio-connect-provider";

const mocks = vi.hoisted(() => ({
  platform: "web",
  capability: vi.fn(),
  configured: false,
  account: "",
  onAuth: (_event: string) => {},
  onDeepLink: (_event: { payload: string }) => {},
  bootstrap: vi.fn(),
  toast: vi.fn(),
  restore: vi.fn(),
  setSession: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  signIn: vi.fn(),
  exchange: vi.fn(),
  getUserInfo: vi.fn(),
  getStatus: vi.fn(),
  store: vi.fn(),
  clear: vi.fn(),
  t: (key: string) => key,
}));

vi.mock("@/features/profiles/api", () => ({
  profileCommand: vi.fn(async (_command, payload) => payload?.operation === "validate"),
}));
vi.mock(import("@/lib/connect-config"), async (importOriginal) => ({
  ...(await importOriginal()),
  CONNECT_ENABLED: true,
}));
vi.mock("@/context/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@/hooks/use-platform", () => ({
  getPlatform: () => mocks.capability(),
}));
vi.mock("tauri-plugin-web-auth-api", () => ({ authenticate: vi.fn() }));
vi.mock("@/adapters", () => ({
  isTauri: true,
  getCurrentDeepLinks: async () => [],
  listenDeepLink: async (callback: typeof mocks.onDeepLink) => {
    mocks.onDeepLink = callback;
    return async () => {};
  },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  openUrlInBrowser: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      setSession: mocks.setSession,
      verifyOtp: mocks.verifyOtp,
      signOut: mocks.signOut,
      signInWithPassword: mocks.signIn,
      exchangeCodeForSession: mocks.exchange,
      onAuthStateChange: (callback: typeof mocks.onAuth) => {
        mocks.onAuth = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock("../services/auth-service", () => ({
  restoreSyncSession: mocks.restore,
  postLoginBootstrap: mocks.bootstrap,
  getSyncSessionStatus: mocks.getStatus,
  clearSyncSession: mocks.clear,
  storeSyncSession: mocks.store,
}));
vi.mock("../services/broker-service", () => ({ getUserInfo: mocks.getUserInfo }));

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: { loading: mocks.toast } }));

const session = (account: string) => ({
  user: { id: account },
  refresh_token: account,
  access_token: `${account}-access`,
});
const info = (account: string, status: string | null = "active") => ({
  id: account,
  team: { subscription_status: status },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <WealthfolioConnectProvider>{children}</WealthfolioConnectProvider>
  </QueryClientProvider>
);
async function setup() {
  const hook = renderHook(useWealthfolioConnect, { wrapper });
  await waitFor(() => expect(hook.result.current.isInitializing).toBe(false));
  return hook;
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.restore.mockRejectedValue(new Error("No stored session"));
  mocks.setSession.mockResolvedValue({ data: { session: session("A") }, error: null });
  mocks.verifyOtp.mockResolvedValue({ data: { session: session("A") }, error: null });
  mocks.configured = false;
  mocks.account = "";
  mocks.platform = "web";
  mocks.capability.mockImplementation(async () => ({
    os: mocks.platform,
    is_mobile: mocks.platform !== "web",
    capabilities: { cloud_sync: true },
  }));
  mocks.getStatus.mockImplementation(async () => ({ isConfigured: mocks.configured }));
  mocks.store.mockImplementation(async (account: string) => {
    mocks.account = account;
    mocks.configured = true;
  });
  mocks.clear.mockImplementation(async () => {
    mocks.configured = false;
  });
  mocks.signIn.mockImplementation(async ({ email }: { email: string }) => ({
    data: { session: session(email) },
    error: null,
  }));
  mocks.exchange.mockResolvedValue({ data: { session: session("B") }, error: null });
  mocks.signOut.mockImplementation(async () => {
    mocks.onAuth("SIGNED_OUT");
    return { error: null };
  });
  mocks.getUserInfo.mockImplementation(async () => info(mocks.account));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Cloud session lifecycle", () => {
  it.each([
    [
      "Profile operations are running. Wait for them to finish and try again.",
      "profiles.errors.busy",
    ],
    [
      "CONNECT_PROFILE_EXISTS: This Connect account belongs to profile 96b0ce9d-dbbb-484c-abe7-ca2f57e5ccf7.",
      "profiles.errors.duplicateAccount",
    ],
  ])(
    "shows friendly copy for native session-storage errors after OAuth: %s",
    async (message, expected) => {
      mocks.platform = "ios";
      mocks.store.mockRejectedValueOnce(message);
      const { result } = await setup();

      act(() => {
        mocks.onDeepLink({
          payload: "wealthfolio://auth/callback?code=restore-login#wf_profile_flow=test-flow",
        });
      });

      await waitFor(() => expect(result.current.error).toBe(expected));
      expect(mocks.exchange).toHaveBeenCalledTimes(1);
      expect(mocks.store).toHaveBeenCalledWith("B");
      expect(result.current.isConnected).toBe(false);
      expect(result.current.postLoginSyncRequest).toBeNull();
    },
  );

  it.each(["legacy desktop", "web envelope"])(
    "requires explicit confirmation before replacing a Connect account (%s)",
    async (runtime) => {
      if (runtime === "web envelope") {
        installProfileSession({ profileId: "test", scopeId: "scope-test" });
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                code: 403,
                errorCode: "CONNECT_REBIND_REQUIRED",
                message: "FAKE-KEY-2531 /private/portfolio.db",
              }),
              { status: 403, headers: { "Content-Type": "application/json" } },
            ),
          ),
        );
        mocks.store.mockImplementationOnce((refreshToken: string) =>
          webInvoke("store_sync_session", { refreshToken }),
        );
      } else {
        mocks.store.mockRejectedValueOnce(
          "CONNECT_REBIND_REQUIRED: Confirm changing this profile's Connect account or team.",
        );
      }
      const { result } = await setup();
      let login!: Promise<void>;
      await act(async () => {
        login = result.current.signInWithEmail("B", "password");
      });
      await screen.findByRole("dialog");
      expect(document.body.textContent).not.toContain("FAKE-KEY");
      expect(mocks.store).toHaveBeenCalledTimes(1);
      expect(result.current.isConnected).toBe(false);
      expect(result.current.postLoginSyncRequest).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "connect:rebind.confirm" }));
        await login;
      });
      expect(mocks.store).toHaveBeenLastCalledWith("B", true);
      expect(result.current.user?.id).toBe("B");
    },
  );

  it("canceling an account change preserves the current connection", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    mocks.store.mockRejectedValueOnce(new Error("CONNECT_REBIND_REQUIRED"));
    let login!: Promise<void>;
    await act(async () => {
      login = result.current.signInWithEmail("B", "password");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "connect:rebind.cancel" }));
      await login;
    });
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(result.current.user?.id).toBe("A");
    expect(result.current.error).toBeNull();
  });

  it("locking or leaving a profile cancels pending confirmation", async () => {
    mocks.store.mockRejectedValueOnce(new Error("CONNECT_REBIND_REQUIRED"));
    const { result, unmount } = await setup();
    let login!: Promise<void>;
    await act(async () => {
      login = result.current.signInWithEmail("B", "password");
    });
    await screen.findByRole("dialog");
    unmount();
    await login;
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("does not offer to override another profile's account reservation", async () => {
    mocks.store.mockRejectedValueOnce(new Error("CONNECT_PROFILE_EXISTS"));
    const { result } = await setup();
    await act(async () => {
      await expect(result.current.signInWithEmail("B", "password")).rejects.toThrow(
        "CONNECT_PROFILE_EXISTS",
      );
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(result.current.error).toBe("profiles.errors.duplicateAccount");
    expect(result.current.isConnected).toBe(false);
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("invalidates restored settings only after the backend accepts reconnection", async () => {
    const stored = deferred<void>();
    mocks.store.mockReturnValueOnce(stored.promise);
    queryClient.setQueryData([QueryKeys.SETTINGS], { restoreReconnectRequired: true });
    const { result } = await setup();
    let login!: Promise<void>;
    await act(async () => {
      login = result.current.signInWithEmail("A", "password");
    });
    expect(queryClient.getQueryState([QueryKeys.SETTINGS])?.isInvalidated).toBe(false);
    await act(async () => {
      stored.resolve();
      await login;
    });
    expect(queryClient.getQueryState([QueryKeys.SETTINGS])?.isInvalidated).toBe(true);
  });
  it.each(["web", "ios", "android"])(
    "ignores a canceled response from a replaced session on %s",
    async (platform) => {
      mocks.platform = platform;
      const old = deferred<ReturnType<typeof info>>();
      mocks.getUserInfo.mockImplementationOnce(() => old.promise);
      const { result } = await setup();
      await act(() => result.current.signInWithEmail("A", "password"));
      await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(1));
      await act(() => result.current.signOut());
      await act(() => result.current.signInWithEmail("B", "password"));
      await waitFor(() => expect(result.current.userInfo?.id).toBe("B"));
      await act(async () => {
        old.resolve(info("A", "canceled"));
      });
      expect(result.current.user?.id).toBe("B");
      expect(result.current.userInfo?.id).toBe("B");
      expect(mocks.signOut).toHaveBeenCalledTimes(1);
      expect(mocks.clear).toHaveBeenCalledTimes(1);
      expect(mocks.configured).toBe(true);
    },
  );

  it.each(["Old account request failed", "API error 429: Too many requests"])(
    "ignores errors from an obsolete request: %s",
    async (message) => {
      const old = deferred<ReturnType<typeof info>>();
      mocks.getUserInfo.mockImplementationOnce(() => old.promise);
      const { result } = await setup();
      await act(() => result.current.signInWithEmail("A", "password"));
      await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(1));
      await act(() => result.current.signInWithEmail("B", "password"));
      await waitFor(() => expect(result.current.userInfo?.id).toBe("B"));
      await act(async () => {
        old.reject(new Error(message));
      });
      expect(result.current.error).toBeNull();
      expect(result.current.userInfo?.id).toBe("B");
      expect(result.current.isLoadingUserInfo).toBe(false);
      const calls = mocks.getUserInfo.mock.calls.length;
      await act(() => result.current.refetchUserInfo());
      expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    },
  );

  it.each([null, "canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "unknown"])(
    "keeps authentication and exposes inactive status %s for pricing",
    async (status) => {
      mocks.getUserInfo.mockResolvedValue(info("A", status));
      const { result } = await setup();
      await act(() => result.current.signInWithEmail("A", "password"));
      await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
      expect(result.current.isConnected).toBe(true);
      expect(result.current.userInfo?.team?.subscription_status).toBe(status);
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
      expect(mocks.configured).toBe(true);
    },
  );

  it("resumes sync after purchasing a subscription without another login", async () => {
    mocks.getUserInfo.mockResolvedValue(info("A", null));
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    const oldRequest = result.current.postLoginSyncRequest!.id;
    act(() => result.current.consumePostLoginSyncRequest(oldRequest));
    mocks.getUserInfo.mockResolvedValue(info("A", "active"));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() =>
      expect(result.current.postLoginSyncRequest?.source).toBe("subscription-activated"),
    );
    expect(result.current.isConnected).toBe(true);
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("keeps login on lookup failures and recovers on refresh", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error("Service unavailable"));
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.error).toBe("Service unavailable"));
    expect(result.current.userInfo).toBeNull();
    expect(result.current.isConnected).toBe(true);
    mocks.getUserInfo.mockResolvedValue(info("A", "active"));
    await act(() => result.current.refetchUserInfo());
    expect(result.current.postLoginSyncRequest?.source).toBe("email-sign-in");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([
    new Error("API error 429: Too many requests. Please try again in 60 seconds."),
    "API error 429: Too many requests. Please try again in 60 seconds.",
  ])("preserves the profile and backs off after a rate limit: %s", async (failure) => {
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));

    const profile = result.current.userInfo;
    mocks.getUserInfo.mockRejectedValueOnce(failure);
    await act(() => result.current.refetchUserInfo());
    expect(result.current.userInfo).toBe(profile);
    expect(result.current.error).toContain("API error 429");
    expect(result.current.isConnected).toBe(true);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();

    const calls = mocks.getUserInfo.mock.calls.length;
    clock.mockReturnValue(now + 59_999);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await result.current.refetchUserInfo();
    });
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
    expect(result.current.error).toContain("API error 429");

    clock.mockReturnValue(now + 60_000);
    mocks.getUserInfo.mockResolvedValue(info("A", "canceled"));
    await act(() => result.current.refetchUserInfo());
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.userInfo?.team?.subscription_status).toBe("canceled");
    expect(result.current.error).toBeNull();
    expect(result.current.isConnected).toBe(true);
  });

  it("backs off after the web server reports a Connect rate limit", async () => {
    const now = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(now);
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    const profile = result.current.userInfo;

    installProfileSession({ profileId: "test", scopeId: "scope-test" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: 429, errorCode: "RATE_LIMITED", message: "FAKE-KEY-2531" }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );
    mocks.getUserInfo.mockImplementationOnce(() => webInvoke("get_user_info"));
    await act(() => result.current.refetchUserInfo());
    expect(result.current.userInfo).toBe(profile);
    expect(result.current.error).not.toContain("FAKE-KEY");

    const calls = mocks.getUserInfo.mock.calls.length;
    clock.mockReturnValue(now + 59_999);
    await act(() => result.current.refetchUserInfo());
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
    vi.unstubAllGlobals();
  });

  it("keeps the profile when a local session check fails during cooldown", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    const profile = result.current.userInfo;
    mocks.getUserInfo.mockRejectedValueOnce(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;
    mocks.getStatus.mockRejectedValueOnce(new Error("Local session unavailable"));
    await act(() => result.current.refetchUserInfo());
    expect(result.current.userInfo).toBe(profile);
    expect(result.current.error).toBe("Local session unavailable");
    expect(result.current.isUserInfoRateLimited).toBe(true);
    await act(() => result.current.refetchUserInfo());
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
    expect(result.current.userInfo).toBe(profile);
    expect(result.current.error).toContain("API error 429");
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([null, "active"])(
    "retries automatically at cooldown expiry with profile %s",
    async (status) => {
      const { result } = await setup();
      // Capture the regular poll to reproduce a response arriving after its minute boundary.
      const intervals = vi.spyOn(window, "setInterval");
      if (status !== null) {
        await act(() => result.current.signInWithEmail("A", "password"));
        await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      if (status === null) {
        mocks.getUserInfo.mockRejectedValueOnce(new Error("API error 429: Too many requests"));
        await act(() => result.current.signInWithEmail("A", "password"));
        expect(result.current.error).toContain("API error 429");
      } else {
        const tick = intervals.mock.calls.find((call) => call[1] === 60_000)?.[0];
        expect(typeof tick).toBe("function");
        const response = deferred<ReturnType<typeof info>>();
        mocks.getUserInfo.mockImplementationOnce(() => response.promise);
        await act(async () => {
          await Promise.resolve((tick as () => void)());
        });
        await act(() => vi.advanceTimersByTimeAsync(10));
        await act(async () => {
          await Promise.resolve(response.reject(new Error("API error 429: Too many requests")));
        });
        await act(() => vi.advanceTimersByTimeAsync(59_990));
        await act(async () => {
          await Promise.resolve((tick as () => void)());
        });
      }
      const calls = mocks.getUserInfo.mock.calls.length;
      expect(result.current.isUserInfoRateLimited).toBe(true);
      mocks.getUserInfo.mockResolvedValue(info("A", "active"));
      await act(() => vi.advanceTimersByTimeAsync(status === null ? 59_999 : 9));
      expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
      expect(result.current.userInfo?.id).toBe("A");
      expect(result.current.isUserInfoRateLimited).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );

  it("retries after the cooldown despite a backward wall-clock jump", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    mocks.getUserInfo.mockRejectedValueOnce(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;
    clock.mockReturnValue(Date.now() - 3_600_000);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.isUserInfoRateLimited).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("ends cooldown if local reconciliation fails at expiry", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    mocks.getUserInfo.mockRejectedValueOnce(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    mocks.getStatus.mockRejectedValueOnce(new Error("Local session unavailable"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current.isUserInfoRateLimited).toBe(false);
    expect(result.current.error).toBe("Local session unavailable");
    await act(() => result.current.refetchUserInfo());
    expect(result.current.userInfo?.id).toBe("A");
    expect(result.current.error).toBeNull();
  });

  it("reschedules another 429 and cancels cooldown retries on sign-out or unmount", async () => {
    const { result, unmount } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    mocks.getUserInfo.mockRejectedValue(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.isUserInfoRateLimited).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 2);
    await act(() => result.current.signOut());
    expect(result.current.isUserInfoRateLimited).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 2);
    mocks.getUserInfo.mockResolvedValue(info("A"));
    await act(() => result.current.signInWithEmail("A", "password"));
    mocks.getUserInfo.mockRejectedValue(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const beforeUnmount = mocks.getUserInfo.mock.calls.length;
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(beforeUnmount);
  });

  it("does not preserve another account's profile or cooldown after an account change", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));

    mocks.getUserInfo.mockRejectedValue(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;
    await act(() => result.current.signInWithEmail("B", "password"));
    await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1));
    expect(result.current.user?.id).toBe("B");
    expect(result.current.userInfo).toBeNull();
    expect(result.current.isConnected).toBe(true);
  });

  it("keeps the cooldown when the same account establishes a new session", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    mocks.getUserInfo.mockRejectedValueOnce(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;

    await act(() => result.current.signInWithEmail("A", "password"));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
    expect(result.current.userInfo?.id).toBe("A");
    expect(result.current.isConnected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.isUserInfoRateLimited).toBe(false);
  });

  it("does not mistake a local session-check failure for a cloud profile rate limit", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    const calls = mocks.getUserInfo.mock.calls.length;
    mocks.getStatus.mockRejectedValueOnce(new Error("API error 429: Local session lookup failed"));
    await act(() => result.current.refetchUserInfo());
    expect(result.current.userInfo).toBeNull();
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);

    await act(() => result.current.refetchUserInfo());
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.userInfo?.id).toBe("A");
  });

  it("still reconciles a missing backend session during the rate-limit cooldown", async () => {
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    mocks.getUserInfo.mockRejectedValue(new Error("API error 429: Too many requests"));
    await act(() => result.current.refetchUserInfo());
    const calls = mocks.getUserInfo.mock.calls.length;

    mocks.configured = false;
    await act(() => result.current.refetchUserInfo());
    expect(result.current.isConnected).toBe(false);
    expect(result.current.userInfo).toBeNull();
    expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls);
  });

  it.each(["API error 401: Unauthorized", "API error 502: Upstream returned API error 429"])(
    "does not retain profile data or back off after another API failure: %s",
    async (message) => {
      const { result } = await setup();
      await act(() => result.current.signInWithEmail("A", "password"));
      await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
      const calls = mocks.getUserInfo.mock.calls.length;
      mocks.getUserInfo.mockRejectedValueOnce(new Error(message));
      await act(() => result.current.refetchUserInfo());
      expect(result.current.userInfo).toBeNull();
      expect(result.current.error).toBe(message);
      await act(() => result.current.refetchUserInfo());
      expect(mocks.getUserInfo).toHaveBeenCalledTimes(calls + 2);
      expect(result.current.userInfo?.id).toBe("A");
    },
  );

  it("signs out only when the backend auth session is missing on mobile resume", async () => {
    mocks.platform = "ios";
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    mocks.configured = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current.isConnected).toBe(false));
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("queues a mobile OAuth callback behind ongoing sign-out cleanup", async () => {
    mocks.platform = "ios";
    const cleanup = deferred<void>();
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
    mocks.clear.mockImplementationOnce(() => cleanup.promise);
    let logout!: Promise<void>;
    act(() => {
      logout = result.current.signOut();
    });
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
    await act(async () =>
      mocks.onDeepLink({
        payload: "wealthfolio://auth/callback?code=mobile-code#wf_profile_flow=test-flow",
      }),
    );
    expect(mocks.exchange).not.toHaveBeenCalled();
    await act(async () => {
      cleanup.resolve();
      await logout;
    });
    await waitFor(() => expect(result.current.user?.id).toBe("B"));
    expect(mocks.account).toBe("B");
    expect(mocks.configured).toBe(true);
  });
});

describe("Login and subscription bootstrap coordination", () => {
  const started = {
    brokerSync: { status: "started" },
    deviceSync: { status: "started" },
  };

  it.each(["email", "otp", "oauth"])(
    "preserves the in-flight %s bootstrap and its started toast",
    async (method) => {
      const userInfo = deferred<ReturnType<typeof info>>();
      const bootstrap = deferred<typeof started>();
      mocks.getUserInfo.mockReturnValue(userInfo.promise);
      mocks.bootstrap.mockReturnValue(bootstrap.promise);
      const { result } = renderHook(
        () => {
          usePostLoginConnectSync({ enabled: true });
          return useWealthfolioConnect();
        },
        { wrapper },
      );
      await waitFor(() => expect(result.current.isInitializing).toBe(false));
      await act(async () => {
        if (method === "email") await result.current.signInWithEmail("A", "password");
        else if (method === "otp") await result.current.verifyOtp("A", "123456");
        else
          mocks.onDeepLink({
            payload: "wealthfolio://auth/callback?code=activation-test#wf_profile_flow=test-flow",
          });
      });
      await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(1));
      const loginRequest = result.current.postLoginSyncRequest;
      await act(async () => userInfo.resolve(info(mocks.account, "active")));
      expect(result.current.postLoginSyncRequest).toBe(loginRequest);
      expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
      await act(async () => bootstrap.resolve(started));
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(result.current.postLoginSyncRequest).toBeNull();
    },
  );

  it("bootstraps a restored active session without an explicit login request", async () => {
    mocks.configured = true;
    mocks.account = "A";
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.bootstrap.mockResolvedValue(started);
    const { result } = renderHook(
      () => {
        usePostLoginConnectSync({ enabled: true });
        return useWealthfolioConnect();
      },
      { wrapper },
    );
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(result.current.postLoginSyncRequest).toBeNull();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });
});

it("mounts local content once after capability resolution without waiting for cloud restoration", async () => {
  const capability = deferred<{ capabilities: { cloud_sync: boolean } }>();
  const restore = deferred<{ accessToken: string; refreshToken: string }>();
  mocks.capability.mockReturnValue(capability.promise);
  mocks.restore.mockReturnValue(restore.promise);
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function LocalPortfolio() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <div>Local portfolio available</div>;
  }
  render(wrapper({ children: <LocalPortfolio /> }));
  expect(screen.queryByText("Local portfolio available")).not.toBeInTheDocument();
  await act(async () => capability.resolve({ capabilities: { cloud_sync: true } }));
  expect(await screen.findByText("Local portfolio available")).toBeInTheDocument();
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
  await act(async () => restore.reject(new Error("offline")));
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});
it("keeps configured credentials unavailable while offline and restores them on retry", async () => {
  mocks.configured = true;
  const { result } = await setup();
  expect(result.current.isSessionUnavailable).toBe(true);
  expect(result.current.isConnected).toBe(false);
  expect(mocks.clear).not.toHaveBeenCalled();
  mocks.restore.mockResolvedValue({ accessToken: "access", refreshToken: "refresh" });
  await act(async () => result.current.retrySession());
  expect(result.current.isConnected).toBe(true);
  expect(result.current.isSessionUnavailable).toBe(false);
});
it.each([new Error("CONNECT_REBIND_REQUIRED"), new BackendError("CONNECT_REBIND_REQUIRED")])(
  "offers explicit reconnection when saved credentials need binding confirmation (%s)",
  async (error) => {
    mocks.configured = true;
    mocks.restore.mockRejectedValue(error);
    const { result } = await setup();
    expect(result.current.isSessionUnavailable).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  },
);
it("does not show signed-out status when the credential status check also fails", async () => {
  mocks.getStatus.mockRejectedValue(new Error("backend unavailable"));
  const { result } = await setup();
  expect(result.current.isSessionUnavailable).toBe(true);
  expect(mocks.clear).not.toHaveBeenCalled();
});
it("coalesces repeated offline retry triggers", async () => {
  mocks.configured = true;
  const { result } = await setup();
  const restored = deferred<{ accessToken: string; refreshToken: string }>();
  mocks.restore.mockClear().mockReturnValue(restored.promise);
  await act(async () => {
    void result.current.retrySession();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(mocks.restore).toHaveBeenCalledOnce();
  await act(async () => restored.reject(new Error("still offline")));
});

it("shares pending profile refreshes without discarding their result", async () => {
  const { result } = await setup();
  await act(() => result.current.signInWithEmail("A", "password"));
  await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
  const before = mocks.getUserInfo.mock.calls.length;
  const pending = deferred<ReturnType<typeof info>>();
  mocks.getUserInfo.mockImplementation(() => pending.promise);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(before + 1));
  let joined!: Promise<void>;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    joined = result.current.refetchUserInfo();
  });
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(before + 1);
  await act(async () => {
    pending.resolve(info("A", "canceled"));
    await joined;
  });
  expect(result.current.userInfo?.team?.subscription_status).toBe("canceled");
  expect(result.current.isLoadingUserInfo).toBe(false);
});

it("pauses hidden profile polling and refreshes once on return", async () => {
  const { result } = await setup();
  await act(() => result.current.signInWithEmail("A", "password"));
  await waitFor(() => expect(result.current.userInfo?.id).toBe("A"));
  const before = mocks.getUserInfo.mock.calls.length;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  // Reinstall the interval in this timer environment by restoring the session.
  mocks.restore.mockResolvedValue({ accessToken: "access", refreshToken: "refresh" });
  await act(() => result.current.retrySession());
  const afterRestore = mocks.getUserInfo.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(180_000));
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(afterRestore);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.getUserInfo).toHaveBeenCalledTimes(afterRestore + 1);
  expect(afterRestore).toBeGreaterThanOrEqual(before);
});

it("replaces an invalidated pending refresh when translation changes", async () => {
  const hook = await setup();
  await act(() => hook.result.current.signInWithEmail("A", "password"));
  await waitFor(() => expect(hook.result.current.userInfo?.id).toBe("A"));
  const before = mocks.getUserInfo.mock.calls.length;
  const pending = deferred<ReturnType<typeof info>>();
  mocks.getUserInfo
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValueOnce(info("A", "canceled"));
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.refetchUserInfo();
  });
  await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(before + 1));
  const previousTranslation = mocks.t;
  try {
    mocks.t = (key: string) => key;
    hook.rerender();
    await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(before + 2));
    await waitFor(() =>
      expect(hook.result.current.userInfo?.team?.subscription_status).toBe("canceled"),
    );
    expect(hook.result.current.isLoadingUserInfo).toBe(false);
    await act(async () => {
      pending.resolve(info("A", "active"));
      await first;
    });
    expect(hook.result.current.userInfo?.team?.subscription_status).toBe("canceled");
    expect(hook.result.current.isLoadingUserInfo).toBe(false);
  } finally {
    mocks.t = previousTranslation;
  }
});
