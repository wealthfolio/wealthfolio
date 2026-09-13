//! Application HTTP clients with a consistent certificate policy on every platform.
//!
//! Retains the Mozilla roots used before reqwest 0.13, without requiring Android
//! platform-verifier initialization. Callers retain control of timeouts, redirects,
//! and HTTP support for local services. OIDC uses its separate legacy transport.

use std::sync::LazyLock;

static ROOTS: LazyLock<Vec<reqwest::Certificate>> = LazyLock::new(|| {
    webpki_root_certs::TLS_SERVER_ROOT_CERTS
        .iter()
        // These are bundled DER certificates, not runtime or user input.
        .map(|cert| {
            reqwest::Certificate::from_der(cert.as_ref())
                .expect("bundled Mozilla root must be a valid DER certificate")
        })
        .collect()
});

/// Start a client with verified TLS using only the bundled Mozilla trust roots.
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_certs_only(ROOTS.iter().cloned())
}

/// Construct the default application client, matching `reqwest::Client::new`.
/// Callers that need to handle initialization errors should use `client_builder`.
pub fn client() -> reqwest::Client {
    client_builder()
        .build()
        .expect("application HTTP client initialization failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_roots_build_a_client() {
        assert!(!ROOTS.is_empty());
        client_builder().build().unwrap();
    }

    #[tokio::test]
    async fn local_http_and_caller_timeout_are_preserved() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let result = client_builder()
            .no_proxy()
            .timeout(std::time::Duration::from_millis(100))
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await;
        server.abort();
        assert!(result.unwrap_err().is_timeout());
    }
}
