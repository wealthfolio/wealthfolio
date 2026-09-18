//! Core error types for the Wealthfolio application.
//!
//! This module defines database-agnostic error types. Storage-specific errors
//! (from Diesel, SQLite, etc.) are converted to these types by the storage layer.

use chrono::{DateTime, NaiveDate, ParseError as ChronoParseError, Utc};
use std::num::ParseFloatError;
use thiserror::Error;

use crate::activities::ActivityError;
use crate::fx::FxError;
use crate::quotes::MarketDataError;

/// Type alias for Result using our Error type.
pub type Result<T> = std::result::Result<T, Error>;

/// Root error type for the portfolio application.
///
/// This enum represents all possible errors that can occur in the application.
/// Database-specific errors are wrapped in string form to keep this type
/// database-agnostic.
#[derive(Error, Debug)]
pub enum Error {
    #[error("Database operation failed: {0}")]
    Database(#[from] DatabaseError),

    #[error("Asset operation failed: {0}")]
    Asset(String),

    #[error("Constraint violation: {0}")]
    ConstraintViolation(String),

    #[error("Failed to convert between currencies: {0}")]
    CurrencyConversionFailed(String),

    #[error("Currency '{0}' is not supported")]
    UnsupportedCurrency(String),

    #[error("Invalid exchange rate: {0}")]
    InvalidExchangeRate(String),

    #[error("{0}")]
    Validation(#[from] ValidationError),

    #[error("Failed to load configuration: {0}")]
    ConfigIO(String),

    #[error("Invalid configuration value: {0}")]
    InvalidConfigValue(String),

    #[error("Missing configuration key: {0}")]
    MissingConfigKey(String),

    #[error("Market data operation failed: {0}")]
    MarketData(#[from] MarketDataError),

    #[error("Activity error: {0}")]
    Activity(#[from] ActivityError),

    #[error("Repository error: {0}")]
    Repository(String),

    #[error("Holdings calculation failed: {0}")]
    Calculation(#[from] CalculatorError),

    #[error("Secret store error: {0}")]
    Secret(String),

    #[error("Unexpected error: {0}")]
    Unexpected(String),

    #[error("Fx error: {0}")]
    Fx(#[from] FxError),
}

/// Database-agnostic error type for storage operations.
///
/// This enum uses `String` for all error details, allowing the storage layer
/// to convert storage-specific errors (Diesel, SQLite, etc.) into this format.
#[derive(Error, Debug)]
pub enum DatabaseError {
    /// Failed to establish a database connection.
    #[error("Failed to connect to database: {0}")]
    ConnectionFailed(String),

    /// Failed to create or configure the connection pool.
    #[error("Failed to create database pool: {0}")]
    PoolCreationFailed(String),

    /// A database query failed to execute.
    #[error("Database query failed: {0}")]
    QueryFailed(String),

    /// The requested record was not found.
    #[error("Record not found: {0}")]
    NotFound(String),

    /// A unique constraint was violated (e.g., duplicate key).
    #[error("Unique constraint violation: {0}")]
    UniqueViolation(String),

    /// A foreign key constraint was violated.
    #[error("Foreign key violation: {0}")]
    ForeignKeyViolation(String),

    /// A database transaction failed.
    #[error("Transaction failed: {0}")]
    TransactionFailed(String),

    /// Database migration failed.
    #[error("Database migration failed: {0}")]
    MigrationFailed(String),

    /// Database backup operation failed.
    #[error("Database backup failed: {0}")]
    BackupFailed(String),

    /// Database restore operation failed.
    #[error("Database restore failed: {0}")]
    RestoreFailed(String),

    /// The database could not be opened with the available key, or key material
    /// could not be read, written or parsed.
    #[error("Database encryption error: {0}")]
    Encryption(String),

    /// Internal/unexpected database error.
    #[error("Internal database error: {0}")]
    Internal(String),
}

/// Errors that occur during portfolio calculations.
#[derive(Error, Debug)]
pub enum CalculatorError {
    #[error("Invalid activity data: {0}")]
    InvalidActivity(String),

    #[error("Insufficient shares for asset {asset_id} in account {account_id} on date {date}")]
    InsufficientShares {
        asset_id: String,
        account_id: String,
        date: DateTime<Utc>,
    },

    #[error("Currency mismatch for position {position_id} ({}): Activity {activity_id} has currency {}. Requires currency conversion activity first.",
        position_currency, activity_currency
    )]
    CurrencyMismatch {
        position_id: String,
        position_currency: String,
        activity_id: String,
        activity_currency: String,
    },

    #[error("Currency conversion failed: {0}")]
    CurrencyConversion(String),

    #[error("FX rate {0}->{1} not found in pre-fetched cache for date {2}")]
    MissingFxRate(String, String, NaiveDate),

    #[error("Position not found for asset {asset_id} in account {account_id} during operation")]
    PositionNotFound {
        asset_id: String,
        account_id: String,
    },

    #[error("Lot not found during operation (this should not happen): Lot ID {lot_id}")]
    LotNotFound { lot_id: String },

    #[error("Unsupported activity type: {0}")]
    UnsupportedActivityType(String),

    #[error("Calculation failed: {0}")]
    Calculation(String),
}

/// Validation errors for user input and data parsing.
#[derive(Error, Debug)]
pub enum ValidationError {
    #[error("Failed to parse number: {0}")]
    NumberParse(#[from] ParseFloatError),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Required field '{0}' is missing")]
    MissingField(String),

    #[error("Failed to parse decimal number: {0}")]
    DecimalParse(#[from] rust_decimal::Error),

    #[error("Failed to parse date/time: {0}")]
    DateTimeParse(#[from] ChronoParseError),

    #[error(
        "INVALID_SNAPSHOT_DATE: {date} can't be used for account {account_id}. Supported dates are {min_date} to {max_date}. Source: {snapshot_source}."
    )]
    InvalidSnapshotDate {
        account_id: String,
        date: NaiveDate,
        min_date: NaiveDate,
        max_date: NaiveDate,
        snapshot_source: String,
    },
}

// === From implementations for common error types ===

impl From<rust_decimal::Error> for Error {
    fn from(err: rust_decimal::Error) -> Self {
        Error::Validation(ValidationError::DecimalParse(err))
    }
}

impl From<Box<dyn std::error::Error>> for Error {
    fn from(err: Box<dyn std::error::Error>) -> Self {
        Error::Validation(ValidationError::InvalidInput(err.to_string()))
    }
}

impl From<Box<dyn std::error::Error + Send + Sync>> for Error {
    fn from(err: Box<dyn std::error::Error + Send + Sync>) -> Self {
        Error::Validation(ValidationError::InvalidInput(err.to_string()))
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Validation(ValidationError::InvalidInput(err.to_string()))
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::Validation(ValidationError::InvalidInput(err.to_string()))
    }
}

impl From<ChronoParseError> for Error {
    fn from(err: ChronoParseError) -> Self {
        Error::Validation(ValidationError::DateTimeParse(err))
    }
}

impl From<Error> for String {
    fn from(err: Error) -> Self {
        err.to_string()
    }
}
