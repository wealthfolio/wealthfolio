import { describe, expect, it } from "vitest";

import { formatDateISO, parseLocalDate } from "@/lib/utils";

import {
  pickForPortfolioRange,
  portfolioViewForPick,
  spendingViewForPick,
  stepCalendarPick,
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
      kind: "range",
      range: ["2026-03-24", "2026-03-31"],
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
