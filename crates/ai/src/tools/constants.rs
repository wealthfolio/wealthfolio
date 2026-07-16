//! Constants for bounded tool outputs and assistant payload limits.
//!
//! Tool-output bounds live in `wealthfolio-agent-tools` (next to the tools
//! they bound) and are re-exported here for backward compatibility.
//! Assistant-only limits (imports, attachments, history) stay local.

pub use wealthfolio_agent_tools::constants::{
    DEFAULT_PAGE_SIZE, DEFAULT_VALUATIONS_DAYS, MAX_ACCOUNTS, MAX_ACTIVITIES_ROWS, MAX_DIVIDENDS,
    MAX_GOALS, MAX_HOLDINGS, MAX_INCOME_RECORDS, MAX_VALUATIONS_POINTS,
};

/// Maximum number of rows to import from CSV per tool call.
pub const MAX_IMPORT_ROWS: usize = 500;

/// Maximum size per attachment in bytes (10 MB).
pub const MAX_ATTACHMENT_SIZE_BYTES: usize = 10 * 1024 * 1024;

/// Maximum total attachment payload in bytes (20 MB).
pub const MAX_TOTAL_ATTACHMENTS_BYTES: usize = 20 * 1024 * 1024;

/// Maximum number of attachments per message.
pub const MAX_ATTACHMENTS_COUNT: usize = 10;

/// Maximum total characters of history sent to the LLM (~25K tokens).
/// Messages are taken from most-recent backwards until this budget is exhausted.
pub const MAX_HISTORY_CHARS: usize = 100_000;
