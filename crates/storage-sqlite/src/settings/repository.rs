use async_trait::async_trait;
use diesel::prelude::*;
use std::sync::Arc;

use super::model::AppSettingDB;
use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::app_settings::dsl::*;
use crate::schema::{accounts, assets};
use wealthfolio_core::assets::AssetKind;
use wealthfolio_core::errors::Result;
use wealthfolio_core::settings::{Settings, SettingsRepositoryTrait, SettingsUpdate};

pub struct SettingsRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl SettingsRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        SettingsRepository { pool, writer }
    }
}

// Implement the trait for SettingsRepository
#[async_trait]
impl SettingsRepositoryTrait for SettingsRepository {
    fn get_settings(&self) -> Result<Settings> {
        let mut conn = get_connection(&self.pool)?;
        let all_settings: Vec<(String, String)> = app_settings
            .select((setting_key, setting_value))
            .load::<(String, String)>(&mut conn)
            .map_err(StorageError::from)?;

        let mut settings = Settings::default(); // Use default implementation

        for (key, value) in all_settings {
            match key.as_str() {
                "theme" => settings.theme = value,
                "font" => settings.font = value,
                "language" => settings.language = value,
                "base_currency" => settings.base_currency = value,
                "timezone" => settings.timezone = value,
                "onboarding_completed" => {
                    settings.onboarding_completed = value.parse().unwrap_or(false);
                }
                "auto_update_check_enabled" => {
                    settings.auto_update_check_enabled = value.parse().unwrap_or(true);
                }
                "menu_bar_visible" => {
                    settings.menu_bar_visible = value.parse().unwrap_or(true);
                }
                "sync_enabled" => {
                    settings.sync_enabled = value.parse().unwrap_or(true);
                }
                "default_return_metric" => settings.default_return_metric = value,
                _ => {} // Ignore unknown settings
            }
        }

        Ok(settings)
    }

    async fn update_settings(&self, new_settings: &SettingsUpdate) -> Result<()> {
        let settings = new_settings.clone();
        self.writer
            .exec(move |conn| {
                if let Some(ref theme) = settings.theme {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "theme".to_string(),
                            setting_value: theme.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(ref font) = settings.font {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "font".to_string(),
                            setting_value: font.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(ref language) = settings.language {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "language".to_string(),
                            setting_value: language.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(ref base_currency) = settings.base_currency {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "base_currency".to_string(),
                            setting_value: base_currency.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(ref timezone) = settings.timezone {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "timezone".to_string(),
                            setting_value: timezone.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(onboarding_completed) = settings.onboarding_completed {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "onboarding_completed".to_string(),
                            setting_value: onboarding_completed.to_string(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(auto_update_check_enabled) = settings.auto_update_check_enabled {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "auto_update_check_enabled".to_string(),
                            setting_value: auto_update_check_enabled.to_string(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(menu_bar_visible) = settings.menu_bar_visible {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "menu_bar_visible".to_string(),
                            setting_value: menu_bar_visible.to_string(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(sync_enabled) = settings.sync_enabled {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "sync_enabled".to_string(),
                            setting_value: sync_enabled.to_string(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                if let Some(ref default_return_metric) = settings.default_return_metric {
                    diesel::replace_into(app_settings)
                        .values(&AppSettingDB {
                            setting_key: "default_return_metric".to_string(),
                            setting_value: default_return_metric.clone(),
                        })
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }

                Ok(())
            })
            .await
    }

    fn get_setting(&self, setting_key_param: &str) -> Result<String> {
        let mut conn = get_connection(&self.pool)?;
        let result = app_settings
            .filter(setting_key.eq(setting_key_param))
            .select(setting_value)
            .first(&mut conn);

        match result {
            Ok(value) => Ok(value),
            Err(diesel::result::Error::NotFound) => {
                // Return default values for known settings
                let default_value = match setting_key_param {
                    "theme" => "light",
                    "font" => "font-mono",
                    "language" => "en",
                    "timezone" => "",
                    "onboarding_completed" => "false",
                    "auto_update_check_enabled" => "true",
                    "menu_bar_visible" => "true",
                    "sync_enabled" => "true",
                    "default_return_metric" => "twr",
                    _ => return Err(StorageError::from(diesel::result::Error::NotFound).into()),
                };
                Ok(default_value.to_string())
            }
            Err(e) => Err(StorageError::from(e).into()),
        }
    }

    async fn update_setting(
        &self,
        setting_key_param: &str,
        setting_value_param: &str,
    ) -> Result<()> {
        let key = setting_key_param.to_string();
        let value = setting_value_param.to_string();

        self.writer
            .exec(move |conn| {
                diesel::replace_into(app_settings)
                    .values(AppSettingDB {
                        setting_key: key.clone(),     // Ensure key is cloned if used after move
                        setting_value: value.clone(), // Ensure value is cloned if used after move
                    })
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    fn get_distinct_currencies_excluding_base(&self, base_currency: &str) -> Result<Vec<String>> {
        let mut conn = get_connection(&self.pool)?;

        let currency_assets: Vec<String> = assets::table
            .filter(assets::kind.eq(AssetKind::Fx.as_db_str()))
            .filter(assets::quote_ccy.ne(base_currency))
            .select(assets::quote_ccy)
            .distinct()
            .load::<String>(&mut conn)
            .map_err(StorageError::from)?;

        let account_currencies: Vec<String> = accounts::table
            .filter(accounts::currency.ne(base_currency))
            .select(accounts::currency)
            .distinct()
            .load::<String>(&mut conn)
            .map_err(StorageError::from)?;

        let mut all_currencies: Vec<String> = Vec::new();
        all_currencies.extend(currency_assets);
        all_currencies.extend(account_currencies);
        all_currencies.sort();
        all_currencies.dedup();

        Ok(all_currencies)
    }
}
