use async_trait::async_trait;
use chrono::Utc;
use diesel::prelude::*;
use log::warn;
use std::sync::Arc;
use uuid::Uuid;

use crate::custom_provider::model::CustomProviderDB;
use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::{IntoCore, StorageError};
use crate::schema::market_data_custom_providers as custom_providers;

use wealthfolio_core::custom_provider::{
    CustomProviderRepository, CustomProviderSource, CustomProviderWithSources, NewCustomProvider,
    NewCustomProviderSource, UpdateCustomProvider,
};
use wealthfolio_core::errors::Result;

/// JSON wrapper stored in custom_providers.config
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct ProviderConfig {
    sources: Vec<NewCustomProviderSource>,
}

pub struct CustomProviderSqliteRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl CustomProviderSqliteRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

/// Parse the config JSON column into sources.
fn parse_sources(config_json: Option<&str>, provider_code: &str) -> Vec<CustomProviderSource> {
    let config: ProviderConfig = match config_json {
        Some(s) => match serde_json::from_str(s) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Failed to parse config JSON for provider '{}': {}",
                    provider_code, e
                );
                ProviderConfig::default()
            }
        },
        None => ProviderConfig::default(),
    };

    config
        .sources
        .into_iter()
        .map(|s| CustomProviderSource {
            id: format!("{}:{}", provider_code, s.kind),
            provider_id: provider_code.to_string(),
            kind: s.kind,
            format: s.format,
            url: s.url,
            price_path: s.price_path,
            date_path: s.date_path,
            date_format: s.date_format,
            currency_path: s.currency_path,
            factor: s.factor,
            invert: s.invert,
            locale: s.locale,
            headers: s.headers,
            method: s.method,
            body: s.body,
            open_path: s.open_path,
            high_path: s.high_path,
            low_path: s.low_path,
            volume_path: s.volume_path,
            default_price: s.default_price,
            date_timezone: s.date_timezone,
        })
        .collect()
}

fn sources_to_config_json(sources: &[NewCustomProviderSource]) -> String {
    let config = ProviderConfig {
        sources: sources.to_vec(),
    };
    serde_json::to_string(&config).unwrap_or_else(|e| {
        warn!("Failed to serialize provider config: {}", e);
        r#"{"sources":[]}"#.to_string()
    })
}

fn db_to_domain(row: CustomProviderDB) -> CustomProviderWithSources {
    let sources = parse_sources(row.config.as_deref(), &row.code);
    CustomProviderWithSources {
        id: row.code,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        priority: row.priority,
        sources,
    }
}

#[async_trait]
impl CustomProviderRepository for CustomProviderSqliteRepository {
    fn get_all(&self) -> Result<Vec<CustomProviderWithSources>> {
        let mut conn = get_connection(&self.pool)?;

        let rows: Vec<CustomProviderDB> = custom_providers::table
            .order(custom_providers::priority.asc())
            .select(CustomProviderDB::as_select())
            .load(&mut conn)
            .into_core()?;

        Ok(rows.into_iter().map(db_to_domain).collect())
    }

    fn get_source_by_kind(
        &self,
        provider_code: &str,
        kind: &str,
    ) -> Result<Option<CustomProviderSource>> {
        let mut conn = get_connection(&self.pool)?;

        let row: Option<CustomProviderDB> = custom_providers::table
            .filter(custom_providers::code.eq(provider_code))
            .select(CustomProviderDB::as_select())
            .first(&mut conn)
            .optional()
            .into_core()?;

        match row {
            Some(r) if r.enabled => {
                let sources = parse_sources(r.config.as_deref(), provider_code);
                Ok(sources.into_iter().find(|s| s.kind == kind))
            }
            _ => Ok(None),
        }
    }

