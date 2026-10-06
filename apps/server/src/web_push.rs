//! Web Push notifications for the self-hosted server (RFC 8030, 8291, 8292).
//!
//! A browser that opts in hands the server a push subscription: an endpoint on
//! its vendor's push service plus the keys used to encrypt messages for it.
//! The server signs each request with its own VAPID key, so no third-party
//! account or relay is involved, and payloads are end-to-end encrypted: the
//! push service carries ciphertext only.
//!
//! State lives in the existing `SecretStore` rather than a new table. Both the
//! VAPID private key and each subscription's `auth` secret are credentials, and
//! the server's secret store is already encrypted at rest when configured.

use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::{
    ecdsa::{signature::Signer as _, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint as _,
    PublicKey, SecretKey,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use wealthfolio_core::secrets::{SecretStore, WEB_PUSH_SUBSCRIPTIONS_KEY, WEB_PUSH_VAPID_KEY};
use web_push_native::{Auth, WebPushBuilder};

/// Push services reject encrypted payloads over 4096 bytes. Encryption adds
/// overhead, so the plaintext is capped with room to spare.
const MAX_PAYLOAD_BYTES: usize = 3072;
/// Bounds the stored subscription list; each browser profile is one entry.
const MAX_SUBSCRIPTIONS: usize = 50;
/// How long a push service should hold an undelivered message.
const MESSAGE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
/// A VAPID token may be valid for at most 24 hours (RFC 8292 §2); push
/// services reject longer ones.
const VAPID_TOKEN_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);
/// VAPID `sub` claim: a contact for the push service operator (RFC 8292 §2.1).
const DEFAULT_CONTACT: &str = "https://github.com/wealthfolio/wealthfolio";
const CONTACT_ENV: &str = "WF_WEB_PUSH_CONTACT";

/// Serializes read-modify-write of the stored subscription list. Without it,
/// two browsers subscribing at once each read the old list and the second
/// write drops the first subscription.
static SUBSCRIPTIONS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
/// Serializes first-use key creation. Two concurrent first requests would each
/// generate a key, and the second write would silently invalidate every
/// subscription made against the first.
static KEY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, thiserror::Error)]
pub enum WebPushError {
    #[error("{0}")]
    Invalid(String),
    #[error("Secret store error: {0}")]
    Store(String),
    #[error("Web push key error: {0}")]
    Key(String),
}

type Result<T> = std::result::Result<T, WebPushError>;

/// A browser `PushSubscription`, as produced by `PushSubscription.toJSON()`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// What a notification shows. `url` is a same-origin path opened on tap.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Notifications sharing a tag replace each other instead of stacking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    pub delivered: usize,
    /// Subscriptions the push service reported as gone; they were removed.
    pub removed: usize,
    pub failed: usize,
}

/// The server's VAPID public key as an uncompressed P-256 point, base64url,
/// ready for `pushManager.subscribe({ applicationServerKey })`. Creates the
/// key pair on first use.
pub fn public_key(store: &dyn SecretStore) -> Result<String> {
    Ok(encode_public_key(&load_or_create_key(store)?))
}

fn encode_public_key(key: &SecretKey) -> String {
    URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes())
}

pub async fn subscribe(store: &dyn SecretStore, subscription: PushSubscription) -> Result<()> {
    validate_subscription(&subscription)?;
    let _guard = SUBSCRIPTIONS_LOCK.lock().await;
    let mut subscriptions = load_subscriptions(store)?;
    subscriptions.retain(|existing| existing.endpoint != subscription.endpoint);
    if subscriptions.len() >= MAX_SUBSCRIPTIONS {
        return Err(WebPushError::Invalid(format!(
            "At most {MAX_SUBSCRIPTIONS} devices can receive notifications"
        )));
    }
    subscriptions.push(subscription);
    save_subscriptions(store, &subscriptions)
}

pub async fn unsubscribe(store: &dyn SecretStore, endpoint: &str) -> Result<()> {
    let _guard = SUBSCRIPTIONS_LOCK.lock().await;
    let mut subscriptions = load_subscriptions(store)?;
    let before = subscriptions.len();
    subscriptions.retain(|existing| existing.endpoint != endpoint);
    if subscriptions.len() != before {
        save_subscriptions(store, &subscriptions)?;
    }
    Ok(())
}

