use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use argon2::{
    password_hash::{Error as PasswordHashError, PasswordHash, PasswordVerifier},
    Argon2,
};
use axum::{
    body::Body,
    extract::State,
    http::{
        header::{AUTHORIZATION, COOKIE, SET_COOKIE},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::main_lib::AppState;

/// Controls when the `Secure` attribute is set on session cookies.
///
/// - `Auto`: set `Secure` only when `X-Forwarded-Proto: https` is present (default).
/// - `Always`: always set `Secure` (use when TLS is guaranteed but the header is absent).
/// - `Never`: never set `Secure` (plain HTTP without a reverse proxy).
#[derive(Clone, Debug)]
pub enum CookieSecurePolicy {
    Auto,
    Always,
    Never,
}

impl std::fmt::Display for CookieSecurePolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => write!(f, "auto (Secure only when X-Forwarded-Proto: https)"),
            Self::Always => write!(f, "always (Secure flag always set)"),
            Self::Never => write!(f, "never (Secure flag never set)"),
        }
    }
}

#[derive(Clone)]
pub struct AuthConfig {
    /// `None` when only OIDC is configured: the manager still signs sessions
    /// but password login is disabled.
    pub password_hash: Option<String>,
    pub jwt_secret: Vec<u8>,
    pub access_token_ttl: Duration,
    pub cookie_secure: CookieSecurePolicy,
}

pub struct AuthManager {
    password_hash: Option<String>,
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
    validation: Validation,
    token_ttl: Duration,
    cookie_secure: CookieSecurePolicy,
}

#[derive(Debug)]
pub enum AuthError {
    Unauthorized,
    InvalidCredentials,
    NotConfigured,
    Internal(String),
}

#[derive(Serialize)]
struct AuthErrorBody {
    code: u16,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub authenticated: bool,
    pub expires_in: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResponse {
    pub requires_password: bool,
    pub oidc_enabled: bool,
}

impl AuthManager {
    pub fn new(config: &AuthConfig) -> anyhow::Result<Self> {
        if let Some(password_hash) = &config.password_hash {
            PasswordHash::new(password_hash).map_err(|e| {
                anyhow::anyhow!(
                    "Failed to parse WF_AUTH_PASSWORD_HASH: {e}. \
                     The hash must be a valid Argon2id PHC string starting with '$argon2id$'. \
                     If using Docker Compose .env/--env-file, single-quote it or double every '$'. \
                     If using Docker Compose YAML, double every '$' (e.g. '$$argon2id$$v=19$$...')."
                )
            })?;
        }
        let encoding_key = EncodingKey::from_secret(&config.jwt_secret);
        let decoding_key = DecodingKey::from_secret(&config.jwt_secret);
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        Ok(Self {
            password_hash: config.password_hash.clone(),
            encoding_key,
            decoding_key,
            validation,
            token_ttl: config.access_token_ttl,
            cookie_secure: config.cookie_secure.clone(),
        })
    }

    /// Whether password login is enabled (a hash is configured).
    pub fn has_password(&self) -> bool {
        self.password_hash.is_some()
    }

    pub fn verify_password(&self, candidate: &str) -> Result<(), AuthError> {
        let password_hash = self
            .password_hash
            .as_ref()
            .ok_or(AuthError::NotConfigured)?;
        let parsed = PasswordHash::new(password_hash).map_err(|e| {
            AuthError::Internal(format!("Invalid password hash configuration: {e}"))
        })?;
        Argon2::default()
            .verify_password(candidate.as_bytes(), &parsed)
            .map_err(|err| match err {
                PasswordHashError::Password => AuthError::InvalidCredentials,
                other => AuthError::Internal(format!("Password verification failed: {other}")),
            })
    }

