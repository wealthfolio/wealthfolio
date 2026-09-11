//! Request-level failures: the caller made a mistake (architecture §4.4). Imperfect
//! DATA never surfaces here; it becomes a [`crate::Diagnostic`].

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EngineError {
    #[error("duplicate activity id {0:?}")]
    DuplicateActivityId(String),
    #[error("duplicate account id {0:?}")]
    DuplicateAccountId(String),
    #[error("duplicate asset id {0:?}")]
    DuplicateAssetId(String),
    #[error("invalid policy: {0}")]
    InvalidPolicy(String),
    #[error("invalid date range: start {start} is after end {end}")]
    InvertedRange {
        start: chrono::NaiveDate,
        end: chrono::NaiveDate,
    },
    #[error("prior state is dated {state} but the range starts {start}")]
    StateRangeMismatch {
        state: chrono::NaiveDate,
        start: chrono::NaiveDate,
    },
}