    async fn create(&self, payload: &NewCustomProvider) -> Result<CustomProviderWithSources> {
        let code = payload.code.clone();
        let name = payload.name.clone();
        let description = payload.description.clone().unwrap_or_default();
        let config_json = sources_to_config_json(&payload.sources);
        let now = Utc::now().to_rfc3339();

        let row = CustomProviderDB {
            id: Uuid::new_v4().to_string(),
            code: code.clone(),
            name,
            description,
            enabled: true,
            priority: payload.priority.unwrap_or(50),
            config: Some(config_json),
            created_at: now.clone(),
            updated_at: now,
        };

        let row_clone = row.clone();
        self.writer
            .exec_tx(move |tx| {
                diesel::insert_into(custom_providers::table)
                    .values(&row_clone)
                    .execute(tx.conn())
                    .map_err(StorageError::QueryFailed)?;
                tx.insert(&row_clone)?;
                Ok(())
            })
            .await?;

        Ok(db_to_domain(row))
    }

    async fn update(
        &self,
        provider_code: &str,
        payload: &UpdateCustomProvider,
    ) -> Result<CustomProviderWithSources> {
        let code = provider_code.to_string();
        let payload = payload.clone();

        self.writer
            .exec_tx(move |tx| {
                // Load current row
                let existing: CustomProviderDB = custom_providers::table
                    .filter(custom_providers::code.eq(&code))
                    .select(CustomProviderDB::as_select())
                    .first(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                let now = Utc::now().to_rfc3339();

                let new_name = payload.name.unwrap_or(existing.name);
                let new_desc = payload.description.unwrap_or(existing.description);
                let new_enabled = payload.enabled.unwrap_or(existing.enabled);
                let new_priority = payload.priority.unwrap_or(existing.priority);
                let new_config = match &payload.sources {
                    Some(sources) => Some(sources_to_config_json(sources)),
                    None => existing.config,
                };

                diesel::update(custom_providers::table.filter(custom_providers::code.eq(&code)))
                    .set((
                        custom_providers::name.eq(&new_name),
                        custom_providers::description.eq(&new_desc),
                        custom_providers::enabled.eq(new_enabled),
                        custom_providers::priority.eq(new_priority),
                        custom_providers::config.eq(&new_config),
                        custom_providers::updated_at.eq(&now),
                    ))
                    .execute(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                let updated = CustomProviderDB {
                    id: existing.id,
                    code: code.clone(),
                    name: new_name,
                    description: new_desc,
                    enabled: new_enabled,
                    priority: new_priority,
                    config: new_config,
                    created_at: existing.created_at,
                    updated_at: now,
                };

                tx.update(&updated)?;

                Ok(db_to_domain(updated))
            })
            .await
    }

    async fn delete(&self, provider_code: &str) -> Result<()> {
        let code = provider_code.to_string();
        self.writer
            .exec_tx(move |tx| {
                let existing: CustomProviderDB = custom_providers::table
                    .filter(custom_providers::code.eq(&code))
                    .select(CustomProviderDB::as_select())
                    .first(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                diesel::delete(custom_providers::table.filter(custom_providers::code.eq(&code)))
                    .execute(tx.conn())
                    .map_err(StorageError::QueryFailed)?;

                tx.delete_model(&existing);
                Ok(())
            })
            .await
    }

    fn get_asset_count_for_provider(&self, provider_code: &str) -> Result<i64> {
        use diesel::sql_types::{BigInt, Text};

        let mut conn = get_connection(&self.pool)?;

        #[derive(QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = BigInt)]
            cnt: i64,
        }

        let escaped_code = provider_code.replace('%', "\\%").replace('_', "\\_");
        let override_pattern = format!("%\"CUSTOM:{}\":%", escaped_code);
        let row: CountRow = diesel::sql_query(
            "SELECT COUNT(*) as cnt FROM assets WHERE \
             json_extract(provider_config, '$.custom_provider_code') = ?1 \
             OR provider_config LIKE ?2 ESCAPE '\\'",
        )
        .bind::<Text, _>(provider_code)
        .bind::<Text, _>(&override_pattern)
        .get_result(&mut conn)
        .into_core()?;

        Ok(row.cnt)
    }
}
