use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use thiserror::Error;
use wealthfolio_ai::ProviderApiError;
use wealthfolio_core::errors::{DatabaseError, Error as CoreError};

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
        if matches!(
            error.downcast_ref::<CoreError>(),
            Some(CoreError::Database(DatabaseError::Internal(_)))
        ) {
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
            ApiError::backup(anyhow::anyhow!("Invalid backup filename"))
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
}
