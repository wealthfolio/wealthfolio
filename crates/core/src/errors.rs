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

/// Reviewed client-facing error content. Arbitrary Display/Debug output can
/// contain credentials or portfolio data and must never become a public message.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicError {
    pub error_code: String,
    pub message: String,
}

impl PublicError {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            error_code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal() -> Self {
        Self::new("internal_error", "The operation could not be completed.")
    }

    pub fn invalid_input() -> Self {
        Self::new("invalid_input", "Check your input and try again.")
    }

    pub fn provider_unavailable() -> Self {
        Self::new(
            "provider_unavailable",
            "The provider could not complete the request. Check your provider settings.",
        )
    }

    /// Recover only reviewed control outcomes from legacy string boundaries.
    /// Device-sync's API wrapper is accepted; diagnostic suffixes are discarded.
    pub fn from_control_message(message: &str) -> Option<Self> {
        let message = if let Some(api) = message.strip_prefix("API error (") {
            let (status, message) = api.split_once("): ")?;
            if status.len() != 3 || !status.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            message
        } else {
            message
        };
        match message.split(':').next()? {
            "PROFILE_BUSY"
            | "Profile operations are running. Wait for them to finish and try again."
            | "Connect account change is in progress. Try again." => Some(Self::new(
                "PROFILE_BUSY", "PROFILE_BUSY: Profile operations are running. Wait for them to finish and try again.",
            )),
            "CONNECT_REBIND_REQUIRED" => Some(Self::new(
                "CONNECT_REBIND_REQUIRED",
                "CONNECT_REBIND_REQUIRED: Confirm changing this profile's Connect account or team.",
            )),
            "PROFILE_LOCKED" => Some(Self::new(
                "PROFILE_LOCKED",
                "PROFILE_LOCKED: Unlock this profile to continue.",
            )),
            "PROFILE_STALE" => Some(Self::new(
                "PROFILE_STALE",
                "PROFILE_STALE: This profile session has ended.",
            )),
            "BACKUP_REAUTHENTICATION_REQUIRED" => Some(Self::new(
                "BACKUP_REAUTHENTICATION_REQUIRED",
                "Sign in again to continue this backup operation.",
            )),
            "BACKUP_MANUAL_LIMIT" => Some(Self::new(
                "BACKUP_MANUAL_LIMIT",
                "The daily manual backup limit has been reached.",
            )),
            _ => None,
        }
    }

    /// Preserve typed core classifications through wrapping errors, without
    /// exposing arbitrary sources or context strings.
    pub fn from_error(error: &(dyn std::error::Error + 'static)) -> Self {
        let mut source = Some(error);
        while let Some(error) = source {
            if let Some(error) = error.downcast_ref::<Error>() {
                return error.public_error();
            }
            source = error.source();
        }
        Self::internal()
    }
}

impl Error {
    pub fn public_error(&self) -> PublicError {
        match self {
            // LoanError is a closed enum of stable codes, with no user data.
            Self::Validation(ValidationError::Loan(error)) => PublicError {
                error_code: error.to_string(),
                message: error.to_string(),
            },
            Self::Validation(ValidationError::InvalidSnapshotDate { .. }) => PublicError::new(
                "INVALID_SNAPSHOT_DATE",
                "This date is outside the supported snapshot range.",
            ),
            Self::Validation(ValidationError::CustomProviderCodeReserved) => PublicError::new(
                "custom_provider_code_reserved", "This provider code is reserved. Choose a different code.",
            ),
            Self::Validation(ValidationError::CustomProviderInUse) => PublicError::new(
                "custom_provider_in_use", "Change the provider for affected assets or remove their symbol mappings before deleting it.",
            ),
            Self::Validation(_) => PublicError::invalid_input(),
            Self::ConstraintViolation(_)
            | Self::Database(
                DatabaseError::UniqueViolation(_) | DatabaseError::ForeignKeyViolation(_),
            ) => PublicError::new("conflict", "The change conflicts with existing data."),
            Self::Database(DatabaseError::NotFound(_)) => {
                PublicError::new("not_found", "The requested item was not found.")
            }
            _ => PublicError::internal(),
        }
    }
}

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

