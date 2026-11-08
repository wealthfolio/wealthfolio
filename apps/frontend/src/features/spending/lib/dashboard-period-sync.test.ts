import { describe, expect, it } from "vitest";

import { formatDateISO, parseLocalDate } from "@/lib/utils";

import {
  pickForPortfolioRange,
  portfolioViewForPick,
  spendingViewForPick,
  stepCalendarPick,
  stepDashboardPeriod,
  getPresetWindow,
  spendingPeriodRange,
  type DashboardPeriodPick,
} from "./dashboard-period-sync";

const TODAY = "2026-03-31";

function isoRange(range: { from?: Date; to?: Date } | undefined) {
  return range?.from && range.to ? [formatDateISO(range.from), formatDateISO(range.to)] : null;
}

function portfolio(pick: DashboardPeriodPick) {
  const view = portfolioViewForPick(pick, TODAY);
  return view && { code: view.code, range: isoRange(view.range) };
}

function spending(pick: DashboardPeriodPick) {
  const view = spendingViewForPick(pick, TODAY);
  return view?.kind === "range" ? { kind: "range", range: isoRange(view.range) } : view;
}

describe("dashboard period sync", () => {
  it("navigates spending weeks without overlapping days and restores the live preset", () => {
    const original: DashboardPeriodPick = { kind: "spending", code: "1W" };
    expect(isoRange(spendingPeriodRange("1W", "2026-03-10"))).toEqual(["2026-03-04", "2026-03-10"]);
    const prior = stepDashboardPeriod(original, -1, "2026-03-10")!;
    expect(prior).toMatchObject({ from: "2026-02-25", to: "2026-03-03" });
    const older = stepDashboardPeriod(prior, -1, "2026-03-10")!;
    expect(older).toMatchObject({ from: "2026-02-18", to: "2026-02-24" });
    expect(stepDashboardPeriod(older, 1, "2026-03-10")).toEqual(prior);
    expect(stepDashboardPeriod(prior, 1, "2026-03-11")).toEqual(original);
    expect(stepDashboardPeriod(original, 1, "2026-03-10")).toBeNull();
  });
  it.each([
    ["3M", "2026-04-01", "2026-06-30"],
    ["6M", "2025-10-01", "2026-03-31"],
    ["1Y", "2024-10-01", "2025-09-30"],
  ] as const)("keeps Insights %s on adjacent full calendar-month blocks", (code, from, to) => {
    const original: DashboardPeriodPick = { kind: "spending", code };
    const prior = stepDashboardPeriod(original, -1, "2026-09-15", "calendar")!;
    expect(isoRange(portfolioViewForPick(prior, "2026-09-15")?.range)).toEqual([from, to]);
    expect(getPresetWindow(prior)).toEqual({
      preset: original,
      anchor: "2026-09-15",
      offset: -1,
      alignment: "calendar",
    });
    // Other tabs retain the alignment without supplying the Insights option.
    const older = stepDashboardPeriod(prior, -1, "2026-09-15")!;
    expect(stepDashboardPeriod(older, 1, "2026-09-15")).toEqual(prior);
    expect(stepDashboardPeriod(prior, 1, "2026-09-16")).toEqual(original);
  });

  it("retains rolling metadata when Insights continues a dashboard window", () => {
    const prior = stepDashboardPeriod({ kind: "spending", code: "6M" }, -1, TODAY)!;
    expect(stepDashboardPeriod(prior, -1, TODAY, "calendar")).toEqual(
      stepDashboardPeriod(prior, -1, TODAY),
    );
  });

  it.each([
    ["1D", "2026-03-29", "2026-03-30"],
    ["1W", "2026-03-17", "2026-03-24"],
    ["1M", "2026-01-31", "2026-02-28"],
    ["3M", "2025-09-30", "2025-12-31"],
    ["6M", "2025-03-31", "2025-09-30"],
    ["YTD", "2025-01-01", "2025-03-31"],
    ["1Y", "2024-03-31", "2025-03-31"],
    ["5Y", "2016-03-31", "2021-03-31"],
  ] as const)(
    "navigates %s by the selected interval and returns to the live preset",
    (code, from, to) => {
      const original: DashboardPeriodPick = { kind: "portfolio", code };
      const prior = stepDashboardPeriod(original, -1, TODAY)!;
      expect(portfolioViewForPick(prior, TODAY)?.range).toEqual({
        from: parseLocalDate(from),
        to: parseLocalDate(to),
      });
      expect(getPresetWindow(prior)).toEqual({ preset: original, anchor: TODAY, offset: -1 });
      const older = stepDashboardPeriod(prior, -1, TODAY)!;
      expect(stepDashboardPeriod(older, 1, TODAY)).toEqual(prior);
      expect(stepDashboardPeriod(prior, 1, "2026-04-01")).toEqual(original);
      expect(stepDashboardPeriod(original, 1, TODAY)).toBeNull();
    },
  );

  it.each([
    ["3M", "2025-09-30", "2025-12-31"],
    ["6M", "2025-03-31", "2025-09-30"],
    ["YTD", "2025-01-01", "2025-03-31"],
    ["1Y", "2024-03-31", "2025-03-31"],
  ] as const)(
    "keeps Spending %s dates and interval identity across navigation",
    (code, from, to) => {
      const original: DashboardPeriodPick = { kind: "spending", code };
      const prior = stepDashboardPeriod(original, -1, TODAY)!;
      const view = spendingViewForPick(prior, TODAY);
      expect(view).toMatchObject({
        kind: "range",
        range: { from: parseLocalDate(from), to: parseLocalDate(to) },
        preset: original,
      });
      expect(stepDashboardPeriod(prior, 1, TODAY)).toEqual(original);
    },
  );

  it("retains leap-day anchors over repeated month and year steps", () => {
    const start: DashboardPeriodPick = { kind: "portfolio", code: "1M" };
    const previous = stepDashboardPeriod(start, -1, "2024-03-31")!;
    expect(isoRange(portfolioViewForPick(previous, "2024-03-31")?.range)).toEqual([
      "2024-01-31",
      "2024-02-29",
    ]);
    const older = stepDashboardPeriod(previous, -1, "2024-03-31")!;
    expect(isoRange(portfolioViewForPick(older, "2024-03-31")?.range)).toEqual([
      "2023-12-31",
      "2024-01-31",
    ]);
    expect(stepDashboardPeriod(older, 1, "2024-03-31")).toEqual(previous);
    expect(isoRange(spendingPeriodRange("LAST_MONTH", "2024-03-31"))).toEqual([
      "2024-02-01",
      "2024-02-29",
    ]);
  });

  it("replaces the Last month shortcut with full calendar-month navigation and a return to This month", () => {
    const prior = stepDashboardPeriod({ kind: "spending", code: "MTD" }, -1, "2026-09-15");
    expect(prior).toEqual({ kind: "month", monthKey: "2026-08" });
    expect(spendingViewForPick(prior!, "2026-09-15")).toEqual({
      kind: "month",
      monthKey: "2026-08",
    });
    expect(stepDashboardPeriod(prior!, 1, "2026-09-15")).toEqual({ kind: "spending", code: "MTD" });
    expect(stepDashboardPeriod({ kind: "spending", code: "LAST_MONTH" }, -1, "2026-09-15")).toEqual(
      { kind: "month", monthKey: "2026-07" },
    );
    expect(stepDashboardPeriod({ kind: "spending", code: "LAST_MONTH" }, 1, "2026-09-15")).toEqual({
      kind: "spending",
      code: "MTD",
    });
    expect(stepDashboardPeriod({ kind: "spending", code: "MTD" }, 1, "2026-09-15")).toBeNull();
  });

  it("keeps ALL and manual ranges unstepped, respects the date floor, and rejects malformed metadata", () => {
    expect(stepDashboardPeriod({ kind: "portfolio", code: "ALL" }, -1, TODAY)).toBeNull();
    expect(
      stepDashboardPeriod({ kind: "range", from: "2025-01-01", to: "2025-03-01" }, -1, TODAY),
    ).toBeNull();
    expect(stepDashboardPeriod({ kind: "portfolio", code: "5Y" }, -1, "1975-01-01")).toBeNull();
    for (const presetWindow of [
      null,
      {},
      { preset: { kind: "portfolio", code: "6M" }, anchor: "bad", offset: -1 },
      { preset: { kind: "portfolio", code: "ALL" }, anchor: TODAY, offset: -1 },
      { preset: { kind: "portfolio", code: "6M" }, anchor: TODAY, offset: -1e15 },
      { preset: { kind: "spending", code: "6M" }, anchor: TODAY, offset: -1, alignment: "bad" },
      {
        preset: { kind: "portfolio", code: "6M" },
        anchor: TODAY,
        offset: -1,
        alignment: "calendar",
      },
    ]) {
      const pick = {
        kind: "range",
        from: "2025-03-31",
        to: "2025-09-30",
        presetWindow,
      } as unknown as DashboardPeriodPick;
      expect(getPresetWindow(pick)).toBeUndefined();
      expect(stepDashboardPeriod(pick, -1, TODAY)).toBeNull();
      expect(portfolioViewForPick(pick, TODAY)?.range).toBeDefined();
    }
  });
  it("keeps every supported portfolio preset readable from the shared preference", () => {
    const codes = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "5Y", "ALL"] as const;
    for (const code of codes) {
      expect(portfolioViewForPick({ kind: "portfolio", code }, TODAY)?.code).toBe(code);
    }
  });
  it("shares calendar-year identity without converting it to a relative preset", () => {
    const pick: DashboardPeriodPick = { kind: "year", year: 2025 };
    expect(portfolio(pick)).toEqual({ code: null, range: ["2025-01-01", "2025-12-31"] });
    expect(spending(pick)).toEqual(pick);
    expect(portfolioViewForPick(pick, "2027-01-01")?.range).toEqual(
      portfolioViewForPick(pick, "2026-12-31")?.range,
    );
    expect(portfolioViewForPick({ kind: "year", year: 2026 }, TODAY)).toBeNull();
    expect(
      spendingViewForPick({ kind: "year", year: "bad" } as unknown as DashboardPeriodPick, TODAY),
    ).toBeNull();
  });

  it("steps only explicit calendar units, across leap years and month-end boundaries", () => {
    expect(stepCalendarPick({ kind: "year", year: 2025 }, -1, TODAY)).toEqual({
      kind: "year",
      year: 2024,
    });
    expect(stepCalendarPick({ kind: "year", year: 2025 }, 1, TODAY)).toBeNull();
    expect(stepCalendarPick({ kind: "year", year: 1970 }, -1, TODAY)).toBeNull();
    expect(stepCalendarPick({ kind: "month", monthKey: "2024-03" }, -1, TODAY)).toEqual({
      kind: "month",
      monthKey: "2024-02",
    });
    expect(stepCalendarPick({ kind: "month", monthKey: "2025-12" }, 1, TODAY)).toEqual({
      kind: "month",
      monthKey: "2026-01",
    });
    expect(stepCalendarPick({ kind: "month", monthKey: "2026-02" }, 1, TODAY)).toBeNull();
    expect(stepCalendarPick({ kind: "month", monthKey: "1970-01" }, -1, TODAY)).toBeNull();
    expect(stepCalendarPick({ kind: "portfolio", code: "1Y" }, -1, TODAY)).toBeNull();
    expect(
      stepCalendarPick({ kind: "range", from: "2025-01-01", to: "2025-12-31" }, -1, TODAY),
    ).toBeNull();
  });
  it("keeps the presets both selectors share", () => {
    for (const code of ["3M", "6M", "YTD", "1Y"] as const) {
      expect(spending({ kind: "portfolio", code })).toEqual({ kind: "period", code });
      expect(portfolio({ kind: "spending", code })?.code).toBe(code);
    }
  });

  it("gives Spending the rolling dates of presets it lacks", () => {
    expect(spending({ kind: "portfolio", code: "1D" })).toEqual({
      kind: "range",
      range: ["2026-03-30", "2026-03-31"],
    });
    expect(spending({ kind: "portfolio", code: "1W" })).toEqual({
      kind: "period",
      code: "1W",
    });
    // Month-end clamps the same way the portfolio chart does.
    expect(spending({ kind: "portfolio", code: "1M" })).toEqual({
      kind: "range",
      range: ["2026-02-28", "2026-03-31"],
    });
    expect(spending({ kind: "portfolio", code: "5Y" })).toEqual({
      kind: "range",
      range: ["2021-03-31", "2026-03-31"],
    });
  });

  it("leaves Spending on its own period for ALL", () => {
    expect(spending({ kind: "portfolio", code: "ALL" })).toBeNull();
  });

  it("moves Investments and Net Worth to 1M for calendar-month presets", () => {
    expect(portfolio({ kind: "spending", code: "MTD" })).toEqual({
      code: "1M",
      range: ["2026-02-28", "2026-03-31"],
    });
    expect(portfolio({ kind: "spending", code: "LAST_MONTH" })?.code).toBe("1M");
  });

  it("shows a picked month as that month's dates everywhere", () => {
    const pick: DashboardPeriodPick = { kind: "month", monthKey: "2026-02" };
    expect(portfolio(pick)).toEqual({ code: null, range: ["2026-02-01", "2026-02-28"] });
    expect(spending(pick)).toEqual({ kind: "month", monthKey: "2026-02" });
  });

  it("shows a picked range as the same dates everywhere", () => {
    const pick: DashboardPeriodPick = { kind: "range", from: "2026-01-05", to: "2026-02-10" };
    expect(portfolio(pick)).toEqual({ code: null, range: ["2026-01-05", "2026-02-10"] });
    expect(spending(pick)).toEqual({ kind: "range", range: ["2026-01-05", "2026-02-10"] });
  });

  it("highlights the preset whose dates a picked range matches", () => {
    expect(portfolio({ kind: "range", from: "2026-03-24", to: "2026-03-31" })?.code).toBe("1W");
    expect(portfolio({ kind: "range", from: "2026-01-01", to: "2026-03-31" })?.code).toBe("YTD");
  });

  it("turns a Performance range into a preset when the dates match one", () => {
    const day = (iso: string) => parseLocalDate(iso);
    expect(
      pickForPortfolioRange({ from: day("2025-12-31"), to: day("2026-03-31") }, TODAY),
    ).toEqual({ kind: "portfolio", code: "3M" });
    expect(
      pickForPortfolioRange({ from: new Date(1970, 0, 1), to: day("2026-03-31") }, TODAY),
    ).toEqual({ kind: "portfolio", code: "ALL" });
    // 3Y exists only on Performance, so it travels as dates.
    expect(
      pickForPortfolioRange({ from: day("2023-03-31"), to: day("2026-03-31") }, TODAY),
    ).toEqual({ kind: "range", from: "2023-03-31", to: "2026-03-31" });
    expect(pickForPortfolioRange({ from: day("2026-03-01"), to: undefined }, TODAY)).toBeNull();
  });

  it("ignores unreadable picks so each tab falls back to its own period", () => {
    expect(portfolio({ kind: "month", monthKey: "2026-13" })).toBeNull();
    expect(portfolio({ kind: "range", from: "2026-03-10", to: "2026-03-01" })).toBeNull();
    expect(spending({ kind: "range", from: "not-a-date", to: "2026-03-01" })).toBeNull();
  });
});
