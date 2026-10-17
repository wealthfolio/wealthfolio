import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHorizontalOverflow } from "./use-horizontal-overflow";

interface ObserverInstance {
  callback: () => void;
  observed: Element[];
  disconnected: boolean;
}

let instances: ObserverInstance[] = [];

class MockResizeObserver {
  instance: ObserverInstance;

  constructor(callback: () => void) {
    this.instance = { callback, observed: [], disconnected: false };
    instances.push(this.instance);
  }

  observe = (element: Element) => {
    this.instance.observed.push(element);
  };

  disconnect = () => {
    this.instance.disconnected = true;
  };
}

/** jsdom has no layout, so give the elements the widths a test needs. */
function sized(clientWidth: number, offsetWidth: number) {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: offsetWidth });
  return element;
}

function resize(element: HTMLElement, width: number) {
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  act(() => instances[0]?.callback());
}

describe("useHorizontalOverflow", () => {
  beforeEach(() => {
    instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assumes the content overflows until both elements are attached", () => {
    const { result } = renderHook(() => useHorizontalOverflow(null, null));

    expect(result.current).toBe(true);
    expect(instances).toHaveLength(0);
  });

  it("reports content as wide as its box as fitting", () => {
    const box = sized(1336, 1338);
    const table = sized(1336, 1336);
    const { result } = renderHook(() => useHorizontalOverflow(box, table));

    expect(result.current).toBe(false);
    expect(instances[0]?.observed).toEqual([box, table]);
  });

  it("re-measures when the content or the box resizes", () => {
    const box = sized(1336, 1338);
    const table = sized(1336, 1336);
    const { result } = renderHook(() => useHorizontalOverflow(box, table));

    resize(table, 1360);
    expect(result.current).toBe(true);

    resize(box, 1400);
    expect(result.current).toBe(false);
  });

  it("stops observing on unmount", () => {
    const { unmount } = renderHook(() => useHorizontalOverflow(sized(10, 10), sized(5, 5)));

    unmount();

    expect(instances[0]?.disconnected).toBe(true);
  });

  it("measures once where ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { result } = renderHook(() => useHorizontalOverflow(sized(800, 800), sized(700, 700)));

    expect(result.current).toBe(false);
  });
});
