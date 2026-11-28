//! Settings module - application settings management.

mod settings_model;
mod settings_service;
mod settings_traits;
mod tax_year;

pub use settings_model::*;
pub use settings_service::{SettingsService, SettingsServiceTrait};
pub use settings_traits::SettingsRepositoryTrait;
pub use tax_year::{TaxYearStart, DEFAULT_TAX_YEAR_START, TAX_YEAR_START_KEY};

pub const SETTING_BASE_CURRENCY: &str = "base_currency";
pub const SETTING_TIMEZONE: &str = "timezone";