    pub fn issue_token(&self) -> Result<String, AuthError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AuthError::Internal("System clock is before UNIX_EPOCH".into()))?;
        let exp = now + self.token_ttl;
        let claims = Claims {
            sub: "wealthfolio-web".to_string(),
            iat: now.as_secs() as usize,
            exp: exp.as_secs() as usize,
        };
        encode(&Header::default(), &claims, &self.encoding_key)
            .map_err(|e| AuthError::Internal(format!("Failed to sign token: {e}")))
    }

    pub(crate) fn validate_token(&self, token: &str) -> Result<Claims, AuthError> {
        decode::<Claims>(token, &self.decoding_key, &self.validation)
            .map(|data| data.claims)
            .map_err(|err| match err.kind() {
                jsonwebtoken::errors::ErrorKind::ExpiredSignature
                | jsonwebtoken::errors::ErrorKind::InvalidToken
                | jsonwebtoken::errors::ErrorKind::InvalidSignature
                | jsonwebtoken::errors::ErrorKind::MissingRequiredClaim(_) => {
                    AuthError::Unauthorized
                }
                other => AuthError::Internal(format!("Failed to validate token: {other:?}")),
            })
    }

    /// Returns `true` if the token is past 50% of its TTL and should be refreshed.
    pub(crate) fn should_refresh(&self, claims: &Claims) -> bool {
        let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return false;
        };
        let elapsed = now.as_secs().saturating_sub(claims.iat as u64);
        elapsed > self.token_ttl.as_secs() / 2
    }

    pub fn expires_in(&self) -> Duration {
        self.token_ttl
    }

    /// Mints a fresh session JWT and builds the `Set-Cookie` value for it.
    /// Shared by password login and OIDC callback so both yield the same session.
    /// Returns `(set_cookie_value, ttl_secs)`.
    pub fn issue_session_cookie(&self, headers: &HeaderMap) -> Result<(String, u64), AuthError> {
        let token = self.issue_token()?;
        let ttl_secs = self.expires_in().as_secs();
        let cookie = build_session_cookie(&token, ttl_secs, self.should_secure_cookie(headers));
        Ok((cookie, ttl_secs))
    }

    /// Resolve whether the `Secure` cookie attribute should be set for this request.
    pub fn should_secure_cookie(&self, headers: &HeaderMap) -> bool {
        match &self.cookie_secure {
            CookieSecurePolicy::Always => true,
            CookieSecurePolicy::Never => false,
            CookieSecurePolicy::Auto => headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(',')
                        .next()
                        .is_some_and(|p| p.trim().eq_ignore_ascii_case("https"))
                }),
        }
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AuthError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()),
            AuthError::InvalidCredentials => {
                (StatusCode::UNAUTHORIZED, "Invalid password".to_string())
            }
            AuthError::NotConfigured => (
                StatusCode::NOT_FOUND,
                "Authentication is not configured for this server".to_string(),
            ),
            AuthError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        let body = Json(AuthErrorBody {
            code: status.as_u16(),
            message,
        });
        (status, body).into_response()
    }
}

/// Derives separate JWT signing and secrets-encryption keys from a master key using HKDF-SHA256.
pub fn derive_keys(master: &[u8]) -> ([u8; 32], [u8; 32]) {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let hk = Hkdf::<Sha256>::new(None, master);
    let mut jwt_key = [0u8; 32];
    hk.expand(b"wealthfolio-jwt", &mut jwt_key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    let mut secrets_key = [0u8; 32];
    hk.expand(b"wealthfolio-secrets", &mut secrets_key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    (jwt_key, secrets_key)
}

pub fn decode_secret_key(raw: &str) -> anyhow::Result<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("JWT secret cannot be empty");
    }
    let decoded = match BASE64.decode(trimmed) {
        Ok(bytes) => bytes,
        Err(_) if trimmed.len() == 32 => trimmed.as_bytes().to_vec(),
        Err(_) => {
            anyhow::bail!("JWT secret must be base64 encoded or a 32-byte ASCII string")
        }
    };

    if decoded.len() != 32 {
        anyhow::bail!("JWT secret must decode to exactly 32 bytes");
    }

    Ok(decoded)
}

const SESSION_COOKIE_NAME: &str = "wf_session";

fn build_session_cookie(token: &str, max_age_secs: u64, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age={max_age_secs}{secure_attr}"
    )
}

/// Builds a `Set-Cookie` value that immediately clears the session cookie.
/// Shared by password logout and OIDC logout so both expire the same cookie.
pub fn clear_session_cookie(secure: bool) -> String {
    build_session_cookie("", 0, secure)
}

pub async fn login(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, AuthError> {
    let auth = state.auth.as_ref().ok_or(AuthError::NotConfigured)?.clone();
    auth.verify_password(&payload.password)?;
    let (cookie_value, ttl_secs) = auth.issue_session_cookie(&headers)?;

    let body = LoginResponse {
        authenticated: true,
        expires_in: ttl_secs,
    };

    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_str(&cookie_value)
            .map_err(|e| AuthError::Internal(format!("Failed to set cookie: {e}")))?,
    );
    Ok(response)
}

pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let secure = state
        .auth
        .as_ref()
        .is_some_and(|a| a.should_secure_cookie(&headers));
    let cookie_value = clear_session_cookie(secure);
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(val) = HeaderValue::from_str(&cookie_value) {
        response.headers_mut().insert(SET_COOKIE, val);
    }
    response
}

pub async fn auth_me(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
) -> Result<Json<serde_json::Value>, AuthError> {
    let Some(auth) = state.auth.clone() else {
        return Ok(Json(serde_json::json!({"authenticated": true})));
    };
    let token = extract_token(&request)?;
    auth.validate_token(&token).map(|_| ())?;
    Ok(Json(serde_json::json!({"authenticated": true})))
}

