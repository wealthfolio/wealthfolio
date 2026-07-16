use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use reqwest::{
    header::{HeaderName, AUTHORIZATION},
    Method,
};
use serde::{Deserialize, Serialize};
use tokio::net::lookup_host;
use url::Url;

use super::validate_addon_id;
use crate::secrets::{addon_secret_service_id, legacy_addon_secret_service_id, SecretStore};

const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 10;

fn validate_addon_runtime_id(addon_id: &str) -> Result<(), String> {
    validate_addon_id(&addon_id.to_ascii_lowercase())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonNetworkAuth {
    #[serde(rename = "type")]
    pub auth_type: String,
    pub secret_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonNetworkRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub body: Option<String>,
    pub auth: Option<AddonNetworkAuth>,
    #[serde(skip)]
    pub injected_authorization: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonNetworkResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub async fn perform_addon_network_request(
    addon_id: &str,
    allowed_hosts: &[String],
    request: AddonNetworkRequest,
) -> Result<AddonNetworkResponse, String> {
    validate_addon_runtime_id(addon_id)?;
    let url = validate_url(&request.url, allowed_hosts)?;
    let host = url
        .host_str()
        .ok_or_else(|| "Addon network URL must include a host".to_string())?
        .to_string();
    let resolved_addresses = resolve_public_addresses(&url).await?;
    let method = validate_method(request.method.as_deref().unwrap_or("GET"))?;
    let body = request.body.unwrap_or_default();
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("Addon network request body is too large".to_string());
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .resolve_to_addrs(&host, &resolved_addresses)
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.request(method, url);
    for (name, value) in request.headers.unwrap_or_default() {
        if is_authorization_header(&name) {
            return Err(
                "Addon network Authorization header must use request.auth.secretKey".to_string(),
            );
        }
        if is_blocked_request_header(&name) {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid request header '{name}'"))?;
        builder = builder.header(header_name, value);
    }
    if let Some(authorization) = request.injected_authorization {
        builder = builder.header(AUTHORIZATION, authorization);
    }

    if !body.is_empty() {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for (name, value) in response.headers() {
        let name = name.as_str();
        if is_blocked_response_header(name) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            headers.insert(name.to_string(), value.to_string());
        }
    }

    if response.content_length().unwrap_or_default() > MAX_RESPONSE_BODY_BYTES as u64 {
        return Err("Addon network response body is too large".to_string());
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
            return Err("Addon network response body is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    Ok(AddonNetworkResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

pub fn resolve_addon_network_auth_header(
    addon_id: &str,
    auth: Option<&AddonNetworkAuth>,
    secret_store: &dyn SecretStore,
) -> Result<Option<String>, String> {
    validate_addon_runtime_id(addon_id)?;
    let Some(auth) = auth else {
        return Ok(None);
    };
    let scheme = match auth.auth_type.as_str() {
        "bearer" => "Bearer",
        "basic" => "Basic",
        _ => return Err("Addon network auth type is not supported".to_string()),
    };
    let service_id = addon_secret_service_id(addon_id, &auth.secret_key)?;
    let legacy_service_id = legacy_addon_secret_service_id(addon_id, &auth.secret_key)?;
    let secret = match secret_store
        .get_secret(&service_id)
        .map_err(|e| e.to_string())?
    {
        Some(secret) => secret,
        None => secret_store
            .get_secret(&legacy_service_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Addon network auth secret was not found".to_string())?,
    };
    if secret.trim().is_empty() {
        return Err("Addon network auth secret is empty".to_string());
    }
    Ok(Some(format!("{} {}", scheme, secret)))
}

fn validate_url(url: &str, allowed_hosts: &[String]) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid addon network URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Addon network requests must use HTTPS".to_string());
    }

    if parsed.username() != "" || parsed.password().is_some() {
        return Err("Addon network URLs cannot include credentials".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Addon network URL must include a host".to_string())?
        .to_ascii_lowercase();

    if is_blocked_host(&host) {
        return Err("Addon network host is not allowed".to_string());
    }

    if !allowed_hosts
        .iter()
        .any(|allowed| host_matches_allowed(&host, allowed))
    {
        return Err(format!("Addon network host '{host}' is not approved"));
    }

    Ok(parsed)
}

fn validate_method(method: &str) -> Result<Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        "HEAD" => Ok(Method::HEAD),
        _ => Err("Addon network method is not allowed".to_string()),
    }
}

fn host_matches_allowed(host: &str, allowed: &str) -> bool {
    let allowed = allowed.trim().trim_end_matches('.').to_ascii_lowercase();
    if let Some(suffix) = allowed.strip_prefix("*.") {
        host.ends_with(&format!(".{suffix}")) && host != suffix
    } else {
        host == allowed
    }
}

fn is_blocked_host(host: &str) -> bool {
    if matches!(host, "localhost" | "ip6-localhost" | "ip6-loopback")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return true;
    }

    match parse_ip_host(host) {
        Ok(ip) => is_blocked_ip(ip),
        Err(_) => false,
    }
}

fn parse_ip_host(host: &str) -> Result<IpAddr, std::net::AddrParseError> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets() == [169, 254, 169, 254]
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

async fn resolve_public_addresses(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Addon network URL must include a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Addon network URL must include a port".to_string())?;

    if let Ok(ip) = parse_ip_host(host) {
        if is_blocked_ip(ip) {
            return Err("Addon network host resolves to a private address".to_string());
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    let addresses = lookup_host((host, port))
        .await
        .map_err(|_| "Addon network host could not be resolved".to_string())?;

    let mut resolved = Vec::new();
    for address in addresses {
        if is_blocked_ip(address.ip()) {
            return Err("Addon network host resolves to a private address".to_string());
        }
        resolved.push(address);
    }

    if resolved.is_empty() {
        return Err("Addon network host could not be resolved".to_string());
    }

    Ok(resolved)
}

fn is_blocked_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "content-length"
            | "cookie"
            | "host"
            | "origin"
            | "proxy-authorization"
            | "referer"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn is_authorization_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization")
}

fn is_blocked_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "set-cookie" | "set-cookie2" | "transfer-encoding"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Result;
    use std::collections::BTreeMap;

    struct TestSecretStore {
        secrets: BTreeMap<String, String>,
    }

    impl SecretStore for TestSecretStore {
        fn set_secret(&self, _service: &str, _secret: &str) -> Result<()> {
            Ok(())
        }

        fn get_secret(&self, service: &str) -> Result<Option<String>> {
            Ok(self.secrets.get(service).cloned())
        }

        fn delete_secret(&self, _service: &str) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn validates_allowed_hosts() {
        assert!(validate_url("https://api.example.com/v1", &["api.example.com".into()]).is_ok());
        assert!(validate_url("https://x.example.com/v1", &["*.example.com".into()]).is_ok());
        assert!(validate_url("https://example.com/v1", &["*.example.com".into()]).is_err());
        assert!(validate_url("http://api.example.com/v1", &["api.example.com".into()]).is_err());
        assert!(validate_url("https://127.0.0.1/v1", &["127.0.0.1".into()]).is_err());
        assert!(validate_url("https://[::1]/v1", &["::1".into()]).is_err());
        assert!(validate_url("https://localhost/v1", &["localhost".into()]).is_err());
    }

    #[test]
    fn blocks_private_and_metadata_addresses() {
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("10.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap()));
        assert!(is_blocked_ip("::1".parse().unwrap()));
        assert!(is_blocked_ip("fd00::1".parse().unwrap()));
        assert!(!is_blocked_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn resolves_bearer_auth_from_addon_scoped_secret() {
        let store = TestSecretStore {
            secrets: BTreeMap::from([(
                "addon:example-addon:api-token".to_string(),
                "secret-token".to_string(),
            )]),
        };
        let header = resolve_addon_network_auth_header(
            "example-addon",
            Some(&AddonNetworkAuth {
                auth_type: "bearer".to_string(),
                secret_key: "api-token".to_string(),
            }),
            &store,
        )
        .unwrap();

        assert_eq!(header, Some("Bearer secret-token".to_string()));
    }

    #[test]
    fn resolves_bearer_auth_from_legacy_addon_secret() {
        let store = TestSecretStore {
            secrets: BTreeMap::from([(
                "addon_example-addon_apitoken".to_string(),
                "legacy-token".to_string(),
            )]),
        };
        let header = resolve_addon_network_auth_header(
            "example-addon",
            Some(&AddonNetworkAuth {
                auth_type: "bearer".to_string(),
                secret_key: "ApiToken".to_string(),
            }),
            &store,
        )
        .unwrap();

        assert_eq!(header, Some("Bearer legacy-token".to_string()));
    }

    #[test]
    fn resolves_basic_auth_from_addon_scoped_secret() {
        let store = TestSecretStore {
            secrets: BTreeMap::from([(
                "addon:example-addon:simplefin-access".to_string(),
                "dXNlcjpwYXNz".to_string(),
            )]),
        };
        let header = resolve_addon_network_auth_header(
            "example-addon",
            Some(&AddonNetworkAuth {
                auth_type: "basic".to_string(),
                secret_key: "simplefin-access".to_string(),
            }),
            &store,
        )
        .unwrap();

        assert_eq!(header, Some("Basic dXNlcjpwYXNz".to_string()));
    }

    #[test]
    fn rejects_invalid_network_auth_requests() {
        let store = TestSecretStore {
            secrets: BTreeMap::new(),
        };

        assert!(resolve_addon_network_auth_header(
            "example-addon",
            Some(&AddonNetworkAuth {
                auth_type: "digest".to_string(),
                secret_key: "api-token".to_string(),
            }),
            &store,
        )
        .is_err());
        assert!(resolve_addon_network_auth_header(
            "example-addon",
            Some(&AddonNetworkAuth {
                auth_type: "bearer".to_string(),
                secret_key: "ApiToken".to_string(),
            }),
            &store,
        )
        .is_err());
    }

    #[test]
    fn recognizes_raw_authorization_headers() {
        assert!(is_authorization_header("Authorization"));
        assert!(is_authorization_header("authorization"));
        assert!(!is_authorization_header("X-Authorization"));
    }
}
