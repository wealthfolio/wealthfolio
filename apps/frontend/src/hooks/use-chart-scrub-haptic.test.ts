import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChartScrubHaptic } from "./use-chart-scrub-haptic";

const triggerHaptic = vi.fn();
vi.mock("./use-haptic-feedback", () => ({
  useHapticFeedback: () => ({ triggerHaptic }),
}));

let now = 1_000;

beforeEach(() => {
  now = 1_000;
  triggerHaptic.mockClear();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("ticks once per new data point, at most every 80 ms", () => {
  const { result } = renderHook(() => useChartScrubHaptic());

  result.current.tick("2026-10-01");
  result.current.tick("2026-10-01");
  expect(triggerHaptic).toHaveBeenCalledTimes(1);

  now += 40;
  result.current.tick("2026-10-02");
  expect(triggerHaptic).toHaveBeenCalledTimes(1);

  now += 40;
  result.current.tick("2026-10-02");
  expect(triggerHaptic).toHaveBeenCalledTimes(2);
});

it("ignores a missing label and ticks again on the same point after a reset", () => {
  const { result } = renderHook(() => useChartScrubHaptic());

  result.current.tick(null);
  result.current.tick(undefined);
  expect(triggerHaptic).not.toHaveBeenCalled();

  result.current.tick("2026-10-01");
  result.current.reset();
  now += 80;
  result.current.tick("2026-10-01");
  expect(triggerHaptic).toHaveBeenCalledTimes(2);
});