pub async fn auth_status(
    axum::extract::State(state): axum::extract::State<Arc<AppState>>,
) -> Json<AuthStatusResponse> {
    Json(AuthStatusResponse {
        requires_password: state.auth.as_ref().is_some_and(|auth| auth.has_password()),
        oidc_enabled: state.oidc.is_some(),
    })
}

pub async fn require_jwt(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, AuthError> {
    request.extensions_mut().insert(state.clone());

    let Some(auth) = state.auth.clone() else {
        return Ok(next.run(request).await);
    };

    let token = extract_token(&request)?;
    let claims = auth.validate_token(&token)?;

    // Sliding session: refresh the cookie when past 50% of TTL
    let needs_refresh = auth.should_refresh(&claims);
    let secure = needs_refresh.then(|| auth.should_secure_cookie(request.headers()));

    let mut response = next.run(request).await;

    if needs_refresh {
        if let Ok(new_token) = auth.issue_token() {
            let ttl_secs = auth.expires_in().as_secs();
            let cookie = build_session_cookie(&new_token, ttl_secs, secure.unwrap_or(false));
            if let Ok(val) = HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(SET_COOKIE, val);
            }
        }
    }

    Ok(response)
}

fn extract_token(request: &Request<Body>) -> Result<String, AuthError> {
    // 1. Authorization header (Bearer token)
    if let Some(header_value) = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        let mut parts = header_value.splitn(2, ' ');
        let (Some(scheme), Some(token)) = (parts.next(), parts.next()) else {
            return Err(AuthError::Unauthorized);
        };

        if !scheme.eq_ignore_ascii_case("Bearer") {
            return Err(AuthError::Unauthorized);
        }

        let token = token.trim();
        if token.is_empty() {
            return Err(AuthError::Unauthorized);
        }

        return Ok(token.to_string());
    }

    // 2. HttpOnly cookie (for SSE and page-refresh scenarios)
    if let Some(cookie_header) = request.headers().get(COOKIE).and_then(|v| v.to_str().ok()) {
        for pair in cookie_header.split(';') {
            if let Some((name, value)) = pair.trim().split_once('=') {
                if name.trim() == SESSION_COOKIE_NAME {
                    let value = value.trim();
                    if !value.is_empty() {
                        return Ok(value.to_string());
                    }
                }
            }
        }
    }

    Err(AuthError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_manager(policy: CookieSecurePolicy) -> AuthManager {
        let config = AuthConfig {
            password_hash: Some(
                "$argon2i$v=19$m=16,t=2,p=1$MTIzMjMyMzIz$/5nvsvwbwLNOxDtDae5XMQ".into(),
            ),
            jwt_secret: vec![0u8; 32],
            access_token_ttl: Duration::from_secs(3600),
            cookie_secure: policy,
        };
        AuthManager::new(&config).unwrap()
    }

    fn headers_with_proto(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn auto_no_header_is_not_secure() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(!mgr.should_secure_cookie(&HeaderMap::new()));
    }

    #[test]
    fn auto_http_is_not_secure() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(!mgr.should_secure_cookie(&headers_with_proto("http")));
    }

    #[test]
    fn auto_https_is_secure() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(mgr.should_secure_cookie(&headers_with_proto("https")));
    }

    #[test]
    fn auto_https_case_insensitive() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(mgr.should_secure_cookie(&headers_with_proto("HTTPS")));
    }

    #[test]
    fn auto_multi_value_https_first() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(mgr.should_secure_cookie(&headers_with_proto("https, http")));
    }

    #[test]
    fn auto_multi_value_http_first() {
        let mgr = make_manager(CookieSecurePolicy::Auto);
        assert!(!mgr.should_secure_cookie(&headers_with_proto("http, https")));
    }

    #[test]
    fn always_without_header() {
        let mgr = make_manager(CookieSecurePolicy::Always);
        assert!(mgr.should_secure_cookie(&HeaderMap::new()));
    }

    #[test]
    fn always_with_http_header() {
        let mgr = make_manager(CookieSecurePolicy::Always);
        assert!(mgr.should_secure_cookie(&headers_with_proto("http")));
    }

    #[test]
    fn never_without_header() {
        let mgr = make_manager(CookieSecurePolicy::Never);
        assert!(!mgr.should_secure_cookie(&HeaderMap::new()));
    }

    #[test]
    fn never_with_https_header() {
        let mgr = make_manager(CookieSecurePolicy::Never);
        assert!(!mgr.should_secure_cookie(&headers_with_proto("https")));
    }
}
