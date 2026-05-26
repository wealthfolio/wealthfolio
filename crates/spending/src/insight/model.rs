use serde::{Deserialize, Serialize};

use crate::budget::BudgetGroup;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingInsightRequest {
    /// RFC3339, inclusive.
    pub start_date: String,
    /// RFC3339, inclusive.
    pub end_date: String,
    /// Defaults to the user's opted-in spending accounts.
    pub account_ids: Option<Vec<String>>,
    /// Defaults to `Prior` (matched-size window immediately preceding).
    pub compare: Option<CompareMode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CompareMode {
    #[default]
    Prior,
    YearOverYear,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodMeta {
    /// RFC3339
    pub start: String,
    /// RFC3339
    pub end: String,
    /// `YYYY-MM` keys covering [start, end], inclusive on both bounds.
    pub months: Vec<String>,
    pub day_count: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AmountSource {
    Default,
    Override,
    Prorated,
    ProratedOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyAmount {
    /// `YYYY-MM`
    pub month: String,
    /// Effective amount contributed by this month to the period total
    /// (already prorated if the window only covers part of the month).
    pub amount: f64,
    /// Full monthly budget for that month (un-prorated). Lets the UI show
    /// "$1000 monthly budget" alongside the prorated contribution.
    pub full_monthly_amount: f64,
    pub source: AmountSource,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmountBlock {
    /// Sum of `monthly_breakdown[].amount`.
    pub total: f64,
    pub monthly_breakdown: Vec<MonthlyAmount>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    OnTrack,
    Approaching,
    Over,
    CashflowNegative,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaceState {
    /// Trailing-7-day average spend per day.
    pub daily_avg: f64,
    /// Number of days elapsed within the window (clamped to window length).
    pub days_elapsed: i64,
    /// Number of days remaining in the window (0 if `end <= now`).
    pub days_remaining: i64,
    /// Pace-implied projection for the full window:
    ///   spent_to_date + (daily_avg × days_remaining).
    /// For closed windows, equals `spent_to_date`.
    pub projected_spend: f64,
    /// Expected pace at this point in the window: `budget × (days_elapsed / total_days)`.
    pub expected_spend_to_date: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Headline {
    pub spent: f64,
    pub income: f64,
    pub net_cashflow: f64,
    /// Total budget for the window: Σ groups[i].budget.total + Σ groups[i].buffer.total.
    pub budget: f64,
    pub remaining: f64,
    pub prior_spent: f64,
    /// `None` when prior_spent is zero (UI renders em-dash).
    pub delta_vs_prior_pct: Option<f64>,
    pub pace: PaceState,
    pub status: HealthStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInsight {
    pub taxonomy_id: String,
    pub category_id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub parent_id: Option<String>,
    /// Category-level budget over the window. Does not include any group buffer.
    pub budget: AmountBlock,
    pub spent: f64,
    pub prior_spent: f64,
    pub delta_vs_prior_pct: Option<f64>,
    pub remaining: f64,
    pub overspent: bool,
    /// Share of headline.spent (None when total is zero).
    pub pct_of_total_spent: Option<f64>,
    pub txn_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInsight {
    pub group: BudgetGroup,
    /// Sum of category-level budgets within the group.
    pub budget: AmountBlock,
    /// Group buffer target fanned out per month.
    pub buffer: AmountBlock,
    pub spent: f64,
    pub prior_spent: f64,
    pub delta_vs_prior_pct: Option<f64>,
    /// `budget.total + buffer.total - spent`.
    pub remaining: f64,
    pub overspent: bool,
    pub pct_of_total_spent: Option<f64>,
    pub categories: Vec<CategoryInsight>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UncategorizedBucket {
    pub spent: f64,
    pub prior_spent: f64,
    pub delta_vs_prior_pct: Option<f64>,
    pub pct_of_total_spent: Option<f64>,
    pub txn_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayBucket {
    /// `YYYY-MM-DD`
    pub date: String,
    pub spent: f64,
    pub income: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCategoryBucket {
    /// `YYYY-MM-DD`
    pub date: String,
    pub taxonomy_id: String,
    pub category_id: String,
    pub amount: f64,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthBucket {
    /// `YYYY-MM`
    pub month: String,
    pub spent: f64,
    pub income: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendingInsight {
    pub period: PeriodMeta,
    pub prior: PeriodMeta,
    /// Target/report currency. All monetary fields below are denominated in
    /// this currency (FX-converted from native at `period.end`, matching
    /// net_worth's snapshot-date convention).
    pub currency: String,
    /// Currencies (other than `currency`) observed on contributing activities
    /// in the current window. Sorted alphabetically. Empty when every counted
    /// activity was already in `currency`.
    #[serde(default)]
    pub foreign_currencies: Vec<String>,
    /// Per-currency outflow totals in activities' *native* units, before FX.
    /// Lets the UI surface a "source: €1,200 EUR" hint for single-foreign-
    /// currency reports and a breakdown for multi-currency ones. Excludes
    /// `currency` itself.
    #[serde(default)]
    pub native_outflow_by_currency: std::collections::HashMap<String, f64>,
    pub headline: Headline,
    pub groups: Vec<GroupInsight>,
    pub uncategorized: UncategorizedBucket,
    pub by_day: Vec<DayBucket>,
    pub by_day_by_category: Vec<DayCategoryBucket>,
    pub by_month: Vec<MonthBucket>,
}
