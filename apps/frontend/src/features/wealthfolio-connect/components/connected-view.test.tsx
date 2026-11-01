import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedView } from "./connected-view";

const context = vi.hoisted(() => ({
  user: { email: "user@example.com" },
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
vi.mock("@/adapters", () => ({ openUrlInBrowser: vi.fn() }));
vi.mock("../services/broker-service", () => ({
  listBrokerAccounts: vi.fn().mockResolvedValue([]),
  listBrokerConnections: vi.fn().mockResolvedValue([]),
  syncBrokerData: vi.fn(),
}));
vi.mock("@wealthfolio/ui", () => ({
  useDateFormatting: () => ({ dateFormat: "yyyy-MM-dd" }),
  Spinner: () => <span data-testid="spinner" />,
  ActionConfirm: ({ button }: { button: React.ReactNode }) => button,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));

afterEach(() => {
  cleanup();
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
