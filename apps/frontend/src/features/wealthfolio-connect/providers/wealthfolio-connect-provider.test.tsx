import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
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
  aal: vi.fn(),
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
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
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.aal,
        listFactors: mocks.listFactors,
        challengeAndVerify: mocks.challengeAndVerify,
      },
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
// The session Supabase saves after the code step: same user, rotated tokens.
const verified = (account: string) => ({
  data: {
    session: {
      user: { id: account },
      refresh_token: `${account}-aal2`,
      access_token: `${account}-aal2-access`,
    },
  },
  error: null,
});
const assurance = (currentLevel: string, nextLevel: string) => ({
  data: { currentLevel, nextLevel, currentAuthenticationMethods: [] },
  error: null,
});
const MFA_REQUIRED =
  "Unexpected error: API error 403: MFA_REQUIRED: Two-factor authentication required (requestId=x)";
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
  // Accounts without 2FA: the sign-in session is already at its highest level.
  mocks.aal.mockResolvedValue(assurance("aal1", "aal1"));
  mocks.listFactors.mockResolvedValue({
    data: { all: [], totp: [{ id: "factor-1", status: "verified" }], phone: [], webauthn: [] },
    error: null,
  });
  mocks.challengeAndVerify.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
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

  it("requires explicit confirmation before replacing a Connect account", async () => {
    mocks.store.mockRejectedValueOnce(new Error("CONNECT_REBIND_REQUIRED"));
    const { result } = await setup();
    let login!: Promise<void>;
    await act(async () => {
      login = result.current.signInWithEmail("B", "password");
    });
    await screen.findByRole("dialog");
    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.postLoginSyncRequest).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "connect:rebind.confirm" }));
      await login;
    });
    expect(mocks.store).toHaveBeenLastCalledWith("B", true);
    expect(result.current.user?.id).toBe("B");
  });

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
it("offers explicit reconnection when saved credentials need binding confirmation", async () => {
  mocks.configured = true;
  mocks.restore.mockRejectedValue(new Error("CONNECT_REBIND_REQUIRED"));
  const { result } = await setup();
  expect(result.current.isSessionUnavailable).toBe(false);
  expect(result.current.isConnected).toBe(false);
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.store).not.toHaveBeenCalled();
});
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

