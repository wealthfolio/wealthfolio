import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAndroidSystemBars } from "./use-android-system-bars";

interface TestBridge {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent<string>) => void) | null;
}
const bridge: TestBridge = { postMessage: vi.fn(), onmessage: null };
const androidWindow = window as typeof window & { WealthfolioAndroid?: TestBridge };
afterEach(() => {
  delete androidWindow.WealthfolioAndroid;
  document.documentElement.removeAttribute("style");
  vi.clearAllMocks();
});

it("accepts physical inset edges, including landscape, without trusting malformed values", () => {
  androidWindow.WealthfolioAndroid = bridge;
  const hook = renderHook(() => useAndroidSystemBars());
  expect(bridge.postMessage).toHaveBeenCalledWith("insets");
  act(() =>
    bridge.onmessage?.(
      new MessageEvent("message", { data: '{"top":24,"right":48,"bottom":0,"left":0}' }),
    ),
  );
  expect(document.documentElement.style.getPropertyValue("--android-inset-right")).toBe("48px");
  act(() =>
    bridge.onmessage?.(new MessageEvent("message", { data: '{"right":-1,"bottom":"bad"}' })),
  );
  expect(document.documentElement.style.getPropertyValue("--android-inset-right")).toBe("48px");
  expect(document.documentElement.style.getPropertyValue("--android-inset-bottom")).toBe("0px");
  act(() => bridge.onmessage?.(new MessageEvent("message", { data: "malformed" })));
  hook.unmount();
  expect(bridge.onmessage).toBeNull();
});

it("supports an older native shell and browsers with no Android bridge", () => {
  const browser = renderHook(() => useAndroidSystemBars());
  browser.unmount();
  androidWindow.WealthfolioAndroid = bridge;
  renderHook(() => useAndroidSystemBars());
  act(() => bridge.onmessage?.(new MessageEvent("message", { data: "48" })));
  expect(document.documentElement.style.getPropertyValue("--android-inset-bottom")).toBe("48px");
});

it("reports keyboard coverage separately from system bars and clears it on dismissal", () => {
  androidWindow.WealthfolioAndroid = bridge;
  renderHook(() => useAndroidSystemBars());
  for (const height of [320, 0]) {
    act(() =>
      bridge.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ bottom: 48, imeBottom: height }) }),
      ),
    );
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset-bottom")).toBe(
      `${height}px`,
    );
    expect(document.documentElement.style.getPropertyValue("--android-inset-bottom")).toBe("48px");
  }
  act(() => bridge.onmessage?.(new MessageEvent("message", { data: '{"imeBottom":-1}' })));
  expect(document.documentElement.style.getPropertyValue("--keyboard-inset-bottom")).toBe("0px");
});
