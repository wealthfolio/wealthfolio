//! Settings module - application settings management.

mod settings_model;
mod settings_service;
mod settings_traits;

pub use settings_model::*;
pub use settings_service::{SettingsService, SettingsServiceTrait};
pub use settings_traits::SettingsRepositoryTrait;

pub const SETTING_BASE_CURRENCY: &str = "base_currency";
pub const SETTING_TIMEZONE: &str = "timezone";
