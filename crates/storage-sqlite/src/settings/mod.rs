//! SQLite storage implementation for settings.

pub mod model;
mod repository;

pub use model::AppSettingDB;
pub use repository::SettingsRepository;

// Re-export trait from core for convenience
pub use wealthfolio_core::settings::SettingsRepositoryTrait;
