import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useSyncBrokerData } from "./use-sync-broker-data";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  t: (key: string, options?: { error?: string }) => {
    if (key === "connect:sync.startFailed") return `Could not start: ${options?.error}`;
    if (key === "connect:upgrade.title") return "Upgrade your plan";
    if (key === "connect:subscription.syncPausedDescription") return "Subscription paused";
    return key;
  },
}));
vi.mock("../services/broker-service", () => ({ syncBrokerData: mocks.sync }));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  toast: { error: mocks.error, loading: mocks.loading },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("i18next", () => ({ default: { t: mocks.t } }));
vi.mock("@/adapters", () => ({ logger: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  [
    new Error("API error 403: PLAN_UPGRADE_REQUIRED: Denied (requestId=synthetic)"),
    "Upgrade your plan",
  ],
  ["API error 403: PLAN_UPGRADE_REQUIRED: Denied (requestId=synthetic)", "Upgrade your plan"],
  [
    new Error("API error 403: SUBSCRIPTION_CANCELED: Denied (requestId=synthetic)"),
    "Subscription paused",
  ],
  ["API error 403: SUBSCRIPTION_CANCELED: Denied (requestId=synthetic)", "Subscription paused"],
  [new Error("connections not found"), "connections not found"],
  ["connections not found", "connect:errors.unknown"],
])("maps domain denials and retains other error fallbacks: %s", async (failure, message) => {
  mocks.sync.mockRejectedValueOnce(failure);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSyncBrokerData(), { wrapper });
  act(() => result.current.mutate());
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(`Could not start: ${message}`));
  expect(mocks.loading).not.toHaveBeenCalled();
});