    #[error("Holdings values are unavailable: {0}")]
    HoldingsUnavailable(String),

    #[error("Holdings are updating for accounts {0:?}")]
    HoldingsPending(Vec<String>),

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

    /// A built-in provider owns this code; no user-supplied code is public.
    #[error("This provider code is reserved. Choose a different code.")]
    CustomProviderCodeReserved,

    /// Provider deletion is blocked by existing asset references.
    #[error("Change the provider for affected assets or remove their symbol mappings before deleting it.")]
    CustomProviderInUse,

    /// A loan action refused by the loan rules; the message is a stable code.
    #[error("{0}")]
    Loan(#[from] crate::assets::loan::LoanError),

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
        // Legacy desktop commands use String errors. Keep their transport shape,
        // but pass a stable identifier rather than internal diagnostic text.
        err.public_error().error_code
    }
}

#[cfg(test)]
mod public_error_tests {
    use super::*;

    #[test]
    fn legacy_control_codes_discard_private_suffixes_and_reject_unknown_codes() {
        let private = "FAKE-KEY-2531 /private/portfolio.db account_balance";
        for code in [
            "BACKUP_REAUTHENTICATION_REQUIRED",
            "BACKUP_MANUAL_LIMIT",
            "PROFILE_LOCKED",
            "PROFILE_STALE",
            "PROFILE_BUSY",
            "CONNECT_REBIND_REQUIRED",
        ] {
            for message in [
                format!("{code}: {private}"),
                format!("API error (409): {code}: {private}"),
            ] {
                let public = PublicError::from_control_message(&message).unwrap();
                assert_eq!(public.error_code, code);
                assert!(!serde_json::to_string(&public).unwrap().contains("FAKE-KEY"));
            }
            assert!(
                PublicError::from_control_message(&format!("{code}_OTHER: {private}")).is_none()
            );
            assert!(PublicError::from_control_message(&format!("{private}: {code}")).is_none());
        }
    }

    #[test]
    fn actionable_custom_provider_refusals_have_public_codes() {
        for (error, code) in [
            (
                ValidationError::CustomProviderCodeReserved,
                "custom_provider_code_reserved",
            ),
            (
                ValidationError::CustomProviderInUse,
                "custom_provider_in_use",
            ),
        ] {
            assert_eq!(Error::from(error).public_error().error_code, code);
        }
    }

    #[test]
    fn public_errors_exclude_secrets_paths_and_database_details() {
        const PRIVATE: &str = "FAKE-KEY-2531 /private/portfolio.db SELECT account_balance";
        for error in [
            Error::Database(DatabaseError::QueryFailed(PRIVATE.into())),
            Error::Secret(PRIVATE.into()),
            Error::Unexpected(PRIVATE.into()),
            Error::Validation(ValidationError::InvalidInput(PRIVATE.into())),
            Error::Validation(ValidationError::MissingField(PRIVATE.into())),
            Error::ConstraintViolation(PRIVATE.into()),
        ] {
            let json = serde_json::to_string(&error.public_error()).unwrap();
            for private in PRIVATE.split_whitespace() {
                assert!(!json.contains(private), "{json}");
            }
            let legacy: String = error.into();
            assert!(!legacy.contains("FAKE-KEY"));
            assert!(!legacy.contains("/private"));
        }
        let wrapped = anyhow::Error::new(Error::Validation(ValidationError::InvalidInput(
            PRIVATE.into(),
        )))
        .context(PRIVATE);
        assert_eq!(
            PublicError::from_error(wrapped.as_ref()).error_code,
            "invalid_input"
        );
    }

    #[test]
    fn public_errors_preserve_typed_loan_refusals() {
        let error = Error::from(crate::assets::loan::LoanError::EventChanged).public_error();
        assert_eq!(error.error_code, "LOAN_EVENT_CHANGED");
        assert_eq!(error.message, "LOAN_EVENT_CHANGED");
    }
}
