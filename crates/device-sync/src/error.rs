//! Error types for the device sync crate.

use thiserror::Error;

/// Result type alias for device sync operations.
pub type Result<T> = std::result::Result<T, DeviceSyncError>;

/// Retry policy class for API failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiRetryClass {
    Retryable,
    Permanent,
    ReauthRequired,
}

// Known error codes returned by the sync-v2 API.
pub const SYNC_CURSOR_TOO_OLD: &str = "SYNC_CURSOR_TOO_OLD";
pub const SYNC_SEGMENT_OBJECT_MISSING: &str = "SYNC_SEGMENT_OBJECT_MISSING";
pub const SYNC_SEGMENT_OFFSET_INVALID: &str = "SYNC_SEGMENT_OFFSET_INVALID";
pub const SYNC_SEGMENT_CHECKSUM_MISMATCH: &str = "SYNC_SEGMENT_CHECKSUM_MISMATCH";
pub const SYNC_SEGMENT_STREAM_MISMATCH: &str = "SYNC_SEGMENT_STREAM_MISMATCH";
pub const SYNC_EVENT_INDEX_MISMATCH: &str = "SYNC_EVENT_INDEX_MISMATCH";
pub const SYNC_SNAPSHOT_OBJECT_MISSING: &str = "SYNC_SNAPSHOT_OBJECT_MISSING";
pub const SYNC_SNAPSHOT_CHECKSUM_MISMATCH: &str = "SYNC_SNAPSHOT_CHECKSUM_MISMATCH";

/// Returns true when the given code indicates an integrity problem.
pub fn is_integrity_code(code: &str) -> bool {
    matches!(
        code,
        SYNC_SEGMENT_OBJECT_MISSING
            | SYNC_SEGMENT_OFFSET_INVALID
            | SYNC_SEGMENT_CHECKSUM_MISMATCH
            | SYNC_SEGMENT_STREAM_MISMATCH
            | SYNC_EVENT_INDEX_MISMATCH
            | SYNC_SNAPSHOT_OBJECT_MISSING
            | SYNC_SNAPSHOT_CHECKSUM_MISMATCH
    )
}

/// Errors that can occur during device sync operations.
#[derive(Debug, Error)]
pub enum DeviceSyncError {
    /// HTTP client error
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization/deserialization error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// API error response from the cloud service
    #[error("API error ({status}): {code}: {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },

    /// Invalid request (missing required data, etc.)
    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    /// Authentication error (missing or invalid token)
    #[error("Authentication error: {0}")]
    Auth(String),
}

impl DeviceSyncError {
    /// Create an API error from status and message
    pub fn api(status: u16, message: impl Into<String>) -> Self {
        Self::Api {
            status,
            code: String::new(),
            message: message.into(),
            details: None,
        }
    }

    /// Create an API error with structured code and details
    pub fn api_structured(
        status: u16,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::Api {
            status,
            code: code.into(),
            message: message.into(),
            details,
        }
    }

    /// Create an invalid request error
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::InvalidRequest(message.into())
    }

    /// Create an auth error
    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth(message.into())
    }

    /// HTTP status if this is an API error.
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Machine-readable error code, if present.
    pub fn error_code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } if !code.is_empty() => Some(code.as_str()),
            _ => None,
        }
    }

    /// Returns true when the error code indicates an integrity problem
    /// (segment/snapshot corruption) that should trigger bootstrap.
    pub fn is_integrity_error(&self) -> bool {
        matches!(
            self.error_code(),
            Some(
                SYNC_SEGMENT_OBJECT_MISSING
                    | SYNC_SEGMENT_OFFSET_INVALID
                    | SYNC_SEGMENT_CHECKSUM_MISMATCH
                    | SYNC_SEGMENT_STREAM_MISMATCH
                    | SYNC_EVENT_INDEX_MISMATCH
                    | SYNC_SNAPSHOT_OBJECT_MISSING
                    | SYNC_SNAPSHOT_CHECKSUM_MISMATCH
            )
        )
    }

    /// Returns true when the local cursor is too old for incremental sync.
    pub fn is_stale_cursor(&self) -> bool {
        self.error_code() == Some(SYNC_CURSOR_TOO_OLD)
    }

    /// Classify error for retry policy.
    pub fn retry_class(&self) -> ApiRetryClass {
        match self {
            Self::Api { status, .. } => match *status {
                401 | 403 => ApiRetryClass::ReauthRequired,
                402 | 408 | 409 | 423 | 425 | 429 => ApiRetryClass::Retryable,
                500..=599 => ApiRetryClass::Retryable,
                _ => ApiRetryClass::Permanent,
            },
            Self::Http(_) => ApiRetryClass::Retryable,
            Self::Json(_) => ApiRetryClass::Permanent,
            Self::InvalidRequest(_) => ApiRetryClass::Permanent,
            Self::Auth(_) => ApiRetryClass::ReauthRequired,
        }
    }

    /// Returns true when server-side validation rejected snapshotId UUID format.
    pub fn is_snapshot_id_validation_error(&self) -> bool {
        match self {
            Self::Api {
                status,
                code,
                message,
                ..
            } => {
                *status == 400
                    && (message.contains("snapshotId") || code.contains("snapshotId"))
                    && (message.contains("Invalid UUID")
                        || message.contains("invalid_format")
                        || code.contains("invalid_format"))
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_validation_error_detected() {
        let err = DeviceSyncError::api(
            400,
            "Request failed: {\"path\":[\"snapshotId\"],\"message\":\"Invalid UUID\"}",
        );
        assert!(err.is_snapshot_id_validation_error());
    }

    #[test]
    fn retry_class_for_auth_error_is_reauth() {
        let err = DeviceSyncError::api(401, "unauthorized");
        assert_eq!(err.retry_class(), ApiRetryClass::ReauthRequired);
    }

    #[test]
    fn stale_cursor_detected() {
        let err = DeviceSyncError::api_structured(409, SYNC_CURSOR_TOO_OLD, "Cursor too old", None);
        assert!(err.is_stale_cursor());
        assert!(!err.is_integrity_error());
    }

    #[test]
    fn integrity_error_detected() {
        let err = DeviceSyncError::api_structured(
            409,
            SYNC_SEGMENT_CHECKSUM_MISMATCH,
            "Checksum mismatch",
            None,
        );
        assert!(err.is_integrity_error());
        assert!(!err.is_stale_cursor());
    }
}
