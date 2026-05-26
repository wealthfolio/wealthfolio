//! Spending-tracker settings: enable toggle + opted-in account list.
//! Stored in the existing `app_settings` k/v table:
//!   - `spending.enabled`         → "true" | "false"
//!   - `spending.account_ids`     → JSON array of opted-in spending account IDs

pub mod model;
pub mod service;
pub mod traits;

pub use model::{SpendingSettings, SpendingSettingsUpdate};
pub use service::SpendingSettingsService;
pub use traits::SpendingSettingsRepositoryTrait;

pub const SETTING_KEY_ENABLED: &str = "spending.enabled";
pub const SETTING_KEY_ACCOUNT_IDS: &str = "spending.account_ids";
