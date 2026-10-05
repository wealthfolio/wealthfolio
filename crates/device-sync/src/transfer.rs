//! Isolated ciphertext transport: no API authorization, cookies, redirects, or URL logging.
use crate::{crypto::sha256_checksum, DeviceSyncError, Result};
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
}
impl std::fmt::Debug for ConnectTransferTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectTransferTransport")
            .finish_non_exhaustive()
    }
}
impl ConnectTransferTransport {
    pub fn new(hosts: Vec<String>) -> Result<Self> {
        let client = wealthfolio_http::client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self { hosts, client })
    }
    pub fn configured() -> Result<Self> {
        let hosts = std::env::var("CONNECT_STORAGE_ALLOWED_HOSTS")
            .ok()
            .or_else(|| option_env!("CONNECT_STORAGE_ALLOWED_HOSTS").map(str::to_string))
            .unwrap_or_default();
        Self::new(
            hosts
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
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
                "content-type" | "content-length" | "if-none-match"
            ) {
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
        if size == 0 || size > crate::backups::MAX_ENCRYPTED_BYTES {
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
            || bytes.len() > crate::backups::MAX_ENCRYPTED_BYTES
            || descriptor.headers.get("content-length") != Some(&bytes.len().to_string())
        {
            return Err(DeviceSyncError::invalid_request("Transfer size mismatch"));
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
    fn descriptor(url: &str) -> TransferDescriptor {
        TransferDescriptor {
            url: url.into(),
            method: "GET".into(),
            headers: BTreeMap::new(),
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        }
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