describe("Two-factor authentication", () => {
  const signIn = async (
    result: { current: ReturnType<typeof useWealthfolioConnect> },
    method: "email" | "otp" | "oauth",
  ) => {
    await act(async () => {
      if (method === "email") await result.current.signInWithEmail("A", "password");
      else if (method === "otp") await result.current.verifyOtp("A", "123456");
      else
        mocks.onDeepLink({
          payload: "wealthfolio://auth/callback?code=mfa-test#wf_profile_flow=test-flow",
        });
    });
  };
  const signInCases = [
    ["email", "A", "email-sign-in"],
    ["otp", "A", "otp"],
    ["oauth", "B", "auth-callback"],
  ] as const;

  it("signs in without a code step when 2FA is off", async () => {
    const { result } = await setup();
    await signIn(result, "email");
    expect(result.current.isConnected).toBe(true);
    expect(mocks.store).toHaveBeenCalledWith("A");
    expect(result.current.mfaChallenge).toBeNull();
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
  });

  it.each(signInCases)(
    "stores a %s sign-in only after the authenticator code",
    async (method, account, source) => {
      mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
      const { result } = await setup();
      await signIn(result, method);
      await waitFor(() => expect(result.current.mfaChallenge).toBe("sign-in"));
      // Checked with the login's own token, not the SDK's stored session.
      expect(mocks.aal).toHaveBeenCalledWith(`${account}-access`);
      expect(mocks.store).not.toHaveBeenCalled();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.postLoginSyncRequest).toBeNull();

      mocks.getSession.mockResolvedValue(verified(account));
      await act(() => result.current.verifyMfaCode("123456"));
      expect(mocks.challengeAndVerify).toHaveBeenCalledWith({
        factorId: "factor-1",
        code: "123456",
      });
      // A new login's tokens are the SDK's own; nothing is read back from the backend.
      expect(mocks.restore).toHaveBeenCalledTimes(1);
      expect(mocks.store).toHaveBeenCalledTimes(1);
      expect(mocks.store).toHaveBeenCalledWith(`${account}-aal2`);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.mfaChallenge).toBeNull();
      expect(result.current.postLoginSyncRequest?.source).toBe(source);
    },
  );

  it("keeps the code step after a wrong code", async () => {
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    const rejected = Object.assign(new Error("Invalid TOTP code entered"), {
      code: "mfa_verification_failed",
    });
    mocks.challengeAndVerify.mockResolvedValueOnce({ data: null, error: rejected });
    const { result } = await setup();
    await signIn(result, "email");
    await expect(result.current.verifyMfaCode("000000")).rejects.toBe(rejected);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(result.current.mfaChallenge).toBe("sign-in");
    expect(result.current.isConnected).toBe(false);
  });

  it("signing out of a new login's code step discards it without touching saved credentials", async () => {
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    const { result } = await setup();
    await signIn(result, "email");
    await act(() => result.current.cancelMfaChallenge());
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(result.current.mfaChallenge).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it("asks for the code when the backend's login check gets MFA_REQUIRED", async () => {
    mocks.store.mockRejectedValueOnce(new Error(MFA_REQUIRED));
    const { result } = await setup();
    await signIn(result, "email");
    expect(result.current.mfaChallenge).toBe("sign-in");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("steps up a restored aal1 session instead of signing out", async () => {
    mocks.configured = true;
    mocks.account = "A";
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    const { result } = await setup();
    expect(result.current.mfaChallenge).toBe("restore");
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isSessionUnavailable).toBe(false);
    expect(mocks.clear).not.toHaveBeenCalled();
    // Reading the SDK's stored session could refresh the backend's token.
    expect(mocks.aal).toHaveBeenCalledWith("A-access");
    expect(mocks.getSession).not.toHaveBeenCalled();

    // The backend may have rotated the refresh token while the step was open.
    mocks.restore.mockResolvedValue({ accessToken: "A-access-2", refreshToken: "A-rotated" });
    mocks.getSession.mockResolvedValue(verified("A"));
    await act(() => result.current.verifyMfaCode("123456"));
    expect(mocks.setSession).toHaveBeenLastCalledWith({
      access_token: "A-access-2",
      refresh_token: "A-rotated",
    });
    expect(mocks.setSession.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.challengeAndVerify.mock.invocationCallOrder[0],
    );
    expect(mocks.store).toHaveBeenCalledWith("A-aal2");
    expect(result.current.isConnected).toBe(true);
    expect(result.current.mfaChallenge).toBeNull();
    expect(result.current.postLoginSyncRequest?.source).toBe("mfa");
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("signing out of a restored session's code step clears saved credentials", async () => {
    mocks.configured = true;
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    const { result } = await setup();
    await act(() => result.current.cancelMfaChallenge());
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(result.current.mfaChallenge).toBeNull();
  });

  it("pauses sync on MFA_REQUIRED and resumes after the code without signing out", async () => {
    mocks.configured = true;
    mocks.account = "A";
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    // The saved login still exists at aal1, so a code can resume sync.
    mocks.getUser.mockResolvedValue({ data: { user: { id: "A" } }, error: null });
    const { result } = await setup();
    await waitFor(() => expect(result.current.isMfaRequired).toBe(true));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();

    mocks.getUserInfo.mockImplementation(async () => info(mocks.account));
    mocks.getSession.mockResolvedValue(verified("A"));
    expect(mocks.getUser).toHaveBeenCalledWith("A-access");
    await act(() => result.current.verifyMfaCode("123456"));
    // Startup, the login check, then the code step.
    expect(mocks.restore).toHaveBeenCalledTimes(3);
    expect(mocks.store).toHaveBeenCalledWith("A-aal2");
    expect(result.current.isMfaRequired).toBe(false);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.postLoginSyncRequest?.source).toBe("mfa");
    await waitFor(() => expect(result.current.userInfo?.id).toBe("A-aal2"));
  });

  it("reads 2FA status with a token the backend minted", async () => {
    mocks.configured = true;
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "A", factors: [{ factor_type: "totp", status: "verified" }] } },
      error: null,
    });
    const { result } = await setup();
    await expect(result.current.fetchMfaEnabled()).resolves.toBe(true);
    expect(mocks.getUser).toHaveBeenCalledWith("A-access");
  });
});

