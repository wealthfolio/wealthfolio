//! HTTP client for Wealthfolio Connect cloud API.
//!
//! This module provides a shared HTTP client for communicating with the
//! Wealthfolio Connect cloud service. Both Tauri and server implementations
//! should use this client to ensure consistency.

use async_trait::async_trait;
use log::{debug, info};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use std::time::Duration;

use crate::broker::{
    BrokerAccount, BrokerBrokerage, BrokerConnection, BrokerConnectionBrokerage,
    BrokerHoldingsResponse, PaginatedUniversalActivity, PlansResponse, UserInfo, UserTeam,
};
use crate::request_metadata::{
    header_value, log_failed_cloud_request, request_metadata_suffix, server_request_id,
    CloudRequestContext, CLIENT_REQUEST_ID_HEADER,
};
use wealthfolio_core::errors::{Error, Result};

use super::broker::BrokerApiClient;

/// Default timeout for API requests.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Default base URL for Wealthfolio Connect cloud service.
pub const DEFAULT_CLOUD_API_URL: &str = "https://api.wealthfolio.app";

// ─────────────────────────────────────────────────────────────────────────────
// API Response Types (internal, for parsing cloud API responses)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct ApiConnectionsResponse {
    #[serde(default)]
    connections: Vec<ApiConnection>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiConnection {
    id: String,
    authorization_id: Option<String>,
    brokerage_name: Option<String>,
    brokerage_slug: Option<String>,
    brokerage: Option<ApiBrokerage>,
    disabled: Option<bool>,
    updated_at: Option<String>,
    name: Option<String>,
    status: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiBrokerage {
    id: Option<String>,
    name: Option<String>,
    display_name: Option<String>,
    slug: Option<String>,
    aws_s3_logo_url: Option<String>,
    aws_s3_square_logo_url: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ApiAccountsResponse {
    #[serde(default)]
    accounts: Vec<BrokerAccount>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiUser {
    id: String,
    email: Option<String>,
    full_name: Option<String>,
    avatar_url: Option<String>,
    locale: Option<String>,
    week_starts_on_monday: Option<bool>,
    timezone: Option<String>,
    timezone_auto_sync: Option<bool>,
    time_format: Option<i32>,
    date_format: Option<String>,
    team_id: Option<String>,
    team_role: Option<String>,
    team: Option<ApiTeam>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiTeam {
    id: String,
    name: Option<String>,
    logo_url: Option<String>,
    plan: Option<String>,
    #[serde(default)]
    subscription_status: Option<String>,
    #[serde(default)]
    subscription_current_period_end: Option<String>,
    #[serde(default)]
    subscription_cancel_at_period_end: Option<bool>,
    #[serde(default)]
    canceled_at: Option<String>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize)]
struct ApiErrorResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect API Client
// ─────────────────────────────────────────────────────────────────────────────

/// HTTP client for the Wealthfolio Connect cloud API.
///
/// This client provides methods for:
/// - Fetching broker connections, accounts, and activities
/// - Getting subscription plans
/// - Getting user information
///
/// # Example
///
/// ```ignore
/// let client = ConnectApiClient::new("https://api.wealthfolio.app", "your-token")?;
/// let connections = client.list_connections().await?;
/// ```
#[derive(Debug, Clone)]
pub struct ConnectApiClient {
    client: reqwest::Client,
    base_url: String,
    auth_header: HeaderValue,
}

impl ConnectApiClient {
    /// Create a new Connect API client.
    ///
    /// # Arguments
    ///
    /// * `base_url` - The base URL of the cloud API (e.g., "https://api.wealthfolio.app")
    /// * `access_token` - A valid JWT access token
    ///
    /// # Errors
    ///
    /// Returns an error if the access token format is invalid or the HTTP client
    /// cannot be initialized.
    pub fn new(base_url: &str, access_token: &str) -> Result<Self> {
        let auth_header = HeaderValue::from_str(&format!("Bearer {}", access_token))
            .map_err(|e| Error::Unexpected(format!("Invalid access token format: {}", e)))?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .build()
            .map_err(|e| Error::Unexpected(format!("Failed to initialize HTTP client: {}", e)))?;

        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            auth_header,
        })
    }

    /// Create default headers for API requests.
    fn headers(&self, client_request_id: &str) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(AUTHORIZATION, self.auth_header.clone());
        headers.insert(
            CLIENT_REQUEST_ID_HEADER,
            header_value(client_request_id).map_err(Error::Unexpected)?,
        );
        Ok(headers)
    }

    /// Make a GET request and parse the response.
    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let context = CloudRequestContext::new("GET", path, None);
        let url = format!("{}{}", self.base_url, path);

        let response = self
            .client
            .get(&url)
            .headers(self.headers(&context.client_request_id)?)
            .send()
            .await
            .map_err(|e| self.request_transport_error(&context, e))?;

        self.parse_response(response, &context).await
    }

    /// Parse an HTTP response, handling errors appropriately.
    async fn parse_response<T: DeserializeOwned>(
        &self,
        response: reqwest::Response,
        context: &CloudRequestContext,
    ) -> Result<T> {
        let status = response.status();
        let request_id = server_request_id(response.headers());
        let body = response.text().await.map_err(|e| {
            log_failed_cloud_request("ConnectApi", context, Some(status), request_id.as_deref());
            Error::Unexpected(format!(
                "Failed to read response: {} ({})",
                e,
                request_metadata_suffix(context, request_id.as_deref())
            ))
        })?;

        if !status.is_success() {
            log_failed_cloud_request("ConnectApi", context, Some(status), request_id.as_deref());

            // Try to parse error response for a better message
            if let Ok(err) = serde_json::from_str::<ApiErrorResponse>(&body) {
                let msg = err
                    .message
                    .or(err.error)
                    .unwrap_or_else(|| format!("HTTP {}", status));
                return Err(Error::Unexpected(format!(
                    "API error {}: {} ({})",
                    status.as_u16(),
                    msg,
                    request_metadata_suffix(context, request_id.as_deref())
                )));
            }
            return Err(Error::Unexpected(format!(
                "API error {} ({})",
                status.as_u16(),
                request_metadata_suffix(context, request_id.as_deref())
            )));
        }

        serde_json::from_str(&body).map_err(|e| {
            log_failed_cloud_request("ConnectApi", context, Some(status), request_id.as_deref());
            Error::Unexpected(format!(
                "Failed to parse response: {} ({})",
                e,
                request_metadata_suffix(context, request_id.as_deref())
            ))
        })
    }

    fn request_transport_error(
        &self,
        context: &CloudRequestContext,
        error: reqwest::Error,
    ) -> Error {
        log_failed_cloud_request("ConnectApi", context, None, None);
        Error::Unexpected(format!(
            "Request failed: {} ({})",
            error,
            request_metadata_suffix(context, None)
        ))
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Brokerage Endpoints
    // ─────────────────────────────────────────────────────────────────────────

    /// Fetch account activities with pagination.
    ///
    /// # Arguments
    ///
    /// * `account_id` - The broker account ID (provider's ID)
    /// * `start_date` - Optional start date filter (YYYY-MM-DD)
    /// * `end_date` - Optional end date filter (YYYY-MM-DD)
    /// * `offset` - Pagination offset
    /// * `limit` - Maximum number of results per page
    pub async fn get_account_activities(
        &self,
        account_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> Result<PaginatedUniversalActivity> {
        let mut path = format!("/api/v1/sync/brokerage/accounts/{}/activities", account_id);

        // Build query parameters
        let mut params = Vec::new();
        if let Some(v) = offset {
            params.push(format!("offset={}", v));
        }
        if let Some(v) = limit {
            params.push(format!("limit={}", v));
        }
        if let Some(v) = start_date {
            params.push(format!("start_date={}", v));
        }
        if let Some(v) = end_date {
            params.push(format!("end_date={}", v));
        }
        if !params.is_empty() {
            path = format!("{}?{}", path, params.join("&"));
        }

        debug!("[ConnectApi] Fetching activities from: {}", path);

        self.get(&path).await
    }

    /// Fetch current holdings for a broker account.
    ///
    /// # Arguments
    ///
    /// * `account_id` - The broker account ID (provider's ID)
    pub async fn get_account_holdings(&self, account_id: &str) -> Result<BrokerHoldingsResponse> {
        let path = format!("/api/v1/sync/brokerage/accounts/{}/holdings", account_id);

        debug!("[ConnectApi] Fetching holdings from: {}", path);

        self.get(&path).await
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User & Subscription Endpoints
    // ─────────────────────────────────────────────────────────────────────────

    /// Get the current user's information.
    pub async fn get_user_info(&self) -> Result<UserInfo> {
        let api_user: Option<ApiUser> = self.get("/api/v1/user/me").await?;

        let user =
            api_user.ok_or_else(|| Error::Unexpected("No user info returned".to_string()))?;

        Ok(UserInfo {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            avatar_url: user.avatar_url,
            locale: user.locale,
            week_starts_on_monday: user.week_starts_on_monday,
            timezone: user.timezone,
            timezone_auto_sync: user.timezone_auto_sync,
            time_format: user.time_format,
            date_format: user.date_format,
            team_id: user.team_id,
            team_role: user.team_role,
            team: user.team.map(|t| UserTeam {
                id: t.id,
                name: t.name.unwrap_or_default(),
                logo_url: t.logo_url,
                plan: t.plan,
                subscription_status: t.subscription_status,
                subscription_current_period_end: t.subscription_current_period_end,
                subscription_cancel_at_period_end: t.subscription_cancel_at_period_end,
                canceled_at: t.canceled_at,
                country_code: t.country_code,
                created_at: t.created_at,
            }),
        })
    }

    /// Get available subscription plans (authenticated).
    pub async fn get_subscription_plans(&self) -> Result<PlansResponse> {
        self.get("/api/v1/subscription/plans").await
    }

    /// Check if the current user's plan includes broker sync.
    ///
    /// Returns true when the user has an active subscription AND their plan
    /// is not "basic" (basic plan only includes device sync).
    pub async fn has_broker_sync(&self) -> Result<bool> {
        let user_info = self.get_user_info().await?;

        let team = match &user_info.team {
            Some(t) => t,
            None => {
                debug!("[ConnectApi] No team info, broker sync not available");
                return Ok(false);
            }
        };

        let is_active = matches!(
            team.subscription_status.as_deref(),
            Some("active") | Some("trialing")
        );
        if !is_active {
            debug!("[ConnectApi] No active subscription, broker sync not available");
            return Ok(false);
        }

        let plan = match team.plan.as_deref() {
            Some(p) => p,
            None => {
                debug!("[ConnectApi] No plan metadata, broker sync not available");
                return Ok(false);
            }
        };
        if plan == "basic" {
            debug!("[ConnectApi] Basic plan, broker sync not available");
            return Ok(false);
        }

        debug!("[ConnectApi] Broker sync is available");
        Ok(true)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BrokerApiClient Trait Implementation
// ─────────────────────────────────────────────────────────────────────────────

#[async_trait]
impl BrokerApiClient for ConnectApiClient {
    /// Fetch all broker connections for the user.
    async fn list_connections(&self) -> Result<Vec<BrokerConnection>> {
        let api_response: ApiConnectionsResponse =
            self.get("/api/v1/sync/brokerage/connections").await?;

        let connections: Vec<BrokerConnection> = api_response
            .connections
            .into_iter()
            .map(|c| {
                // Use brokerage object if present, otherwise use top-level fields
                let brokerage = c.brokerage.map(|b| BrokerConnectionBrokerage {
                    id: b.id,
                    slug: b.slug,
                    name: b.name.clone(),
                    display_name: b.display_name.or(b.name),
                    aws_s3_logo_url: b.aws_s3_logo_url,
                    aws_s3_square_logo_url: b.aws_s3_square_logo_url,
                });

                let brokerage = brokerage.or_else(|| {
                    if c.brokerage_name.is_some() || c.brokerage_slug.is_some() {
                        Some(BrokerConnectionBrokerage {
                            id: None,
                            slug: c.brokerage_slug,
                            name: c.brokerage_name.clone(),
                            display_name: c.brokerage_name,
                            aws_s3_logo_url: None,
                            aws_s3_square_logo_url: None,
                        })
                    } else {
                        None
                    }
                });

                BrokerConnection {
                    id: c.authorization_id.unwrap_or(c.id),
                    brokerage,
                    connection_type: None,
                    status: c.status,
                    disabled: c.disabled.unwrap_or(false),
                    disabled_date: None,
                    updated_at: c.updated_at,
                    name: c.name,
                }
            })
            .collect();

        let count = connections.len();
        info!("[ConnectApi] Fetched {} broker connections", count);
        Ok(connections)
    }

    /// Fetch all broker accounts for the user.
    async fn list_accounts(
        &self,
        _authorization_ids: Option<Vec<String>>,
    ) -> Result<Vec<BrokerAccount>> {
        let api_response: ApiAccountsResponse = self.get("/api/v1/sync/brokerage/accounts").await?;

        Ok(api_response.accounts)
    }

    /// Fetch all available brokerages (not implemented in REST API).
    async fn list_brokerages(&self) -> Result<Vec<BrokerBrokerage>> {
        // The REST API doesn't have a separate brokerages endpoint
        // Brokerages are embedded in connections
        Ok(vec![])
    }

    /// Fetch account activities with pagination.
    async fn get_account_activities(
        &self,
        account_id: &str,
        start_date: Option<&str>,
        end_date: Option<&str>,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> Result<PaginatedUniversalActivity> {
        // Delegate to the inherent method
        ConnectApiClient::get_account_activities(
            self, account_id, start_date, end_date, offset, limit,
        )
        .await
    }

    /// Fetch current holdings for a broker account.
    async fn get_account_holdings(&self, account_id: &str) -> Result<BrokerHoldingsResponse> {
        // Delegate to the inherent method
        ConnectApiClient::get_account_holdings(self, account_id).await
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public (Unauthenticated) API Functions
// ─────────────────────────────────────────────────────────────────────────────

/// Fetch subscription plans without authentication.
///
/// This function is used to display pricing information before the user logs in.
/// The plans endpoint is public and does not require authentication.
///
/// # Arguments
///
/// * `base_url` - The base URL of the cloud API (e.g., "https://api.wealthfolio.app")
///
/// # Example
///
/// ```ignore
/// let plans = fetch_subscription_plans_public("https://api.wealthfolio.app").await?;
/// ```
pub async fn fetch_subscription_plans_public(base_url: &str) -> Result<PlansResponse> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| Error::Unexpected(format!("Failed to initialize HTTP client: {}", e)))?;

    let base_url = base_url.trim_end_matches('/');
    let path = "/api/v1/subscription/plans";
    let url = format!("{}{}", base_url, path);
    let context = CloudRequestContext::new("GET", path, None);

    let response = client
        .get(&url)
        .header(CONTENT_TYPE, "application/json")
        .header(CLIENT_REQUEST_ID_HEADER, context.client_request_id.as_str())
        .send()
        .await
        .map_err(|e| {
            log_failed_cloud_request("ConnectApi", &context, None, None);
            Error::Unexpected(format!(
                "Request failed: {} ({})",
                e,
                request_metadata_suffix(&context, None)
            ))
        })?;

    let status = response.status();
    let request_id = server_request_id(response.headers());
    let body = response.text().await.map_err(|e| {
        log_failed_cloud_request("ConnectApi", &context, Some(status), request_id.as_deref());
        Error::Unexpected(format!(
            "Failed to read response: {} ({})",
            e,
            request_metadata_suffix(&context, request_id.as_deref())
        ))
    })?;

    if !status.is_success() {
        log_failed_cloud_request("ConnectApi", &context, Some(status), request_id.as_deref());
        return Err(Error::Unexpected(format!(
            "API error {} ({})",
            status.as_u16(),
            request_metadata_suffix(&context, request_id.as_deref())
        )));
    }

    serde_json::from_str(&body).map_err(|e| {
        log_failed_cloud_request("ConnectApi", &context, Some(status), request_id.as_deref());
        Error::Unexpected(format!(
            "Failed to parse plans response: {} ({})",
            e,
            request_metadata_suffix(&context, request_id.as_deref())
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request_metadata::{
        generate_client_request_id, is_log_safe_request_id, CLIENT_REQUEST_ID_HEADER,
        SERVER_REQUEST_ID_HEADER,
    };
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    type CapturedHeaders = Arc<Mutex<Option<HashMap<String, String>>>>;
    type TestServer = (String, CapturedHeaders, thread::JoinHandle<()>);

    #[test]
    fn test_client_creation() {
        let client = ConnectApiClient::new("https://api.wealthfolio.app", "test-token");
        assert!(client.is_ok());
    }

    #[test]
    fn test_client_url_normalization() {
        let client = ConnectApiClient::new("https://api.wealthfolio.app/", "test-token").unwrap();
        assert_eq!(client.base_url, "https://api.wealthfolio.app");
    }

    #[test]
    fn client_request_id_is_log_safe() {
        let request_id = generate_client_request_id(Some("device_1"));
        assert!(request_id.starts_with("device_1:"));
        assert!(is_log_safe_request_id(&request_id));
        assert!(request_id.len() <= 128);

        let fallback = generate_client_request_id(Some("unsafe/device"));
        assert!(fallback.starts_with("app:"));
        assert!(is_log_safe_request_id(&fallback));
    }

    #[test]
    fn headers_include_client_request_id_without_x_request_id() {
        let client = ConnectApiClient::new("https://api.wealthfolio.app", "test-token").unwrap();
        let headers = client
            .headers("app:00000000-0000-4000-8000-000000000000")
            .unwrap();

        assert_eq!(
            headers
                .get(CLIENT_REQUEST_ID_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("app:00000000-0000-4000-8000-000000000000")
        );
        assert!(!headers.contains_key(SERVER_REQUEST_ID_HEADER));
    }

    #[tokio::test]
    async fn request_sends_client_request_id_without_x_request_id() {
        let (base_url, captured, handle) = start_one_request_server(200, r#"{"plans":[]}"#, None);
        let client = ConnectApiClient::new(&base_url, "test-token").unwrap();

        let response = client.get_subscription_plans().await.unwrap();

        assert!(response.plans.is_empty());
        let headers = captured.lock().unwrap().clone().expect("captured request");
        let client_request_id = headers
            .get(CLIENT_REQUEST_ID_HEADER)
            .expect("client request id header");
        assert!(client_request_id.starts_with("app:"));
        assert!(is_log_safe_request_id(client_request_id));
        assert!(!headers.contains_key(SERVER_REQUEST_ID_HEADER));
        handle.join().expect("server thread");
    }

    #[tokio::test]
    async fn failed_request_error_includes_client_and_server_request_ids() {
        let (base_url, captured, handle) = start_one_request_server(
            500,
            r#"{"error":"server_error","message":"temporary failure"}"#,
            Some("server-req-123"),
        );
        let client = ConnectApiClient::new(&base_url, "test-token").unwrap();

        let error = client
            .get_subscription_plans()
            .await
            .expect_err("request should fail")
            .to_string();

        let headers = captured.lock().unwrap().clone().expect("captured request");
        let client_request_id = headers
            .get(CLIENT_REQUEST_ID_HEADER)
            .expect("client request id header");
        assert!(error.contains("temporary failure"));
        assert!(error.contains(&format!("clientRequestId={}", client_request_id)));
        assert!(error.contains("requestId=server-req-123"));
        handle.join().expect("server thread");
    }

    fn start_one_request_server(
        status: u16,
        body: &'static str,
        request_id: Option<&'static str>,
    ) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let addr = listener.local_addr().expect("listener addr");
        let captured = Arc::new(Mutex::new(None));
        let captured_for_thread = Arc::clone(&captured);

        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 4096];
            let read = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..read]);
            let headers = parse_headers(&request);
            *captured_for_thread.lock().unwrap() = Some(headers);

            let request_id_header = request_id
                .map(|value| format!("x-request-id: {}\r\n", value))
                .unwrap_or_default();
            let response = format!(
                "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                request_id_header,
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
            stream.flush().expect("flush response");
        });

        (format!("http://{}", addr), captured, handle)
    }

    fn parse_headers(request: &str) -> HashMap<String, String> {
        request
            .lines()
            .skip(1)
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect()
    }
}
