//! Isolated ciphertext transport: no API authorization, cookies, redirects, or URL logging.
use crate::{
    crypto::sha256_checksum,
    limits::{
        BACKUP_TRANSFER_TIMEOUT_SECONDS, MAX_ENCRYPTED_BACKUP_BYTES, MAX_ENCRYPTED_SNAPSHOT_BYTES,
        SNAPSHOT_TRANSFER_TIMEOUT_SECONDS,
    },
    DeviceSyncError, Result,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::LazyLock, time::Duration};

// Share connection pools without retaining capabilities, credentials, or profile state.
static TRANSFER_CLIENT: LazyLock<std::result::Result<reqwest::Client, String>> =
    LazyLock::new(|| transfer_client(SNAPSHOT_TRANSFER_TIMEOUT_SECONDS));
fn transfer_client(seconds: u64) -> std::result::Result<reqwest::Client, String> {
    wealthfolio_http::client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(seconds))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Secure transfer client unavailable".into())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TransferDescriptor {
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: String,
}
impl std::fmt::Debug for TransferDescriptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferDescriptor")
            .field("method", &self.method)
            .field("url", &"[REDACTED]")
            .finish()
    }
}
#[derive(Clone)]
pub struct ConnectTransferTransport {
    hosts: Vec<String>,
    client: reqwest::Client,
    max_bytes: usize,
    timeout: Duration,
}
impl std::fmt::Debug for ConnectTransferTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectTransferTransport")
            .finish_non_exhaustive()
    }
}
impl ConnectTransferTransport {
    #[cfg(test)]
    fn new(hosts: Vec<String>) -> Result<Self> {
        Self::with_limits(
            hosts,
            MAX_ENCRYPTED_SNAPSHOT_BYTES,
            SNAPSHOT_TRANSFER_TIMEOUT_SECONDS,
        )
    }
    #[cfg(test)]
    fn with_limits(hosts: Vec<String>, max_bytes: usize, timeout_seconds: u64) -> Result<Self> {
        let client = wealthfolio_http::client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(timeout_seconds))
            .connect_timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            hosts,
            client,
            max_bytes,
            timeout: Duration::from_secs(timeout_seconds),
        })
    }
    pub fn configured() -> Result<Self> {
        Self::configured_with_limits(
            MAX_ENCRYPTED_SNAPSHOT_BYTES,
            SNAPSHOT_TRANSFER_TIMEOUT_SECONDS,
        )
    }
    pub fn configured_for_backups() -> Result<Self> {
        Self::configured_with_limits(MAX_ENCRYPTED_BACKUP_BYTES, BACKUP_TRANSFER_TIMEOUT_SECONDS)
    }
    fn configured_with_limits(max_bytes: usize, timeout_seconds: u64) -> Result<Self> {
        let hosts = std::env::var("CONNECT_STORAGE_ALLOWED_HOSTS")
            .ok()
            .or_else(|| option_env!("CONNECT_STORAGE_ALLOWED_HOSTS").map(str::to_string))
            .unwrap_or_default();
        Ok(Self {
            hosts: hosts
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            client: TRANSFER_CLIENT
                .clone()
                .map_err(DeviceSyncError::invalid_request)?,
            max_bytes,
            timeout: Duration::from_secs(timeout_seconds),
        })
    }
    fn request(
        &self,
        descriptor: &TransferDescriptor,
        method: &str,
    ) -> Result<reqwest::RequestBuilder> {
        if self.hosts.is_empty() {
            return Err(DeviceSyncError::invalid_request(
                "Connect transfer destinations are not configured in this build",
            ));
        }
        let url = reqwest::Url::parse(&descriptor.url)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid transfer descriptor"))?;
        if descriptor.method != method
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
            || !url
                .host_str()
                .is_some_and(|host| self.hosts.iter().any(|allowed| allowed == host))
        {
            return Err(DeviceSyncError::invalid_request(
                "Unapproved transfer destination",
            ));
        }
        // Storage enforces expiry on its clock. A skewed device clock must not
        // reject an otherwise valid signed capability before trying it.
        chrono::DateTime::parse_from_rfc3339(&descriptor.expires_at)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid transfer expiration"))?;
        let mut request = self
            .client
            .request(
                if method == "GET" {
                    reqwest::Method::GET
                } else {
                    reqwest::Method::PUT
                },
                url,
            )
            .timeout(self.timeout);
        for (name, value) in &descriptor.headers {
            if !matches!(
                name.as_str(),
                "content-type" | "content-length" | "if-none-match" | "x-amz-checksum-sha256"
            ) {
                return Err(DeviceSyncError::invalid_request(
                    "Unapproved transfer header",
                ));
            }
            if name == "x-amz-checksum-sha256" && method != "PUT" {
                return Err(DeviceSyncError::invalid_request(
                    "Unapproved transfer header",
                ));
            }
            request = request.header(name, value);
        }
        Ok(request)
    }
    pub async fn download(
        &self,
        descriptor: &TransferDescriptor,
        size: usize,
        checksum: &str,
    ) -> Result<Vec<u8>> {
        if size == 0 || size > self.max_bytes {
            return Err(DeviceSyncError::invalid_request(
                "Transfer size exceeds limit",
            ));
        }
        let mut response = self
            .request(descriptor, "GET")?
            .send()
            .await
            .map_err(|e| DeviceSyncError::Http(e.without_url()))?;
        if !response.status().is_success() {
            return Err(DeviceSyncError::api(
                response.status().as_u16(),
                "Secure download failed",
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length != size as u64)
        {
            return Err(DeviceSyncError::invalid_request("Transfer size mismatch"));
        }
        let mut bytes = Vec::with_capacity(size);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| DeviceSyncError::Http(e.without_url()))?
        {
            if chunk.len() > size.saturating_sub(bytes.len()) {
                return Err(DeviceSyncError::invalid_request("Transfer size mismatch"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != size || sha256_checksum(&bytes) != checksum {
            return Err(DeviceSyncError::invalid_request(
                "Transfer integrity verification failed",
            ));
        }
        Ok(bytes)
    }
    pub async fn upload(&self, descriptor: &TransferDescriptor, bytes: Vec<u8>) -> Result<()> {
        if bytes.is_empty()
            || bytes.len() > self.max_bytes
            || descriptor.headers.get("content-length") != Some(&bytes.len().to_string())
        {
            return Err(DeviceSyncError::invalid_request("Transfer size mismatch"));
        }
        if let Some(expected) = descriptor.headers.get("x-amz-checksum-sha256") {
            use base64::{engine::general_purpose::STANDARD, Engine};
            use sha2::{Digest, Sha256};
            if *expected != STANDARD.encode(Sha256::digest(&bytes)) {
                return Err(DeviceSyncError::invalid_request(
                    "Transfer integrity verification failed",
                ));
            }
        }
        let request = self
            .request(descriptor, "PUT")?
            .body(bytes)
            .build()
            .map_err(|_| DeviceSyncError::invalid_request("Invalid transfer headers"))?;
        self.send_upload(request).await
    }
    async fn send_upload(&self, request: reqwest::Request) -> Result<()> {
        // Reuse the existing bounded upload retry policy and the same immutable
        // body/key. Request clones share the body allocation, including large backups.
        tokio::time::timeout(self.timeout, async {
            for attempt in 1..=crate::client::SNAPSHOT_UPLOAD_MAX_ATTEMPTS {
                let request = request
                    .try_clone()
                    .expect("buffered upload body is clonable");
                let result = match self.client.execute(request).await {
                    Ok(response) if response.status().is_success() => return Ok(()),
                    Ok(response) => Err(DeviceSyncError::api(
                        response.status().as_u16(),
                        "Secure upload failed",
                    )),
                    Err(error) => Err(DeviceSyncError::Http(error.without_url())),
                };
                let retry = match &result {
                    Err(DeviceSyncError::Http(error)) => {
                        crate::client::is_retryable_transport_error(error)
                    }
                    Err(DeviceSyncError::Api { status, .. }) => {
                        crate::client::is_retryable_snapshot_status(*status)
                    }
                    _ => false,
                };
                if !retry || attempt == crate::client::SNAPSHOT_UPLOAD_MAX_ATTEMPTS {
                    return result;
                }
                tokio::time::sleep(crate::client::snapshot_backoff_with_jitter(attempt)).await;
            }
            unreachable!("bounded upload loop returns on its final attempt")
        })
        .await
        .unwrap_or_else(|_| Err(DeviceSyncError::api(408, "Secure upload timed out")))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn backup_and_snapshot_downloads_keep_distinct_size_bounds() {
        let snapshot = ConnectTransferTransport::new(vec!["storage.test".into()]).unwrap();
        let backup = ConnectTransferTransport::with_limits(
            vec!["storage.test".into()],
            MAX_ENCRYPTED_BACKUP_BYTES,
            BACKUP_TRANSFER_TIMEOUT_SECONDS,
        )
        .unwrap();
        let expired = descriptor("https://blocked.test/object");
        assert!(snapshot
            .download(&expired, MAX_ENCRYPTED_SNAPSHOT_BYTES + 1, "unused")
            .await
            .unwrap_err()
            .to_string()
            .contains("Transfer size exceeds limit"));
        // An admitted size gets as far as the capability check, before any allocation/network I/O.
        assert!(backup
            .download(&expired, MAX_ENCRYPTED_BACKUP_BYTES, "unused")
            .await
            .unwrap_err()
            .to_string()
            .contains("Unapproved transfer destination"));
        assert!(backup
            .download(&expired, MAX_ENCRYPTED_BACKUP_BYTES + 1, "unused")
            .await
            .unwrap_err()
            .to_string()
            .contains("Transfer size exceeds limit"));
    }
    fn descriptor(url: &str) -> TransferDescriptor {
        TransferDescriptor {
            url: url.into(),
            method: "GET".into(),
            headers: BTreeMap::new(),
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        }
    }
    #[test]
    fn missing_destinations_have_a_distinct_configuration_error() {
        let transport = ConnectTransferTransport::new(vec![]).unwrap();
        assert!(transport
            .request(&descriptor("https://storage.test/object"), "GET")
            .unwrap_err()
            .to_string()
            .contains("not configured"));
    }

    #[test]
    fn signed_expiry_is_enforced_by_storage_not_the_device_clock() {
        let transport = ConnectTransferTransport::new(vec!["storage.test".into()]).unwrap();
        let mut old = descriptor("https://storage.test/object");
        old.expires_at = "2000-01-01T00:00:00Z".into();
        assert!(transport.request(&old, "GET").is_ok());
        old.expires_at = "invalid".into();
        assert!(transport.request(&old, "GET").is_err());
    }
    #[tokio::test]
    async fn payload_retry_reuses_bytes_and_stops_on_success_or_a_conditional_conflict() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (first_status, final_status) in [(Some(503), 201), (Some(503), 412), (None, 412)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let mut bodies = Vec::new();
                for status in [first_status, Some(final_status)] {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut data = Vec::new();
                    let body = loop {
                        let mut chunk = [0; 1024];
                        let n = stream.read(&mut chunk).await.unwrap();
                        assert!(n > 0);
                        data.extend_from_slice(&chunk[..n]);
                        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                            if data.len() >= end + 4 + 3 {
                                break data[end + 4..].to_vec();
                            }
                        }
                    };
                    bodies.push(body);
                    if let Some(status) = status {
                        stream.write_all(format!("HTTP/1.1 {status} response\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    }
                }
                bodies
            });
            let transport = ConnectTransferTransport::new(vec![]).unwrap();
            let request = transport
                .client
                .put(url)
                .body(vec![1, 2, 3])
                .build()
                .unwrap();
            let result = transport.send_upload(request).await;
            if final_status == 201 {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err().status_code(), Some(412));
            }
            assert_eq!(server.await.unwrap(), vec![vec![1, 2, 3], vec![1, 2, 3]]);
        }
    }
    #[tokio::test]
    async fn all_upload_retries_share_one_duration_budget() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let mut transport = ConnectTransferTransport::new(vec![]).unwrap();
        transport.timeout = Duration::from_millis(20);
        let request = transport
            .client
            .put(url)
            .body(vec![1, 2, 3])
            .build()
            .unwrap();
        assert_eq!(
            transport
                .send_upload(request)
                .await
                .unwrap_err()
                .status_code(),
            Some(408)
        );
        server.abort();
    }
    #[tokio::test]
    async fn checksum_header_is_bound_to_upload_bytes_before_network_io() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let transport = ConnectTransferTransport::new(vec!["storage.test".into()]).unwrap();
        let mut upload = descriptor("https://storage.test/object");
        upload.method = "PUT".into();
        upload.headers.insert("content-length".into(), "3".into());
        upload
            .headers
            .insert("x-amz-checksum-sha256".into(), STANDARD.encode([0u8; 32]));
        assert!(transport.request(&upload, "PUT").is_ok());
        let error = transport.upload(&upload, vec![1, 2, 3]).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("Transfer integrity verification failed"));
        assert!(transport.request(&upload, "GET").is_err());
        use sha2::{Digest, Sha256};
        let checksum = STANDARD.encode(Sha256::digest([1, 2, 3]));
        upload
            .headers
            .insert("x-amz-checksum-sha256".into(), checksum.clone());
        let request = transport.request(&upload, "PUT").unwrap().build().unwrap();
        assert_eq!(
            request.headers().get("x-amz-checksum-sha256").unwrap(),
            checksum.as_str()
        );
    }
    #[test]
    fn destination_and_headers_are_restricted_and_capabilities_redacted() {
        let transport = ConnectTransferTransport::new(vec!["storage.test".into()]).unwrap();
        assert!(!format!("{transport:?}").contains("storage.test"));
        let valid = descriptor("https://storage.test/object?secret=capability");
        assert!(transport.request(&valid, "GET").is_ok());
        assert!(!format!("{valid:?}").contains("capability"));
        for url in [
            "http://storage.test/object",
            "https://evil.test/object",
            "https://user@storage.test/object",
            "https://storage.test:444/object",
        ] {
            assert!(transport.request(&descriptor(url), "GET").is_err());
        }
        let mut poisoned = valid;
        poisoned
            .headers
            .insert("authorization".into(), "Bearer token".into());
        assert!(transport.request(&poisoned, "GET").is_err());
    }
}
