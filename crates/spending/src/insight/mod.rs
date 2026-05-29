//! Insight — single source of truth for the Spending Insight dashboard.
//!
//! Returns a reconciled tree (`SpendingInsight`) covering an arbitrary window:
//! budgets fanned out across months (with prorated partial months), spend
//! aggregated against the same window, an uncategorized bucket, prior-period
//! comparison, trailing-7-day pace, and a derived health status.
//!
//! The four reconciliation invariants — `headline.spent == Σ groups.spent +
//! uncategorized.spent`, `headline.budget == Σ groups.budget + Σ groups.buffer`,
//! `groups[i].spent == Σ groups[i].categories.spent`, `groups[i].budget ==
//! Σ groups[i].categories.budget` — are asserted in tests and as
//! `debug_assert!` calls inside `InsightService::compute`.

pub mod model;
pub mod service;

pub use model::{
    AmountBlock, AmountSource, CategoryInsight, CompareMode, DayBucket, DayCategoryBucket,
    GroupInsight, Headline, HealthStatus, MonthBucket, MonthlyAmount, PaceState, PeriodMeta,
    SpendingInsight, SpendingInsightRequest, UncategorizedBucket,
};
pub use service::InsightService;
