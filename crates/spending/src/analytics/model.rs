use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    /// RFC3339 inclusive
    pub start_date: String,
    /// RFC3339 inclusive
    pub end_date: String,
    /// Optional account filter (defaults to all spending accounts).
    pub account_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSummary {
    /// Sum of DEPOSIT/TRANSFER_IN/INTEREST amounts (absolute)
    pub income: f64,
    /// Sum of WITHDRAWAL/TRANSFER_OUT/FEE amounts (absolute)
    pub outflow: f64,
    /// income - outflow
    pub net: f64,
    /// Count of activities included
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryBreakdownRow {
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: f64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayBucket {
    /// "YYYY-MM-DD"
    pub date: String,
    pub income: f64,
    pub outflow: f64,
}

/// Per-day, per-category spending row.
///
/// Powers daily-granularity sparklines (e.g., the 1-month Categories tab) and
/// any other widget that needs to know "how much was spent on X on day Y".
/// The frontend rolls up to top-level categories as needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCategoryBucket {
    /// "YYYY-MM-DD"
    pub date: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: f64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyReport {
    pub current: PeriodSummary,
    pub prior: PeriodSummary,
    pub spending_breakdown: Vec<CategoryBreakdownRow>,
    pub income_breakdown: Vec<CategoryBreakdownRow>,
    pub by_day: Vec<DayBucket>,
    pub by_day_by_category: Vec<DayCategoryBucket>,
}

// ----------------- SpendingSummary (PR-style; per-period rollup) -----------------

/// Per-category spending aggregate. `category_id`=None → uncategorized.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpending {
    pub category_id: Option<String>,
    pub category_name: String,
    pub color: Option<String>,
    pub amount: f64,
    pub transaction_count: usize,
}

/// Per-subcategory aggregate carrying a back-pointer to the parent category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubcategorySpending {
    pub subcategory_id: Option<String>,
    pub subcategory_name: String,
    pub category_id: Option<String>,
    pub category_name: String,
    pub color: Option<String>,
    pub amount: f64,
    pub transaction_count: usize,
}

// ----------------- EventSpendingSummary (per-event rollup with date filter) -----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCategorySpending {
    pub category_id: Option<String>,
    pub category_name: String,
    pub color: Option<String>,
    pub amount: f64,
    pub transaction_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSpendingSummary {
    pub event_id: String,
    pub event_name: String,
    pub event_type_id: String,
    pub event_type_name: String,
    pub event_type_color: Option<String>,
    pub start_date: String,
    pub end_date: String,
    pub total_spending: f64,
    pub transaction_count: usize,
    pub currency: String,
    /// category_id (or "uncategorized") → row
    pub by_category: HashMap<String, EventCategorySpending>,
    /// "YYYY-MM-DD" → spend on that day
    pub daily_spending: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummariesRequest {
    /// RFC3339; if omitted, no lower bound
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Defaults to base currency (set by caller)
    pub currency: Option<String>,
}

/// One spending summary for a named period (TOTAL, YTD, LAST_YEAR, TWO_YEARS_AGO).
/// Mirrors the shape consumed by the PR's spending-page.tsx.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingSummary {
    pub period: String,
    /// month "YYYY-MM" → total spend (outflow only)
    pub by_month: HashMap<String, f64>,
    /// category_id → CategorySpending (key "uncategorized" when category_id is None)
    pub by_category: HashMap<String, CategorySpending>,
    pub by_subcategory: HashMap<String, SubcategorySpending>,
    /// account_id → spend
    pub by_account: HashMap<String, f64>,
    /// month → category_id → amount (stacked-bar)
    pub by_month_by_category: HashMap<String, HashMap<String, f64>>,
    pub by_month_by_subcategory: HashMap<String, HashMap<String, f64>>,
    pub total_spending: f64,
    pub currency: String,
    pub monthly_average: f64,
    pub transaction_count: usize,
    pub yoy_growth: Option<f64>,
}
