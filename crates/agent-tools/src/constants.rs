//! Constants for bounded tool outputs.
//!
//! These limits ensure that tool outputs don't overwhelm the LLM context
//! while still providing enough data for meaningful analysis.

/// Default page size for activity searches.
pub const DEFAULT_PAGE_SIZE: i64 = 50;

/// Maximum number of activity rows returned per tool call.
pub const MAX_ACTIVITIES_ROWS: usize = 200;

/// Default number of days for valuation history (when no date range specified).
pub const DEFAULT_VALUATIONS_DAYS: i64 = 365;

/// Maximum number of valuation data points returned per tool call.
pub const MAX_VALUATIONS_POINTS: usize = 400;

/// Maximum number of holdings returned per tool call.
pub const MAX_HOLDINGS: usize = 100;

/// Maximum number of income/dividend records returned per tool call.
pub const MAX_INCOME_RECORDS: usize = 50;

/// Maximum number of dividend/interest payments returned per tool call.
pub const MAX_DIVIDENDS: usize = 100;

/// Maximum number of goals returned per tool call.
pub const MAX_GOALS: usize = 50;

/// Maximum number of accounts returned per tool call.
pub const MAX_ACCOUNTS: usize = 50;

/// Maximum number of portfolios returned per tool call.
pub const MAX_PORTFOLIOS: usize = 50;

/// Maximum number of net-worth history points returned per tool call.
pub const MAX_NET_WORTH_POINTS: usize = 400;

/// Maximum number of contribution limits returned per tool call.
pub const MAX_CONTRIBUTION_LIMITS: usize = 50;