/// Delivers `payload` to every subscribed browser.
///
/// Subscriptions the push service reports as gone (404/410) are removed, so a
/// browser that revoked permission or cleared its data stops costing a request
/// on every send. The lock is not held across network calls; removal re-reads
/// the list so a subscription added mid-send survives.
pub async fn send(store: &dyn SecretStore, payload: &NotificationPayload) -> Result<SendReport> {
    validate_payload(payload)?;
    let body = serde_json::to_vec(payload)
        .map_err(|err| WebPushError::Invalid(format!("Invalid notification: {err}")))?;
    if body.len() > MAX_PAYLOAD_BYTES {
        return Err(WebPushError::Invalid(format!(
            "Notification exceeds {MAX_PAYLOAD_BYTES} bytes"
        )));
    }

    let key = load_or_create_key(store)?;
    let subscriptions = {
        let _guard = SUBSCRIPTIONS_LOCK.lock().await;
        load_subscriptions(store)?
    };
    let contact = std::env::var(CONTACT_ENV).unwrap_or_else(|_| DEFAULT_CONTACT.to_string());
    let client = wealthfolio_http::client_builder()
        .timeout(SEND_TIMEOUT)
        .build()
        .map_err(|err| WebPushError::Key(format!("HTTP client: {err}")))?;

    let mut report = SendReport::default();
    let mut gone: Vec<String> = Vec::new();
    for subscription in &subscriptions {
        match deliver(&client, &key, &contact, subscription, &body).await {
            Delivery::Delivered => report.delivered += 1,
            Delivery::Gone => gone.push(subscription.endpoint.clone()),
            Delivery::Failed => report.failed += 1,
        }
    }

    if !gone.is_empty() {
        let _guard = SUBSCRIPTIONS_LOCK.lock().await;
        let mut current = load_subscriptions(store)?;
        let before = current.len();
        current.retain(|existing| !gone.contains(&existing.endpoint));
        report.removed = before - current.len();
        save_subscriptions(store, &current)?;
    }
    // Counts only: endpoints are capability URLs and payloads may carry
    // financial detail, so neither is logged.
    tracing::info!(
        delivered = report.delivered,
        removed = report.removed,
        failed = report.failed,
        "Web push send finished"
    );
    Ok(report)
}

enum Delivery {
    Delivered,
    Gone,
    Failed,
}

async fn deliver(
    client: &reqwest::Client,
    key: &SecretKey,
    contact: &str,
    subscription: &PushSubscription,
    body: &[u8],
) -> Delivery {
    let request = match build_request(key, contact, subscription, body) {
        Ok(request) => request,
        Err(_) => return Delivery::Failed,
    };
    match client.execute(request).await {
        Ok(response) => match response.status().as_u16() {
            200..=299 => Delivery::Delivered,
            404 | 410 => Delivery::Gone,
            status => {
                tracing::warn!(status, "Web push service rejected a message");
                Delivery::Failed
            }
        },
        Err(err) => {
            tracing::warn!("Web push request failed: {}", err.without_url());
            Delivery::Failed
        }
    }
}

fn build_request(
    key: &SecretKey,
    contact: &str,
    subscription: &PushSubscription,
    body: &[u8],
) -> Result<reqwest::Request> {
    let endpoint = subscription
        .endpoint
        .parse()
        .map_err(|_| WebPushError::Invalid("Invalid push endpoint".into()))?;
    let (ua_public, ua_auth) = decode_keys(&subscription.keys)?;
    let mut request = WebPushBuilder::new(endpoint, ua_public, ua_auth)
        .with_valid_duration(MESSAGE_TTL)
        .build(body.to_vec())
        .map_err(|err| WebPushError::Key(err.to_string()))?;
    let authorization = vapid_authorization(key, &subscription.endpoint, contact)?;
    request.headers_mut().insert(
        axum::http::header::AUTHORIZATION,
        authorization
            .parse()
            .map_err(|_| WebPushError::Key("Invalid VAPID header".into()))?,
    );
    reqwest::Request::try_from(request).map_err(|err| WebPushError::Key(err.to_string()))
}

/// The VAPID `Authorization` header (RFC 8292 §3): an ES256 JWT whose audience
/// is the push service origin, plus the public key the browser subscribed with.
/// Signed with the P-256 support the workspace already builds, rather than
/// pulling in a general-purpose JWT library for a single fixed token shape.
fn vapid_authorization(key: &SecretKey, endpoint: &str, contact: &str) -> Result<String> {
    let audience = reqwest::Url::parse(endpoint)
        .map_err(|_| WebPushError::Invalid("Invalid push endpoint".into()))?
        .origin()
        .ascii_serialization();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| WebPushError::Key(err.to_string()))?
        + VAPID_TOKEN_LIFETIME;
    let claims = serde_json::json!({
        "aud": audience,
        "exp": expires.as_secs(),
        "sub": contact,
    });
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string()),
    );
    let signature: Signature = SigningKey::from(key).sign(signing_input.as_bytes());
    Ok(format!(
        "vapid t={signing_input}.{}, k={}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        encode_public_key(key),
    ))
}

