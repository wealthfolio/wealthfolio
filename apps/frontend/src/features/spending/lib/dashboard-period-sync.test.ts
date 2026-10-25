import { describe, expect, it } from "vitest";

import { formatDateISO } from "@/lib/utils";

import {
  portfolioViewForPick,
  spendingViewForPick,
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

  it("ignores unreadable picks so each tab falls back to its own period", () => {
    expect(portfolio({ kind: "month", monthKey: "2026-13" })).toBeNull();
    expect(portfolio({ kind: "range", from: "2026-03-10", to: "2026-03-01" })).toBeNull();
    expect(spending({ kind: "range", from: "not-a-date", to: "2026-03-01" })).toBeNull();
  });
});
