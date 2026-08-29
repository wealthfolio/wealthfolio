import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIntersectionObserver } from "./use-intersection-observer";

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;

const observeMock = vi.fn();
const disconnectMock = vi.fn();
let observerCallback: ObserverCallback | undefined;
let observerOptions: IntersectionObserverInit | undefined;

class MockIntersectionObserver {
  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    observerCallback = callback;
    observerOptions = options;
  }

  observe = observeMock;
  disconnect = disconnectMock;
}

function renderWithElement(
  callback: () => void,
  options?: Parameters<typeof useIntersectionObserver>[1],
) {
  const element = document.createElement("div");
  return renderHook(() => {
    const ref = useIntersectionObserver(callback, options);
    // Attach the sentinel during render so the effect sees it.
    ref.current = element;
    return ref;
  });
}

describe("useIntersectionObserver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observerCallback = undefined;
    observerOptions = undefined;
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observes the sentinel element when enabled", () => {
    renderWithElement(vi.fn());

    expect(observeMock).toHaveBeenCalledTimes(1);
    expect(observerOptions).toEqual({ rootMargin: "100px" });
  });

  it("invokes the callback when the sentinel intersects", () => {
    const callback = vi.fn();
    renderWithElement(callback);

    observerCallback?.([{ isIntersecting: true }]);
    expect(callback).toHaveBeenCalledTimes(1);

    observerCallback?.([{ isIntersecting: false }]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not create an observer when disabled", () => {
    renderWithElement(vi.fn(), { enabled: false });

    expect(observeMock).not.toHaveBeenCalled();
    expect(observerCallback).toBeUndefined();
  });

  it("disconnects the observer on unmount", () => {
    const { unmount } = renderWithElement(vi.fn());
    expect(observeMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("passes a custom rootMargin to the observer", () => {
    renderWithElement(vi.fn(), { rootMargin: "200px" });

    expect(observerOptions).toEqual({ rootMargin: "200px" });
  });
});
