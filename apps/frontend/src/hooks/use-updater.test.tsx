import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePersistentState } from "./use-persistent-state";
import { UPDATE_DISMISSED_KEY, useCheckForUpdates, useCheckUpdateOnStartup } from "./use-updater";

vi.mock("@/features/profiles/session", () => ({
  selectedProfileId: () => "legacy",
  usesLegacyPreferences: () => true,
}));
vi.mock("@/adapters", () => ({
  isTauri: false,
  logger: { error: vi.fn() },
  isAutoUpdateCheckEnabled: vi.fn(),
  checkForUpdates: vi.fn().mockResolvedValue({ latestVersion: "4.0.0" }),
  installUpdate: vi.fn(),
  getExternalUpdateSource: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => localStorage.clear());

it.each([false, true])(
  "manual update checks clear snooze with scoped preference present: %s",
  async (scoped) => {
    const snooze = { version: "4.0.0", dismissedAt: Date.now() };
    const scopedKey = `profile:legacy:${UPDATE_DISMISSED_KEY}`;
    localStorage.setItem(UPDATE_DISMISSED_KEY, JSON.stringify(snooze));
    localStorage.setItem(`profile:other:${UPDATE_DISMISSED_KEY}`, JSON.stringify(snooze));
    if (scoped) localStorage.setItem(scopedKey, JSON.stringify(snooze));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(
      () => ({
        check: useCheckForUpdates(),
        dismissed: usePersistentState<typeof snooze | null>(UPDATE_DISMISSED_KEY, null)[0],
      }),
      { wrapper },
    );
    expect(result.current.dismissed).toEqual(snooze);
    await act(async () => {
      await result.current.check.mutateAsync();
    });
    expect(result.current.dismissed).toBeNull();
    expect(localStorage.getItem(scopedKey)).toBe("null");
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe(JSON.stringify(snooze));
    expect(localStorage.getItem(`profile:other:${UPDATE_DISMISSED_KEY}`)).toBe(
      JSON.stringify(snooze),
    );
    unmount();
    const reopened = renderHook(() => usePersistentState(UPDATE_DISMISSED_KEY, null));
    expect(reopened.result.current[0]).toBeNull();
    client.clear();
  },
);

it.each([
  { kind: "packager", explanation: "Update Wealthfolio with pacman." },
  { kind: "flatpak" },
  { kind: "packageManager" },
] as const)("startup check skips the update feed for $kind installs", async (source) => {
  const adapters = await import("@/adapters");
  vi.mocked(adapters.getExternalUpdateSource).mockResolvedValueOnce(source);
  vi.mocked(adapters.isAutoUpdateCheckEnabled).mockResolvedValue(true);
  vi.mocked(adapters.checkForUpdates).mockClear();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCheckUpdateOnStartup(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
  expect(adapters.checkForUpdates).not.toHaveBeenCalled();
  client.clear();
});

it("startup check still asks the update feed when the app updates itself", async () => {
  const adapters = await import("@/adapters");
  vi.mocked(adapters.isAutoUpdateCheckEnabled).mockResolvedValue(true);
  vi.mocked(adapters.checkForUpdates).mockClear();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCheckUpdateOnStartup(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual({ latestVersion: "4.0.0" });
  expect(adapters.checkForUpdates).toHaveBeenCalledOnce();
  client.clear();
});
