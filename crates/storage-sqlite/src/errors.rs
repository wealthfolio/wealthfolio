//! Storage-specific error types for SQLite operations.
//!
//! This module provides error types that wrap Diesel-specific errors and convert
//! them to the database-agnostic error types defined in `wealthfolio_core`.

use diesel::result::Error as DieselError;
use thiserror::Error;
use wealthfolio_core::errors::{DatabaseError, Error, ValidationError};

/// Storage-specific errors that wrap Diesel and r2d2 types.
///
/// These errors are internal to the storage layer and are converted to
/// `wealthfolio_core::Error` before being returned to callers.
#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Database connection failed: {0}")]
    ConnectionFailed(#[from] diesel::ConnectionError),

    #[error("Connection pool error: {0}")]
    PoolError(#[from] r2d2::Error),

    #[error("Query execution failed: {0}")]
    QueryFailed(#[from] DieselError),

    #[error("Migration failed: {0}")]
    MigrationFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Core error: {0}")]
    CoreError(Error),
}

/// Convert core Error to StorageError (for write_actor transaction wrapper)
impl From<Error> for StorageError {
    fn from(err: Error) -> Self {
        StorageError::CoreError(err)
    }
}

impl From<StorageError> for Error {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::ConnectionFailed(e) => {
                Error::Database(DatabaseError::ConnectionFailed(e.to_string()))
            }
            StorageError::PoolError(e) => {
                Error::Database(DatabaseError::PoolCreationFailed(e.to_string()))
            }
            StorageError::QueryFailed(DieselError::NotFound) => {
                Error::Database(DatabaseError::NotFound("Record not found".to_string()))
            }
            StorageError::QueryFailed(DieselError::DatabaseError(
                diesel::result::DatabaseErrorKind::UniqueViolation,
                info,
            )) => Error::Database(DatabaseError::UniqueViolation(info.message().to_string())),
            StorageError::QueryFailed(DieselError::DatabaseError(
                diesel::result::DatabaseErrorKind::ForeignKeyViolation,
                info,
            )) => Error::Database(DatabaseError::ForeignKeyViolation(
                info.message().to_string(),
            )),
            StorageError::QueryFailed(DieselError::DatabaseError(
                diesel::result::DatabaseErrorKind::CheckViolation
                | diesel::result::DatabaseErrorKind::NotNullViolation,
                info,
            )) => Error::Validation(ValidationError::InvalidInput(info.message().to_string())),
            StorageError::QueryFailed(e) => {
                Error::Database(DatabaseError::QueryFailed(e.to_string()))
            }
            StorageError::MigrationFailed(e) => Error::Database(DatabaseError::MigrationFailed(e)),
            StorageError::SerializationError(e) => Error::Database(DatabaseError::Internal(e)),
            StorageError::CoreError(e) => e,
        }
    }
}

/// Extension trait to convert Diesel errors to core errors.
///
/// Since we can't implement `From<DieselError> for Error` due to orphan rules,
/// this trait provides a method to perform the conversion.
pub trait DieselErrorExt {
    /// Convert to a core Error type.
    fn into_core_error(self) -> Error;
}

impl DieselErrorExt for DieselError {
    fn into_core_error(self) -> Error {
        StorageError::QueryFailed(self).into()
    }
}

impl DieselErrorExt for r2d2::Error {
    fn into_core_error(self) -> Error {
        StorageError::PoolError(self).into()
    }
}

impl DieselErrorExt for diesel::ConnectionError {
    fn into_core_error(self) -> Error {
        StorageError::ConnectionFailed(self).into()
    }
}

/// Helper function to convert a Diesel Result to a core Result.
pub fn map_diesel_err<T>(
    result: std::result::Result<T, DieselError>,
) -> wealthfolio_core::Result<T> {
    result.map_err(|e| e.into_core_error())
}

/// Helper function to convert an r2d2 Result to a core Result.
pub fn map_pool_err<T>(result: std::result::Result<T, r2d2::Error>) -> wealthfolio_core::Result<T> {
    result.map_err(|e| e.into_core_error())
}

/// Extension trait for easily converting Diesel Results to core Results.
///
/// This provides a `.into_core()` method on any `Result<T, diesel::result::Error>`
/// which handles the conversion through StorageError.
pub trait IntoCore<T> {
    fn into_core(self) -> wealthfolio_core::Result<T>;
}

impl<T> IntoCore<T> for std::result::Result<T, DieselError> {
    fn into_core(self) -> wealthfolio_core::Result<T> {
        self.map_err(|e| StorageError::from(e).into())
    }
}

impl<T> IntoCore<T> for std::result::Result<T, r2d2::Error> {
    fn into_core(self) -> wealthfolio_core::Result<T> {
        self.map_err(|e| StorageError::from(e).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_constraint_violations_are_validation_errors() {
        use diesel::result::DatabaseErrorKind::{CheckViolation, NotNullViolation};

        for kind in [CheckViolation, NotNullViolation] {
            let error: Error = StorageError::QueryFailed(DieselError::DatabaseError(
                kind,
                Box::new("invalid value".to_string()),
            ))
            .into();
            assert!(matches!(
                error,
                Error::Validation(ValidationError::InvalidInput(message)) if message == "invalid value"
            ));
        }
    }
}
