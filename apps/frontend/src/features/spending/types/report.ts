export interface PeriodSummary {
  income: number;
  outflow: number;
  net: number;
  count: number;
}

export interface CategoryBreakdownRow {
  taxonomyId: string;
  categoryId: string;
  amount: number;
  count: number;
}

export interface DayBucket {
  date: string;
  income: number;
  outflow: number;
}

/** Per-day, per-category amount — feeds daily-granularity sparklines and similar widgets. */
export interface DayCategoryBucket {
  date: string;
  taxonomyId: string;
  categoryId: string;
  amount: number;
  count: number;
}

export interface MonthlyReport {
  current: PeriodSummary;
  prior: PeriodSummary;
  spendingBreakdown: CategoryBreakdownRow[];
  incomeBreakdown: CategoryBreakdownRow[];
  byDay: DayBucket[];
  byDayByCategory: DayCategoryBucket[];
}

export interface MonthBucket {
  /** ISO YYYY-MM-01, anchors the month for charting. */
  iso: string;
  /** Short month label, e.g. "May". */
  label: string;
  /** Resolved monthly report (undefined while in flight). */
  report: MonthlyReport | undefined;
  isLoading: boolean;
}

export interface ReportRequest {
  startDate: string;
  endDate: string;
  accountIds?: string[];
}
