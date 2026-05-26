/** Period selector options on the Spending dashboard tab. */
export type DashboardPeriod = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "ALL";

export const DASHBOARD_PERIODS: DashboardPeriod[] = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
  "5Y",
  "ALL",
];

export interface PeriodRange {
  start: Date;
  end: Date;
  /** Number of days the period nominally covers (used for bar-chart x-axis density). */
  days: number;
  /** Human label for axis subtitle. */
  axis: "day" | "month";
}

export function periodToRange(period: DashboardPeriod): PeriodRange {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (period) {
    case "1D": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 1, axis: "day" };
    }
    case "1W": {
      const start = new Date(now);
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 7, axis: "day" };
    }
    case "1M": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return { start, end: monthEnd, days: monthEnd.getDate(), axis: "day" };
    }
    case "3M": {
      const start = new Date(now);
      start.setMonth(now.getMonth() - 3);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 90, axis: "day" };
    }
    case "6M": {
      const start = new Date(now);
      start.setMonth(now.getMonth() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 180, axis: "month" };
    }
    case "YTD": {
      const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      return {
        start,
        end,
        days: Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
        axis: "month",
      };
    }
    case "1Y": {
      const start = new Date(now);
      start.setFullYear(now.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 365, axis: "month" };
    }
    case "5Y": {
      const start = new Date(now);
      start.setFullYear(now.getFullYear() - 5);
      start.setHours(0, 0, 0, 0);
      return { start, end, days: 365 * 5, axis: "month" };
    }
    case "ALL":
    default: {
      const start = new Date(2000, 0, 1);
      return { start, end, days: 9999, axis: "month" };
    }
  }
}

/** Returns the equally-sized prior period range (used for vs-last-month delta). */
export function priorRange(range: PeriodRange): PeriodRange {
  const span = range.end.getTime() - range.start.getTime();
  const priorEnd = new Date(range.start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - span);
  return {
    start: priorStart,
    end: priorEnd,
    days: range.days,
    axis: range.axis,
  };
}

export function rangeToReportRequest(range: PeriodRange) {
  return {
    startDate: range.start.toISOString(),
    endDate: range.end.toISOString(),
  };
}

export function periodLabel(period: DashboardPeriod): string {
  switch (period) {
    case "1D":
      return "today";
    case "1W":
      return "last 7 days";
    case "1M":
      return "this month";
    case "3M":
      return "last 3 months";
    case "6M":
      return "last 6 months";
    case "YTD":
      return "year to date";
    case "1Y":
      return "last year";
    case "5Y":
      return "last 5 years";
    case "ALL":
      return "all time";
  }
}
