import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
  error: null as string | null,
}));
vi.mock("../providers/wealthfolio-connect-provider", () => ({
  useWealthfolioConnect: () => context,
}));
vi.mock("./subscription-plans", () => ({
  SubscriptionPlans: () => <div data-testid="pricing" />,
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
  ActionConfirm: ({ button }: { button: React.ReactNode }) => button,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));

afterEach(() => {
  cleanup();
  context.error = null;
  vi.clearAllMocks();
});

function renderView() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConnectedView />
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
