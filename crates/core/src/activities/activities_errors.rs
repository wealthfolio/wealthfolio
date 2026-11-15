use diesel::result::Error as DieselError;
use thiserror::Error;

/// Custom error type for activity-related operations
#[derive(Debug, Error)]
pub enum ActivityError {
    #[error("Database error: {0}")]
    DatabaseError(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Invalid data: {0}")]
    InvalidData(String),
    /// A write matched an activity that already exists. The id stays out of
    /// public errors; it is kept for diagnostics and per-row bulk results.
    #[error(
        "Duplicate activity detected. A matching activity already exists{}.",
        existing_activity_id.as_deref().map(|id| format!(" (id: {id})")).unwrap_or_default()
    )]
    Duplicate {
        existing_activity_id: Option<String>,
    },
    #[error("Asset error: {0}")]
    AssetError(String),
    #[error("Currency exchange error: {0}")]
    CurrencyExchangeError(String),
}

impl From<DieselError> for ActivityError {
    fn from(err: DieselError) -> Self {
        match err {
            DieselError::NotFound => ActivityError::NotFound("Record not found".to_string()),
            _ => ActivityError::DatabaseError(err.to_string()),
        }
    }
}

impl From<ActivityError> for String {
    fn from(error: ActivityError) -> Self {
        error.to_string()
    }
}

impl From<ActivityError> for diesel::result::Error {
    fn from(err: ActivityError) -> Self {
        // Convert ActivityError to a diesel error
        // Using DatabaseError as it's the most appropriate for general errors
        diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::SerializationFailure,
            Box::new(format!("{}", err)),
        )
    }
}
