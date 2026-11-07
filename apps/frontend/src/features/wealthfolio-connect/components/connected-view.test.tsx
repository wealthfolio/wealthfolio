import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedView } from "./connected-view";

const sync = vi.hoisted(() => ({ trigger: vi.fn(), error: vi.fn(), loading: vi.fn() }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  toast: { error: sync.error, loading: sync.loading },
}));
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));

const context = vi.hoisted(() => ({
  user: { id: "user-1", email: "user@example.com" } as Record<string, unknown>,
  isConnected: true,
  isMfaRequired: false,
  fetchMfaEnabled: vi.fn(),
  verifyMfaCode: vi.fn(),
  cancelMfaChallenge: vi.fn(),
  reportMfaRequired: vi.fn(),
  session: { access_token: "test" },
  userInfo: null as unknown,
  signOut: vi.fn(),
  clearError: vi.fn(),
  refetchUserInfo: vi.fn(),
  isLoading: false,
  isLoadingUserInfo: false,
  isUserInfoRateLimited: false,
  error: null as string | null,
}));
vi.mock("../providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => context,
}));
vi.mock("@/pages/settings/exports/cloud-backup-card", () => ({
  CloudBackupSummary: () => <div data-testid="cloud-backups" />,
}));
vi.mock("./subscription-plans", () => ({
  SubscriptionPlans: ({ isRefreshing }: { isRefreshing?: boolean }) => (
    <button data-testid="pricing" disabled={isRefreshing}>
      Refresh
    </button>
  ),
}));
vi.mock("@/features/devices-sync", () => ({
  DeviceSyncSection: () => <div data-testid="device-sync" />,
}));
const adapters = vi.hoisted(() => ({ openUrlInBrowser: vi.fn() }));
vi.mock("@/adapters", () => adapters);
vi.mock("../services/broker-service", () => ({
  listBrokerAccounts: vi.fn().mockResolvedValue([]),
  listBrokerConnections: vi.fn().mockResolvedValue([]),
  syncBrokerData: sync.trigger,
}));
vi.mock("@wealthfolio/ui", async (importOriginal) => ({
  // The two-factor nudge's "Not now" is stored like other UI preferences.
  usePersistentState: (await importOriginal<typeof import("@wealthfolio/ui")>()).usePersistentState,
  buttonVariants: () => "",
  useDateFormatting: () => ({ dateFormat: "yyyy-MM-dd" }),
  Spinner: () => <span data-testid="spinner" />,
  ActionConfirm: ({ button }: { button: React.ReactNode }) => button,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) =>
      key === "connect:sync.startFailed" ? `Start failed: ${options?.error}` : key,
  }),
  Trans: () => null,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  context.isMfaRequired = false;
  context.error = null;
  context.isLoadingUserInfo = false;
  context.isUserInfoRateLimited = false;
  vi.clearAllMocks();
});

function renderView(direction: "ltr" | "rtl" = "ltr") {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <div dir={direction}>
        <ConnectedView />
      </div>
    </QueryClientProvider>,
  );
}

