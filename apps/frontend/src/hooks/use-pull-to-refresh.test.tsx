import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { usePullToRefresh } from "./use-pull-to-refresh";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@/hooks/use-calculate-portfolio", () => ({
  useUpdatePortfolioMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-haptic-feedback", () => ({
  useHapticFeedback: () => ({ triggerHaptic: vi.fn() }),
}));

function touch(y: number, target: HTMLElement, currentTarget: HTMLElement) {
  return {
    touches: [{ clientX: 100, clientY: y }],
    target,
    currentTarget,
    preventDefault: () => undefined,
  } as unknown as React.TouchEvent;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("eases the content back without refreshing when the system cancels a pull", () => {
  const onRefresh = vi.fn(async () => undefined);
  const container = document.createElement("div");
  const content = document.createElement("div");
  content.setAttribute("data-ptr-content", "");
  container.appendChild(content);
  document.body.appendChild(container);
  const { result } = renderHook(() => usePullToRefresh({ onRefresh }));

  // Pull far enough that lifting the finger would refresh.
  act(() => result.current[1].onTouchStart(touch(100, content, container)));
  act(() => result.current[1].onTouchMove(touch(350, content, container)));
  expect(content.style.transform).toBe("translateY(80px)");

  // A system gesture takes the touch over.
  act(() => result.current[1].onTouchCancel(touch(350, content, container)));

  expect(content.style.transform).toBe("translateY(0px)");
  expect(onRefresh).not.toHaveBeenCalled();
});

it("refreshes when a pull past the activation point ends", () => {
  const onRefresh = vi.fn(async () => undefined);
  const container = document.createElement("div");
  const content = document.createElement("div");
  content.setAttribute("data-ptr-content", "");
  container.appendChild(content);
  document.body.appendChild(container);
  const { result } = renderHook(() => usePullToRefresh({ onRefresh }));

  act(() => result.current[1].onTouchStart(touch(100, content, container)));
  act(() => result.current[1].onTouchMove(touch(350, content, container)));
  act(() => result.current[1].onTouchEnd(touch(350, content, container)));

  expect(onRefresh).toHaveBeenCalledOnce();
  expect(content.style.transform).toBe("translateY(0px)");
});
