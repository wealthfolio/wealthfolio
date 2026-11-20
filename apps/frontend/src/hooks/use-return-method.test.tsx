import { act, renderHook } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReturnMethod } from "./use-return-method";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({
    settings: { defaultReturnMetric: "twr" },
    updateSettings: mocks.updateSettings,
  }),
}));
vi.mock("@/adapters", () => ({ logger: { error: mocks.logError } }));

describe("useReturnMethod", () => {
  beforeEach(() => {
    mocks.updateSettings.mockReset();
    mocks.logError.mockReset();
  });

  it("saves the method as the setting's stored value", () => {
    mocks.updateSettings.mockResolvedValue(undefined);
    const { result } = renderHook(() => useReturnMethod());
    expect(result.current.returnView).toBe("twr");

    act(() => result.current.setReturnView("moneyWeighted"));

    expect(mocks.updateSettings).toHaveBeenCalledWith({ defaultReturnMetric: "irr" });
  });

  it("handles a failed save instead of leaving the rejection unhandled", async () => {
    mocks.updateSettings.mockRejectedValue(new Error("Settings not loaded"));
    const { result } = renderHook(() => useReturnMethod());

    await act(async () => result.current.setReturnView("moneyWeighted"));

    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});
