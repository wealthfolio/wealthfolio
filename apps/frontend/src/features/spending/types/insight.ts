import type { BudgetGroup } from "./budget";

export type CompareMode = "prior" | "year_over_year";

export interface SpendingInsightRequest {
  startDate: string; // RFC3339, inclusive
  endDate: string; // RFC3339, inclusive
  accountIds?: string[];
  compare?: CompareMode;
}

export interface PeriodMeta {
  start: string; // RFC3339
  end: string; // RFC3339
  /** `YYYY-MM` keys covering [start, end], inclusive on both bounds. */
  months: string[];
  dayCount: number;
}

export type AmountSource = "default" | "override" | "prorated" | "prorated_override";

export interface MonthlyAmount {
  month: string; // YYYY-MM
  /** Effective amount contributed to the period total (post-proration). */
  amount: number;
  /** Full monthly budget for that month (un-prorated). */
  fullMonthlyAmount: number;
  source: AmountSource;
}

export interface AmountBlock {
  total: number;
  monthlyBreakdown: MonthlyAmount[];
}

export type HealthStatus = "on_track" | "approaching" | "over" | "cashflow_negative";

export interface PaceState {
  /** Trailing-7-day average daily spend. */
  dailyAvg: number;
  daysElapsed: number;
  daysRemaining: number;
  /** spent_to_date + dailyAvg × daysRemaining. */
  projectedSpend: number;
  /** budget × daysElapsed / totalDays. */
  expectedSpendToDate: number;
}

export interface Headline {
  spent: number;
  income: number;
  netCashflow: number;
  /** Σ groups.budget + Σ groups.buffer. */
  budget: number;
  remaining: number;
  priorSpent: number;
  /** `null` when prior_spent is zero — UI renders "—". */
  deltaVsPriorPct: number | null;
  pace: PaceState;
  status: HealthStatus;
}

export interface CategoryInsight {
  taxonomyId: string;
  categoryId: string;
  name: string;
  color: string | null;
  icon: string | null;
  parentId: string | null;
  budget: AmountBlock;
  spent: number;
  priorSpent: number;
  deltaVsPriorPct: number | null;
  remaining: number;
  overspent: boolean;
  pctOfTotalSpent: number | null;
  txnCount: number;
}

export interface GroupInsight {
  group: BudgetGroup;
  budget: AmountBlock;
  buffer: AmountBlock;
  spent: number;
  priorSpent: number;
  deltaVsPriorPct: number | null;
  remaining: number;
  overspent: boolean;
  pctOfTotalSpent: number | null;
  categories: CategoryInsight[];
}

export interface UncategorizedBucket {
  spent: number;
  priorSpent: number;
  deltaVsPriorPct: number | null;
  pctOfTotalSpent: number | null;
  txnCount: number;
}

export interface DayBucket {
  date: string; // YYYY-MM-DD
  spent: number;
  income: number;
}

export interface DayCategoryBucket {
  date: string; // YYYY-MM-DD
  taxonomyId: string;
  categoryId: string;
  amount: number;
  count: number;
}

export interface MonthBucket {
  month: string; // YYYY-MM
  spent: number;
  income: number;
}

export interface SpendingInsight {
  period: PeriodMeta;
  prior: PeriodMeta;
  /**
   * Report/target currency. All monetary fields below are denominated in
   * this currency: per-activity native amounts are FX-converted at
   * `period.end` (snapshot-date convention, matches net_worth + holdings).
   */
  currency: string;
  /**
   * Currencies (other than `currency`) observed on contributing activities,
   * sorted alphabetically. Empty when every counted activity was already
   * in `currency`. UI can show a "totals FX-converted using rates from
   * <period.end>" notice when this is non-empty.
   */
  foreignCurrencies?: string[];
  /**
   * Per-currency outflow totals in activities' *native* units, before FX.
   * Lets the UI render "source: €1,200 EUR" hints for single-foreign-
   * currency reports, or a per-currency breakdown for multi-currency
   * ones. Excludes `currency`.
   */
  nativeOutflowByCurrency?: Record<string, number>;
  headline: Headline;
  groups: GroupInsight[];
  uncategorized: UncategorizedBucket;
  byDay: DayBucket[];
  byDayByCategory: DayCategoryBucket[];
  byMonth: MonthBucket[];
}
