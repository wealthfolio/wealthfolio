import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { formatDateISO } from "@/lib/utils";

import { useDashboardPeriod } from "./use-dashboard-period";

const TODAY = "2026-03-31";

function dates(range: { from?: Date; to?: Date } | undefined) {
  return range?.from && range.to ? [formatDateISO(range.from), formatDateISO(range.to)] : null;
}

describe("useDashboardPeriod", () => {
  beforeEach(() => localStorage.clear());

  it("exposes navigation immediately for 6M, shares its window, and restores it after reload", () => {
    const first = renderHook(() => useDashboardPeriod(TODAY));
    act(() => first.result.current.selectPreset("6M"));
    expect(first.result.current.navigation.previousDisabled).toBe(false);
    expect(first.result.current.navigation.nextDisabled).toBe(true);
    act(() => first.result.current.navigation.onStep(-1));
    expect(first.result.current.selectedPreset).toBe("6M");
    expect(first.result.current.code).toBeNull();
    expect(dates(first.result.current.range)).toEqual(["2025-03-31", "2025-09-30"]);
    const second = renderHook(() => useDashboardPeriod(TODAY));
    expect(second.result.current.selectedPreset).toBe("6M");
    expect(dates(second.result.current.range)).toEqual(dates(first.result.current.range));
    act(() => second.result.current.navigation.onStep(1));
    expect(first.result.current.code).toBe("6M");
    expect(first.result.current.customRange).toBeUndefined();
  });

  it("retains an Insights calendar window and its alignment on both portfolio tabs", () => {
    localStorage.setItem(
      "dashboard-period",
      JSON.stringify({
        kind: "range",
        from: "2025-10-01",
        to: "2026-03-31",
        presetWindow: {
          preset: { kind: "spending", code: "6M" },
          anchor: "2026-09-15",
          offset: -1,
          alignment: "calendar",
        },
      }),
    );
    const investments = renderHook(() => useDashboardPeriod("2026-09-15"));
    const netWorth = renderHook(() =>
      useDashboardPeriod("2026-09-15", { key: "networth-interval", initial: "ALL" }),
    );
    expect(investments.result.current.selectedPreset).toBe("6M");
    expect(dates(netWorth.result.current.range)).toEqual(["2025-10-01", "2026-03-31"]);
    act(() => netWorth.result.current.navigation.onStep(-1));
    expect(dates(investments.result.current.range)).toEqual(["2025-04-01", "2025-09-30"]);
    act(() => investments.result.current.navigation.onStep(1));
    expect(dates(netWorth.result.current.range)).toEqual(["2025-10-01", "2026-03-31"]);
    act(() => netWorth.result.current.navigation.onStep(1));
    expect(investments.result.current.code).toBe("6M");
  });

  it("persists and synchronizes a stepped year, then clears back to the previous preset", () => {
    const investments = renderHook(() => useDashboardPeriod(TODAY));
    const netWorth = renderHook(() => useDashboardPeriod(TODAY));
    act(() => investments.result.current.selectPreset("6M"));
    act(() => investments.result.current.selectYear(2025));
    expect(netWorth.result.current.customYear).toBe(2025);
    expect(netWorth.result.current.code).toBeNull();
    expect(netWorth.result.current.navigation?.nextDisabled).toBe(true);
    act(() => netWorth.result.current.navigation?.onStep(-1));
    expect(investments.result.current.customYear).toBe(2024);
    expect(dates(investments.result.current.range)).toEqual(["2024-01-01", "2024-12-31"]);
    investments.unmount();
    const reopened = renderHook(() => useDashboardPeriod("2027-01-01"));
    expect(reopened.result.current.customYear).toBe(2024);
    act(() => reopened.result.current.selectYear(null));
    expect(netWorth.result.current.code).toBe("6M");
    expect(netWorth.result.current.navigation.previousDisabled).toBe(false);
    expect(netWorth.result.current.navigation.nextDisabled).toBe(true);
  });

  it("keeps each tab's own preset until a period is picked", () => {
    localStorage.setItem("networth-interval", JSON.stringify("ALL"));
    const investments = renderHook(() => useDashboardPeriod(TODAY));
    const netWorth = renderHook(() =>
      useDashboardPeriod(TODAY, { key: "networth-interval", initial: "ALL" }),
    );
    expect(investments.result.current.code).toBe("3M");
    expect(netWorth.result.current.code).toBe("ALL");

    act(() => investments.result.current.selectPreset("6M"));
    expect(netWorth.result.current.code).toBe("6M");
  });

  it("shares a picked month as a custom range and restores the last preset on clear", () => {
    const investments = renderHook(() => useDashboardPeriod(TODAY));
    const netWorth = renderHook(() =>
      useDashboardPeriod(TODAY, { key: "networth-interval", initial: "ALL" }),
    );
    act(() => investments.result.current.selectPreset("1Y"));
    act(() => netWorth.result.current.selectMonth("2026-02"));

    expect(investments.result.current.code).toBeNull();
    expect(investments.result.current.customMonth).toBe("2026-02");
    expect(dates(investments.result.current.range)).toEqual(["2026-02-01", "2026-02-28"]);

    act(() => investments.result.current.selectMonth(null));
    expect(netWorth.result.current.code).toBe("1Y");
  });

  it.each(["dashboard-interval", "networth-interval"])(
    "keeps calendar-month navigation bounded to completed months on %s",
    (key) => {
      const { result } = renderHook(() => useDashboardPeriod(TODAY, { key, initial: "3M" }));
      act(() => result.current.selectMonth("2026-02"));
      expect(result.current.navigation.nextDisabled).toBe(true);
      act(() => result.current.navigation.onStep(1));
      expect(result.current.customMonth).toBe("2026-02");
      act(() => result.current.navigation.onStep(-1));
      expect(result.current.customMonth).toBe("2026-01");
      expect(result.current.navigation.nextDisabled).toBe(false);
      act(() => result.current.navigation.onStep(1));
      expect(result.current.customMonth).toBe("2026-02");
      expect(result.current.navigation.nextDisabled).toBe(true);
    },
  );

  it("clears a custom period back to the preset this tab showed", () => {
    // An old Investments preset is stored, but Net Worth shows its own ALL.
    localStorage.setItem("dashboard-interval", JSON.stringify("3M"));
    localStorage.setItem("networth-interval", JSON.stringify("ALL"));
    const netWorth = renderHook(() =>
      useDashboardPeriod(TODAY, { key: "networth-interval", initial: "ALL" }),
    );
    act(() => netWorth.result.current.selectMonth("2026-02"));
    act(() => netWorth.result.current.selectMonth(null));
    expect(netWorth.result.current.code).toBe("ALL");
  });

  it("highlights a preset when a picked range matches it", () => {
    const { result } = renderHook(() => useDashboardPeriod(TODAY));
    act(() =>
      result.current.selectRange({ from: new Date(2026, 2, 24), to: new Date(2026, 2, 31) }),
    );
    expect(result.current.code).toBe("1W");
    expect(result.current.customRange).toBeUndefined();

    act(() =>
      result.current.selectRange({ from: new Date(2026, 0, 5), to: new Date(2026, 1, 10) }),
    );
    expect(result.current.code).toBeNull();
    expect(dates(result.current.customRange)).toEqual(["2026-01-05", "2026-02-10"]);
  });

  it("follows a Spending pick", () => {
    localStorage.setItem(
      "dashboard-period",
      JSON.stringify({ kind: "spending", code: "LAST_MONTH" }),
    );
    const { result } = renderHook(() => useDashboardPeriod(TODAY));
    expect(result.current.code).toBe("1M");
  });
});
