import { updateSettings } from "@/adapters";
import type { Settings } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import i18n from "i18next";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
