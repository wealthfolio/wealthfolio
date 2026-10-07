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
use std::{collections::BTreeMap, time::Duration};

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
}
impl std::fmt::Debug for ConnectTransferTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectTransferTransport")
            .finish_non_exhaustive()
    }
}
impl ConnectTransferTransport {
    pub fn new(hosts: Vec<String>) -> Result<Self> {
        Self::with_limits(
            hosts,
            MAX_ENCRYPTED_SNAPSHOT_BYTES,
            SNAPSHOT_TRANSFER_TIMEOUT_SECONDS,
        )
    }
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
        Self::with_limits(
            hosts
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            max_bytes,
            timeout_seconds,
        )
    }
    fn request(
        &self,
        descriptor: &TransferDescriptor,
        method: &str,
    ) -> Result<reqwest::RequestBuilder> {
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
        let expiry = chrono::DateTime::parse_from_rfc3339(&descriptor.expires_at)
            .map_err(|_| DeviceSyncError::invalid_request("Invalid transfer expiration"))?;
        if expiry.timestamp() <= chrono::Utc::now().timestamp() {
            return Err(DeviceSyncError::invalid_request(
                "Transfer capability expired",
            ));
        }
        let mut request = self.client.request(
            if method == "GET" {
                reqwest::Method::GET
            } else {
                reqwest::Method::PUT
            },
            url,
        );
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
        let response = self
            .request(descriptor, "PUT")?
            .body(bytes)
            .send()
            .await
            .map_err(|e| DeviceSyncError::Http(e.without_url()))?;
        if !response.status().is_success() {
            return Err(DeviceSyncError::api(
                response.status().as_u16(),
                "Secure upload failed",
            ));
        }
        Ok(())
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
        let mut expired = descriptor("https://storage.test/object");
        expired.expires_at = "2000-01-01T00:00:00Z".into();
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
            .contains("Transfer capability expired"));
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
