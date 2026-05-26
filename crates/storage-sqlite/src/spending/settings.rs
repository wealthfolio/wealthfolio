//! Storage adapter for `wealthfolio-spending::settings`.
//! Backed by the existing `app_settings` k/v table.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use diesel::prelude::*;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::app_settings::dsl::*;
use crate::settings::model::AppSettingDB;
use wealthfolio_spending::settings::SpendingSettingsRepositoryTrait;

pub struct SpendingSettingsRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl SpendingSettingsRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl SpendingSettingsRepositoryTrait for SpendingSettingsRepository {
    async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut conn = get_connection(&self.pool).map_err(|e| anyhow::anyhow!(e))?;
        let value = app_settings
            .filter(setting_key.eq(key))
            .select(setting_value)
            .first::<String>(&mut conn)
            .optional()
            .map_err(StorageError::from)
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(value)
    }

    async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.set_settings(vec![(key.to_string(), value.to_string())])
            .await
    }

    async fn set_settings(&self, values: Vec<(String, String)>) -> Result<()> {
        let rows: Vec<AppSettingDB> = values
            .into_iter()
            .map(|(key, value)| AppSettingDB {
                setting_key: key,
                setting_value: value,
            })
            .collect();
        self.writer
            .exec_tx(move |tx| {
                for row in rows {
                    diesel::replace_into(app_settings)
                        .values(&row)
                        .execute(tx.conn())
                        .map_err(StorageError::from)?;
                    tx.update(&row)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        Ok(())
    }
}
