import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePostLoginConnectSync } from "../hooks/use-post-login-connect-sync";
import { WealthfolioConnectProvider, useWealthfolioConnect } from "./wealthfolio-connect-provider";

const mocks = vi.hoisted(() => ({
  platform: "web",
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

vi.mock("@/lib/connect-config", () => ({ CONNECT_ENABLED: true }));
vi.mock("@/context/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@/hooks/use-platform", () => ({
  getPlatform: async () => ({
    os: mocks.platform,
    is_mobile: mocks.platform !== "web",
    capabilities: { cloud_sync: true },
  }),
}));
vi.mock("tauri-plugin-web-auth-api", () => ({ authenticate: vi.fn() }));
vi.mock("@/adapters", () => ({
  isDesktop: true,
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
const wrapper = ({ children }: { children: ReactNode }) => (
  <WealthfolioConnectProvider>{children}</WealthfolioConnectProvider>
);
async function setup() {
  const hook = renderHook(useWealthfolioConnect, { wrapper });
  await waitFor(() => expect(hook.result.current.isInitializing).toBe(false));
  return hook;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.restore.mockRejectedValue(new Error("No stored session"));
  mocks.setSession.mockResolvedValue({ data: { session: session("A") }, error: null });
  mocks.verifyOtp.mockResolvedValue({ data: { session: session("A") }, error: null });
  mocks.configured = false;
  mocks.account = "";
  mocks.platform = "web";
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

describe("Cloud session lifecycle", () => {
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

  it("ignores errors from an obsolete request", async () => {
    const old = deferred<ReturnType<typeof info>>();
    mocks.getUserInfo.mockImplementationOnce(() => old.promise);
    const { result } = await setup();
    await act(() => result.current.signInWithEmail("A", "password"));
    await waitFor(() => expect(mocks.getUserInfo).toHaveBeenCalledTimes(1));
    await act(() => result.current.signInWithEmail("B", "password"));
    await waitFor(() => expect(result.current.userInfo?.id).toBe("B"));
    await act(async () => {
      old.reject(new Error("Old account request failed"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.userInfo?.id).toBe("B");
    expect(result.current.isLoadingUserInfo).toBe(false);
  });

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
      mocks.onDeepLink({ payload: "wealthfolio://auth/callback?code=mobile-code" }),
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
        else mocks.onDeepLink({ payload: "wealthfolio://auth/callback?code=activation-test" });
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
