use reqwest::{
    header::{HeaderMap, HeaderValue},
    StatusCode,
};
use uuid::Uuid;

pub(crate) const CLIENT_REQUEST_ID_HEADER: &str = "x-wf-client-request-id";
pub(crate) const SERVER_REQUEST_ID_HEADER: &str = "x-request-id";

#[derive(Debug, Clone)]
pub(crate) struct CloudRequestContext {
    pub method: &'static str,
    pub path: String,
    pub client_request_id: String,
    pub device_id: Option<String>,
}

impl CloudRequestContext {
    pub fn new(method: &'static str, path: impl Into<String>, device_id: Option<&str>) -> Self {
        Self {
            method,
            path: path.into(),
            client_request_id: generate_client_request_id(device_id),
            device_id: device_id.map(str::to_string),
        }
    }
}

pub(crate) fn generate_client_request_id(device_id: Option<&str>) -> String {
    let uuid = Uuid::new_v4();
    if let Some(device_id) = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| is_log_safe_request_id_part(value))
    {
        let candidate = format!("{}:{}", device_id, uuid);
        if is_log_safe_request_id(&candidate) {
            return candidate;
        }
    }
    format!("app:{}", uuid)
}

pub(crate) fn is_log_safe_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn is_log_safe_request_id_part(value: &str) -> bool {
    is_log_safe_request_id(value)
}

pub(crate) fn header_value(value: &str) -> Result<HeaderValue, String> {
    HeaderValue::from_str(value).map_err(|_| "Invalid client request ID format".to_string())
}

pub(crate) fn server_request_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SERVER_REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| is_log_safe_request_id(value))
        .map(str::to_string)
}

pub(crate) fn request_metadata_suffix(
    context: &CloudRequestContext,
    server_request_id: Option<&str>,
) -> String {
    match server_request_id {
        Some(request_id) => format!(
            "clientRequestId={}, requestId={}",
            context.client_request_id, request_id
        ),
        None => format!(
            "clientRequestId={}, requestId=none",
            context.client_request_id
        ),
    }
}

pub(crate) fn log_failed_cloud_request(
    target: &str,
    context: &CloudRequestContext,
    status: Option<StatusCode>,
    server_request_id: Option<&str>,
) {
    let status = status
        .map(|status| status.as_u16().to_string())
        .unwrap_or_else(|| "no_response".to_string());
    let request_id = server_request_id.unwrap_or("none");
    let device_id = context.device_id.as_deref().unwrap_or("none");

    log::warn!(
        "[{}] Cloud request failed method={} path={} status={} clientRequestId={} requestId={} deviceId={}",
        target,
        context.method,
        context.path,
        status,
        context.client_request_id,
        request_id,
        device_id
    );
}
