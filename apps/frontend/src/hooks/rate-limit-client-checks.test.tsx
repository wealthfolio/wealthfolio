import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkForUpdates, fetchAddonStoreListings } from "@/adapters";
import { useAddonStore } from "@/pages/settings/addons/hooks/use-addon-store";
import { useCheckForUpdates, useCheckUpdateOnStartup } from "./use-updater";

vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  isAutoUpdateCheckEnabled: vi.fn().mockResolvedValue(true),
  checkForUpdates: vi.fn(),
  installUpdate: vi.fn(),
  fetchAddonStoreListings: vi.fn(),
  clearAddonStaging: vi.fn(),
  downloadAddonForReview: vi.fn(),
  getAddonRatings: vi.fn(),
  installFromStaging: vi.fn(),
  submitAddonRating: vi.fn(),
}));
vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "test",
  usesLegacyPreferences: () => true,
}));
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

const clients: QueryClient[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  clients.push(client);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

it.each([
  new Error("HTTP 429: Please try again in 60 seconds."),
  "HTTP 429: Too many requests",
  new TypeError("Failed to fetch"),
])("update checks stop on a recoverable failure and can be retried: %s", async (failure) => {
  vi.mocked(checkForUpdates).mockRejectedValue(failure);
  const startup = renderHook(() => useCheckUpdateOnStartup(), { wrapper: wrapper() });
  await waitFor(() => expect(startup.result.current.isError).toBe(true));
  expect(checkForUpdates).toHaveBeenCalledTimes(1);
  expect(startup.result.current.fetchStatus).toBe("idle");
  startup.unmount();

  const manual = renderHook(() => useCheckForUpdates(), { wrapper: wrapper() });
  await act(async () => {
    await expect(manual.result.current.mutateAsync()).rejects.toBe(failure);
  });
  await waitFor(() => expect(manual.result.current.isPending).toBe(false));
  expect(checkForUpdates).toHaveBeenCalledTimes(2);
  vi.mocked(checkForUpdates).mockResolvedValue(null);
  await act(() => manual.result.current.mutateAsync());
  expect(checkForUpdates).toHaveBeenCalledTimes(3);
});

it.each([
  new Error("Store API returned error 429: Please try again in 60 seconds."),
  "Store API returned error 429: <html>Too many requests</html>",
  new TypeError("Failed to fetch"),
])("marketplace retries are bounded and a later refresh recovers: %s", async (failure) => {
  vi.mocked(fetchAddonStoreListings).mockRejectedValue(failure);
  const { result } = renderHook(() => useAddonStore(), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.isLoadingStore).toBe(false));
  expect(fetchAddonStoreListings).toHaveBeenCalledTimes(2);
  expect(result.current.storeListings).toEqual([]);
  vi.mocked(fetchAddonStoreListings).mockResolvedValue([]);
  await act(async () => {
    await result.current.fetchStoreListings();
  });
  expect(fetchAddonStoreListings).toHaveBeenCalledTimes(3);
});
