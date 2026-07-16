//! Wealthfolio Device Sync - Cloud-based device synchronization for Wealthfolio.
//!
//! This crate provides the API client and types for device enrollment, pairing,
//! and E2EE synchronization via the Wealthfolio Connect cloud service.
//!
//! # Usage
//!
//! ```rust,ignore
//! use wealthfolio_device_sync::{DeviceSyncClient, RegisterDeviceRequest, EnrollDeviceResponse};
//!
//! let client = DeviceSyncClient::new("https://api.wealthfolio.app");
//! let result = client.enroll_device(
//!     "access_token",
//!     RegisterDeviceRequest {
//!         device_nonce: "random-device-nonce".to_string(),
//!         display_name: "My Device".to_string(),
//!         platform: "mac".to_string(),
//!         os_version: Some("15.2".to_string()),
//!         app_version: Some("3.0.0".to_string()),
//!     },
//! ).await?;
//!
//! // Handle the enrollment result
//! match result {
//!     EnrollDeviceResponse::Bootstrap { device_id, .. } => {
//!         // First device - initialize team keys
//!     }
//!     EnrollDeviceResponse::Pair { device_id, trusted_devices, .. } => {
//!         // Device needs to pair with an existing trusted device
//!     }
//!     EnrollDeviceResponse::Ready { device_id, .. } => {
//!         // Device is already trusted
//!     }
//! }
//! ```

mod client;
pub mod crypto;
pub mod engine;
mod enroll_service;
mod error;
mod time;
mod types;

pub use client::DeviceSyncClient;
pub use enroll_service::{
    DeviceEnrollService, EnableSyncResult, EnrollServiceError, SyncIdentity, SyncState,
    SyncStateResult,
};
pub use error::{ApiRetryClass, DeviceSyncError, Result};
pub use time::{normalize_sync_datetime, parse_sync_datetime_to_utc};
pub use types::*;