fn decode_keys(keys: &PushSubscriptionKeys) -> Result<(PublicKey, Auth)> {
    let p256dh = URL_SAFE_NO_PAD
        .decode(keys.p256dh.trim_end_matches('='))
        .map_err(|_| WebPushError::Invalid("Invalid p256dh key encoding".into()))?;
    let public = PublicKey::from_sec1_bytes(&p256dh)
        .map_err(|_| WebPushError::Invalid("Invalid p256dh key".into()))?;
    let auth = URL_SAFE_NO_PAD
        .decode(keys.auth.trim_end_matches('='))
        .map_err(|_| WebPushError::Invalid("Invalid auth secret encoding".into()))?;
    if auth.len() != 16 {
        return Err(WebPushError::Invalid("Invalid auth secret length".into()));
    }
    Ok((public, Auth::clone_from_slice(&auth)))
}

/// The server POSTs to every stored endpoint, so an endpoint is an outbound
/// request target. Push services are public HTTPS hosts; anything else is
/// refused rather than fetched.
fn validate_subscription(subscription: &PushSubscription) -> Result<()> {
    let url = reqwest::Url::parse(&subscription.endpoint)
        .map_err(|_| WebPushError::Invalid("Invalid push endpoint".into()))?;
    if url.scheme() != "https" {
        return Err(WebPushError::Invalid(
            "Push endpoints must use HTTPS".into(),
        ));
    }
    // `domain()` is None for IP literals, which no push service uses.
    let domain = url
        .domain()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| WebPushError::Invalid("Push endpoint host is not allowed".into()))?;
    if domain == "localhost" || domain.ends_with(".localhost") || !domain.contains('.') {
        return Err(WebPushError::Invalid(
            "Push endpoint host is not allowed".into(),
        ));
    }
    if subscription.endpoint.len() > 2048 {
        return Err(WebPushError::Invalid("Push endpoint is too long".into()));
    }
    decode_keys(&subscription.keys).map(|_| ())
}

fn validate_payload(payload: &NotificationPayload) -> Result<()> {
    if payload.title.trim().is_empty() {
        return Err(WebPushError::Invalid(
            "Notification title is required".into(),
        ));
    }
    if let Some(url) = &payload.url {
        // Same-origin paths only: the service worker opens this on tap, and a
        // full URL would turn notifications into an open redirect.
        if !url.starts_with('/') || url.starts_with("//") || url.contains('\\') {
            return Err(WebPushError::Invalid(
                "Notification url must be a same-origin path".into(),
            ));
        }
    }
    Ok(())
}

fn load_or_create_key(store: &dyn SecretStore) -> Result<SecretKey> {
    let _guard = KEY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(encoded) = store
        .get_secret(WEB_PUSH_VAPID_KEY)
        .map_err(|err| WebPushError::Store(err.to_string()))?
    {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| WebPushError::Key("Stored VAPID key is corrupt".into()))?;
        return SecretKey::from_slice(&bytes)
            .map_err(|_| WebPushError::Key("Stored VAPID key is corrupt".into()));
    }
    let key = SecretKey::random(&mut rand::thread_rng());
    store
        .set_secret(WEB_PUSH_VAPID_KEY, &URL_SAFE_NO_PAD.encode(key.to_bytes()))
        .map_err(|err| WebPushError::Store(err.to_string()))?;
    Ok(key)
}

fn load_subscriptions(store: &dyn SecretStore) -> Result<Vec<PushSubscription>> {
    match store
        .get_secret(WEB_PUSH_SUBSCRIPTIONS_KEY)
        .map_err(|err| WebPushError::Store(err.to_string()))?
    {
        Some(json) => serde_json::from_str(&json)
            .map_err(|_| WebPushError::Store("Stored push subscriptions are corrupt".into())),
        None => Ok(Vec::new()),
    }
}

