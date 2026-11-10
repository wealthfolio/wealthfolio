use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use std::error::Error as StdError;
use thiserror::Error;
use wealthfolio_ai::ProviderApiError;
use wealthfolio_core::errors::{DatabaseError, Error as CoreError, PublicError};
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
    #[error("{0}")]
    Provider(#[from] ProviderApiError),
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: u16,
    #[serde(flatten)]
    error: PublicError,
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
        let error = match &self {
            Self::Core(error) => error.public_error(),
            Self::Provider(error) => error.public_error(),
            Self::NotFound => PublicError::new("not_found", "The requested item was not found."),
            Self::NotImplemented(_) => {
                PublicError::new("not_implemented", "This operation is unavailable.")
            }
            Self::BadRequest(reason) => {
                PublicError::from_control_message(reason).unwrap_or_else(PublicError::invalid_input)
            }
            Self::Unauthorized(_) => PublicError::new("unauthorized", "Sign in to continue."),
            Self::Forbidden(reason) => PublicError::from_control_message(reason)
                .unwrap_or_else(|| PublicError::new("forbidden", "This operation is not allowed.")),
            Self::Internal(_) => PublicError::internal(),
            Self::Anyhow(error) => {
                if let Some(error) =
                    error.downcast_ref::<wealthfolio_spending::error::SpendingError>()
                {
                    use wealthfolio_spending::error::SpendingError;
                    match error {
                        SpendingError::EventTypeInUse { .. } => {
                            PublicError::new("conflict", "The change conflicts with existing data.")
                        }
                        SpendingError::NotFound { .. } | SpendingError::ActivityNotFound => {
                            PublicError::new("not_found", "The requested item was not found.")
                        }
                        _ => PublicError::invalid_input(),
                    }
                } else {
                    PublicError::from_error(error.as_ref())
                }
            }
        };
        let status = match &self {
            ApiError::Core(e) => match e {
                CoreError::ConstraintViolation(_)
                | CoreError::Database(
                    DatabaseError::UniqueViolation(_) | DatabaseError::ForeignKeyViolation(_),
                ) => StatusCode::CONFLICT,
                CoreError::Database(DatabaseError::NotFound(_)) => StatusCode::NOT_FOUND,
                // Any other database error is a failure on the server, not in the request.
                CoreError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
                _ => StatusCode::BAD_REQUEST,
            },
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::NotImplemented(_) => StatusCode::NOT_IMPLEMENTED,
            ApiError::BadRequest(_) | ApiError::Provider(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            // An upstream rate limit reaches the app as a reviewed control code.
            ApiError::Forbidden(_) if error.error_code == "RATE_LIMITED" => {
                StatusCode::TOO_MANY_REQUESTS
            }
            ApiError::Forbidden(_) => StatusCode::FORBIDDEN,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
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
                    match spending_err {
                        SpendingError::EventTypeInUse { .. } => StatusCode::CONFLICT,
                        SpendingError::InvalidEventRange => StatusCode::BAD_REQUEST,
                        SpendingError::GlobalRuleHasAccount => StatusCode::BAD_REQUEST,
                        SpendingError::InvalidInput { .. } => StatusCode::BAD_REQUEST,
                        SpendingError::NotFound { .. } | SpendingError::ActivityNotFound => {
                            StatusCode::NOT_FOUND
                        }
                    }
                } else {
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }
        };
        // Legacy core failures can retain HTTP 400 while their public code is
        // internal_error. Keep their safe classification available to operators.
        if status == StatusCode::INTERNAL_SERVER_ERROR || error.error_code == "internal_error" {
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
            error,
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

#[cfg(test)]
mod tests {
    use super::*;
    const PRIVATE: &str = "FAKE-KEY-2531 /private/portfolio.db SELECT account_balance";

    #[tokio::test]
    async fn response_bodies_do_not_expose_internal_error_text() {
        let cases = [
            (
                ApiError::Core(CoreError::Database(DatabaseError::QueryFailed(
                    PRIVATE.into(),
                ))),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
            (
                ApiError::Core(CoreError::Secret(PRIVATE.into())),
                StatusCode::BAD_REQUEST,
                "internal_error",
            ),
            (
                ApiError::Core(CoreError::Validation(
                    wealthfolio_core::errors::ValidationError::InvalidInput(PRIVATE.into()),
                )),
                StatusCode::BAD_REQUEST,
                "invalid_input",
            ),
            (
                ApiError::Internal(PRIVATE.into()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
            (
                ApiError::Anyhow(anyhow::anyhow!(PRIVATE)),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
            (
                ApiError::backup(anyhow::anyhow!(PRIVATE)),
                StatusCode::BAD_REQUEST,
                "invalid_input",
            ),
            (
                ApiError::from(ProviderApiError::ProviderError {
                    message: PRIVATE.into(),
                }),
                StatusCode::BAD_REQUEST,
                "provider_unavailable",
            ),
            (
                ApiError::BadRequest(PRIVATE.into()),
                StatusCode::BAD_REQUEST,
                "invalid_input",
            ),
        ];
        for (error, status, code) in cases {
            let response = error.into_response();
            assert_eq!(response.status(), status);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["errorCode"], code);
            assert_eq!(json["code"], status.as_u16());
            assert!(json["message"].is_string());
            for private in PRIVATE.split_whitespace() {
                assert!(!String::from_utf8_lossy(&body).contains(private));
            }
        }
    }

    #[tokio::test]
    async fn connect_rebind_keeps_only_the_reviewed_control_code() {
        for (reason, expected) in [
            (
                format!("CONNECT_REBIND_REQUIRED: {PRIVATE}"),
                "CONNECT_REBIND_REQUIRED",
            ),
            (
                format!("CONNECT_REBIND_REQUIRED_OTHER: {PRIVATE}"),
                "forbidden",
            ),
            (format!("{PRIVATE}: CONNECT_REBIND_REQUIRED"), "forbidden"),
        ] {
            let response = ApiError::Forbidden(reason).into_response();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(json["code"], 403);
            assert_eq!(json["errorCode"], expected);
            for private in PRIVATE.split_whitespace() {
                assert!(!String::from_utf8_lossy(&body).contains(private));
            }
        }
    }

    #[tokio::test]
    async fn backup_and_profile_control_codes_survive_http_sanitization() {
        for (error, code, status) in [
            (
                ApiError::BadRequest(format!(
                    "API error (403): BACKUP_REAUTHENTICATION_REQUIRED: {PRIVATE}"
                )),
                "BACKUP_REAUTHENTICATION_REQUIRED",
                StatusCode::BAD_REQUEST,
            ),
            (
                ApiError::BadRequest(format!("API error (409): BACKUP_MANUAL_LIMIT: {PRIVATE}")),
                "BACKUP_MANUAL_LIMIT",
                StatusCode::BAD_REQUEST,
            ),
            (
                ApiError::Forbidden(format!("PROFILE_LOCKED: {PRIVATE}")),
                "PROFILE_LOCKED",
                StatusCode::FORBIDDEN,
            ),
            (
                ApiError::Forbidden(format!("PROFILE_STALE: {PRIVATE}")),
                "PROFILE_STALE",
                StatusCode::FORBIDDEN,
            ),
            (
                ApiError::BadRequest(format!(
                    "API error (409): BACKUP_MANUAL_LIMIT_OTHER: {PRIVATE}"
                )),
                "invalid_input",
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let response = error.into_response();
            assert_eq!(response.status(), status);
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["errorCode"], code);
            for value in PRIVATE.split_whitespace() {
                assert!(!String::from_utf8_lossy(&bytes).contains(value));
            }
        }
    }

    #[tokio::test]
    async fn connect_subscription_and_rate_limit_codes_reach_the_app() {
        // Connect's client error text, as broker sync and the profile refresh get it.
        for (reason, code, status) in [
            (
                format!("API error 403: SUBSCRIPTION_CANCELED: Subscription required ({PRIVATE})"),
                "SUBSCRIPTION_REQUIRED",
                StatusCode::FORBIDDEN,
            ),
            (
                format!("API error 403: PLAN_UPGRADE_REQUIRED: Upgrade ({PRIVATE})"),
                "PLAN_UPGRADE_REQUIRED",
                StatusCode::FORBIDDEN,
            ),
            (
                format!("API error 429 ({PRIVATE})"),
                "RATE_LIMITED",
                StatusCode::TOO_MANY_REQUESTS,
            ),
            (
                format!("API error 429: Too many requests ({PRIVATE})"),
                "RATE_LIMITED",
                StatusCode::TOO_MANY_REQUESTS,
            ),
            (
                format!("API error 403: SUBSCRIPTIONS ({PRIVATE})"),
                "forbidden",
                StatusCode::FORBIDDEN,
            ),
        ] {
            let response = ApiError::Forbidden(reason).into_response();
            assert_eq!(response.status(), status);
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["errorCode"], code);
            assert_eq!(json["code"], status.as_u16());
            for value in PRIVATE.split_whitespace() {
                assert!(!String::from_utf8_lossy(&bytes).contains(value));
            }
        }
    }

    #[test]
    fn legacy_internal_failures_log_only_safe_diagnostics() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().write(bytes)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let output = Capture(Arc::new(Mutex::new(Vec::new())));
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let response = ApiError::Core(CoreError::Secret(PRIVATE.into())).into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        });
        let logged = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert!(logged.contains("API request failed"));
        assert!(logged.contains("secret_store"));
        for private in PRIVATE.split_whitespace() {
            assert!(!logged.contains(private));
        }
    }

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
    fn database_errors_are_classified_by_variant() {
        let status = |error: DatabaseError| {
            ApiError::from(CoreError::from(error))
                .into_response()
                .status()
        };
        let message = || "detail".to_string();
        for server_failure in [
            DatabaseError::ConnectionFailed(message()),
            DatabaseError::PoolCreationFailed(message()),
            DatabaseError::QueryFailed(message()),
            DatabaseError::TransactionFailed(message()),
            DatabaseError::MigrationFailed(message()),
            DatabaseError::BackupFailed(message()),
            DatabaseError::RestoreFailed(message()),
            DatabaseError::Encryption(message()),
            DatabaseError::Internal(message()),
        ] {
            assert_eq!(status(server_failure), StatusCode::INTERNAL_SERVER_ERROR);
        }
        assert_eq!(
            status(DatabaseError::NotFound(message())),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(DatabaseError::UniqueViolation(message())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status(DatabaseError::ForeignKeyViolation(message())),
            StatusCode::CONFLICT
        );

        let core_status = |error: CoreError| ApiError::from(error).into_response().status();
        assert_eq!(
            core_status(CoreError::ConstraintViolation(message())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            core_status(CoreError::Validation(
                wealthfolio_core::errors::ValidationError::InvalidInput(message())
            )),
            StatusCode::BAD_REQUEST
        );
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
