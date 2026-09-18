import { updateSettings } from "@/adapters";
import type { Settings } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import i18n from "i18next";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsMutation } from "./use-settings-mutation";

vi.mock("@/adapters", () => ({
  logger: { error: vi.fn() },
  updateSettings: vi.fn(),
}));

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useSettingsMutation", () => {
  it("waits for the saved language resources before translating the success toast", async () => {
    let finishLoading!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    const updatedSettings = {
      language: "de",
      onboardingCompleted: true,
    } as Settings;
    vi.mocked(updateSettings).mockResolvedValue(updatedSettings);
    const loadLanguages = vi.spyOn(i18n, "loadLanguages").mockReturnValue(loading);
    const fixedT = ((key: string) => `de:${key}`) as ReturnType<typeof i18n.getFixedT>;
    const getFixedT = vi.spyOn(i18n, "getFixedT").mockReturnValue(fixedT);
    const setSettings = vi.fn();
    const applySettings = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSettingsMutation(setSettings, applySettings), {
      wrapper,
    });

    let mutation!: Promise<Settings>;
    act(() => {
      mutation = result.current.mutateAsync({ language: "de" });
    });

    await waitFor(() => expect(loadLanguages).toHaveBeenCalledWith("de"));
    expect(toast).not.toHaveBeenCalled();

    finishLoading();
    await act(async () => {
      await mutation;
    });

    expect(getFixedT).toHaveBeenCalledWith("de");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "de:settings:settings_updated_title",
        description: "de:settings:settings_updated_description",
      }),
    );
  });

  /**
   * Spending responses carry amounts the server converted into the base
   * currency, so a change leaves every cached page denominated in the old one.
   * Without this the transactions net kept reporting the previous currency's
   * figures until some unrelated mutation happened to refetch.
   */
  it("refetches spending caches when the base currency changes", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      baseCurrency: "EUR",
      onboardingCompleted: true,
    } as Settings);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSettingsMutation(vi.fn(), vi.fn()), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ baseCurrency: "EUR" });
    });

    const invalidated = invalidate.mock.calls.flatMap((call) => call[0]?.queryKey ?? []);
    expect(invalidated).toContain(QueryKeys.SPENDING_TRANSACTIONS);
  });

  /**
   * The server dates each conversion by the activity's day in the user's zone,
   * so a row near midnight converts at a different rate once the zone moves.
   * The timezone travels in no request and appears in no query key, so nothing
   * else would evict the pages computed under the old one.
   */
  it("refetches spending and planning caches when the timezone changes", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      timezone: "America/New_York",
      onboardingCompleted: true,
    } as Settings);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSettingsMutation(vi.fn(), vi.fn()), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ timezone: "America/New_York" });
    });

    const invalidated = invalidate.mock.calls.flatMap((call) => call[0]?.queryKey ?? []);
    expect(invalidated).toContain(QueryKeys.SPENDING_TRANSACTIONS);
    expect(invalidated).toContain(QueryKeys.RETIREMENT_OVERVIEW);
    expect(invalidated).toContain(QueryKeys.SAVE_UP_OVERVIEW);
    expect(invalidated).toContain(QueryKeys.SAVE_UP_PREVIEW);
  });

  it("leaves spending caches alone for an unrelated setting", async () => {
    vi.mocked(updateSettings).mockResolvedValue({
      onboardingCompleted: true,
    } as Settings);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSettingsMutation(vi.fn(), vi.fn()), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ theme: "dark" } as Partial<Settings>);
    });

    const invalidated = invalidate.mock.calls.flatMap((call) => call[0]?.queryKey ?? []);
    expect(invalidated).not.toContain(QueryKeys.SPENDING_TRANSACTIONS);
    expect(invalidated).not.toContain(QueryKeys.RETIREMENT_OVERVIEW);
    expect(invalidated).not.toContain(QueryKeys.SAVE_UP_OVERVIEW);
    expect(invalidated).not.toContain(QueryKeys.SAVE_UP_PREVIEW);
  });
});