fn save_subscriptions(store: &dyn SecretStore, subscriptions: &[PushSubscription]) -> Result<()> {
    if subscriptions.is_empty() {
        return store
            .delete_secret(WEB_PUSH_SUBSCRIPTIONS_KEY)
            .map_err(|err| WebPushError::Store(err.to_string()));
    }
    let json =
        serde_json::to_string(subscriptions).map_err(|err| WebPushError::Store(err.to_string()))?;
    store
        .set_secret(WEB_PUSH_SUBSCRIPTIONS_KEY, &json)
        .map_err(|err| WebPushError::Store(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn set_secret(&self, service: &str, secret: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().insert(service.into(), secret.into());
            Ok(())
        }
        fn get_secret(&self, service: &str) -> wealthfolio_core::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(service).cloned())
        }
        fn delete_secret(&self, service: &str) -> wealthfolio_core::Result<()> {
            self.0.lock().unwrap().remove(service);
            Ok(())
        }
    }

    /// A real browser-shaped key pair, generated the way a user agent would.
    fn subscription(endpoint: &str) -> PushSubscription {
        let ua = SecretKey::random(&mut rand::thread_rng());
        let point = ua.public_key().to_sec1_bytes();
        PushSubscription {
            endpoint: endpoint.into(),
            keys: PushSubscriptionKeys {
                p256dh: URL_SAFE_NO_PAD.encode(point),
                auth: URL_SAFE_NO_PAD.encode([7u8; 16]),
            },
        }
    }

    #[test]
    fn public_key_is_created_once_and_is_an_uncompressed_point() {
        let store = MemoryStore::default();
        let first = public_key(&store).unwrap();
        let second = public_key(&store).unwrap();
        assert_eq!(first, second, "the key pair must persist across calls");
        let point = URL_SAFE_NO_PAD.decode(&first).unwrap();
        assert_eq!(point.len(), 65);
        assert_eq!(point[0], 0x04);
    }

    #[tokio::test]
    async fn subscribing_twice_replaces_rather_than_duplicates() {
        let store = MemoryStore::default();
        let endpoint = "https://fcm.googleapis.com/fcm/send/abc";
        subscribe(&store, subscription(endpoint)).await.unwrap();
        subscribe(&store, subscription(endpoint)).await.unwrap();
        assert_eq!(load_subscriptions(&store).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unsubscribing_the_last_device_clears_the_secret() {
        let store = MemoryStore::default();
        let endpoint = "https://updates.push.services.mozilla.com/wpush/v2/x";
        subscribe(&store, subscription(endpoint)).await.unwrap();
        unsubscribe(&store, endpoint).await.unwrap();
        assert!(store
            .get_secret(WEB_PUSH_SUBSCRIPTIONS_KEY)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn rejects_endpoints_that_are_not_public_https_hosts() {
        let store = MemoryStore::default();
        for endpoint in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://localhost/push",
            "https://127.0.0.1/push",
            "https://[::1]/push",
            "https://internal/push",
            "not a url",
        ] {
            assert!(
                subscribe(&store, subscription(endpoint)).await.is_err(),
                "{endpoint} should be rejected"
            );
        }
    }

    #[tokio::test]
    async fn rejects_malformed_keys() {
        let store = MemoryStore::default();
        let mut sub = subscription("https://fcm.googleapis.com/fcm/send/abc");
        sub.keys.auth = URL_SAFE_NO_PAD.encode([1u8; 8]);
        assert!(subscribe(&store, sub).await.is_err());
        let mut sub = subscription("https://fcm.googleapis.com/fcm/send/abc");
        sub.keys.p256dh = URL_SAFE_NO_PAD.encode([4u8; 65]);
        assert!(subscribe(&store, sub).await.is_err());
    }

    #[test]
    fn notification_urls_must_be_same_origin_paths() {
        let payload = |url: &str| NotificationPayload {
            title: "t".into(),
            body: "b".into(),
            url: Some(url.into()),
            tag: None,
        };
        assert!(validate_payload(&payload("/activities")).is_ok());
        for url in [
            "https://evil.example",
            "//evil.example",
            "/\\evil.example",
            "activities",
        ] {
            assert!(validate_payload(&payload(url)).is_err(), "{url}");
        }
    }

    #[test]
    fn built_requests_are_encrypted_and_vapid_signed() {
        let store = MemoryStore::default();
        let key = load_or_create_key(&store).unwrap();
        let sub = subscription("https://fcm.googleapis.com/fcm/send/abc");
        let request = build_request(&key, DEFAULT_CONTACT, &sub, b"{\"title\":\"hi\"}").unwrap();
        let headers = request.headers();
        assert_eq!(headers["content-encoding"], "aes128gcm");
        assert!(headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("vapid t="));
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        assert!(
            !body.windows(5).any(|w| w == b"title"),
            "payload must not travel in the clear"
        );
    }

    /// What a browser does on receipt: decrypt with its own private key. Proves
    /// the payload is addressed to this subscription, and that the VAPID token
    /// verifies against the public key the browser subscribed with.
    #[test]
    fn a_subscribed_browser_can_decrypt_the_payload_and_verify_the_sender() {
        use p256::ecdsa::{signature::Verifier as _, VerifyingKey};
        let store = MemoryStore::default();
        let key = load_or_create_key(&store).unwrap();
        let ua_secret = SecretKey::random(&mut rand::thread_rng());
        let auth = [9u8; 16];
        let sub = PushSubscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
            keys: PushSubscriptionKeys {
                p256dh: URL_SAFE_NO_PAD.encode(ua_secret.public_key().to_sec1_bytes()),
                auth: URL_SAFE_NO_PAD.encode(auth),
            },
        };
        let message = br#"{"title":"Over budget","body":"Dining is $40 over"}"#;
        let request = build_request(&key, DEFAULT_CONTACT, &sub, message).unwrap();

        // What the browser does on receipt: decrypt with its own private key.
        let ciphertext = request.body().and_then(|b| b.as_bytes()).unwrap().to_vec();
        let plaintext =
            web_push_native::decrypt(ciphertext, &ua_secret, &Auth::clone_from_slice(&auth))
                .unwrap();
        assert_eq!(plaintext, message);

        // What the push service does: verify the token against the key the
        // browser subscribed with, and check it is addressed to that service.
        let header = request.headers()["authorization"]
            .to_str()
            .unwrap()
            .to_owned();
        let token = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        let advertised = header.split("k=").nth(1).unwrap().trim();
        assert_eq!(advertised, public_key(&store).unwrap());

        let (signing_input, signature) = token.rsplit_once('.').unwrap();
        let verifier =
            VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(advertised).unwrap()).unwrap();
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
        verifier
            .verify(signing_input.as_bytes(), &signature)
            .expect("push services reject a token that does not verify");

        let claims: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(signing_input.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], DEFAULT_CONTACT);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let exp = claims["exp"].as_u64().unwrap();
        assert!(
            exp > now && exp <= now + 24 * 60 * 60,
            "exp must be within 24h"
        );
    }

    /// Push services answer 404/410 for a subscription the browser dropped.
    /// Those must be forgotten; a transient failure must not be. Uses a local
    /// stand-in push service, since real ones report "gone" only after a delay.
    #[tokio::test]
    async fn gone_subscriptions_are_pruned_and_failures_are_kept() {
        use axum::{http::StatusCode, routing::post, Router};
        let app = Router::new()
            .route("/delivered", post(|| async { StatusCode::CREATED }))
            .route("/gone", post(|| async { StatusCode::GONE }))
            .route("/missing", post(|| async { StatusCode::NOT_FOUND }))
            .route("/busy", post(|| async { StatusCode::TOO_MANY_REQUESTS }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // Stored directly: `subscribe` rightly refuses a loopback endpoint.
        let store = MemoryStore::default();
        let subs: Vec<_> = ["delivered", "gone", "missing", "busy"]
            .iter()
            .map(|path| subscription(&format!("{base}/{path}")))
            .collect();
        save_subscriptions(&store, &subs).unwrap();

        let payload = NotificationPayload {
            title: "t".into(),
            body: "b".into(),
            url: None,
            tag: None,
        };
        let report = send(&store, &payload).await.unwrap();
        assert_eq!(
            report,
            SendReport {
                delivered: 1,
                removed: 2,
                failed: 1
            }
        );
        let left: Vec<_> = load_subscriptions(&store)
            .unwrap()
            .into_iter()
            .map(|s| s.endpoint.rsplit('/').next().unwrap().to_string())
            .collect();
        assert_eq!(left, ["delivered", "busy"]);
    }

    #[tokio::test]
    async fn sending_with_no_subscriptions_is_a_no_op() {
        let store = MemoryStore::default();
        let payload = NotificationPayload {
            title: "Wealthfolio".into(),
            body: "test".into(),
            url: None,
            tag: None,
        };
        assert_eq!(send(&store, &payload).await.unwrap(), SendReport::default());
    }
}
