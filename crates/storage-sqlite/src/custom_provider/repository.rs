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
use wealthfolio_core::errors::{Result, ValidationError};

/// JSON wrapper stored in custom_providers.config
///
/// The fallback flag lives here rather than in a column because sync rejects rows
/// with columns an older peer doesn't know.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    sources: Vec<NewCustomProviderSource>,
    /// Absent on rows saved before the setting existed. Those providers already served
    /// as fallbacks, so absence reads as `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    use_as_fallback: Option<bool>,
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

/// Parse the config JSON column, falling back to an empty config.
fn parse_config(config_json: Option<&str>, provider_code: &str) -> ProviderConfig {
    match config_json {
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
    }
}

/// Convert stored source definitions into domain sources.
fn to_domain_sources(
    sources: Vec<NewCustomProviderSource>,
    provider_code: &str,
) -> Vec<CustomProviderSource> {
    sources
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

fn config_to_json(config: &ProviderConfig) -> String {
    serde_json::to_string(config).unwrap_or_else(|e| {
        warn!("Failed to serialize provider config: {}", e);
        r#"{"sources":[]}"#.to_string()
    })
}

fn db_to_domain(row: CustomProviderDB) -> CustomProviderWithSources {
    let config = parse_config(row.config.as_deref(), &row.code);
    CustomProviderWithSources {
        use_as_fallback: config.use_as_fallback.unwrap_or(true),
        sources: to_domain_sources(config.sources, &row.code),
        id: row.code,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        priority: row.priority,
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
                let config = parse_config(r.config.as_deref(), provider_code);
                Ok(to_domain_sources(config.sources, provider_code)
                    .into_iter()
                    .find(|s| s.kind == kind))
            }
            _ => Ok(None),
        }
    }

    async fn create(&self, payload: &NewCustomProvider) -> Result<CustomProviderWithSources> {
        let code = payload.code.clone();
        let name = payload.name.clone();
        let description = payload.description.clone().unwrap_or_default();
        let config_json = config_to_json(&ProviderConfig {
            sources: payload.sources.clone(),
            use_as_fallback: Some(payload.use_as_fallback.unwrap_or(false)),
        });
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
                let new_config = if payload.sources.is_none() && payload.use_as_fallback.is_none() {
                    existing.config
                } else {
                    let stored = existing.config.as_deref();
                    let mut config = match (&payload.sources, stored) {
                        // New sources replace the stored ones, so an unreadable config can go.
                        (Some(_), _) => stored
                            .and_then(|raw| serde_json::from_str::<ProviderConfig>(raw).ok())
                            .unwrap_or_default(),
                        (None, None) => ProviderConfig::default(),
                        (None, Some(raw)) => serde_json::from_str(raw).map_err(|e| {
                            ValidationError::InvalidInput(format!(
                                "Stored config for provider '{}' is unreadable; save its \
                                 sources again before changing fallback use: {}",
                                code, e
                            ))
                        })?,
                    };
                    if let Some(sources) = &payload.sources {
                        config.sources = sources.clone();
                    }
                    if let Some(use_as_fallback) = payload.use_as_fallback {
                        config.use_as_fallback = Some(use_as_fallback);
                    }
                    Some(config_to_json(&config))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{create_pool, run_migrations, write_actor::spawn_writer};
    use tempfile::tempdir;

    fn create_test_repository() -> (CustomProviderSqliteRepository, tempfile::TempDir) {
        std::env::set_var("CONNECT_API_URL", "http://test.local");
        let temp_dir = tempdir().expect("Failed to create temp directory");
        let db_path = temp_dir.path().join("test.db");
        let db_path_str = db_path.to_string_lossy().to_string();
        run_migrations(&db_path_str).expect("Failed to run migrations");
        let pool = create_pool(&db_path_str).expect("Failed to create pool");
        let writer = spawn_writer((*pool).clone()).expect("Failed to spawn writer actor");
        (CustomProviderSqliteRepository::new(pool, writer), temp_dir)
    }

    fn latest_source(url: &str) -> NewCustomProviderSource {
        serde_json::from_value(serde_json::json!({
            "kind": "latest",
            "format": "json",
            "url": url,
            "pricePath": "$.price",
        }))
        .expect("valid source")
    }

    fn new_provider(code: &str, use_as_fallback: Option<bool>) -> NewCustomProvider {
        NewCustomProvider {
            code: code.to_string(),
            name: code.to_string(),
            description: None,
            priority: None,
            use_as_fallback,
            sources: vec![latest_source("https://fund.test/{ISIN}")],
        }
    }

    fn update(
        use_as_fallback: Option<bool>,
        sources: Option<Vec<NewCustomProviderSource>>,
    ) -> UpdateCustomProvider {
        UpdateCustomProvider {
            name: None,
            description: None,
            enabled: None,
            priority: None,
            use_as_fallback,
            sources,
        }
    }

    fn insert_raw_config(repo: &CustomProviderSqliteRepository, code: &str, config: &str) {
        let mut conn = get_connection(&repo.pool).expect("get conn");
        diesel::sql_query(
            "INSERT INTO market_data_custom_providers \
             (id, code, name, config, created_at, updated_at) \
             VALUES (?1, ?2, ?2, ?3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind::<diesel::sql_types::Text, _>(format!("{code}-id"))
        .bind::<diesel::sql_types::Text, _>(code)
        .bind::<diesel::sql_types::Text, _>(config)
        .execute(&mut conn)
        .expect("insert raw provider");
    }

    fn stored_config(repo: &CustomProviderSqliteRepository, code: &str) -> Option<String> {
        let mut conn = get_connection(&repo.pool).expect("get conn");
        custom_providers::table
            .filter(custom_providers::code.eq(code))
            .select(custom_providers::config)
            .first(&mut conn)
            .expect("stored provider")
    }

    #[tokio::test]
    async fn new_providers_serve_only_assigned_securities_by_default() {
        let (repo, _dir) = create_test_repository();

        let created = repo.create(&new_provider("fund", None)).await.unwrap();

        assert!(!created.use_as_fallback);
        assert!(!repo.get_all().unwrap()[0].use_as_fallback);
    }

    #[tokio::test]
    async fn providers_saved_before_the_setting_keep_serving_as_fallbacks() {
        let (repo, _dir) = create_test_repository();
        insert_raw_config(
            &repo,
            "legacy",
            r#"{"sources":[{"kind":"latest","format":"json","url":"https://x.test/{SYMBOL}","pricePath":"$.price"}]}"#,
        );

        let provider = repo.get_all().unwrap().remove(0);

        assert!(provider.use_as_fallback);
        assert_eq!(provider.sources.len(), 1);
    }

    #[tokio::test]
    async fn changing_fallback_use_keeps_sources_and_editing_sources_keeps_the_flag() {
        let (repo, _dir) = create_test_repository();
        repo.create(&new_provider("fund", Some(false)))
            .await
            .unwrap();

        let toggled = repo
            .update("fund", &update(Some(true), None))
            .await
            .unwrap();
        assert!(toggled.use_as_fallback);
        assert_eq!(toggled.sources[0].url, "https://fund.test/{ISIN}");

        let edited = repo
            .update(
                "fund",
                &update(
                    None,
                    Some(vec![latest_source("https://fund.test/v2/{ISIN}")]),
                ),
            )
            .await
            .unwrap();
        assert!(edited.use_as_fallback);
        assert_eq!(edited.sources[0].url, "https://fund.test/v2/{ISIN}");
        assert!(repo.get_all().unwrap()[0].use_as_fallback);
    }

    #[tokio::test]
    async fn changing_fallback_use_refuses_to_overwrite_an_unreadable_config() {
        let (repo, _dir) = create_test_repository();
        insert_raw_config(&repo, "broken", "not json");

        let result = repo.update("broken", &update(Some(false), None)).await;

        assert!(result.is_err());
        assert_eq!(stored_config(&repo, "broken").as_deref(), Some("not json"));
    }
}