describe("authenticated subscription view", () => {
  it.each(["ltr", "rtl"] as const)(
    "uses translated plan-denial errors for the Connect page Sync button (%s)",
    async (direction) => {
      context.userInfo = { team: { plan: "essentials", subscription_status: "active" } };
      sync.trigger.mockRejectedValueOnce(
        "API error 403: PLAN_UPGRADE_REQUIRED: Denied (requestId=synthetic)",
      );
      renderView(direction);
      const button = screen.getByRole("button", { name: "connect:sync.syncNow" });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      await waitFor(() =>
        expect(sync.error).toHaveBeenCalledWith("Start failed: connect:upgrade.title"),
      );
      expect(sync.loading).not.toHaveBeenCalled();
    },
  );

  it.each([null, "canceled", "unpaid", "incomplete", "paused", "unknown"])(
    "shows pricing and preserves the session for status %s",
    (status) => {
      context.userInfo = { team: { subscription_status: status } };
      renderView();
      expect(screen.getByTestId("pricing")).toBeTruthy();
      expect(screen.getByText("connect:subscription.syncPausedDescription")).toBeTruthy();
      expect(screen.queryByTestId("device-sync")).toBeNull();
      expect(context.signOut).not.toHaveBeenCalled();
    },
  );

  it("shows pricing when the user has no team", () => {
    context.userInfo = { team: null };
    renderView();
    expect(screen.getByTestId("pricing")).toBeTruthy();
    expect(screen.getByText("connect:subscription.syncPausedDescription")).toBeTruthy();
  });

  it("shows retry instead of pricing when subscription lookup fails", () => {
    context.userInfo = null;
    context.error = "Service unavailable";
    renderView();
    expect(screen.getByText("connect:serviceUnavailable.tryAgain")).toBeTruthy();
    expect(screen.queryByTestId("pricing")).toBeNull();
    expect(screen.queryByText("connect:subscription.syncPausedTitle")).toBeNull();
    expect(context.signOut).not.toHaveBeenCalled();
  });
  it.each(["ltr", "rtl"] as const)(
    "keeps first-load cooldown visible and disables Retry until expiry (%s)",
    (direction) => {
      context.userInfo = null;
      context.error = "API error 429: Too many requests";
      context.isUserInfoRateLimited = true;
      renderView(direction);
      const retry = screen.getByRole("button", { name: "connect:serviceUnavailable.retrying" });
      expect((retry as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(retry);
      expect(context.refetchUserInfo).not.toHaveBeenCalled();
      expect(context.clearError).not.toHaveBeenCalled();
      expect(screen.getByText("connect:serviceUnavailable.description")).toBeTruthy();
    },
  );

  it("keeps the error card visible while local reconciliation is pending", () => {
    context.userInfo = null;
    context.error = "API error 429: Too many requests";
    context.isLoadingUserInfo = true;
    renderView();
    expect(screen.getByText("connect:serviceUnavailable.retrying")).toBeTruthy();
    expect(screen.getByText("connect:serviceUnavailable.description")).toBeTruthy();
  });

  it("Retry leaves the error in place until the provider refreshes it", async () => {
    context.userInfo = null;
    context.error = "Service unavailable";
    renderView();
    fireEvent.click(screen.getByText("connect:serviceUnavailable.tryAgain"));
    await waitFor(() => expect(context.refetchUserInfo).toHaveBeenCalledTimes(1));
    expect(context.clearError).not.toHaveBeenCalled();
  });

  it.each(["ltr", "rtl"] as const)(
    "disables the subscription refresh during cooldown (%s)",
    (direction) => {
      context.userInfo = { team: { subscription_status: "canceled" } };
      context.isUserInfoRateLimited = true;
      renderView(direction);
      expect((screen.getByTestId("pricing") as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it.each(["active", "trialing", "past_due"])(
    "does not show subscription pause for %s",
    (status) => {
      context.userInfo = { team: { plan: "basic", subscription_status: status } };
      renderView();
      expect(screen.queryByText("connect:subscription.syncPausedTitle")).toBeNull();
      expect(screen.queryByTestId("pricing")).toBeNull();
    },
  );
});

describe("two-factor authentication", () => {
  const SECURITY_URL = "https://connect.wealthfolio.app/settings/security";
  const basicPlan = { team: { plan: "basic", subscription_status: "active" } };

  it.each([
    [false, "connect:twoFactor.off", "connect:twoFactor.turnOn"],
    [true, "connect:twoFactor.on", "connect:twoFactor.manage"],
  ])("shows the account's 2FA status (on: %s)", async (enabled, badge, action) => {
    context.userInfo = basicPlan;
    context.fetchMfaEnabled.mockResolvedValue(enabled);
    renderView();
    expect(screen.getByText("connect:twoFactor.label")).toBeTruthy();
    expect(await screen.findByText(badge)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(action) }));
    expect(adapters.openUrlInBrowser).toHaveBeenCalledWith(SECURITY_URL);
  });

  it("nudges subscribed users with 2FA off instead of stacking the upgrade callout", async () => {
    context.userInfo = basicPlan;
    context.fetchMfaEnabled.mockResolvedValue(false);
    renderView();
    expect(await screen.findByText("connect:twoFactorNudge.title")).toBeTruthy();
    expect(screen.queryByText("connect:upgrade.title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /connect:twoFactorNudge.setUp/ }));
    expect(adapters.openUrlInBrowser).toHaveBeenCalledWith(SECURITY_URL);

    fireEvent.click(screen.getByRole("button", { name: "connect:twoFactorNudge.notNow" }));
    expect(screen.queryByText("connect:twoFactorNudge.title")).toBeNull();
    expect(screen.getByText("connect:upgrade.title")).toBeTruthy();

    // "Not now" holds for 60 days for this user.
    cleanup();
    renderView();
    await screen.findByText("connect:twoFactor.off");
    expect(screen.queryByText("connect:twoFactorNudge.title")).toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 24 * 60 * 60 * 1000);
    cleanup();
    renderView();
    expect(await screen.findByText("connect:twoFactorNudge.title")).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("keeps one account's snooze from hiding another account's nudge", async () => {
    context.userInfo = basicPlan;
    context.fetchMfaEnabled.mockResolvedValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = () => (
      <QueryClientProvider client={client}>
        <ConnectedView />
      </QueryClientProvider>
    );
    const { rerender } = render(view());
    fireEvent.click(await screen.findByRole("button", { name: "connect:twoFactorNudge.notNow" }));
    expect(screen.queryByText("connect:twoFactorNudge.title")).toBeNull();
    // Same screen, another account signs in.
    context.user = { id: "user-2", email: "other@example.com" };
    rerender(view());
    expect(await screen.findByText("connect:twoFactorNudge.title")).toBeTruthy();
    context.user = { id: "user-1", email: "user@example.com" };
  });

  it.each([
    ["2FA is on", { team: { plan: "basic", subscription_status: "active" } }, true],
    ["no subscription", { team: { subscription_status: "canceled" } }, false],
  ])("does not nudge when %s", async (_case, userInfo, enabled) => {
    context.userInfo = userInfo;
    context.fetchMfaEnabled.mockResolvedValue(enabled);
    renderView();
    await waitFor(() => expect(context.fetchMfaEnabled).toHaveBeenCalled());
    await screen.findByText(enabled ? "connect:twoFactor.on" : "connect:twoFactor.off");
    expect(screen.queryByText("connect:twoFactorNudge.title")).toBeNull();
  });

  it("explains a paused sync and offers the code step without signing out", async () => {
    context.userInfo = null;
    context.isMfaRequired = true;
    context.fetchMfaEnabled.mockResolvedValue(true);
    // The code step's InputOTP measures itself.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    document.elementFromPoint = () => null;
    renderView();
    expect(screen.getByText("connect:mfaSyncPaused.description")).toBeTruthy();
    // Not a service outage, and no endless loading skeleton.
    expect(screen.queryByText("connect:serviceUnavailable.tryAgain")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "connect:mfaSyncPaused.enterCode" }));
    expect(await screen.findByText("auth:connect.mfa.title")).toBeTruthy();
    expect(context.signOut).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
