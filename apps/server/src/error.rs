use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::error::Error as StdError;
use thiserror::Error;
use wealthfolio_ai::ProviderApiError;
use wealthfolio_core::errors::{DatabaseError, Error as CoreError};
use wealthfolio_core::profiles::ProfileError;

#[allow(dead_code)]
#[derive(Error, Debug)]
pub enum ApiError {
    #[error("{0}")]
    Core(#[from] CoreError),
    #[error("Not Found")]
    NotFound,
    #[error("{0}")]
    NotImplemented(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Internal(String),
    // Surface the underlying error message to help debugging during development
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: u16,
    message: String,
}

// Error messages can contain account data, SQL values, paths or credentials.
// Log only typed causes that are safe to include in server diagnostics.
pub(crate) fn safe_error_diagnostic(
    error: &(dyn StdError + 'static),
) -> (&'static str, Option<std::io::ErrorKind>, Option<i32>) {
    let mut cause = Some(error);
    let mut kind = "other";
    while let Some(current) = cause {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            return ("io", Some(io.kind()), io.raw_os_error());
        }
        if let Some(core) = current.downcast_ref::<CoreError>() {
            kind = match core {
                CoreError::Database(database) => match database {
                    DatabaseError::ConnectionFailed(_) => "database_connection",
                    DatabaseError::PoolCreationFailed(_) => "database_pool",
                    DatabaseError::QueryFailed(_) => "database_query",
                    DatabaseError::MigrationFailed(_) => "database_migration",
                    DatabaseError::BackupFailed(_) => "database_backup",
                    DatabaseError::Encryption(_) => "database_encryption",
                    DatabaseError::Internal(_) => "database_internal",
                    _ => "database_other",
                },
                CoreError::Secret(_) => "secret_store",
                CoreError::ConfigIO(_) => "configuration_io",
                CoreError::Validation(_) => "validation",
                _ => "core_other",
            };
        }
        if let Some(profile) = current.downcast_ref::<ProfileError>() {
            kind = match profile {
                ProfileError::Unavailable(_) => "profile_storage_unavailable",
                ProfileError::Invalid(_) => "profile_invalid",
                ProfileError::StorageIo { kind, os_code } => {
                    return ("profile_io", Some(*kind), *os_code);
                }
                _ => "profile_other",
            };
        }
        cause = current.source();
    }
    (kind, None, None)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            ApiError::Core(e) => match e {
                CoreError::ConstraintViolation(_) => (StatusCode::CONFLICT, e.to_string()),
                CoreError::Validation(_) => (StatusCode::BAD_REQUEST, e.to_string()),
                _ => (StatusCode::BAD_REQUEST, e.to_string()),
            },
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::NotImplemented(reason) => (StatusCode::NOT_IMPLEMENTED, reason.clone()),
            ApiError::BadRequest(reason) => (StatusCode::BAD_REQUEST, reason.clone()),
            ApiError::Unauthorized(reason) => (StatusCode::UNAUTHORIZED, reason.clone()),
            ApiError::Forbidden(reason) => (StatusCode::FORBIDDEN, reason.clone()),
            ApiError::Internal(reason) => (StatusCode::INTERNAL_SERVER_ERROR, reason.clone()),
            ApiError::Anyhow(e) => {
                // Downcast to known typed errors so user-facing validation
                // failures return 4xx instead of 500. SpendingError variants
                // represent invariant violations the user can fix; the
                // generic 500 fallback was misleading for clients and log
                // scrapers.
                if let Some(spending_err) =
                    e.downcast_ref::<wealthfolio_spending::error::SpendingError>()
                {
                    use wealthfolio_spending::error::SpendingError;
                    let status = match spending_err {
                        SpendingError::EventTypeInUse { .. } => StatusCode::CONFLICT,
                        SpendingError::InvalidEventRange => StatusCode::BAD_REQUEST,
                        SpendingError::GlobalRuleHasAccount => StatusCode::BAD_REQUEST,
                        SpendingError::InvalidInput { .. } => StatusCode::BAD_REQUEST,
                        SpendingError::NotFound { .. } => StatusCode::NOT_FOUND,
                    };
                    (status, spending_err.to_string())
                } else {
                    (StatusCode::INTERNAL_SERVER_ERROR, self.to_string())
                }
            }
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            let (kind, io_kind, os_code) = match &self {
                ApiError::Core(error) => safe_error_diagnostic(error),
                ApiError::Anyhow(error) => safe_error_diagnostic(error.as_ref()),
                _ => ("internal", None, None),
            };
            tracing::error!(
                code = "API_ERROR",
                kind,
                ?io_kind,
                ?os_code,
                "API request failed"
            );
        }
        let body = Json(ErrorBody {
            code: status.as_u16(),
            message: msg,
        });
        (status, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    /// Invalid backups remain client errors; unavailable runtime state is an
    /// internal failure, even when it travels through a blocking backup task.
    pub(crate) fn backup(error: anyhow::Error) -> Self {
        let (kind, io_kind, os_code) = safe_error_diagnostic(error.as_ref());
        let internal_io = io_kind.is_some_and(|kind| {
            !matches!(
                kind,
                std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidInput
            )
        });
        if internal_io
            || matches!(
                error.downcast_ref::<CoreError>(),
                Some(CoreError::Database(DatabaseError::Internal(_)))
            )
        {
            tracing::error!(
                code = "BACKUP_ERROR",
                kind,
                ?io_kind,
                ?os_code,
                "Backup operation failed"
            );
            Self::Internal(error.to_string())
        } else {
            Self::BadRequest(error.to_string())
        }
    }
}

impl From<ProviderApiError> for ApiError {
    fn from(err: ProviderApiError) -> Self {
        ApiError::BadRequest(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_keeps_io_kind_without_logging_error_text() {
        let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            .context("private profile path");
        let (kind, io_kind, os_code) = safe_error_diagnostic(error.as_ref());
        assert_eq!(kind, "io");
        assert_eq!(io_kind, Some(std::io::ErrorKind::PermissionDenied));
        assert_eq!(os_code, None);

        let profile_error = ProfileError::StorageIo {
            kind: std::io::ErrorKind::PermissionDenied,
            os_code: Some(13),
        };
        let (kind, io_kind, os_code) = safe_error_diagnostic(&profile_error);
        assert_eq!(kind, "profile_io");
        assert_eq!(io_kind, Some(std::io::ErrorKind::PermissionDenied));
        assert_eq!(os_code, Some(13));
    }

    #[test]
    fn backup_state_failure_is_internal_and_validation_remains_a_client_error() {
        let fault = anyhow::Error::new(CoreError::Database(DatabaseError::Internal(
            "Snapshot state unavailable".into(),
        )))
        .context("Export failed");
        assert_eq!(
            ApiError::backup(fault).into_response().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            ApiError::backup(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into())
                .into_response()
                .status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            ApiError::backup(std::io::Error::from(std::io::ErrorKind::NotFound).into())
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            ApiError::backup(anyhow::anyhow!("Invalid backup filename"))
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
}
