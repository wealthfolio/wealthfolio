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
