//! Analytics — aggregations over cash activities + category assignments.
//! Used by the Spending overview, monthly report, and dashboard tab.

pub mod model;
pub mod service;

pub use model::{
    CategoryBreakdownRow, CategorySpending, DayBucket, DayCategoryBucket, EventCategorySpending,
    EventSpendingSummary, EventSummariesRequest, MonthlyReport, PeriodSummary, ReportRequest,
    SpendingSummary, SubcategorySpending,
};
pub use service::AnalyticsService;