describe("Two-factor authentication turned on elsewhere", () => {
  // Supabase deletes a user's other aal1 sessions when a code is verified.
  const missing = () =>
    Object.assign(new Error("Auth session missing!"), { name: "AuthSessionMissingError" });
  const connectedA = async () => {
    mocks.configured = true;
    mocks.account = "A";
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    return setup();
  };

  it("tries each authenticator until one accepts the code", async () => {
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [],
        totp: [
          { id: "phone-app", status: "verified" },
          { id: "backup-app", status: "verified" },
        ],
        phone: [],
        webauthn: [],
      },
      error: null,
    });
    const rejected = Object.assign(new Error("Invalid TOTP code entered"), {
      code: "mfa_verification_failed",
    });
    mocks.challengeAndVerify
      .mockResolvedValueOnce({ data: null, error: rejected })
      .mockResolvedValueOnce({ data: {}, error: null });
    mocks.getSession.mockResolvedValue(verified("A"));
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await act(() => result.current.verifyMfaCode("123456"));
    expect(mocks.challengeAndVerify.mock.calls.map(([params]) => params.factorId)).toEqual([
      "phone-app",
      "backup-app",
    ]);
    expect(result.current.isConnected).toBe(true);
  });

  it("stops at an error that isn't a wrong code", async () => {
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [],
        totp: [
          { id: "phone-app", status: "verified" },
          { id: "backup-app", status: "verified" },
        ],
        phone: [],
        webauthn: [],
      },
      error: null,
    });
    const limited = Object.assign(new Error("Too many requests"), {
      code: "over_request_rate_limit",
    });
    mocks.challengeAndVerify.mockResolvedValueOnce({ data: null, error: limited });
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await expect(result.current.verifyMfaCode("123456")).rejects.toBe(limited);
    expect(mocks.challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("asks to sign in again, not for a code, when MFA_REQUIRED comes from a deleted login", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: missing() });
    const { result } = await connectedA();
    await waitFor(() => expect(result.current.sessionEnded).toBe(true));
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isMfaRequired).toBe(false);
    // Cleared like a sign-out, which keeps the device's sync identity.
    expect(mocks.clear).toHaveBeenCalledTimes(1);

    // Signing in again goes through the code step and clears the notice.
    mocks.getUserInfo.mockImplementation(async () => info(mocks.account));
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    await act(() => result.current.signInWithEmail("A", "password"));
    expect(result.current.mfaChallenge).toBe("sign-in");
    mocks.getSession.mockResolvedValue(verified("A"));
    await act(() => result.current.verifyMfaCode("123456"));
    expect(result.current.isConnected).toBe(true);
    expect(result.current.sessionEnded).toBe(false);
    expect(mocks.store).toHaveBeenLastCalledWith("A-aal2");
  });

  it("turns the code step into a sign-in when the login was deleted meanwhile", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "A" } }, error: null });
    const { result } = await connectedA();
    await waitFor(() => expect(result.current.isMfaRequired).toBe(true));
    mocks.setSession.mockResolvedValueOnce({ data: { session: null }, error: missing() });
    await act(() => result.current.verifyMfaCode("123456"));
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
    expect(result.current.sessionEnded).toBe(true);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("explains a deleted login the backend still had a cached token for", async () => {
    mocks.configured = true;
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    // The SDK signs out a deleted session before setSession returns.
    mocks.setSession.mockImplementationOnce(async () => {
      mocks.onAuth("SIGNED_OUT");
      return { data: { session: null }, error: missing() };
    });
    const { result } = await setup();
    expect(result.current.sessionEnded).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("a late check of a deleted login can't sign out a newer one", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    const late = deferred<void>();
    mocks.getUser.mockImplementationOnce(async () => {
      await late.promise;
      // The SDK drops whatever session it holds when a token's session is gone.
      mocks.onAuth("SIGNED_OUT");
      return { data: { user: null }, error: missing() };
    });
    const { result } = await connectedA();
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(1));
    mocks.getUserInfo.mockImplementation(async () => info(mocks.account));
    let login!: Promise<void>;
    await act(async () => {
      login = result.current.signInWithEmail("B", "password");
      // Long enough for a login that doesn't wait for the check to finish.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      late.resolve();
      await login;
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.user?.id).toBe("B");
    expect(mocks.store).toHaveBeenLastCalledWith("B");
  });

  it("explains a deleted login found by the restore's 2FA check", async () => {
    mocks.configured = true;
    mocks.restore.mockResolvedValue({ accessToken: "A-access", refreshToken: "A" });
    mocks.aal.mockImplementationOnce(async () => {
      mocks.onAuth("SIGNED_OUT");
      return { data: null, error: missing() };
    });
    const { result } = await setup();
    expect(result.current.sessionEnded).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("retries handing a verified login to the backend instead of verifying again", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "A" } }, error: null });
    const { result } = await connectedA();
    await waitFor(() => expect(result.current.isMfaRequired).toBe(true));
    mocks.getSession.mockResolvedValue(verified("A"));
    mocks.store.mockRejectedValueOnce(
      new Error("Broker sync is running. Wait for it to finish and try again."),
    );
    await act(async () => {
      await expect(result.current.verifyMfaCode("123456")).rejects.toThrow("Broker sync");
    });
    const restores = mocks.restore.mock.calls.length;
    mocks.getUserInfo.mockImplementation(async () => info(mocks.account));
    await act(() => result.current.verifyMfaCode("123456"));
    // The backend's older token is never restored over the verified one.
    expect(mocks.restore).toHaveBeenCalledTimes(restores);
    expect(mocks.challengeAndVerify).toHaveBeenCalledTimes(1);
    expect(mocks.store.mock.calls.map(([token]) => token)).toEqual(["A-aal2", "A-aal2"]);
    expect(result.current.isMfaRequired).toBe(false);
    expect(result.current.isConnected).toBe(true);
  });

  it("never hands over a cancelled login's verified session for another account", async () => {
    mocks.aal.mockResolvedValue(assurance("aal1", "aal2"));
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    mocks.getSession.mockResolvedValue(verified("A"));
    mocks.store.mockRejectedValueOnce(
      new Error("Broker sync is running. Wait for it to finish and try again."),
    );
    await act(async () => {
      await expect(result.current.verifyMfaCode("123456")).rejects.toThrow("Broker sync");
    });
    // Sign out of A's code step fails to reach the server, so the SDK keeps A.
    mocks.signOut.mockResolvedValueOnce({ error: new Error("Network request failed") });
    await act(() => result.current.cancelMfaChallenge());

    await act(() => result.current.signInWithEmail("B", "password"));
    expect(result.current.mfaChallenge).toBe("sign-in");
    mocks.getSession.mockResolvedValue(verified("B"));
    await act(() => result.current.verifyMfaCode("654321"));
    expect(mocks.challengeAndVerify).toHaveBeenLastCalledWith({
      factorId: "factor-1",
      code: "654321",
    });
    expect(mocks.store).toHaveBeenLastCalledWith("B-aal2");
    expect(result.current.user?.id).toBe("B");
  });

  it("turns the code step into a sign-in when the factor lookup finds the login deleted", async () => {
    mocks.getUserInfo.mockRejectedValue(new Error(MFA_REQUIRED));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "A" } }, error: null });
    const { result } = await connectedA();
    await waitFor(() => expect(result.current.isMfaRequired).toBe(true));
    mocks.listFactors.mockImplementationOnce(async () => {
      mocks.onAuth("SIGNED_OUT");
      return { data: null, error: missing() };
    });
    await act(() => result.current.verifyMfaCode("123456"));
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
    expect(result.current.sessionEnded).toBe(true);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it("explains a login the backend found expired at startup", async () => {
    mocks.configured = true;
    mocks.restore.mockImplementation(async () => {
      // The backend's refresh was rejected; it cleared the tokens, not the pairing.
      mocks.configured = false;
      throw new Error("CONNECT_SESSION_EXPIRED: Session expired. Please sign in again.");
    });
    const { result } = await setup();
    expect(result.current.sessionEnded).toBe(true);
    expect(result.current.isSessionUnavailable).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });

  it("explains a login the backend dropped while the app was open", async () => {
    const { result } = await connectedA();
    await waitFor(() => expect(result.current.userInfo).not.toBeNull());
    mocks.configured = false;
    await act(() => result.current.refetchUserInfo());
    expect(result.current.isConnected).toBe(false);
    expect(result.current.sessionEnded).toBe(true);
  });

  it("does not show the notice after a sign-out here", async () => {
    const { result } = await connectedA();
    await act(() => result.current.signOut());
    expect(result.current.isConnected).toBe(false);
    expect(result.current.sessionEnded).toBe(false);
  });
});
