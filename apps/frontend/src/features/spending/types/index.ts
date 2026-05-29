// Spending settings (toggle + opted-in account list)
export interface SpendingSettings {
  enabled: boolean;
  accountIds: string[];
}

export interface SpendingSettingsUpdate {
  enabled?: boolean;
  accountIds?: string[];
}

// SpendingSummary — multi-period rollup consumed by the spending overview UI
export type SpendingPeriod = "TOTAL" | "YTD" | "LAST_YEAR" | "TWO_YEARS_AGO";

export interface CategorySpending {
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  amount: number;
  transactionCount: number;
}

export interface SubcategorySpending {
  subcategoryId: string | null;
  subcategoryName: string;
  categoryId: string | null;
  categoryName: string;
  color: string | null;
  amount: number;
  transactionCount: number;
}

export interface SpendingSummary {
  period: string;
  byMonth: Record<string, number>;
  byCategory: Record<string, CategorySpending>;
  bySubcategory: Record<string, SubcategorySpending>;
  byAccount: Record<string, number>;
  byMonthByCategory: Record<string, Record<string, number>>;
  byMonthBySubcategory: Record<string, Record<string, number>>;
  totalSpending: number;
  currency: string;
  monthlyAverage: number;
  transactionCount: number;
  yoyGrowth: number | null;
}
