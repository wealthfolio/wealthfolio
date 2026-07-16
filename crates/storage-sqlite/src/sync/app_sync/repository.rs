//! Repository for app-side device sync tables.

use chrono::{DateTime, Duration, Utc};
use diesel::prelude::*;
use diesel::r2d2::{self, Pool};
use diesel::sqlite::SqliteConnection;
use rust_decimal::Decimal;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

use wealthfolio_core::constants::DECIMAL_PRECISION;
use wealthfolio_core::errors::{DatabaseError, Error, Result};
use wealthfolio_core::portfolio::snapshot::Position;
use wealthfolio_core::sync::{
    should_apply_lww, SyncEngineStatus, SyncEntity, SyncEntityMetadata, SyncOperation,
    SyncOutboxEvent, SyncOutboxStatus, APP_SYNC_TABLES,
};

use crate::addons::addon_storage_id;
use crate::db::{get_connection, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{
    addon_storage, spending_preset_rule_deletions, sync_applied_events, sync_cursor,
    sync_device_config, sync_engine_state, sync_entity_metadata, sync_outbox, sync_table_state,
};
use crate::spending::deterministic_ids::preset_rule_deletion_id;
use crate::sync::broker_activity_patch::{
    apply_broker_activity_user_patch_tx, BrokerActivityUserPatchApplyOutcome,
};

use super::model::{
    SyncAppliedEventDB, SyncCursorDB, SyncDeviceConfigDB, SyncEngineStateDB, SyncEntityMetadataDB,
    SyncOutboxEventDB, SyncTableStateDB,
};
use super::outbox_models::is_syncable_spending_setting_key;

fn enum_to_db<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?.trim_matches('"').to_string())
}

fn enum_from_db<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    Ok(serde_json::from_str(&format!("\"{}\"", value))?)
}

fn validate_sync_table(table: &str) -> Result<()> {
    if APP_SYNC_TABLES.contains(&table) {
        return Ok(());
    }
    Err(Error::Database(DatabaseError::Internal(format!(
        "Unsupported sync table '{}'",
        table
    ))))
}

fn canonical_sync_table_set(tables: Vec<String>) -> Result<Vec<String>> {
    if tables.is_empty() {
        return Ok(APP_SYNC_TABLES.iter().map(|t| t.to_string()).collect());
    }

    let requested = tables.into_iter().collect::<HashSet<_>>();
    for table in &requested {
        validate_sync_table(table)?;
    }

    Ok(APP_SYNC_TABLES
        .iter()
        .filter(|table| requested.contains::<str>(*table))
        .map(|table| table.to_string())
        .collect())
}

#[derive(Clone)]
struct PayloadColumnCatalog {
    writable: HashSet<String>,
    readonly: HashSet<String>,
}

fn payload_column_catalog_cache() -> &'static Mutex<HashMap<String, PayloadColumnCatalog>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PayloadColumnCatalog>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn escape_sqlite_str(value: &str) -> String {
    value.replace('\'', "''")
}

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

#[derive(diesel::QueryableByName)]
struct PragmaTableInfoRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    name: String,
}

#[derive(diesel::QueryableByName)]
struct PragmaTableXInfoRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    name: String,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    hidden: i32,
}

#[derive(diesel::QueryableByName)]
struct TableRowCountResult {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

#[derive(diesel::QueryableByName)]
struct TextIdRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    id: String,
}

#[derive(diesel::QueryableByName)]
struct ForeignKeyCheckRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    table: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
    rowid: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::Text)]
    parent: String,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    fkid: i32,
}

#[derive(diesel::QueryableByName)]
struct PortfolioAccountForeignKeyContext {
    #[diesel(sql_type = diesel::sql_types::Text)]
    portfolio_id: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    portfolio_name: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Text)]
    account_id: String,
}

const USER_SYNCABLE_ACTIVITIES_FILTER_SQL: &str = "\
    UPPER(COALESCE(source_system, '')) IN ('MANUAL', 'CSV') \
    OR ((source_system IS NULL OR TRIM(source_system) = '') \
        AND (import_run_id IS NULL OR TRIM(import_run_id) = '') \
        AND (source_record_id IS NULL OR TRIM(source_record_id) = ''))";

const ROWS_WITH_USER_SYNCABLE_ACTIVITY_FILTER_SQL: &str = "\
    activity_id IN (
        SELECT id FROM activities
        WHERE UPPER(COALESCE(source_system, '')) IN ('MANUAL', 'CSV')
           OR ((source_system IS NULL OR TRIM(source_system) = '')
               AND (import_run_id IS NULL OR TRIM(import_run_id) = '')
               AND (source_record_id IS NULL OR TRIM(source_record_id) = ''))
    )";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncRowFilter {
    UserSyncableHoldingsSnapshots,
    UserSyncableSnapshotPositions,
    ManualQuotes,
    UserImportRuns,
    UserSyncableActivities,
    SpendingSettings,
    UserTaxonomies,
    SyncableTaxonomyCategories,
    UserModifiedBudgetGroups,
    UserModifiedBudgetGroupAssignments,
    BudgetGroupAssignmentsWithExistingDependencies,
    BudgetTargetsWithExistingDependencies,
    BudgetRolloverSettingsWithExistingDependencies,
    OverwriteRiskAccounts,
    ValidPortfolioAccounts,
    RowsWithUserSyncableActivity,
}

impl SyncRowFilter {
    fn sql(self) -> &'static str {
        match self {
            Self::UserSyncableHoldingsSnapshots => {
                "account_id IN (SELECT id FROM accounts) AND source IN ('MANUAL_ENTRY', 'CSV_IMPORT')"
            }
            Self::UserSyncableSnapshotPositions => {
                "snapshot_id IN (
                    SELECT id FROM holdings_snapshots
                    WHERE account_id IN (SELECT id FROM accounts)
                      AND source IN ('MANUAL_ENTRY', 'CSV_IMPORT')
                )"
            }
            Self::ManualQuotes => "source = 'MANUAL'",
            Self::UserImportRuns => {
                "UPPER(run_type) = 'IMPORT' AND UPPER(source_system) IN ('CSV', 'MANUAL')"
            }
            Self::UserSyncableActivities => USER_SYNCABLE_ACTIVITIES_FILTER_SQL,
            Self::SpendingSettings => "setting_key IN ('spending.enabled', 'spending.account_ids')",
            Self::UserTaxonomies => "is_system = 0",
            // Spending/income seed category IDs use the `cat_` prefix; user-created rows use UUIDs.
            Self::SyncableTaxonomyCategories => {
                "taxonomy_id = 'custom_groups' \
                 OR taxonomy_id IN (SELECT id FROM taxonomies WHERE is_system = 0) \
                 OR (taxonomy_id IN ('spending_categories', 'income_sources', 'savings_categories') AND id NOT LIKE 'cat_%')"
            }
            Self::UserModifiedBudgetGroups | Self::UserModifiedBudgetGroupAssignments => {
                "is_system = 0 OR updated_at != created_at"
            }
            Self::BudgetGroupAssignmentsWithExistingDependencies => {
                "group_id IN (SELECT id FROM budget_groups) \
                 AND EXISTS (
                     SELECT 1 FROM taxonomy_categories AS tc
                     WHERE tc.taxonomy_id = budget_group_assignments.taxonomy_id
                       AND tc.id = budget_group_assignments.category_id
                 )"
            }
            Self::BudgetTargetsWithExistingDependencies => {
                "(target_type = 'category' \
                    AND taxonomy_id IS NOT NULL \
                    AND category_id IS NOT NULL \
                    AND EXISTS (
                        SELECT 1 FROM taxonomy_categories AS tc
                        WHERE tc.taxonomy_id = budget_targets.taxonomy_id
                          AND tc.id = budget_targets.category_id
                    )) \
                 OR (target_type = 'group_buffer' \
                    AND group_id IN (SELECT id FROM budget_groups))"
            }
            Self::BudgetRolloverSettingsWithExistingDependencies => {
                "(target_type = 'category' \
                    AND taxonomy_id IS NOT NULL \
                    AND category_id IS NOT NULL \
                    AND EXISTS (
                        SELECT 1 FROM taxonomy_categories AS tc
                        WHERE tc.taxonomy_id = budget_rollover_settings.taxonomy_id
                          AND tc.id = budget_rollover_settings.category_id
                    )) \
                 OR (target_type = 'group' \
                    AND group_id IN (SELECT id FROM budget_groups))"
            }
            Self::OverwriteRiskAccounts => {
                "provider_account_id IS NULL OR TRIM(provider_account_id) = ''"
            }
            Self::ValidPortfolioAccounts => {
                "account_id IN (SELECT id FROM accounts) AND portfolio_id IN (SELECT id FROM portfolios)"
            }
            Self::RowsWithUserSyncableActivity => ROWS_WITH_USER_SYNCABLE_ACTIVITY_FILTER_SQL,
        }
    }
}

struct SyncTableFilterSpec {
    table: &'static str,
    filter: SyncRowFilter,
}

const OVERWRITE_RISK_UNFILTERED_TABLES: &[&str] = &["goals"];

const OVERWRITE_RISK_FILTERED_TABLES: &[SyncTableFilterSpec] = &[
    SyncTableFilterSpec {
        table: "accounts",
        filter: SyncRowFilter::OverwriteRiskAccounts,
    },
    SyncTableFilterSpec {
        table: "budget_groups",
        filter: SyncRowFilter::UserModifiedBudgetGroups,
    },
    SyncTableFilterSpec {
        table: "budget_group_assignments",
        filter: SyncRowFilter::UserModifiedBudgetGroupAssignments,
    },
    SyncTableFilterSpec {
        table: "budget_targets",
        filter: SyncRowFilter::BudgetTargetsWithExistingDependencies,
    },
    SyncTableFilterSpec {
        table: "budget_rollover_settings",
        filter: SyncRowFilter::BudgetRolloverSettingsWithExistingDependencies,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncTableRowCount {
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncLocalDataSummary {
    pub total_rows: i64,
    pub non_empty_tables: Vec<SyncTableRowCount>,
}

fn load_table_columns(
    conn: &mut SqliteConnection,
    db_name: &str,
    table_name: &str,
) -> Result<Vec<String>> {
    let pragma_xinfo_sql = format!(
        "PRAGMA {}.table_xinfo('{}')",
        db_name,
        escape_sqlite_str(table_name)
    );
    let xinfo_result = diesel::sql_query(pragma_xinfo_sql)
        .load::<PragmaTableXInfoRow>(conn)
        .map_err(StorageError::from);
    if let Ok(rows) = xinfo_result {
        let columns = rows
            .into_iter()
            .filter(|row| row.hidden == 0)
            .map(|row| row.name)
            .collect::<Vec<_>>();
        return Ok(columns);
    }

    let pragma_info_sql = format!(
        "PRAGMA {}.table_info('{}')",
        db_name,
        escape_sqlite_str(table_name)
    );
    let columns = diesel::sql_query(pragma_info_sql)
        .load::<PragmaTableInfoRow>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .map(|row| row.name)
        .collect::<Vec<_>>();
    Ok(columns)
}

fn load_payload_column_catalog(
    conn: &mut SqliteConnection,
    table_name: &str,
) -> Result<PayloadColumnCatalog> {
    let known_columns = {
        let cache = payload_column_catalog_cache().lock().map_err(|_| {
            Error::Database(DatabaseError::Internal(
                "Sync payload column cache is poisoned".to_string(),
            ))
        })?;
        cache.get(table_name).cloned()
    };
    if let Some(cached) = known_columns {
        return Ok(cached);
    }

    let pragma_xinfo_sql = format!(
        "PRAGMA main.table_xinfo('{}')",
        escape_sqlite_str(table_name)
    );
    let xinfo_result = diesel::sql_query(pragma_xinfo_sql)
        .load::<PragmaTableXInfoRow>(conn)
        .map_err(StorageError::from);

    let catalog = match xinfo_result {
        Ok(rows) => {
            let mut writable = HashSet::new();
            let mut readonly = HashSet::new();
            for row in rows {
                if row.hidden == 0 {
                    writable.insert(row.name);
                } else {
                    readonly.insert(row.name);
                }
            }
            PayloadColumnCatalog { writable, readonly }
        }
        Err(_) => PayloadColumnCatalog {
            writable: load_table_columns(conn, "main", table_name)?
                .into_iter()
                .collect::<HashSet<_>>(),
            readonly: HashSet::new(),
        },
    };

    let mut cache = payload_column_catalog_cache().lock().map_err(|_| {
        Error::Database(DatabaseError::Internal(
            "Sync payload column cache is poisoned".to_string(),
        ))
    })?;
    cache.insert(table_name.to_string(), catalog.clone());
    Ok(catalog)
}

fn payload_value_matches_entity_id(value: &serde_json::Value, entity_id: &str) -> bool {
    match value {
        serde_json::Value::String(v) => v == entity_id,
        serde_json::Value::Number(v) => v.to_string() == entity_id,
        serde_json::Value::Bool(v) => v.to_string() == entity_id,
        _ => false,
    }
}

fn normalize_payload_key_to_snake_case(key: &str) -> String {
    let mut normalized = String::with_capacity(key.len());
    let chars = key.chars().collect::<Vec<_>>();

    for (idx, ch) in chars.iter().enumerate() {
        if ch.is_ascii_uppercase() {
            let prev = idx.checked_sub(1).and_then(|i| chars.get(i));
            let next = chars.get(idx + 1);
            let prev_is_lower_or_digit =
                prev.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            let prev_is_upper = prev.is_some_and(|c| c.is_ascii_uppercase());
            let next_is_lower = next.is_some_and(|c| c.is_ascii_lowercase());

            if !normalized.is_empty()
                && !normalized.ends_with('_')
                && (prev_is_lower_or_digit || (prev_is_upper && next_is_lower))
            {
                normalized.push('_');
            }
            normalized.push(ch.to_ascii_lowercase());
            continue;
        }

        if ch.is_ascii_alphanumeric() {
            normalized.push(*ch);
            continue;
        }

        if !normalized.is_empty() && !normalized.ends_with('_') {
            normalized.push('_');
        }
    }

    normalized.trim_matches('_').to_string()
}

enum PayloadColumnResolution {
    Writable(String),
    Readonly,
}

/// Column renames applied during sync replay for backward compatibility.
/// Old devices may still send payloads with the pre-rename column names.
fn apply_column_rename(table: &str, column: &str) -> Option<&'static str> {
    match (table, column) {
        ("goals", "is_achieved") => Some("status_lifecycle"),
        ("goals_allocation", "percent_allocation") => Some("share_percent"),
        ("import_account_templates", "import_type") => Some("context_kind"),
        _ => None,
    }
}

/// Value transformations applied during sync replay for backward compatibility.
/// Old payloads may send pre-rename enum values (e.g., "ACTIVITY" → "CSV_ACTIVITY").
fn apply_value_migration(table: &str, column: &str, value: serde_json::Value) -> serde_json::Value {
    match (table, column) {
        ("goals", "status_lifecycle") => migrate_legacy_goal_lifecycle_value(value),
        ("import_account_templates", "context_kind") => {
            if let Some(s) = value.as_str() {
                let migrated = wealthfolio_core::activities::normalize_context_kind_value(s);
                if migrated != s {
                    return serde_json::Value::String(migrated.to_string());
                }
            }
            value
        }
        ("accounts", "account_type") => {
            if let Some(s) = value.as_str() {
                if !matches!(s, "SECURITIES" | "CASH" | "CREDIT_CARD" | "CRYPTOCURRENCY") {
                    return serde_json::Value::String("SECURITIES".to_string());
                }
            }
            value
        }
        _ => value,
    }
}

fn migrate_legacy_goal_lifecycle_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Bool(true) => serde_json::Value::String("achieved".to_string()),
        serde_json::Value::Bool(false) | serde_json::Value::Null => {
            serde_json::Value::String("active".to_string())
        }
        serde_json::Value::Number(n) if n.as_i64() == Some(1) || n.as_f64() == Some(1.0) => {
            serde_json::Value::String("achieved".to_string())
        }
        serde_json::Value::Number(n) if n.as_i64() == Some(0) || n.as_f64() == Some(0.0) => {
            serde_json::Value::String("active".to_string())
        }
        serde_json::Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => serde_json::Value::String("achieved".to_string()),
            "false" | "0" => serde_json::Value::String("active".to_string()),
            _ => serde_json::Value::String(s),
        },
        value => value,
    }
}

fn resolve_payload_column(
    raw_key: &str,
    catalog: &PayloadColumnCatalog,
    table_name: &str,
) -> Option<PayloadColumnResolution> {
    if catalog.writable.contains(raw_key) {
        return Some(PayloadColumnResolution::Writable(raw_key.to_string()));
    }
    if catalog.readonly.contains(raw_key) {
        return Some(PayloadColumnResolution::Readonly);
    }

    let normalized = normalize_payload_key_to_snake_case(raw_key);
    if normalized != raw_key {
        if catalog.writable.contains(&normalized) {
            return Some(PayloadColumnResolution::Writable(normalized.clone()));
        }
        if catalog.readonly.contains(&normalized) {
            return Some(PayloadColumnResolution::Readonly);
        }
    }

    // Check for known column renames (backward compat with older sync payloads)
    let check = if normalized != raw_key {
        &normalized
    } else {
        raw_key
    };
    if let Some(renamed) = apply_column_rename(table_name, check) {
        if catalog.writable.contains(renamed) {
            return Some(PayloadColumnResolution::Writable(renamed.to_string()));
        }
    }

    None
}

fn normalize_payload_fields(
    conn: &mut SqliteConnection,
    table_name: &str,
    fields: Vec<(String, serde_json::Value)>,
) -> Result<Vec<(String, serde_json::Value)>> {
    let catalog = load_payload_column_catalog(conn, table_name)?;
    let mut normalized_fields = Vec::with_capacity(fields.len());
    let mut seen_columns: HashMap<String, serde_json::Value> = HashMap::new();

    for (raw_key, value) in fields {
        let resolution =
            resolve_payload_column(&raw_key, &catalog, table_name).ok_or_else(|| {
                Error::Database(DatabaseError::Internal(format!(
                    "Sync payload column '{}' is not valid for table '{}'",
                    raw_key, table_name
                )))
            })?;

        let column = match resolution {
            PayloadColumnResolution::Writable(column) => column,
            PayloadColumnResolution::Readonly => continue,
        };

        let value = apply_value_migration(table_name, &column, value);
        if let Some(existing_value) = seen_columns.get(&column) {
            if existing_value != &value {
                return Err(Error::Database(DatabaseError::Internal(format!(
                    "Sync payload maps multiple values to column '{}' for table '{}'",
                    column, table_name
                ))));
            }
            continue;
        }

        seen_columns.insert(column.clone(), value.clone());
        normalized_fields.push((column, value));
    }

    Ok(normalized_fields)
}

fn normalize_outbox_payload(payload: serde_json::Value) -> Result<serde_json::Value> {
    let serde_json::Value::Object(fields) = payload else {
        return Ok(payload);
    };

    let mut normalized = serde_json::Map::new();
    for (raw_key, value) in fields {
        let normalized_key = normalize_payload_key_to_snake_case(&raw_key);
        let column = if normalized_key.is_empty() {
            raw_key
        } else {
            normalized_key
        };

        if let Some(existing) = normalized.get(&column) {
            if existing != &value {
                return Err(Error::Database(DatabaseError::Internal(format!(
                    "Outbox payload maps multiple values to column '{}'",
                    column
                ))));
            }
            continue;
        }

        normalized.insert(column, value);
    }

    Ok(serde_json::Value::Object(normalized))
}

/// Per-table WHERE filters for snapshot export and restore.
/// During export: only rows matching the filter are copied to the snapshot.
/// During restore: only rows matching the filter are deleted before importing snapshot data,
/// so that unfiltered rows (e.g. system taxonomies) are preserved.
/// Tables not listed here are exported/restored unfiltered.
const SYNC_TABLE_SNAPSHOT_COPY_FILTERS: &[SyncTableFilterSpec] = &[
    SyncTableFilterSpec {
        table: "holdings_snapshots",
        filter: SyncRowFilter::UserSyncableHoldingsSnapshots,
    },
    SyncTableFilterSpec {
        table: "snapshot_positions",
        filter: SyncRowFilter::UserSyncableSnapshotPositions,
    },
    SyncTableFilterSpec {
        table: "quotes",
        filter: SyncRowFilter::ManualQuotes,
    },
    // Taxonomy rows are all seeded by migrations — no user-created taxonomies yet.
    // Export nothing; the table is in APP_SYNC_TABLES for future custom taxonomy support.
    SyncTableFilterSpec {
        table: "taxonomies",
        filter: SyncRowFilter::UserTaxonomies,
    },
    // Only export user-created categories under syncable system taxonomies.
    SyncTableFilterSpec {
        table: "taxonomy_categories",
        filter: SyncRowFilter::SyncableTaxonomyCategories,
    },
    // Only export user-initiated import runs (CSV/manual), matching the outbox policy.
    SyncTableFilterSpec {
        table: "import_runs",
        filter: SyncRowFilter::UserImportRuns,
    },
    // Activities: match the outbox policy so broker activities don't reference
    // filtered-out import_runs (which would cause FK violations on restore).
    SyncTableFilterSpec {
        table: "activities",
        filter: SyncRowFilter::UserSyncableActivities,
    },
    SyncTableFilterSpec {
        table: "activity_taxonomy_assignments",
        filter: SyncRowFilter::RowsWithUserSyncableActivity,
    },
    SyncTableFilterSpec {
        table: "spending_activity_events",
        filter: SyncRowFilter::RowsWithUserSyncableActivity,
    },
    // Only the spending module's app_settings keys participate in sync.
    SyncTableFilterSpec {
        table: "app_settings",
        filter: SyncRowFilter::SpendingSettings,
    },
    SyncTableFilterSpec {
        table: "budget_group_assignments",
        filter: SyncRowFilter::BudgetGroupAssignmentsWithExistingDependencies,
    },
    SyncTableFilterSpec {
        table: "budget_targets",
        filter: SyncRowFilter::BudgetTargetsWithExistingDependencies,
    },
    SyncTableFilterSpec {
        table: "budget_rollover_settings",
        filter: SyncRowFilter::BudgetRolloverSettingsWithExistingDependencies,
    },
    // Drop legacy orphan membership rows at snapshot boundaries. Portfolio
    // settings remains the user-facing repair surface for the source DB.
    SyncTableFilterSpec {
        table: "portfolio_accounts",
        filter: SyncRowFilter::ValidPortfolioAccounts,
    },
];

const SYNC_TABLE_SNAPSHOT_CLEAR_FILTERS: &[SyncTableFilterSpec] = &[
    SyncTableFilterSpec {
        table: "holdings_snapshots",
        filter: SyncRowFilter::UserSyncableHoldingsSnapshots,
    },
    SyncTableFilterSpec {
        table: "snapshot_positions",
        filter: SyncRowFilter::UserSyncableSnapshotPositions,
    },
    SyncTableFilterSpec {
        table: "quotes",
        filter: SyncRowFilter::ManualQuotes,
    },
    SyncTableFilterSpec {
        table: "taxonomies",
        filter: SyncRowFilter::UserTaxonomies,
    },
    SyncTableFilterSpec {
        table: "taxonomy_categories",
        filter: SyncRowFilter::SyncableTaxonomyCategories,
    },
    SyncTableFilterSpec {
        table: "import_runs",
        filter: SyncRowFilter::UserImportRuns,
    },
    SyncTableFilterSpec {
        table: "activities",
        filter: SyncRowFilter::UserSyncableActivities,
    },
    SyncTableFilterSpec {
        table: "activity_taxonomy_assignments",
        filter: SyncRowFilter::RowsWithUserSyncableActivity,
    },
    SyncTableFilterSpec {
        table: "spending_activity_events",
        filter: SyncRowFilter::RowsWithUserSyncableActivity,
    },
    SyncTableFilterSpec {
        table: "app_settings",
        filter: SyncRowFilter::SpendingSettings,
    },
    SyncTableFilterSpec {
        table: "budget_group_assignments",
        filter: SyncRowFilter::BudgetGroupAssignmentsWithExistingDependencies,
    },
    SyncTableFilterSpec {
        table: "budget_targets",
        filter: SyncRowFilter::BudgetTargetsWithExistingDependencies,
    },
    SyncTableFilterSpec {
        table: "budget_rollover_settings",
        filter: SyncRowFilter::BudgetRolloverSettingsWithExistingDependencies,
    },
];

fn snapshot_copy_filter_for_table(table: &str) -> Option<&'static str> {
    SYNC_TABLE_SNAPSHOT_COPY_FILTERS
        .iter()
        .find(|spec| spec.table == table)
        .map(|spec| spec.filter.sql())
}

fn snapshot_clear_filter_for_table(table: &str) -> Option<&'static str> {
    SYNC_TABLE_SNAPSHOT_CLEAR_FILTERS
        .iter()
        .find(|spec| spec.table == table)
        .map(|spec| spec.filter.sql())
}

fn delete_orphan_snapshot_rows(conn: &mut SqliteConnection) -> Result<()> {
    diesel::sql_query(
        "DELETE FROM snapshot_positions
         WHERE snapshot_id IN (
             SELECT id FROM holdings_snapshots
             WHERE account_id NOT IN (SELECT id FROM accounts)
         )",
    )
    .execute(conn)
    .map_err(StorageError::from)?;

    diesel::sql_query(
        "DELETE FROM holdings_snapshots
         WHERE account_id NOT IN (SELECT id FROM accounts)",
    )
    .execute(conn)
    .map_err(StorageError::from)?;

    Ok(())
}

fn reset_restore_dependent_read_models(
    conn: &mut SqliteConnection,
    table_set: &HashSet<String>,
) -> Result<()> {
    if table_set.contains("snapshot_positions")
        || table_set.contains("holdings_snapshots")
        || table_set.contains("assets")
    {
        diesel::sql_query("DELETE FROM snapshot_positions")
            .execute(conn)
            .map_err(StorageError::from)?;
    }

    if table_set.contains("accounts")
        || table_set.contains("assets")
        || table_set.contains("activities")
    {
        for table in ["lot_disposals", "lots", "daily_account_valuation"] {
            diesel::sql_query(format!("DELETE FROM {}", quote_identifier(table)))
                .execute(conn)
                .map_err(StorageError::from)?;
        }
    }

    Ok(())
}

fn deserialize_snapshot_positions_payload(
    positions_json: &str,
    account_id: &str,
) -> HashMap<String, Position> {
    if positions_json.is_empty() || positions_json == "{}" {
        return HashMap::new();
    }

    match serde_json::from_str::<HashMap<String, Position>>(positions_json) {
        Ok(mut positions) => {
            for position in positions.values_mut() {
                if position.account_id.is_empty() {
                    position.account_id = account_id.to_string();
                }
            }
            positions
        }
        Err(err) => {
            log::warn!(
                "Leaving snapshot_positions empty because synced positions JSON could not be decoded (account {}): {}",
                account_id,
                err
            );
            HashMap::new()
        }
    }
}

fn rebuild_snapshot_positions_from_snapshot_row_tx(
    conn: &mut SqliteConnection,
    snapshot_id_value: &str,
) -> Result<()> {
    use crate::schema::assets::dsl as asset_dsl;
    use crate::schema::holdings_snapshots::dsl as snapshot_dsl;
    use crate::schema::snapshot_positions::dsl as position_dsl;

    let snapshot_row = snapshot_dsl::holdings_snapshots
        .select((snapshot_dsl::account_id, snapshot_dsl::positions))
        .filter(snapshot_dsl::id.eq(snapshot_id_value))
        .first::<(String, String)>(conn)
        .optional()
        .map_err(StorageError::from)?;

    diesel::delete(
        position_dsl::snapshot_positions.filter(position_dsl::snapshot_id.eq(snapshot_id_value)),
    )
    .execute(conn)
    .map_err(StorageError::from)?;

    let Some((account_id, positions_json)) = snapshot_row else {
        return Ok(());
    };

    let positions = deserialize_snapshot_positions_payload(&positions_json, &account_id);
    if positions.is_empty() {
        return Ok(());
    }

    let requested_asset_ids = positions
        .values()
        .map(|position| position.asset_id.clone())
        .collect::<HashSet<_>>();
    let requested_asset_ids_vec = requested_asset_ids.iter().cloned().collect::<Vec<_>>();
    let existing_asset_ids = asset_dsl::assets
        .select(asset_dsl::id)
        .filter(asset_dsl::id.eq_any(&requested_asset_ids_vec))
        .load::<String>(conn)
        .map_err(StorageError::from)?
        .into_iter()
        .collect::<HashSet<_>>();

    if existing_asset_ids.len() != requested_asset_ids.len() {
        let missing = requested_asset_ids
            .difference(&existing_asset_ids)
            .cloned()
            .collect::<Vec<_>>();
        log::warn!(
            "Leaving snapshot_positions empty for snapshot {} because synced positions reference missing assets: {:?}",
            snapshot_id_value,
            missing
        );
        return Ok(());
    }

    for position in positions.values() {
        let insert_sql = format!(
            "INSERT INTO snapshot_positions (
                snapshot_id, asset_id, quantity, average_cost, total_cost_basis,
                currency, inception_date, is_alternative, contract_multiplier,
                created_at, last_updated
            ) VALUES (
                '{}', '{}', '{}', '{}', '{}',
                '{}', '{}', {}, '{}',
                '{}', '{}'
            )",
            escape_sqlite_str(snapshot_id_value),
            escape_sqlite_str(&position.asset_id),
            escape_sqlite_str(&position.quantity.round_dp(DECIMAL_PRECISION).to_string()),
            escape_sqlite_str(
                &position
                    .average_cost
                    .round_dp(DECIMAL_PRECISION)
                    .to_string()
            ),
            escape_sqlite_str(
                &position
                    .total_cost_basis
                    .round_dp(DECIMAL_PRECISION)
                    .to_string()
            ),
            escape_sqlite_str(&position.currency),
            escape_sqlite_str(&position.inception_date.to_rfc3339()),
            if position.is_alternative { 1 } else { 0 },
            escape_sqlite_str(&position.contract_multiplier.to_string()),
            escape_sqlite_str(&position.created_at.to_rfc3339()),
            escape_sqlite_str(&position.last_updated.to_rfc3339())
        );
        diesel::sql_query(insert_sql)
            .execute(conn)
            .map_err(StorageError::from)?;
    }

    Ok(())
}

fn entity_storage_mapping(entity: &SyncEntity) -> Option<(&'static str, &'static str)> {
    match entity {
        SyncEntity::Account => Some(("accounts", "id")),
        SyncEntity::Asset => Some(("assets", "id")),
        SyncEntity::Quote => Some(("quotes", "id")),
        SyncEntity::AssetTaxonomyAssignment => Some(("asset_taxonomy_assignments", "id")),
        SyncEntity::Activity => Some(("activities", "id")),
        // Broker activity user patches update an existing local broker row by provider identity.
        SyncEntity::BrokerActivityUserPatch => None,
        SyncEntity::ActivityImportProfile => Some(("import_account_templates", "id")),
        SyncEntity::ImportTemplate => Some(("import_templates", "id")),
        SyncEntity::Goal => Some(("goals", "id")),
        SyncEntity::GoalPlan => Some(("goal_plans", "goal_id")),
        SyncEntity::GoalsAllocation => Some(("goals_allocation", "id")),
        SyncEntity::AiThread => Some(("ai_threads", "id")),
        SyncEntity::AiMessage => Some(("ai_messages", "id")),
        SyncEntity::AiThreadTag => Some(("ai_thread_tags", "id")),
        SyncEntity::ContributionLimit => Some(("contribution_limits", "id")),
        SyncEntity::Platform => Some(("platforms", "id")),
        SyncEntity::Snapshot => Some(("holdings_snapshots", "id")),
        SyncEntity::CustomProvider => Some(("market_data_custom_providers", "id")),
        SyncEntity::ImportRun => Some(("import_runs", "id")),
        SyncEntity::Portfolio => Some(("portfolios", "id")),
        SyncEntity::PortfolioAccount => Some(("portfolio_accounts", "id")),
        SyncEntity::AllocationTarget => Some(("allocation_targets", "id")),
        SyncEntity::AllocationTargetWeight => Some(("allocation_target_weights", "id")),
        SyncEntity::AllocationTargetConstraint => Some(("allocation_target_constraints", "id")),
        SyncEntity::SpendingSetting => Some(("app_settings", "setting_key")),
        // CustomTaxonomy uses bundle replay — handled by custom branch in apply_remote_event_lww_tx
        SyncEntity::CustomTaxonomy => None,
        // Spending module entities
        SyncEntity::ActivityTaxonomyAssignment => Some(("activity_taxonomy_assignments", "id")),
        SyncEntity::SpendingActivitySplit => Some(("spending_activity_splits", "id")),
        SyncEntity::SpendingActivityEvent => Some(("spending_activity_events", "activity_id")),
        SyncEntity::SpendingCategorizationRule => Some(("spending_categorization_rules", "id")),
        // Composite primary key; handled by custom branch in apply_remote_event_lww_tx.
        SyncEntity::SpendingPresetRuleDeletion => None,
        SyncEntity::SpendingEvent => Some(("spending_events", "id")),
        SyncEntity::SpendingEventType => Some(("spending_event_types", "id")),
        SyncEntity::BudgetGroup => Some(("budget_groups", "id")),
        SyncEntity::BudgetGroupAssignment => Some(("budget_group_assignments", "id")),
        SyncEntity::BudgetTarget => Some(("budget_targets", "id")),
        SyncEntity::BudgetRolloverSetting => Some(("budget_rollover_settings", "id")),
        // Composite primary key; handled by custom branch in apply_remote_event_lww_tx.
        SyncEntity::AddonStorage => None,
    }
}

fn replay_apply_error(
    entity: SyncEntity,
    entity_id: &str,
    op: SyncOperation,
    event_id: &str,
    seq: i64,
    err: Error,
) -> Error {
    let table_context = entity_storage_mapping(&entity)
        .map(|(table, pk)| format!(" table={table} pk={pk}"))
        .unwrap_or_default();
    let message = format!(
        "Replay apply failed for entity={entity:?}{table_context} entity_id={entity_id} op={op:?} event_id={event_id} seq={seq}: {err}"
    );
    if is_foreign_key_error_message(&message) {
        Error::Database(DatabaseError::ForeignKeyViolation(message))
    } else {
        Error::Database(DatabaseError::Internal(message))
    }
}

fn is_foreign_key_error_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("foreign key")
}

fn collect_foreign_key_violations_tx<'a, I>(
    conn: &mut SqliteConnection,
    tables: I,
) -> Result<Vec<ForeignKeyCheckRow>>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut rows = Vec::new();
    for table in tables {
        let sql = format!("PRAGMA foreign_key_check({})", quote_identifier(table));
        rows.extend(
            diesel::sql_query(sql)
                .load::<ForeignKeyCheckRow>(conn)
                .map_err(StorageError::from)?,
        );
    }
    Ok(rows)
}

fn foreign_key_violation_details(rows: &[ForeignKeyCheckRow]) -> String {
    let details = rows
        .iter()
        .take(10)
        .map(|row| {
            format!(
                "table={} rowid={} parent={} fkid={}",
                row.table,
                row.rowid
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "NULL".to_string()),
                row.parent,
                row.fkid
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let suffix = if rows.len() > 10 {
        format!("; +{} more", rows.len() - 10)
    } else {
        String::new()
    };

    format!("{details}{suffix}")
}

fn ensure_no_foreign_key_violations_tx<'a, I>(conn: &mut SqliteConnection, tables: I) -> Result<()>
where
    I: IntoIterator<Item = &'a str>,
{
    let rows = collect_foreign_key_violations_tx(conn, tables)?;
    if rows.is_empty() {
        return Ok(());
    }

    Err(Error::Database(DatabaseError::ForeignKeyViolation(
        format!(
            "Replay batch foreign key check failed: {}",
            foreign_key_violation_details(&rows)
        ),
    )))
}

fn portfolio_account_foreign_key_message_tx(
    conn: &mut SqliteConnection,
    row: &ForeignKeyCheckRow,
) -> Option<String> {
    if row.table != "portfolio_accounts" || row.parent != "accounts" {
        return None;
    }

    let rowid = row.rowid?;
    let sql = format!(
        "SELECT pa.portfolio_id, p.name AS portfolio_name, pa.account_id \
         FROM portfolio_accounts pa \
         LEFT JOIN portfolios p ON p.id = pa.portfolio_id \
         WHERE pa.rowid = {}",
        rowid
    );
    let context = diesel::sql_query(sql)
        .get_result::<PortfolioAccountForeignKeyContext>(conn)
        .ok()?;
    let portfolio_name = context
        .portfolio_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(context.portfolio_id.as_str());

    Some(format!(
        "Portfolio \"{}\" contains a deleted account link (account_id={}). Open Settings > Portfolios, edit the portfolio, then save.",
        portfolio_name, context.account_id
    ))
}

fn snapshot_upload_integrity_error_tx(
    conn: &mut SqliteConnection,
    rows: &[ForeignKeyCheckRow],
) -> Error {
    let mut portfolio_messages = Vec::new();
    for row in rows {
        if let Some(message) = portfolio_account_foreign_key_message_tx(conn, row) {
            if !portfolio_messages.contains(&message) {
                portfolio_messages.push(message);
            }
        }
    }

    if !portfolio_messages.is_empty() {
        return Error::Database(DatabaseError::ForeignKeyViolation(
            portfolio_messages.join(" "),
        ));
    }

    Error::Database(DatabaseError::ForeignKeyViolation(format!(
        "Local data has foreign key violations. Fix data health issues before syncing: {}",
        foreign_key_violation_details(rows)
    )))
}

fn should_ignore_snapshot_upload_fk_violation(row: &ForeignKeyCheckRow) -> bool {
    row.table == "portfolio_accounts" && row.parent == "portfolios"
}

fn json_value_to_sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(v) => {
            if *v {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => format!("'{}'", escape_sqlite_str(v)),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            format!(
                "'{}'",
                escape_sqlite_str(&serde_json::to_string(value).unwrap_or_default())
            )
        }
    }
}

fn restore_sql_error(phase: &str, table: &str, err: diesel::result::Error) -> Error {
    let core_error: Error = StorageError::from(err).into();
    let message = format!("Snapshot restore {phase} failed for table={table}: {core_error}");
    if is_foreign_key_error_message(&message) {
        Error::Database(DatabaseError::ForeignKeyViolation(message))
    } else {
        Error::Database(DatabaseError::Internal(message))
    }
}

#[derive(Debug, Clone)]
pub struct OutboxWriteRequest {
    pub event_id: Option<String>,
    pub entity: SyncEntity,
    pub entity_id: String,
    pub op: SyncOperation,
    pub client_timestamp: String,
    pub payload: serde_json::Value,
    pub payload_key_version: i32,
}

impl OutboxWriteRequest {
    pub fn new(
        entity: SyncEntity,
        entity_id: impl Into<String>,
        op: SyncOperation,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            event_id: None,
            entity,
            entity_id: entity_id.into(),
            op,
            client_timestamp: Utc::now().to_rfc3339(),
            payload,
            // 0 means "resolve from local sync_device_config"; explicit callers can override.
            payload_key_version: 0,
        }
    }
}

fn resolve_payload_key_version(conn: &mut SqliteConnection, requested_version: i32) -> Result<i32> {
    if requested_version > 0 {
        return Ok(requested_version);
    }

    let maybe_row = sync_device_config::table
        .filter(sync_device_config::trust_state.eq("trusted"))
        .filter(sync_device_config::key_version.is_not_null())
        .order(sync_device_config::last_bootstrap_at.desc())
        .first::<SyncDeviceConfigDB>(conn)
        .optional()
        .map_err(StorageError::from)?;

    Ok(maybe_row
        .and_then(|row| row.key_version)
        .unwrap_or(1)
        .max(1))
}

fn resolve_local_device_id(conn: &mut SqliteConnection) -> Option<String> {
    sync_device_config::table
        .filter(sync_device_config::trust_state.eq("trusted"))
        .order(sync_device_config::last_bootstrap_at.desc())
        .select(sync_device_config::device_id)
        .first::<String>(conn)
        .optional()
        .unwrap_or(None)
}

fn upsert_entity_metadata_tx(
    conn: &mut SqliteConnection,
    entity: SyncEntity,
    entity_id: &str,
    event_id: &str,
    client_timestamp: &str,
    op: SyncOperation,
    seq: i64,
) -> Result<()> {
    let entity_db = enum_to_db(&entity)?;
    let op_db = enum_to_db(&op)?;
    diesel::insert_into(sync_entity_metadata::table)
        .values(SyncEntityMetadataDB {
            entity: entity_db,
            entity_id: entity_id.to_string(),
            last_event_id: event_id.to_string(),
            last_client_timestamp: client_timestamp.to_string(),
            last_op: op_db.clone(),
            last_seq: seq,
        })
        .on_conflict((
            sync_entity_metadata::entity,
            sync_entity_metadata::entity_id,
        ))
        .do_update()
        .set((
            sync_entity_metadata::last_event_id.eq(event_id.to_string()),
            sync_entity_metadata::last_client_timestamp.eq(client_timestamp.to_string()),
            sync_entity_metadata::last_op.eq(op_db),
            sync_entity_metadata::last_seq.eq(seq),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
}

fn upsert_entity_metadata_preserving_seq_tx(
    conn: &mut SqliteConnection,
    entity: SyncEntity,
    entity_id: &str,
    event_id: &str,
    client_timestamp: &str,
    op: SyncOperation,
) -> Result<()> {
    let entity_db = enum_to_db(&entity)?;
    let op_db = enum_to_db(&op)?;
    diesel::insert_into(sync_entity_metadata::table)
        .values(SyncEntityMetadataDB {
            entity: entity_db,
            entity_id: entity_id.to_string(),
            last_event_id: event_id.to_string(),
            last_client_timestamp: client_timestamp.to_string(),
            last_op: op_db.clone(),
            last_seq: 0,
        })
        .on_conflict((
            sync_entity_metadata::entity,
            sync_entity_metadata::entity_id,
        ))
        .do_update()
        .set((
            sync_entity_metadata::last_event_id.eq(event_id.to_string()),
            sync_entity_metadata::last_client_timestamp.eq(client_timestamp.to_string()),
            sync_entity_metadata::last_op.eq(op_db),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
}

pub(in crate::sync::app_sync) fn insert_outbox_event(
    conn: &mut SqliteConnection,
    request: OutboxWriteRequest,
) -> Result<String> {
    let OutboxWriteRequest {
        event_id,
        entity,
        entity_id,
        op,
        client_timestamp,
        payload,
        payload_key_version,
    } = request;

    let event_id = event_id.unwrap_or_else(|| Uuid::now_v7().to_string());
    let payload = serde_json::to_string(&normalize_outbox_payload(payload)?)?;
    let now = Utc::now().to_rfc3339();

    let payload_key_version = resolve_payload_key_version(conn, payload_key_version)?;
    let device_id = resolve_local_device_id(conn);
    let row = SyncOutboxEventDB {
        event_id: event_id.clone(),
        entity: enum_to_db(&entity)?,
        entity_id: entity_id.clone(),
        op: enum_to_db(&op)?,
        client_timestamp: client_timestamp.clone(),
        payload,
        payload_key_version,
        sent: 0,
        status: enum_to_db(&SyncOutboxStatus::Pending)?,
        retry_count: 0,
        next_retry_at: None,
        last_error: None,
        last_error_code: None,
        device_id,
        created_at: now,
    };

    diesel::insert_into(sync_outbox::table)
        .values(&row)
        .execute(conn)
        .map_err(StorageError::from)?;

    upsert_entity_metadata_preserving_seq_tx(
        conn,
        entity,
        &entity_id,
        &event_id,
        &client_timestamp,
        op,
    )?;

    Ok(event_id)
}

fn to_outbox_event(row: SyncOutboxEventDB) -> Result<SyncOutboxEvent> {
    Ok(SyncOutboxEvent {
        event_id: row.event_id,
        entity: enum_from_db(&row.entity)?,
        entity_id: row.entity_id,
        op: enum_from_db(&row.op)?,
        client_timestamp: row.client_timestamp,
        payload: row.payload,
        payload_key_version: row.payload_key_version,
        sent: row.sent != 0,
        status: enum_from_db(&row.status)?,
        retry_count: row.retry_count,
        next_retry_at: row.next_retry_at,
        last_error: row.last_error,
        last_error_code: row.last_error_code,
        created_at: row.created_at,
    })
}

fn to_entity_metadata(row: SyncEntityMetadataDB) -> Result<SyncEntityMetadata> {
    Ok(SyncEntityMetadata {
        entity: enum_from_db(&row.entity)?,
        entity_id: row.entity_id,
        last_event_id: row.last_event_id,
        last_client_timestamp: row.last_client_timestamp,
        last_op: enum_from_db(&row.last_op)?,
        last_seq: row.last_seq,
    })
}

/// Build an upsert SQL statement from a JSON object and execute it.
/// `conflict_keys` are the columns used in `ON CONFLICT(...)`.
fn upsert_json_row(
    conn: &mut SqliteConnection,
    table: &str,
    conflict_keys: &[&str],
    row: &serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let fields: Vec<(&String, &serde_json::Value)> = row.iter().collect();
    if fields.is_empty() {
        return Ok(());
    }

    let columns = fields
        .iter()
        .map(|(k, _)| quote_identifier(k))
        .collect::<Vec<_>>()
        .join(", ");
    let values = fields
        .iter()
        .map(|(_, v)| json_value_to_sql_literal(v))
        .collect::<Vec<_>>()
        .join(", ");
    let upserts = fields
        .iter()
        .map(|(k, _)| {
            let q = quote_identifier(k);
            format!("{q}=excluded.{q}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let conflict = conflict_keys
        .iter()
        .map(|k| quote_identifier(k))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "INSERT INTO {table_q} ({columns}) VALUES ({values}) ON CONFLICT({conflict}) DO UPDATE SET {upserts}",
        table_q = quote_identifier(table),
    );
    diesel::sql_query(sql)
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
}

fn load_entity_metadata_tx(
    conn: &mut SqliteConnection,
    entity_db: &str,
    entity_id: &str,
) -> Result<Option<SyncEntityMetadataDB>> {
    let row = sync_entity_metadata::table
        .find((entity_db.to_string(), entity_id.to_string()))
        .first::<SyncEntityMetadataDB>(conn)
        .optional()
        .map_err(StorageError::from)?;
    Ok(row)
}

fn should_apply_against_metadata(
    entity: SyncEntity,
    meta: &SyncEntityMetadataDB,
    op: SyncOperation,
    client_timestamp: &str,
    event_id: &str,
) -> Result<bool> {
    let previous_op = enum_from_db::<SyncOperation>(&meta.last_op)?;
    // Pure last-writer-wins entities: a delete is just another write to a key
    // that can be legitimately re-used, NOT a permanent tombstone. Every op
    // (create/update/delete) competes on timestamp+event_id. The delete-wins /
    // tombstone branches below would otherwise let a stale delete clobber a newer
    // value and permanently swallow any later re-create of a deleted key.
    if matches!(
        entity,
        SyncEntity::SpendingPresetRuleDeletion | SyncEntity::AddonStorage
    ) {
        Ok(should_apply_lww(
            &meta.last_client_timestamp,
            &meta.last_event_id,
            client_timestamp,
            event_id,
        ))
    } else if op == SyncOperation::Delete && previous_op != SyncOperation::Delete {
        Ok(true)
    } else if previous_op == SyncOperation::Delete
        && matches!(op, SyncOperation::Create | SyncOperation::Update)
    {
        Ok(false)
    } else {
        Ok(should_apply_lww(
            &meta.last_client_timestamp,
            &meta.last_event_id,
            client_timestamp,
            event_id,
        ))
    }
}

fn validate_spending_decimal_field(
    entity: &SyncEntity,
    fields: &[(String, serde_json::Value)],
) -> Result<()> {
    let field_name = match entity {
        SyncEntity::BudgetTarget => Some("amount"),
        SyncEntity::BudgetRolloverSetting => Some("starting_balance"),
        _ => None,
    };

    let Some(field_name) = field_name else {
        return Ok(());
    };
    let Some((_, value)) = fields.iter().find(|(key, _)| key == field_name) else {
        return Ok(());
    };
    let Some(amount) = value.as_str() else {
        return Err(Error::Database(DatabaseError::Internal(format!(
            "{} sync payload field '{}' must be a decimal string",
            enum_to_db(entity)?,
            field_name
        ))));
    };

    amount.parse::<Decimal>().map(|_| ()).map_err(|_| {
        Error::Database(DatabaseError::Internal(format!(
            "{} sync payload field '{}' is not a valid decimal",
            enum_to_db(entity).unwrap_or_else(|_| "spending".to_string()),
            field_name
        )))
    })
}

fn is_syncable_system_taxonomy_id(taxonomy_id: &str) -> bool {
    matches!(
        taxonomy_id,
        "custom_groups" | "spending_categories" | "income_sources" | "savings_categories"
    )
}

fn sql_string_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("'{}'", escape_sqlite_str(value)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn tombstone_spending_children_for_removed_categories(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
    category_clause: &str,
    event_id: &str,
    client_timestamp: &str,
    seq: i64,
) -> Result<()> {
    for (entity, table_name) in [
        (
            SyncEntity::ActivityTaxonomyAssignment,
            "activity_taxonomy_assignments",
        ),
        (
            SyncEntity::BudgetGroupAssignment,
            "budget_group_assignments",
        ),
        (SyncEntity::BudgetTarget, "budget_targets"),
        (
            SyncEntity::BudgetRolloverSetting,
            "budget_rollover_settings",
        ),
    ] {
        let sql = format!(
            "SELECT id FROM {} WHERE taxonomy_id = '{}' {}",
            quote_identifier(table_name),
            escape_sqlite_str(taxonomy_id),
            category_clause
        );
        let rows = diesel::sql_query(sql)
            .load::<TextIdRow>(conn)
            .map_err(StorageError::from)?;
        for row in rows {
            upsert_entity_metadata_tx(
                conn,
                entity,
                &row.id,
                event_id,
                client_timestamp,
                SyncOperation::Delete,
                seq,
            )?;
        }
    }
    Ok(())
}

fn preset_rule_delete_kind(payload_json: &serde_json::Value) -> Option<&str> {
    payload_json
        .get("preset_delete_kind")
        .or_else(|| payload_json.get("presetDeleteKind"))
        .and_then(serde_json::Value::as_str)
}

fn preset_rule_identity_from_payload(payload_json: &serde_json::Value) -> Option<(String, String)> {
    let preset_id = payload_json
        .get("preset_id")
        .or_else(|| payload_json.get("presetId"))
        .and_then(serde_json::Value::as_str)?;
    let rule_key = payload_json
        .get("preset_rule_key")
        .or_else(|| payload_json.get("presetRuleKey"))
        .and_then(serde_json::Value::as_str)?;
    Some((preset_id.to_string(), rule_key.to_string()))
}

fn preset_rule_payload_str<'a>(
    payload_json: &'a serde_json::Value,
    snake_case: &str,
    camel_case: &str,
) -> Option<&'a str> {
    payload_json
        .get(snake_case)
        .or_else(|| payload_json.get(camel_case))
        .and_then(serde_json::Value::as_str)
}

fn upsert_preset_rule_deletion_tx(
    conn: &mut SqliteConnection,
    preset_id: &str,
    preset_rule_key: &str,
    rule_id: &str,
    deleted_at: &str,
) -> Result<()> {
    diesel::insert_into(spending_preset_rule_deletions::table)
        .values((
            spending_preset_rule_deletions::preset_id.eq(preset_id),
            spending_preset_rule_deletions::preset_rule_key.eq(preset_rule_key),
            spending_preset_rule_deletions::rule_id.eq(rule_id),
            spending_preset_rule_deletions::deleted_at.eq(deleted_at),
        ))
        .on_conflict((
            spending_preset_rule_deletions::preset_id,
            spending_preset_rule_deletions::preset_rule_key,
        ))
        .do_update()
        .set((
            spending_preset_rule_deletions::rule_id.eq(rule_id),
            spending_preset_rule_deletions::deleted_at.eq(deleted_at),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
}

fn tombstone_remote_preset_rule_delete(
    conn: &mut SqliteConnection,
    rule_id: &str,
    payload_json: &serde_json::Value,
    deleted_at: &str,
) -> Result<()> {
    if preset_rule_delete_kind(payload_json) != Some("rule") {
        return Ok(());
    }
    let Some((preset_id, rule_key)) = preset_rule_identity_from_payload(payload_json) else {
        return Ok(());
    };
    upsert_preset_rule_deletion_tx(conn, &preset_id, &rule_key, rule_id, deleted_at)
}

fn apply_spending_preset_rule_deletion_event(
    conn: &mut SqliteConnection,
    entity_id: &str,
    op: SyncOperation,
    payload_json: &serde_json::Value,
    client_timestamp: &str,
) -> Result<()> {
    let Some((preset_id, rule_key)) = preset_rule_identity_from_payload(payload_json) else {
        return Err(Error::Database(DatabaseError::Internal(
            "spending_preset_rule_deletion payload must include preset_id/preset_rule_key"
                .to_string(),
        )));
    };
    let expected_entity_id = preset_rule_deletion_id(&preset_id, &rule_key);
    if expected_entity_id != entity_id {
        return Err(Error::Database(DatabaseError::Internal(format!(
            "spending_preset_rule_deletion entity_id '{}' does not match payload key '{}'",
            entity_id, expected_entity_id
        ))));
    }

    match op {
        SyncOperation::Delete => {
            diesel::delete(
                spending_preset_rule_deletions::table
                    .filter(spending_preset_rule_deletions::preset_id.eq(&preset_id))
                    .filter(spending_preset_rule_deletions::preset_rule_key.eq(&rule_key)),
            )
            .execute(conn)
            .map_err(StorageError::from)?;
        }
        SyncOperation::Create | SyncOperation::Update => {
            let rule_id =
                preset_rule_payload_str(payload_json, "rule_id", "ruleId").ok_or_else(|| {
                    Error::Database(DatabaseError::Internal(
                        "spending_preset_rule_deletion payload must include rule_id".to_string(),
                    ))
                })?;
            let deleted_at = preset_rule_payload_str(payload_json, "deleted_at", "deletedAt")
                .unwrap_or(client_timestamp);
            upsert_preset_rule_deletion_tx(conn, &preset_id, &rule_key, rule_id, deleted_at)?;
        }
    }

    Ok(())
}

fn addon_storage_identity_from_payload(
    payload_json: &serde_json::Value,
) -> Option<(String, String)> {
    let addon_id = payload_json
        .get("addon_id")
        .or_else(|| payload_json.get("addonId"))
        .and_then(serde_json::Value::as_str)?;
    let key = payload_json
        .get("key")
        .and_then(serde_json::Value::as_str)?;
    Some((addon_id.to_string(), key.to_string()))
}

fn apply_addon_storage_event(
    conn: &mut SqliteConnection,
    entity_id: &str,
    op: SyncOperation,
    payload_json: &serde_json::Value,
    _client_timestamp: &str,
) -> Result<()> {
    let Some((addon_id, key)) = addon_storage_identity_from_payload(payload_json) else {
        return Err(Error::Database(DatabaseError::Internal(
            "addon_storage payload must include addon_id/key".to_string(),
        )));
    };
    let expected_entity_id = addon_storage_id(&addon_id, &key);
    if expected_entity_id != entity_id {
        return Err(Error::Database(DatabaseError::Internal(format!(
            "addon_storage entity_id '{}' does not match payload key '{}'",
            entity_id, expected_entity_id
        ))));
    }

    match op {
        SyncOperation::Delete => {
            diesel::delete(
                addon_storage::table
                    .filter(addon_storage::addon_id.eq(&addon_id))
                    .filter(addon_storage::key.eq(&key)),
            )
            .execute(conn)
            .map_err(StorageError::from)?;
        }
        SyncOperation::Create | SyncOperation::Update => {
            let value = payload_json
                .get("value")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    Error::Database(DatabaseError::Internal(
                        "addon_storage payload must include value".to_string(),
                    ))
                })?;
            diesel::replace_into(addon_storage::table)
                .values((
                    addon_storage::addon_id.eq(&addon_id),
                    addon_storage::key.eq(&key),
                    addon_storage::value.eq(value),
                ))
                .execute(conn)
                .map_err(StorageError::from)?;
        }
    }

    Ok(())
}

/// Convert a serializable DB model to a JSON object with snake_case keys
/// suitable for SQL upsert. Returns None if serialization fails.
fn model_to_sql_fields<T: serde::Serialize>(
    model: &T,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    let value = serde_json::to_value(model)?;
    let obj = value.as_object().ok_or_else(|| {
        Error::Database(DatabaseError::Internal(
            "Expected JSON object from model serialization".to_string(),
        ))
    })?;

    // The DB models use #[serde(rename_all = "camelCase")], so we need to
    // convert keys back to snake_case for the DB columns.
    let mut fields = serde_json::Map::new();
    for (key, val) in obj {
        let snake = normalize_payload_key_to_snake_case(key);
        let col = if snake.is_empty() { key.clone() } else { snake };
        fields.insert(col, val.clone());
    }
    Ok(fields)
}

/// Apply a custom taxonomy bundle event (create/update/delete).
/// For create/update: upserts taxonomy row, upserts each category, deletes stale categories.
/// For delete: deletes custom taxonomy rows, or only categories for seeded system taxonomies.
fn apply_custom_taxonomy_event(
    conn: &mut SqliteConnection,
    taxonomy_id: &str,
    op: SyncOperation,
    payload_json: &serde_json::Value,
    event_id: &str,
    client_timestamp: &str,
    seq: i64,
) -> Result<()> {
    match op {
        SyncOperation::Delete => {
            tombstone_spending_children_for_removed_categories(
                conn,
                taxonomy_id,
                "",
                event_id,
                client_timestamp,
                seq,
            )?;
            let sql = if is_syncable_system_taxonomy_id(taxonomy_id) {
                format!(
                    "DELETE FROM \"taxonomy_categories\" WHERE \"taxonomy_id\" = '{}'",
                    escape_sqlite_str(taxonomy_id)
                )
            } else {
                format!(
                    "DELETE FROM \"taxonomies\" WHERE \"id\" = '{}'",
                    escape_sqlite_str(taxonomy_id)
                )
            };
            diesel::sql_query(sql)
                .execute(conn)
                .map_err(StorageError::from)?;
        }
        SyncOperation::Create | SyncOperation::Update => {
            let bundle: crate::taxonomies::CustomTaxonomyPayload =
                serde_json::from_value(payload_json.clone()).map_err(|e| {
                    Error::Database(DatabaseError::Internal(format!(
                        "Invalid custom_taxonomy payload: {}",
                        e
                    )))
                })?;

            // Reject most system taxonomy payloads; these seeded taxonomies allow user categories.
            if bundle.taxonomy.is_system != 0
                && !is_syncable_system_taxonomy_id(&bundle.taxonomy.id)
            {
                return Err(Error::Database(DatabaseError::Internal(
                    "Cannot sync system taxonomy".to_string(),
                )));
            }

            // Validate payload taxonomy ID matches event entity_id
            if bundle.taxonomy.id != taxonomy_id {
                return Err(Error::Database(DatabaseError::Internal(format!(
                    "custom_taxonomy payload id '{}' does not match entity_id '{}'",
                    bundle.taxonomy.id, taxonomy_id
                ))));
            }

            // Validate all categories belong to this taxonomy
            for cat in &bundle.categories {
                if cat.taxonomy_id != taxonomy_id {
                    return Err(Error::Database(DatabaseError::Internal(format!(
                        "custom_taxonomy category '{}' has taxonomy_id '{}', expected '{}'",
                        cat.id, cat.taxonomy_id, taxonomy_id
                    ))));
                }
            }

            // Upsert taxonomy row only for custom taxonomies; seeded system taxonomies are local.
            if !is_syncable_system_taxonomy_id(taxonomy_id) {
                let tax_fields = model_to_sql_fields(&bundle.taxonomy)?;
                upsert_json_row(conn, "taxonomies", &["id"], &tax_fields)?;
            }

            // Upsert each category
            let mut incoming_cat_ids: Vec<String> = Vec::new();
            for cat in &bundle.categories {
                incoming_cat_ids.push(cat.id.clone());
                let cat_fields = model_to_sql_fields(cat)?;
                upsert_json_row(
                    conn,
                    "taxonomy_categories",
                    &["taxonomy_id", "id"],
                    &cat_fields,
                )?;
            }

            // Delete local categories that are NOT in the incoming payload.
            // This cascades their assignments via FK ON DELETE CASCADE.
            if incoming_cat_ids.is_empty() {
                tombstone_spending_children_for_removed_categories(
                    conn,
                    taxonomy_id,
                    "",
                    event_id,
                    client_timestamp,
                    seq,
                )?;
                let sql = format!(
                    "DELETE FROM \"taxonomy_categories\" WHERE \"taxonomy_id\" = '{}'",
                    escape_sqlite_str(taxonomy_id)
                );
                diesel::sql_query(sql)
                    .execute(conn)
                    .map_err(StorageError::from)?;
            } else {
                let placeholders = sql_string_list(&incoming_cat_ids);
                let category_clause = format!("AND category_id NOT IN ({})", placeholders);
                tombstone_spending_children_for_removed_categories(
                    conn,
                    taxonomy_id,
                    &category_clause,
                    event_id,
                    client_timestamp,
                    seq,
                )?;
                let sql = format!(
                    "DELETE FROM \"taxonomy_categories\" WHERE \"taxonomy_id\" = '{}' AND \"id\" NOT IN ({})",
                    escape_sqlite_str(taxonomy_id),
                    placeholders
                );
                diesel::sql_query(sql)
                    .execute(conn)
                    .map_err(StorageError::from)?;
            }
        }
    }

    // Mark both tables as touched
    let now = Utc::now().to_rfc3339();
    for table in &["taxonomies", "taxonomy_categories"] {
        diesel::insert_into(sync_table_state::table)
            .values(SyncTableStateDB {
                table_name: table.to_string(),
                enabled: 1,
                last_snapshot_restore_at: None,
                last_incremental_apply_at: Some(now.clone()),
            })
            .on_conflict(sync_table_state::table_name)
            .do_update()
            .set((
                sync_table_state::enabled.eq(1),
                sync_table_state::last_incremental_apply_at.eq(Some(now.clone())),
            ))
            .execute(conn)
            .map_err(StorageError::from)?;
    }

    Ok(())
}

fn mark_table_incremental_applied_tx(conn: &mut SqliteConnection, table_name: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    diesel::insert_into(sync_table_state::table)
        .values(SyncTableStateDB {
            table_name: table_name.to_string(),
            enabled: 1,
            last_snapshot_restore_at: None,
            last_incremental_apply_at: Some(now.clone()),
        })
        .on_conflict(sync_table_state::table_name)
        .do_update()
        .set((
            sync_table_state::enabled.eq(1),
            sync_table_state::last_incremental_apply_at.eq(Some(now)),
        ))
        .execute(conn)
        .map_err(StorageError::from)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_remote_event_lww_tx(
    conn: &mut SqliteConnection,
    entity: SyncEntity,
    entity_id_value: String,
    op: SyncOperation,
    event_id_value: String,
    client_timestamp_value: String,
    seq_value: i64,
    payload_json: serde_json::Value,
) -> Result<bool> {
    let already_applied = sync_applied_events::table
        .find(&event_id_value)
        .first::<SyncAppliedEventDB>(conn)
        .optional()
        .map_err(StorageError::from)?
        .is_some();
    if already_applied {
        return Ok(false);
    }

    let entity_db = enum_to_db(&entity)?;
    let metadata_row = load_entity_metadata_tx(conn, &entity_db, &entity_id_value)?;

    let mut should_apply = match metadata_row.as_ref() {
        Some(meta) => should_apply_against_metadata(
            entity,
            meta,
            op,
            &client_timestamp_value,
            &event_id_value,
        )?,
        None => true,
    };

    let mut record_applied_event = true;
    if should_apply {
        let mut applied_entity_change = true;
        if entity == SyncEntity::CustomTaxonomy {
            apply_custom_taxonomy_event(
                conn,
                &entity_id_value,
                op,
                &payload_json,
                &event_id_value,
                &client_timestamp_value,
                seq_value,
            )?;
        } else if entity == SyncEntity::BrokerActivityUserPatch {
            match op {
                SyncOperation::Create | SyncOperation::Update => {
                    match apply_broker_activity_user_patch_tx(
                        conn,
                        &entity_id_value,
                        &event_id_value,
                        &payload_json,
                        &client_timestamp_value,
                        seq_value,
                        op,
                    )? {
                        BrokerActivityUserPatchApplyOutcome::Applied => {
                            mark_table_incremental_applied_tx(conn, "activities")?;
                        }
                        BrokerActivityUserPatchApplyOutcome::MissingTarget => {
                            applied_entity_change = false;
                            record_applied_event = false;
                        }
                    }
                }
                SyncOperation::Delete => {
                    applied_entity_change = false;
                }
            }
        } else if entity == SyncEntity::SpendingSetting
            && !is_syncable_spending_setting_key(&entity_id_value)
        {
            log::warn!(
                "Skipping unsupported synced spending setting '{}'",
                entity_id_value
            );
            applied_entity_change = false;
        } else if entity == SyncEntity::SpendingPresetRuleDeletion {
            apply_spending_preset_rule_deletion_event(
                conn,
                &entity_id_value,
                op,
                &payload_json,
                &client_timestamp_value,
            )?;
            mark_table_incremental_applied_tx(conn, "spending_preset_rule_deletions")?;
        } else if entity == SyncEntity::AddonStorage {
            apply_addon_storage_event(
                conn,
                &entity_id_value,
                op,
                &payload_json,
                &client_timestamp_value,
            )?;
            mark_table_incremental_applied_tx(conn, "addon_storage")?;
        } else if let Some((table_name, pk_name)) = entity_storage_mapping(&entity) {
            match op {
                SyncOperation::Delete => {
                    if entity == SyncEntity::SpendingCategorizationRule {
                        tombstone_remote_preset_rule_delete(
                            conn,
                            &entity_id_value,
                            &payload_json,
                            &client_timestamp_value,
                        )?;
                    }
                    let sql = format!(
                        "DELETE FROM {} WHERE {} = '{}'",
                        quote_identifier(table_name),
                        quote_identifier(pk_name),
                        escape_sqlite_str(&entity_id_value)
                    );
                    diesel::sql_query(sql)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }
                SyncOperation::Create | SyncOperation::Update => {
                    let payload_obj = payload_json.as_object().ok_or_else(|| {
                        Error::Database(DatabaseError::Internal(
                            "Sync payload must be a JSON object".to_string(),
                        ))
                    })?;

                    let fields: Vec<(String, serde_json::Value)> = payload_obj
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    let mut fields = normalize_payload_fields(conn, table_name, fields)?;
                    if let Some((_, payload_pk)) = fields.iter().find(|(k, _)| k == pk_name) {
                        if !payload_value_matches_entity_id(payload_pk, &entity_id_value) {
                            return Err(Error::Database(DatabaseError::Internal(format!(
                                "Sync payload PK '{}' does not match entity_id '{}'",
                                pk_name, entity_id_value
                            ))));
                        }
                    } else {
                        fields.push((
                            pk_name.to_string(),
                            serde_json::Value::String(entity_id_value.clone()),
                        ));
                    }
                    validate_spending_decimal_field(&entity, &fields)?;

                    let columns = fields
                        .iter()
                        .map(|(k, _)| quote_identifier(k))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let values = fields
                        .iter()
                        .map(|(_, v)| json_value_to_sql_literal(v))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let upserts = fields
                        .iter()
                        .map(|(k, _)| {
                            let quoted = quote_identifier(k);
                            format!("{quoted}=excluded.{quoted}")
                        })
                        .collect::<Vec<_>>()
                        .join(", ");

                    let sql = format!(
                        "INSERT INTO {} ({columns}) VALUES ({values}) \
                         ON CONFLICT({}) DO UPDATE SET {upserts}",
                        quote_identifier(table_name),
                        quote_identifier(pk_name)
                    );
                    if applied_entity_change {
                        diesel::sql_query(sql)
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }

                    if applied_entity_change && matches!(entity, SyncEntity::Snapshot) {
                        rebuild_snapshot_positions_from_snapshot_row_tx(conn, &entity_id_value)?;
                        mark_table_incremental_applied_tx(conn, "snapshot_positions")?;
                    }
                }
            }

            mark_table_incremental_applied_tx(conn, table_name)?;
        }

        if applied_entity_change {
            upsert_entity_metadata_tx(
                conn,
                entity,
                &entity_id_value,
                &event_id_value,
                &client_timestamp_value,
                op,
                seq_value,
            )?;
        } else {
            should_apply = false;
        }
    }

    if record_applied_event {
        diesel::insert_into(sync_applied_events::table)
            .values(SyncAppliedEventDB {
                event_id: event_id_value,
                seq: seq_value,
                entity: entity_db,
                entity_id: entity_id_value,
                applied_at: Utc::now().to_rfc3339(),
            })
            .on_conflict(sync_applied_events::event_id)
            .do_nothing()
            .execute(conn)
            .map_err(StorageError::from)?;
    }

    Ok(should_apply)
}

pub struct AppSyncRepository {
    pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
    writer: WriteHandle,
}

impl AppSyncRepository {
    pub fn new(
        pool: Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        writer: WriteHandle,
    ) -> Self {
        Self { pool, writer }
    }

    pub fn get_cursor(&self) -> Result<i64> {
        let mut conn = get_connection(&self.pool)?;
        let row = sync_cursor::table
            .find(1)
            .first::<SyncCursorDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(row.map(|r| r.cursor).unwrap_or(0))
    }

    pub async fn set_cursor(&self, cursor_value: i64) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                let row = SyncCursorDB {
                    id: 1,
                    cursor: cursor_value,
                    updated_at: now.clone(),
                };

                diesel::insert_into(sync_cursor::table)
                    .values(&row)
                    .on_conflict(sync_cursor::id)
                    .do_update()
                    .set((
                        sync_cursor::cursor.eq(cursor_value),
                        sync_cursor::updated_at.eq(now),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    pub fn get_engine_status(&self) -> Result<SyncEngineStatus> {
        let mut conn = get_connection(&self.pool)?;
        let cursor = self.get_cursor()?;
        let engine = sync_engine_state::table
            .find(1)
            .first::<SyncEngineStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        Ok(SyncEngineStatus {
            cursor,
            last_push_at: engine.as_ref().and_then(|s| s.last_push_at.clone()),
            last_pull_at: engine.as_ref().and_then(|s| s.last_pull_at.clone()),
            last_error: engine.as_ref().and_then(|s| s.last_error.clone()),
            consecutive_failures: engine.as_ref().map(|s| s.consecutive_failures).unwrap_or(0),
            next_retry_at: engine.as_ref().and_then(|s| s.next_retry_at.clone()),
            last_cycle_status: engine.as_ref().and_then(|s| s.last_cycle_status.clone()),
            last_cycle_duration_ms: engine.and_then(|s| s.last_cycle_duration_ms),
        })
    }

    pub fn needs_bootstrap(&self, device_id: &str) -> Result<bool> {
        let mut conn = get_connection(&self.pool)?;
        let config = sync_device_config::table
            .find(device_id)
            .first::<SyncDeviceConfigDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        let stale_cursor_detected = sync_engine_state::table
            .find(1)
            .first::<SyncEngineStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?
            .and_then(|row| row.last_cycle_status)
            .is_some_and(|status| status == "stale_cursor");

        Ok(match config {
            None => true,
            Some(row) => row.last_bootstrap_at.is_none() || stale_cursor_detected,
        })
    }

    pub fn get_local_sync_data_summary(&self) -> Result<SyncLocalDataSummary> {
        let mut conn = get_connection(&self.pool)?;
        let mut total_rows = 0_i64;
        let mut non_empty_tables = Vec::new();

        for table in APP_SYNC_TABLES {
            let table_ident = quote_identifier(table);
            let count_sql = match snapshot_copy_filter_for_table(table) {
                Some(where_clause) => {
                    format!("SELECT COUNT(*) AS count FROM {table_ident} WHERE {where_clause}")
                }
                None => format!("SELECT COUNT(*) AS count FROM {table_ident}"),
            };
            let row = diesel::sql_query(count_sql)
                .get_result::<TableRowCountResult>(&mut conn)
                .map_err(StorageError::from)?;
            total_rows += row.count;
            if row.count > 0 {
                non_empty_tables.push(SyncTableRowCount {
                    table: table.to_string(),
                    rows: row.count,
                });
            }
        }

        non_empty_tables.sort_by(|a, b| b.rows.cmp(&a.rows).then_with(|| a.table.cmp(&b.table)));

        Ok(SyncLocalDataSummary {
            total_rows,
            non_empty_tables,
        })
    }

    pub fn get_local_sync_overwrite_risk_summary(&self) -> Result<SyncLocalDataSummary> {
        let mut conn = get_connection(&self.pool)?;
        let mut total_rows = 0_i64;
        let mut non_empty_tables = Vec::new();

        let mut record_table = |table: &str, filter: Option<SyncRowFilter>| -> Result<()> {
            let table_ident = quote_identifier(table);
            let count_sql = match filter.map(SyncRowFilter::sql) {
                Some(filter) => {
                    format!("SELECT COUNT(*) AS count FROM {table_ident} WHERE {filter}")
                }
                None => format!("SELECT COUNT(*) AS count FROM {table_ident}"),
            };
            let row = diesel::sql_query(count_sql)
                .get_result::<TableRowCountResult>(&mut conn)
                .map_err(StorageError::from)?;
            total_rows += row.count;
            if row.count > 0 {
                non_empty_tables.push(SyncTableRowCount {
                    table: table.to_string(),
                    rows: row.count,
                });
            }
            Ok(())
        };

        for table in OVERWRITE_RISK_UNFILTERED_TABLES {
            record_table(table, None)?;
        }
        for spec in OVERWRITE_RISK_FILTERED_TABLES {
            record_table(spec.table, Some(spec.filter))?;
        }

        non_empty_tables.sort_by(|a, b| b.rows.cmp(&a.rows).then_with(|| a.table.cmp(&b.table)));

        Ok(SyncLocalDataSummary {
            total_rows,
            non_empty_tables,
        })
    }

    pub async fn upsert_device_config(
        &self,
        device_id_value: String,
        key_version_value: Option<i32>,
        trust_state_value: String,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let row = SyncDeviceConfigDB {
                    device_id: device_id_value.clone(),
                    key_version: key_version_value,
                    trust_state: trust_state_value.clone(),
                    last_bootstrap_at: None,
                    min_snapshot_created_at: None,
                };

                diesel::insert_into(sync_device_config::table)
                    .values(&row)
                    .on_conflict(sync_device_config::device_id)
                    .do_update()
                    .set((
                        sync_device_config::key_version.eq(key_version_value),
                        sync_device_config::trust_state.eq(trust_state_value),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    pub async fn reset_local_sync_session(&self) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();

                diesel::delete(sync_outbox::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                diesel::delete(sync_entity_metadata::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                diesel::delete(sync_applied_events::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                diesel::delete(sync_table_state::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                diesel::delete(sync_device_config::table)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                diesel::insert_into(sync_cursor::table)
                    .values(SyncCursorDB {
                        id: 1,
                        cursor: 0,
                        updated_at: now.clone(),
                    })
                    .on_conflict(sync_cursor::id)
                    .do_update()
                    .set((
                        sync_cursor::cursor.eq(0),
                        sync_cursor::updated_at.eq(now.clone()),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: 0,
                        last_push_at: None,
                        last_pull_at: None,
                        last_error: None,
                        consecutive_failures: 0,
                        next_retry_at: None,
                        last_cycle_status: None,
                        last_cycle_duration_ms: None,
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set((
                        sync_engine_state::lock_version.eq(0),
                        sync_engine_state::last_push_at.eq::<Option<String>>(None),
                        sync_engine_state::last_pull_at.eq::<Option<String>>(None),
                        sync_engine_state::last_error.eq::<Option<String>>(None),
                        sync_engine_state::consecutive_failures.eq(0),
                        sync_engine_state::next_retry_at.eq::<Option<String>>(None),
                        sync_engine_state::last_cycle_status.eq::<Option<String>>(None),
                        sync_engine_state::last_cycle_duration_ms.eq::<Option<i64>>(None),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    pub async fn reset_and_mark_bootstrap_complete(
        &self,
        device_id_value: String,
        key_version_value: Option<i32>,
    ) -> Result<()> {
        self.reset_local_sync_session().await?;

        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();

                diesel::insert_into(sync_device_config::table)
                    .values(SyncDeviceConfigDB {
                        device_id: device_id_value.clone(),
                        key_version: key_version_value,
                        trust_state: "trusted".to_string(),
                        last_bootstrap_at: Some(now.clone()),
                        min_snapshot_created_at: None,
                    })
                    .on_conflict(sync_device_config::device_id)
                    .do_update()
                    .set((
                        sync_device_config::key_version.eq(key_version_value),
                        sync_device_config::trust_state.eq("trusted"),
                        sync_device_config::last_bootstrap_at.eq(Some(now.clone())),
                        sync_device_config::min_snapshot_created_at.eq(None::<String>),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(())
            })
            .await
    }

    /// Persist the bootstrap freshness gate for a device.
    /// Uses upsert so the gate is stored even if no device_config row exists yet.
    pub async fn set_min_snapshot_created_at(
        &self,
        device_id_value: String,
        value: String,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::insert_into(sync_device_config::table)
                    .values(SyncDeviceConfigDB {
                        device_id: device_id_value.clone(),
                        key_version: None,
                        trust_state: "untrusted".to_string(),
                        last_bootstrap_at: None,
                        min_snapshot_created_at: Some(value.clone()),
                    })
                    .on_conflict(sync_device_config::device_id)
                    .do_update()
                    .set(sync_device_config::min_snapshot_created_at.eq(Some(&value)))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    /// Read the bootstrap freshness gate for a device.
    pub fn get_min_snapshot_created_at(&self, device_id_value: &str) -> Result<Option<String>> {
        let mut conn = get_connection(&self.pool)?;
        let row = sync_device_config::table
            .filter(sync_device_config::device_id.eq(device_id_value))
            .select(sync_device_config::min_snapshot_created_at)
            .first::<Option<String>>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(row.flatten())
    }

    /// Clear the bootstrap freshness gate for ALL devices.
    /// Used during logout/reset/reinitialize flows.
    pub async fn clear_all_min_snapshot_created_at(&self) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::update(sync_device_config::table)
                    .set(sync_device_config::min_snapshot_created_at.eq(None::<String>))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    /// Clear the bootstrap freshness gate for a device.
    pub async fn clear_min_snapshot_created_at(&self, device_id_value: String) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::update(
                    sync_device_config::table
                        .filter(sync_device_config::device_id.eq(&device_id_value)),
                )
                .set(sync_device_config::min_snapshot_created_at.eq(None::<String>))
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub fn list_pending_outbox(&self, limit_value: i64) -> Result<Vec<SyncOutboxEvent>> {
        let mut conn = get_connection(&self.pool)?;
        let now = Utc::now().to_rfc3339();
        let pending_status = enum_to_db(&SyncOutboxStatus::Pending)?;
        log::debug!(
            "[OutboxQuery] status_filter={}, sent_filter=0, now={}, limit={}",
            pending_status,
            now,
            limit_value
        );

        let rows = sync_outbox::table
            .filter(
                sync_outbox::status
                    .eq(pending_status)
                    .and(sync_outbox::sent.eq(0)),
            )
            .filter(
                sync_outbox::next_retry_at
                    .is_null()
                    .or(sync_outbox::next_retry_at.le(now)),
            )
            .order(sync_outbox::created_at.asc())
            .limit(limit_value)
            .load::<SyncOutboxEventDB>(&mut conn)
            .map_err(StorageError::from)?;

        log::debug!("[OutboxQuery] Found {} pending outbox events", rows.len());
        rows.into_iter().map(to_outbox_event).collect()
    }

    pub async fn mark_outbox_sent(&self, event_ids: Vec<String>) -> Result<()> {
        if event_ids.is_empty() {
            return Ok(());
        }

        self.writer
            .exec(move |conn| {
                diesel::update(sync_outbox::table.filter(sync_outbox::event_id.eq_any(event_ids)))
                    .set((
                        sync_outbox::sent.eq(1),
                        sync_outbox::status.eq(enum_to_db(&SyncOutboxStatus::Sent)?),
                        sync_outbox::next_retry_at.eq::<Option<String>>(None),
                        sync_outbox::last_error.eq::<Option<String>>(None),
                        sync_outbox::last_error_code.eq::<Option<String>>(None),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn schedule_outbox_retry(
        &self,
        event_ids: Vec<String>,
        backoff_seconds: i64,
        last_error: Option<String>,
        last_error_code: Option<String>,
    ) -> Result<()> {
        if event_ids.is_empty() {
            return Ok(());
        }

        self.writer
            .exec(move |conn| {
                let retry_at = (Utc::now() + Duration::seconds(backoff_seconds)).to_rfc3339();
                let rows = sync_outbox::table
                    .filter(sync_outbox::event_id.eq_any(&event_ids))
                    .load::<SyncOutboxEventDB>(conn)
                    .map_err(StorageError::from)?;

                for row in rows {
                    diesel::update(sync_outbox::table.find(row.event_id))
                        .set((
                            sync_outbox::retry_count.eq(row.retry_count + 1),
                            sync_outbox::next_retry_at.eq(Some(retry_at.clone())),
                            sync_outbox::status.eq(enum_to_db(&SyncOutboxStatus::Pending)?),
                            sync_outbox::last_error.eq(last_error.clone()),
                            sync_outbox::last_error_code.eq(last_error_code.clone()),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }
                Ok(())
            })
            .await
    }

    pub async fn upsert_entity_metadata(&self, metadata: SyncEntityMetadata) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let row = SyncEntityMetadataDB {
                    entity: enum_to_db(&metadata.entity)?,
                    entity_id: metadata.entity_id.clone(),
                    last_event_id: metadata.last_event_id.clone(),
                    last_client_timestamp: metadata.last_client_timestamp.clone(),
                    last_op: enum_to_db(&metadata.last_op)?,
                    last_seq: metadata.last_seq,
                };

                diesel::insert_into(sync_entity_metadata::table)
                    .values(&row)
                    .on_conflict((
                        sync_entity_metadata::entity,
                        sync_entity_metadata::entity_id,
                    ))
                    .do_update()
                    .set((
                        sync_entity_metadata::last_event_id.eq(row.last_event_id.clone()),
                        sync_entity_metadata::last_client_timestamp
                            .eq(row.last_client_timestamp.clone()),
                        sync_entity_metadata::last_op.eq(row.last_op.clone()),
                        sync_entity_metadata::last_seq.eq(row.last_seq),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub fn get_entity_metadata(
        &self,
        entity: SyncEntity,
        entity_id_value: &str,
    ) -> Result<Option<SyncEntityMetadata>> {
        let mut conn = get_connection(&self.pool)?;
        let entity_value = enum_to_db(&entity)?;
        let row = sync_entity_metadata::table
            .find((entity_value, entity_id_value))
            .first::<SyncEntityMetadataDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;

        row.map(to_entity_metadata).transpose()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_remote_event_lww(
        &self,
        entity: SyncEntity,
        entity_id_value: String,
        op: SyncOperation,
        event_id_value: String,
        client_timestamp_value: String,
        seq_value: i64,
        payload_json: serde_json::Value,
    ) -> Result<bool> {
        self.writer
            .exec(move |conn| {
                apply_remote_event_lww_tx(
                    conn,
                    entity,
                    entity_id_value.clone(),
                    op,
                    event_id_value.clone(),
                    client_timestamp_value,
                    seq_value,
                    payload_json,
                )
                .map_err(|err| {
                    replay_apply_error(
                        entity,
                        &entity_id_value,
                        op,
                        &event_id_value,
                        seq_value,
                        err,
                    )
                })
            })
            .await
    }

    pub async fn apply_remote_events_lww_batch(
        &self,
        events: Vec<(
            SyncEntity,
            String,
            SyncOperation,
            String,
            String,
            i64,
            serde_json::Value,
        )>,
    ) -> Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }

        self.writer
            .exec(move |conn| {
                // Defer FK checks during batch replay — events may arrive
                // out of dependency order (e.g. activity before its account).
                // Note: writer actor wraps jobs in a transaction, and SQLite
                // ignores PRAGMA foreign_keys toggles inside active transactions.
                // defer_foreign_keys applies to the current transaction and lets
                // constraints validate at commit time.
                diesel::sql_query("PRAGMA defer_foreign_keys = ON")
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let result = (|| -> Result<usize> {
                    let mut fk_check_tables = Vec::new();
                    for (entity, ..) in &events {
                        if let Some((table, _)) = entity_storage_mapping(entity) {
                            if !fk_check_tables.contains(&table) {
                                fk_check_tables.push(table);
                            }
                        }
                    }

                    let mut applied = 0usize;
                    for (entity, entity_id, op, event_id, client_timestamp, seq, payload) in events
                    {
                        if apply_remote_event_lww_tx(
                            conn,
                            entity,
                            entity_id.clone(),
                            op,
                            event_id.clone(),
                            client_timestamp.clone(),
                            seq,
                            payload,
                        )
                        .map_err(|err| {
                            replay_apply_error(entity, &entity_id, op, &event_id, seq, err)
                        })? {
                            applied += 1;
                        }
                    }
                    ensure_no_foreign_key_violations_tx(conn, fk_check_tables.iter().copied())?;
                    Ok(applied)
                })();

                let _ = diesel::sql_query("PRAGMA defer_foreign_keys = OFF").execute(conn);
                result
            })
            .await
    }

    pub async fn acquire_cycle_lock(&self) -> Result<i64> {
        self.writer
            .exec(move |conn| {
                let state = sync_engine_state::table
                    .find(1)
                    .first::<SyncEngineStateDB>(conn)
                    .optional()
                    .map_err(StorageError::from)?;

                let next_lock_version = state.map(|s| s.lock_version + 1).unwrap_or(1);
                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: next_lock_version,
                        last_push_at: None,
                        last_pull_at: None,
                        last_error: None,
                        consecutive_failures: 0,
                        next_retry_at: None,
                        last_cycle_status: None,
                        last_cycle_duration_ms: None,
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set(sync_engine_state::lock_version.eq(next_lock_version))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                Ok(next_lock_version)
            })
            .await
    }

    pub fn verify_cycle_lock(&self, expected_version: i64) -> Result<bool> {
        let mut conn = get_connection(&self.pool)?;
        let state = sync_engine_state::table
            .find(1)
            .first::<SyncEngineStateDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(state
            .map(|s| s.lock_version == expected_version)
            .unwrap_or(false))
    }

    pub async fn mark_push_completed(&self) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: 0,
                        last_push_at: Some(now.clone()),
                        last_pull_at: None,
                        last_error: None,
                        consecutive_failures: 0,
                        next_retry_at: None,
                        last_cycle_status: None,
                        last_cycle_duration_ms: None,
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set((
                        sync_engine_state::last_push_at.eq(Some(now)),
                        sync_engine_state::last_error.eq::<Option<String>>(None),
                        sync_engine_state::consecutive_failures.eq(0),
                        sync_engine_state::next_retry_at.eq::<Option<String>>(None),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn mark_pull_completed(&self) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: 0,
                        last_push_at: None,
                        last_pull_at: Some(now.clone()),
                        last_error: None,
                        consecutive_failures: 0,
                        next_retry_at: None,
                        last_cycle_status: None,
                        last_cycle_duration_ms: None,
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set((
                        sync_engine_state::last_pull_at.eq(Some(now)),
                        sync_engine_state::last_error.eq::<Option<String>>(None),
                        sync_engine_state::consecutive_failures.eq(0),
                        sync_engine_state::next_retry_at.eq::<Option<String>>(None),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn mark_engine_error(&self, error_message: String) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: 0,
                        last_push_at: None,
                        last_pull_at: None,
                        last_error: Some(error_message.clone()),
                        consecutive_failures: 1,
                        next_retry_at: None,
                        last_cycle_status: Some("error".to_string()),
                        last_cycle_duration_ms: None,
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set((
                        sync_engine_state::last_error.eq(Some(error_message)),
                        sync_engine_state::consecutive_failures
                            .eq(sync_engine_state::consecutive_failures + 1),
                        sync_engine_state::last_cycle_status.eq(Some("error")),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub fn has_applied_event(&self, event_id_value: &str) -> Result<bool> {
        let mut conn = get_connection(&self.pool)?;
        let existing = sync_applied_events::table
            .find(event_id_value)
            .first::<SyncAppliedEventDB>(&mut conn)
            .optional()
            .map_err(StorageError::from)?;
        Ok(existing.is_some())
    }

    pub async fn mark_applied_event(
        &self,
        event_id_value: String,
        seq_value: i64,
        entity_value: SyncEntity,
        entity_id_value: String,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let row = SyncAppliedEventDB {
                    event_id: event_id_value.clone(),
                    seq: seq_value,
                    entity: enum_to_db(&entity_value)?,
                    entity_id: entity_id_value,
                    applied_at: Utc::now().to_rfc3339(),
                };

                diesel::insert_into(sync_applied_events::table)
                    .values(&row)
                    .on_conflict(sync_applied_events::event_id)
                    .do_nothing()
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn prune_applied_events_up_to_seq(&self, seq_cutoff: i64) -> Result<usize> {
        self.writer
            .exec(move |conn| {
                let deleted = diesel::delete(
                    sync_applied_events::table.filter(sync_applied_events::seq.le(seq_cutoff)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(deleted)
            })
            .await
    }

    pub async fn prune_sync_outbox(
        &self,
        sent_before: DateTime<Utc>,
        dead_before: DateTime<Utc>,
    ) -> Result<usize> {
        self.writer
            .exec(move |conn| {
                let sent_status = enum_to_db(&SyncOutboxStatus::Sent)?;
                let dead_status = enum_to_db(&SyncOutboxStatus::Dead)?;
                let sent_cutoff = sent_before.to_rfc3339();
                let dead_cutoff = dead_before.to_rfc3339();

                let sent_deleted = diesel::delete(
                    sync_outbox::table
                        .filter(sync_outbox::status.eq(sent_status))
                        .filter(sync_outbox::created_at.lt(sent_cutoff)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;

                let dead_deleted = diesel::delete(
                    sync_outbox::table
                        .filter(sync_outbox::status.eq(dead_status))
                        .filter(sync_outbox::created_at.lt(dead_cutoff)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;

                Ok(sent_deleted + dead_deleted)
            })
            .await
    }

    pub async fn mark_table_incremental_applied(&self, table_name_value: String) -> Result<()> {
        validate_sync_table(&table_name_value)?;
        self.writer
            .exec(move |conn| {
                let now = Utc::now().to_rfc3339();
                diesel::insert_into(sync_table_state::table)
                    .values(SyncTableStateDB {
                        table_name: table_name_value.clone(),
                        enabled: 1,
                        last_snapshot_restore_at: None,
                        last_incremental_apply_at: Some(now.clone()),
                    })
                    .on_conflict(sync_table_state::table_name)
                    .do_update()
                    .set((
                        sync_table_state::enabled.eq(1),
                        sync_table_state::last_incremental_apply_at.eq(Some(now)),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn mark_outbox_dead(
        &self,
        event_ids: Vec<String>,
        error_message: Option<String>,
        error_code: Option<String>,
    ) -> Result<()> {
        if event_ids.is_empty() {
            return Ok(());
        }

        self.writer
            .exec(move |conn| {
                diesel::update(sync_outbox::table.filter(sync_outbox::event_id.eq_any(event_ids)))
                    .set((
                        sync_outbox::status.eq(enum_to_db(&SyncOutboxStatus::Dead)?),
                        sync_outbox::last_error.eq(error_message),
                        sync_outbox::last_error_code.eq(error_code),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }

    pub async fn mark_cycle_outcome(
        &self,
        status_value: String,
        duration_ms_value: i64,
        next_retry_at_value: Option<String>,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                diesel::insert_into(sync_engine_state::table)
                    .values(SyncEngineStateDB {
                        id: 1,
                        lock_version: 0,
                        last_push_at: None,
                        last_pull_at: None,
                        last_error: None,
                        consecutive_failures: 0,
                        next_retry_at: next_retry_at_value.clone(),
                        last_cycle_status: Some(status_value.clone()),
                        last_cycle_duration_ms: Some(duration_ms_value),
                    })
                    .on_conflict(sync_engine_state::id)
                    .do_update()
                    .set((
                        sync_engine_state::last_cycle_status.eq(Some(status_value.clone())),
                        sync_engine_state::last_cycle_duration_ms.eq(Some(duration_ms_value)),
                        sync_engine_state::next_retry_at.eq(next_retry_at_value.clone()),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                if status_value == "ok" {
                    diesel::update(sync_engine_state::table.filter(sync_engine_state::id.eq(1)))
                        .set((
                            sync_engine_state::last_error.eq::<Option<String>>(None),
                            sync_engine_state::consecutive_failures.eq(0),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;
                }
                Ok(())
            })
            .await
    }

    pub async fn validate_snapshot_upload_integrity(&self, tables: Vec<String>) -> Result<()> {
        let pool = Arc::clone(&self.pool);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = get_connection(&pool)?;
            let table_set = canonical_sync_table_set(tables)?;
            let rows = collect_foreign_key_violations_tx(
                &mut conn,
                table_set.iter().map(|table| table.as_str()),
            )?;
            let rows = rows
                .into_iter()
                .filter(|row| !should_ignore_snapshot_upload_fk_violation(row))
                .collect::<Vec<_>>();
            if rows.is_empty() {
                return Ok(());
            }

            Err(snapshot_upload_integrity_error_tx(&mut conn, &rows))
        })
        .await
        .map_err(|e| {
            Error::Database(DatabaseError::Internal(format!(
                "Snapshot upload integrity worker failed: {}",
                e
            )))
        })?
    }

    pub async fn export_snapshot_sqlite_image(&self, tables: Vec<String>) -> Result<Vec<u8>> {
        let pool = Arc::clone(&self.pool);
        tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let mut conn = get_connection(&pool)?;
            let table_set = if tables.is_empty() {
                APP_SYNC_TABLES
                    .iter()
                    .map(|t| t.to_string())
                    .collect::<Vec<_>>()
            } else {
                tables
            };
            for table in &table_set {
                validate_sync_table(table)?;
            }

            let snapshot_path =
                std::env::temp_dir().join(format!("wf_snapshot_export_{}.db", Uuid::now_v7()));
            let escaped_path = escape_sqlite_str(&snapshot_path.to_string_lossy());
            let snapshot_alias = format!("snapshot_export_{}", Uuid::now_v7().simple());
            let attach_sql = format!("ATTACH DATABASE '{}' AS {}", escaped_path, snapshot_alias);
            let tx_result = conn.immediate_transaction::<_, StorageError, _>(|tx| {
                diesel::sql_query(attach_sql.clone())
                    .execute(tx)
                    .map_err(StorageError::from)?;

                let run_export = (|| -> Result<()> {
                    for table in &table_set {
                        let table_ident = quote_identifier(table);
                        let filter = snapshot_copy_filter_for_table(table);
                        let copy_sql = match filter {
                            Some(where_clause) => format!(
                                "CREATE TABLE {snapshot_alias}.{table_ident} AS SELECT * FROM main.{table_ident} WHERE {where_clause}"
                            ),
                            None => format!(
                                "CREATE TABLE {snapshot_alias}.{table_ident} AS SELECT * FROM main.{table_ident}"
                            ),
                        };
                        diesel::sql_query(copy_sql)
                            .execute(tx)
                            .map_err(StorageError::from)?;
                    }
                    Ok(())
                })();

                let detach_sql = format!("DETACH DATABASE {}", snapshot_alias);
                let _ = diesel::sql_query(detach_sql).execute(tx);
                run_export.map_err(StorageError::from)
            });
            if let Err(err) = tx_result {
                let _ = std::fs::remove_file(&snapshot_path);
                return Err(Error::from(err));
            }

            let payload = std::fs::read(&snapshot_path).map_err(|e| {
                Error::Database(DatabaseError::Internal(format!(
                    "Failed reading exported snapshot: {}",
                    e
                )))
            })?;
            let _ = std::fs::remove_file(snapshot_path);
            Ok(payload)
        })
        .await
        .map_err(|e| {
            Error::Database(DatabaseError::Internal(format!(
                "Snapshot export worker failed: {}",
                e
            )))
        })?
    }

    pub async fn restore_snapshot_tables_from_file(
        &self,
        snapshot_db_path: String,
        tables: Vec<String>,
        cursor_value: i64,
        device_id_value: String,
        key_version_value: Option<i32>,
    ) -> Result<()> {
        self.writer
            .exec(move |conn| {
                let table_set = canonical_sync_table_set(tables)?;
                let table_set_lookup = table_set.iter().cloned().collect::<HashSet<_>>();

                let now = Utc::now().to_rfc3339();
                let escaped_path = escape_sqlite_str(&snapshot_db_path);
                let snapshot_alias = format!("snapshot_{}", Uuid::new_v4().simple());
                let attach_sql =
                    format!("ATTACH DATABASE '{}' AS {}", escaped_path, snapshot_alias);

                // APP_SYNC_TABLES is parent-first for inserts. Restore clears the
                // selected tables in reverse order, then inserts in canonical order.
                diesel::sql_query(attach_sql)
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let restore_result = (|| -> Result<()> {
                    // Bootstrap reset: clear control-plane sync state so stale events/metadata
                    // never leak into the newly restored snapshot baseline.
                    diesel::delete(sync_outbox::table)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    diesel::delete(sync_entity_metadata::table)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    diesel::delete(sync_applied_events::table)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    diesel::delete(sync_table_state::table)
                        .execute(conn)
                        .map_err(StorageError::from)?;
                    // Remove stale device config rows from previous enrollment cycles so
                    // resolve_payload_key_version never picks an outdated key_version.
                    diesel::delete(
                        sync_device_config::table
                            .filter(sync_device_config::device_id.ne(&device_id_value)),
                    )
                    .execute(conn)
                    .map_err(StorageError::from)?;

                    reset_restore_dependent_read_models(conn, &table_set_lookup)?;

                    struct RestorePlan {
                        table: String,
                        clear_sql: String,
                        copy_sql: String,
                    }

                    let mut restore_plans = Vec::new();
                    for table in &table_set {
                        let target_columns = load_table_columns(conn, "main", table)?;
                        let source_columns = load_table_columns(conn, &snapshot_alias, table)?;
                        if source_columns.is_empty() {
                            // Table is absent from the snapshot (e.g., snapshot was created by
                            // an older client before this table was introduced). Skip it — the
                            // local table retains whatever data it has, which is safer than
                            // clearing it to empty.
                            log::warn!(
                                "Snapshot does not contain table '{}' — skipping restore for this table",
                                table
                            );
                            continue;
                        }
                        let source_column_set =
                            source_columns.into_iter().collect::<HashSet<String>>();
                        let common_columns = target_columns
                            .into_iter()
                            .filter(|column| source_column_set.contains(column))
                            .collect::<Vec<_>>();
                        if common_columns.is_empty() {
                            return Err(Error::Database(DatabaseError::Internal(format!(
                                "Snapshot table '{}' has no compatible columns to restore",
                                table
                            ))));
                        }

                        let table_ident = quote_identifier(table);
                        let alias_ident = quote_identifier(&snapshot_alias);
                        let columns_sql = common_columns
                            .iter()
                            .map(|column| quote_identifier(column))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let copy_sql = match snapshot_copy_filter_for_table(table) {
                            Some(where_clause) => format!(
                                "INSERT INTO {table_ident} ({columns_sql}) SELECT {columns_sql} FROM {alias_ident}.{table_ident} WHERE {where_clause}"
                            ),
                            None => format!(
                                "INSERT INTO {table_ident} ({columns_sql}) SELECT {columns_sql} FROM {alias_ident}.{table_ident}"
                            ),
                        };
                        // For filtered tables, only delete rows matching the filter so
                        // unfiltered rows (e.g. system taxonomies) are preserved.
                        let clear_sql = match snapshot_clear_filter_for_table(table) {
                            Some(where_clause) => {
                                format!("DELETE FROM {table_ident} WHERE {where_clause}")
                            }
                            None => format!("DELETE FROM {table_ident}"),
                        };
                        restore_plans.push(RestorePlan {
                            table: table.clone(),
                            clear_sql,
                            copy_sql,
                        });
                    }

                    for plan in restore_plans.iter().rev() {
                        diesel::sql_query(&plan.clear_sql)
                            .execute(conn)
                            .map_err(|err| restore_sql_error("clear", &plan.table, err))?;
                        if plan.table == "holdings_snapshots" {
                            delete_orphan_snapshot_rows(conn)?;
                        }
                    }

                    for plan in &restore_plans {
                        diesel::sql_query(&plan.copy_sql)
                            .execute(conn)
                            .map_err(|err| restore_sql_error("copy", &plan.table, err))?;

                        let state_row = SyncTableStateDB {
                            table_name: plan.table.clone(),
                            enabled: 1,
                            last_snapshot_restore_at: Some(now.clone()),
                            last_incremental_apply_at: None,
                        };
                        diesel::insert_into(sync_table_state::table)
                            .values(&state_row)
                            .on_conflict(sync_table_state::table_name)
                            .do_update()
                            .set((
                                sync_table_state::enabled.eq(1),
                                sync_table_state::last_snapshot_restore_at.eq(Some(now.clone())),
                            ))
                            .execute(conn)
                            .map_err(StorageError::from)?;
                    }
                    ensure_no_foreign_key_violations_tx(
                        conn,
                        restore_plans.iter().map(|plan| plan.table.as_str()),
                    )?;

                    diesel::insert_into(sync_cursor::table)
                        .values(SyncCursorDB {
                            id: 1,
                            cursor: cursor_value,
                            updated_at: now.clone(),
                        })
                        .on_conflict(sync_cursor::id)
                        .do_update()
                        .set((
                            sync_cursor::cursor.eq(cursor_value),
                            sync_cursor::updated_at.eq(now.clone()),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;

                    diesel::insert_into(sync_device_config::table)
                        .values(SyncDeviceConfigDB {
                            device_id: device_id_value.clone(),
                            key_version: key_version_value,
                            trust_state: "trusted".to_string(),
                            last_bootstrap_at: Some(now.clone()),
                            min_snapshot_created_at: None,
                        })
                        .on_conflict(sync_device_config::device_id)
                        .do_update()
                        .set((
                            sync_device_config::key_version.eq(key_version_value),
                            sync_device_config::trust_state.eq("trusted"),
                            sync_device_config::last_bootstrap_at.eq(Some(now.clone())),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;

                    diesel::insert_into(sync_engine_state::table)
                        .values(SyncEngineStateDB {
                            id: 1,
                            lock_version: 0,
                            last_push_at: None,
                            last_pull_at: Some(now.clone()),
                            last_error: None,
                            consecutive_failures: 0,
                            next_retry_at: None,
                            last_cycle_status: Some("ok".to_string()),
                            last_cycle_duration_ms: None,
                        })
                        .on_conflict(sync_engine_state::id)
                        .do_update()
                        .set((
                            sync_engine_state::last_pull_at.eq(Some(now.clone())),
                            sync_engine_state::last_error.eq::<Option<String>>(None),
                            sync_engine_state::consecutive_failures.eq(0),
                            sync_engine_state::next_retry_at.eq::<Option<String>>(None),
                            sync_engine_state::last_cycle_status.eq(Some("ok")),
                        ))
                        .execute(conn)
                        .map_err(StorageError::from)?;

                    Ok(())
                })();

                let detach_sql = format!("DETACH DATABASE {}", snapshot_alias);
                let _ = diesel::sql_query(detach_sql).execute(conn);
                restore_result
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;
    use diesel::dsl::count_star;
    use diesel::Connection;
    use std::collections::BTreeSet;
    use tempfile::tempdir;

    use crate::activities::ActivityRepository;
    use crate::db::{create_pool, get_connection, init, run_migrations, write_actor::spawn_writer};
    use crate::goals::GoalRepository;
    use crate::schema::{
        accounts, activities, app_settings, assets, goals, goals_allocation,
        import_account_templates, import_templates, platforms, spending_preset_rule_deletions,
        sync_applied_events, sync_device_config, sync_entity_metadata, sync_outbox, taxonomies,
        taxonomy_categories,
    };
    use crate::sync::broker_activity_patch::{
        broker_activity_identity, broker_activity_user_patch_entity_id,
        clear_pending_broker_activity_user_patches,
    };
    use wealthfolio_core::accounts::account_types;
    use wealthfolio_core::activities::{ActivityRepositoryTrait, ActivityUpsert};
    use wealthfolio_core::goals::{GoalRepositoryTrait, GoalSummaryUpdate};

    fn setup_db() -> (
        Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        WriteHandle,
    ) {
        // Ensure connect is "configured" so outbox writes work in tests
        std::env::set_var("CONNECT_API_URL", "http://test.local");

        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let writer = spawn_writer(pool.as_ref().clone()).expect("spawn writer");
        (pool, writer)
    }

    #[test]
    fn taxonomy_category_snapshot_filter_includes_user_category_taxonomies() {
        let filter = snapshot_copy_filter_for_table("taxonomy_categories").expect("filter");

        assert!(filter.contains("custom_groups"));
        assert!(filter.contains("SELECT id FROM taxonomies WHERE is_system = 0"));
        assert!(filter.contains("spending_categories"));
        assert!(filter.contains("income_sources"));
        assert!(filter.contains("savings_categories"));
        assert!(filter.contains("id NOT LIKE 'cat_%'"));
    }

    #[tokio::test]
    async fn local_sync_summary_counts_spending_preset_rule_deletions() {
        let (pool, writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");

        diesel::insert_into(spending_preset_rule_deletions::table)
            .values((
                spending_preset_rule_deletions::preset_id.eq("preset-ca"),
                spending_preset_rule_deletions::preset_rule_key.eq("rule-groceries"),
                spending_preset_rule_deletions::rule_id.eq("rule-1"),
                spending_preset_rule_deletions::deleted_at.eq("2026-01-01T00:00:00Z"),
            ))
            .execute(&mut conn)
            .expect("insert preset deletion");
        drop(conn);

        let repo = AppSyncRepository::new(pool, writer);
        let summary = repo.get_local_sync_data_summary().expect("summary");
        let row = summary
            .non_empty_tables
            .iter()
            .find(|row| row.table == "spending_preset_rule_deletions")
            .expect("preset deletion table should be included in sync summary");

        assert_eq!(row.rows, 1);
    }

    #[test]
    fn last_op_migration_marks_missing_entities_as_tombstones() {
        let mut conn = SqliteConnection::establish(":memory:").expect("memory db");
        conn.batch_execute(
            "
            CREATE TABLE sync_entity_metadata (
                entity TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                last_event_id TEXT NOT NULL,
                last_client_timestamp TEXT NOT NULL,
                last_seq BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (entity, entity_id)
            );
            CREATE TABLE sync_outbox (
                event_id TEXT PRIMARY KEY NOT NULL,
                entity TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op TEXT NOT NULL,
                client_timestamp TEXT NOT NULL
            );
            CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE quotes (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE asset_taxonomy_assignments (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE activities (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE import_account_templates (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE import_templates (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE goals (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE goal_plans (goal_id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE goals_allocation (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE ai_threads (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE ai_messages (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE ai_thread_tags (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE contribution_limits (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE platforms (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE holdings_snapshots (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE market_data_custom_providers (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE taxonomies (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE import_runs (id TEXT PRIMARY KEY NOT NULL);

            INSERT INTO accounts (id) VALUES ('existing-account');
            INSERT INTO assets (id) VALUES ('existing-asset');

            INSERT INTO sync_entity_metadata
                (entity, entity_id, last_event_id, last_client_timestamp, last_seq)
            VALUES
                ('goal', 'deleted-goal', 'evt-remote-delete', '2026-02-12T00:00:10Z', 44),
                ('account', 'existing-account', 'evt-remote-update', '2026-02-12T00:00:10Z', 55),
                ('asset', 'existing-asset', 'evt-remote-old', '2026-02-12T00:00:10Z', 77);

            INSERT INTO sync_outbox
                (event_id, entity, entity_id, op, client_timestamp)
            VALUES
                ('evt-local-newer', 'asset', 'existing-asset', 'update', '2026-02-12T00:00:11Z');
            ",
        )
        .expect("create pre-migration schema");

        conn.batch_execute(include_str!(
            "../../../migrations/2026-04-29-000001_sync_entity_metadata_last_op/up.sql"
        ))
        .expect("run last_op migration");

        let deleted_goal = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq("goal"))
            .filter(sync_entity_metadata::entity_id.eq("deleted-goal"))
            .first::<SyncEntityMetadataDB>(&mut conn)
            .expect("deleted goal metadata");
        assert_eq!(deleted_goal.last_op, "delete");
        assert_eq!(deleted_goal.last_seq, 44);

        let existing_account = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq("account"))
            .filter(sync_entity_metadata::entity_id.eq("existing-account"))
            .first::<SyncEntityMetadataDB>(&mut conn)
            .expect("existing account metadata");
        assert_eq!(existing_account.last_op, "update");
        assert_eq!(existing_account.last_seq, 55);

        let existing_asset = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq("asset"))
            .filter(sync_entity_metadata::entity_id.eq("existing-asset"))
            .first::<SyncEntityMetadataDB>(&mut conn)
            .expect("existing asset metadata");
        assert_eq!(existing_asset.last_event_id, "evt-local-newer");
        assert_eq!(existing_asset.last_op, "update");
        assert_eq!(existing_asset.last_seq, 77);
    }

    fn insert_account_for_test(conn: &mut SqliteConnection, account_id: &str) -> Result<()> {
        let sql = format!(
            "INSERT INTO accounts (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) VALUES ('{}', 'Sync Test', 'cash', NULL, 'USD', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL, 0, 'portfolio')",
            escape_sqlite_str(account_id)
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_asset_kind_for_test(
        conn: &mut SqliteConnection,
        asset_id: &str,
        kind: &str,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, provider_config, created_at, updated_at) VALUES ('{}', '{}', 'Sync Test Asset', '{}', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            escape_sqlite_str(asset_id),
            escape_sqlite_str(kind),
            escape_sqlite_str(asset_id)
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    #[tokio::test]
    async fn broker_activity_user_patch_updates_only_overlay_fields() {
        let (pool, _writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");

        diesel::sql_query(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('broker-local-account', 'Broker Account', 'cash', NULL, 'USD', 0, 1, \
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, 'SNAPTRADE', \
                     'provider-account-1', 0, 'portfolio')",
        )
        .execute(&mut conn)
        .expect("insert broker account");

        diesel::sql_query(
            "INSERT INTO import_runs \
             (id, account_id, source_system, run_type, mode, status, started_at, finished_at, \
              review_mode, applied_at, checkpoint_in, checkpoint_out, summary, warnings, error, \
              created_at, updated_at) \
             VALUES ('local-import-run', 'broker-local-account', 'SNAPTRADE', 'SYNC', \
                     'INCREMENTAL', 'COMPLETED', '2026-01-01T00:00:00Z', \
                     '2026-01-01T00:00:01Z', 'NEVER', '2026-01-01T00:00:01Z', \
                     NULL, NULL, NULL, NULL, NULL, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
        )
        .execute(&mut conn)
        .expect("insert broker import run");

        diesel::sql_query(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('broker-local-activity', 'broker-local-account', NULL, 'BUY', NULL, NULL, NULL, \
                     'POSTED', '2026-01-01T00:00:00Z', NULL, '10', '5', '50', '1', 'USD', \
                     NULL, 'Broker note', '{\"broker\":\"keep\"}', 'snaptrade', 'broker-record-1', \
                     'local-group-id', 'local-idempotency-key', 'local-import-run', 0, 1, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(&mut conn)
        .expect("insert broker activity");

        let identity = broker_activity_identity(
            Some("SNAPTRADE"),
            Some("provider-account-1"),
            Some("broker-record-1"),
        )
        .expect("broker identity");
        let entity_id = broker_activity_user_patch_entity_id(&identity);

        let applied = apply_remote_event_lww_tx(
            &mut conn,
            SyncEntity::BrokerActivityUserPatch,
            entity_id,
            SyncOperation::Update,
            "broker-patch-event-1".to_string(),
            "2026-02-01T00:00:00Z".to_string(),
            1,
            serde_json::json!({
                "sourceSystem": "SNAPTRADE",
                "providerAccountId": "provider-account-1",
                "sourceRecordId": "broker-record-1",
                "overlay": {
                    "notes": "Synced user note",
                    "activityTypeOverride": "SELL",
                    "subtype": "DRIP",
                    "needsReview": false
                }
            }),
        )
        .expect("apply broker activity user patch");

        assert!(applied);

        let row = activities::table
            .find("broker-local-activity")
            .select((
                activities::activity_type,
                activities::activity_type_override,
                activities::subtype,
                activities::notes,
                activities::needs_review,
                activities::is_user_modified,
                activities::amount,
                activities::source_group_id,
                activities::import_run_id,
                activities::updated_at,
            ))
            .first::<(
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                i32,
                i32,
                Option<String>,
                Option<String>,
                Option<String>,
                String,
            )>(&mut conn)
            .expect("broker activity row");

        assert_eq!(row.0, "BUY");
        assert_eq!(row.1.as_deref(), Some("SELL"));
        assert_eq!(row.2.as_deref(), Some("DRIP"));
        assert_eq!(row.3.as_deref(), Some("Synced user note"));
        assert_eq!(row.4, 0);
        assert_eq!(row.5, 1);
        assert_eq!(row.6.as_deref(), Some("50"));
        assert_eq!(row.7.as_deref(), Some("local-group-id"));
        assert_eq!(row.8.as_deref(), Some("local-import-run"));
        assert_eq!(row.9, "2026-02-01T00:00:00Z");
    }

    #[tokio::test]
    async fn broker_activity_user_patch_missing_target_defers_until_broker_import() {
        clear_pending_broker_activity_user_patches();
        let (pool, writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");

        diesel::sql_query(
            "INSERT INTO accounts \
             (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
              platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
             VALUES ('broker-local-account', 'Broker Account', 'cash', NULL, 'USD', 0, 1, \
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL, NULL, 'SNAPTRADE', \
                     'provider-account-1', 0, 'portfolio')",
        )
        .execute(&mut conn)
        .expect("insert broker account");

        let identity = broker_activity_identity(
            Some("SNAPTRADE"),
            Some("provider-account-1"),
            Some("broker-record-missing-first"),
        )
        .expect("broker identity");
        let entity_id = broker_activity_user_patch_entity_id(&identity);
        let entity_db = enum_to_db(&SyncEntity::BrokerActivityUserPatch).expect("entity db");

        let applied = apply_remote_event_lww_tx(
            &mut conn,
            SyncEntity::BrokerActivityUserPatch,
            entity_id.clone(),
            SyncOperation::Update,
            "broker-patch-event-missing-first".to_string(),
            "2026-02-01T00:00:00Z".to_string(),
            9,
            serde_json::json!({
                "sourceSystem": "SNAPTRADE",
                "providerAccountId": "provider-account-1",
                "sourceRecordId": "broker-record-missing-first",
                "overlay": {
                    "notes": "Synced pending note",
                    "activityTypeOverride": "SELL",
                    "subtype": "DRIP",
                    "needsReview": false
                }
            }),
        )
        .expect("defer missing broker activity patch");

        assert!(!applied);
        let metadata_count: i64 = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq(&entity_db))
            .filter(sync_entity_metadata::entity_id.eq(&entity_id))
            .count()
            .get_result(&mut conn)
            .expect("metadata count");
        assert_eq!(metadata_count, 0);
        let applied_event_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("broker-patch-event-missing-first"))
            .count()
            .get_result(&mut conn)
            .expect("applied event count");
        assert_eq!(applied_event_count, 0);
        drop(conn);

        let activity_repo = ActivityRepository::new(pool.clone(), writer);
        activity_repo
            .bulk_upsert(vec![ActivityUpsert {
                id: "broker-local-activity-imported-later".to_string(),
                account_id: "broker-local-account".to_string(),
                asset_id: None,
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2026-01-01T00:00:00Z".to_string(),
                quantity: Some(Decimal::new(10, 0)),
                unit_price: Some(Decimal::new(5, 0)),
                currency: "USD".to_string(),
                fee: Some(Decimal::new(1, 0)),
                tax: None,
                amount: Some(Decimal::new(50, 0)),
                status: None,
                notes: Some("Broker note".to_string()),
                fx_rate: None,
                metadata: Some("{\"broker\":\"keep\"}".to_string()),
                needs_review: Some(true),
                source_system: Some("SNAPTRADE".to_string()),
                source_record_id: Some("broker-record-missing-first".to_string()),
                source_group_id: Some("broker-group".to_string()),
                idempotency_key: Some("broker-idempotency-missing-first".to_string()),
                import_run_id: None,
            }])
            .await
            .expect("import broker activity");

        let mut conn = get_connection(&pool).expect("conn");
        let row = activities::table
            .find("broker-local-activity-imported-later")
            .select((
                activities::activity_type,
                activities::activity_type_override,
                activities::subtype,
                activities::notes,
                activities::needs_review,
                activities::is_user_modified,
                activities::amount,
                activities::source_group_id,
            ))
            .first::<(
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                i32,
                i32,
                Option<String>,
                Option<String>,
            )>(&mut conn)
            .expect("imported broker activity");

        assert_eq!(row.0, "BUY");
        assert_eq!(row.1.as_deref(), Some("SELL"));
        assert_eq!(row.2.as_deref(), Some("DRIP"));
        assert_eq!(row.3.as_deref(), Some("Synced pending note"));
        assert_eq!(row.4, 0);
        assert_eq!(row.5, 1);
        assert_eq!(row.6.as_deref(), Some("50"));
        assert_eq!(row.7.as_deref(), Some("broker-group"));

        let metadata_count: i64 = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq(&entity_db))
            .filter(sync_entity_metadata::entity_id.eq(&entity_id))
            .count()
            .get_result(&mut conn)
            .expect("metadata count after replay");
        assert_eq!(metadata_count, 1);
        let applied_event_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("broker-patch-event-missing-first"))
            .count()
            .get_result(&mut conn)
            .expect("applied event count after replay");
        assert_eq!(applied_event_count, 1);
        clear_pending_broker_activity_user_patches();
    }

    fn insert_goal_for_test(conn: &mut SqliteConnection, goal_id: &str) -> Result<()> {
        let sql = format!(
            "INSERT INTO goals (id, title, description, target_amount, goal_type, status_lifecycle, status_health, priority, cover_image_key, currency, start_date, target_date, summary_current_value, summary_progress, projected_completion_date, projected_value_at_target_date, created_at, updated_at, summary_target_amount) VALUES ('{}', 'Sync Goal', NULL, 1000, 'custom', 'active', 'on_track', 1, NULL, 'USD', NULL, NULL, 0, 0, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1000)",
            escape_sqlite_str(goal_id)
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn create_snapshot_db_with_account(account_id: &str) -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, account_id).expect("insert account");
        db_path
    }

    fn create_snapshot_db_with_holding_snapshot(account_id: &str) -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        let sql = format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)
             VALUES ('snap-{}', '{}', '2026-01-01', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
            escape_sqlite_str(account_id),
            escape_sqlite_str(account_id)
        );
        diesel::sql_query(sql)
            .execute(&mut conn)
            .expect("insert snapshot");
        db_path
    }

    fn create_snapshot_db_with_account_and_holding_snapshot(account_id: &str) -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, account_id).expect("insert account");
        let sql = format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)
             VALUES ('snap-{}', '{}', '2026-01-01', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
            escape_sqlite_str(account_id),
            escape_sqlite_str(account_id)
        );
        diesel::sql_query(sql)
            .execute(&mut conn)
            .expect("insert snapshot");
        db_path
    }

    fn create_snapshot_db_with_account_asset_snapshot_position(
        account_id: &str,
        asset_id: &str,
    ) -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, account_id).expect("insert account");
        insert_asset_kind_for_test(&mut conn, asset_id, "INVESTMENT").expect("insert asset");
        let snapshot_id = format!("snap-{account_id}");
        let sql = format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)
             VALUES ('{}', '{}', '2026-01-01', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY');
             INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, average_cost, total_cost_basis, currency, inception_date, is_alternative, contract_multiplier, created_at, last_updated)
             VALUES ('{}', '{}', '3', '10', '30', 'USD', '2026-01-01T00:00:00Z', 0, '1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            escape_sqlite_str(&snapshot_id),
            escape_sqlite_str(account_id),
            escape_sqlite_str(&snapshot_id),
            escape_sqlite_str(asset_id)
        );
        conn.batch_execute(&sql).expect("insert snapshot position");
        db_path
    }

    fn insert_portfolio_for_test(
        conn: &mut SqliteConnection,
        portfolio_id: &str,
        name: &str,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO portfolios (id, name, description, sort_order, created_at, updated_at) \
             VALUES ('{}', '{}', NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            escape_sqlite_str(portfolio_id),
            escape_sqlite_str(name)
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_portfolio_account_for_test(
        conn: &mut SqliteConnection,
        membership_id: &str,
        portfolio_id: &str,
        account_id: &str,
        sort_order: i32,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO portfolio_accounts (id, portfolio_id, account_id, sort_order, created_at) \
             VALUES ('{}', '{}', '{}', {}, '2026-01-01T00:00:00Z')",
            escape_sqlite_str(membership_id),
            escape_sqlite_str(portfolio_id),
            escape_sqlite_str(account_id),
            sort_order
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn sql_value(value: Option<&str>) -> String {
        value
            .map(|value| format!("'{}'", escape_sqlite_str(value)))
            .unwrap_or_else(|| "NULL".to_string())
    }

    fn insert_broker_import_run_for_test(
        conn: &mut SqliteConnection,
        import_run_id: &str,
        account_id: &str,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO import_runs \
             (id, account_id, source_system, run_type, mode, status, started_at, finished_at, \
              review_mode, applied_at, checkpoint_in, checkpoint_out, summary, warnings, error, \
              created_at, updated_at) \
             VALUES ('{}', '{}', 'SNAPTRADE', 'SYNC', 'INCREMENTAL', 'COMPLETED', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 'NEVER', \
                     '2026-01-01T00:00:01Z', NULL, NULL, NULL, NULL, NULL, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
            escape_sqlite_str(import_run_id),
            escape_sqlite_str(account_id)
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_activity_for_snapshot_filter_test(
        conn: &mut SqliteConnection,
        activity_id: &str,
        account_id: &str,
        source_system: &str,
        import_run_id: Option<&str>,
        source_record_id: Option<&str>,
        is_user_modified: i32,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO activities \
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, \
              status, activity_date, settlement_date, quantity, unit_price, amount, fee, currency, \
              fx_rate, notes, metadata, source_system, source_record_id, source_group_id, \
              idempotency_key, import_run_id, is_user_modified, needs_review, created_at, updated_at) \
             VALUES ('{}', '{}', NULL, 'DEPOSIT', NULL, NULL, NULL, 'POSTED', \
                     '2026-01-01T00:00:00Z', NULL, NULL, NULL, '100', '0', 'USD', \
                     NULL, NULL, NULL, '{}', {}, NULL, NULL, {}, {}, 0, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            escape_sqlite_str(activity_id),
            escape_sqlite_str(account_id),
            escape_sqlite_str(source_system),
            sql_value(source_record_id),
            sql_value(import_run_id),
            is_user_modified,
        );
        diesel::sql_query(sql)
            .execute(conn)
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_spending_event_for_snapshot_filter_test(
        conn: &mut SqliteConnection,
        event_id: &str,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO spending_event_types (id, key, name, color, created_at, updated_at) \
             VALUES ('event-type-{}', NULL, 'Snapshot Event Type', NULL, \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); \
             INSERT INTO spending_events \
             (id, name, description, event_type_id, start_date, end_date, created_at, updated_at) \
             VALUES ('{}', 'Snapshot Event', NULL, 'event-type-{}', '2026-01-01', '2026-01-02', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            escape_sqlite_str(event_id),
            escape_sqlite_str(event_id),
            escape_sqlite_str(event_id)
        );
        conn.batch_execute(&sql).map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_activity_sidecars_for_snapshot_filter_test(
        conn: &mut SqliteConnection,
        activity_id: &str,
        suffix: &str,
        event_id: &str,
    ) -> Result<()> {
        let sql = format!(
            "INSERT INTO activity_taxonomy_assignments \
             (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at) \
             VALUES ('assignment-{}', '{}', 'spending_categories', 'cat_food', 10000, 'manual', \
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); \
             INSERT INTO spending_activity_events (activity_id, event_id, created_at, updated_at) \
             VALUES ('{}', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            escape_sqlite_str(suffix),
            escape_sqlite_str(activity_id),
            escape_sqlite_str(activity_id),
            escape_sqlite_str(event_id)
        );
        conn.batch_execute(&sql).map_err(StorageError::from)?;
        Ok(())
    }

    fn insert_orphan_portfolio_account_for_test(
        conn: &mut SqliteConnection,
        membership_id: &str,
        portfolio_id: &str,
        missing_account_id: &str,
    ) {
        conn.batch_execute(&format!(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO portfolio_accounts (id, portfolio_id, account_id, sort_order, created_at)
             VALUES ('{}', '{}', '{}', 99, '2026-01-01T00:00:00Z');
             PRAGMA foreign_keys = ON;",
            escape_sqlite_str(membership_id),
            escape_sqlite_str(portfolio_id),
            escape_sqlite_str(missing_account_id),
        ))
        .expect("insert orphan portfolio account");
    }

    fn insert_missing_portfolio_account_for_test(
        conn: &mut SqliteConnection,
        membership_id: &str,
        missing_portfolio_id: &str,
        account_id: &str,
    ) {
        conn.batch_execute(&format!(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO portfolio_accounts (id, portfolio_id, account_id, sort_order, created_at)
             VALUES ('{}', '{}', '{}', 99, '2026-01-01T00:00:00Z');
             PRAGMA foreign_keys = ON;",
            escape_sqlite_str(membership_id),
            escape_sqlite_str(missing_portfolio_id),
            escape_sqlite_str(account_id),
        ))
        .expect("insert missing-portfolio account membership");
    }

    fn create_snapshot_db_with_portfolio_accounts() -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-snapshot-valid").expect("insert account");
        insert_portfolio_for_test(&mut conn, "portfolio-snapshot", "Snapshot Portfolio")
            .expect("insert portfolio");
        insert_portfolio_account_for_test(
            &mut conn,
            "membership-snapshot-valid",
            "portfolio-snapshot",
            "acc-snapshot-valid",
            0,
        )
        .expect("insert valid membership");
        insert_orphan_portfolio_account_for_test(
            &mut conn,
            "membership-snapshot-orphan",
            "portfolio-snapshot",
            "acc-snapshot-missing",
        );
        db_path
    }

    fn create_snapshot_db_with_orphan_activity_sidecars() -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        insert_spending_event_for_snapshot_filter_test(&mut conn, "event-orphan-sidecar")
            .expect("insert event");
        conn.batch_execute(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO activity_taxonomy_assignments
             (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at)
             VALUES ('assignment-orphan-activity', 'missing-broker-activity', 'spending_categories',
                     'cat_food', 10000, 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO spending_activity_events (activity_id, event_id, created_at, updated_at)
             VALUES ('missing-broker-activity', 'event-orphan-sidecar',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             PRAGMA foreign_keys = ON;",
        )
        .expect("insert orphan activity sidecars");
        db_path
    }

    fn create_snapshot_db_with_invalid_spending_activity_event() -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        conn.batch_execute(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO spending_activity_events (activity_id, event_id, created_at, updated_at)
             VALUES ('local-existing-activity-for-invalid-event', 'missing-snapshot-event', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');
             PRAGMA foreign_keys = ON;",
        )
        .expect("insert invalid spending activity event");
        db_path
    }

    fn create_snapshot_db_with_assets_extra_column(asset_id: &str) -> String {
        let app_data = tempdir()
            .expect("tempdir")
            .keep()
            .to_string_lossy()
            .to_string();
        let db_path = init(&app_data).expect("init db");
        run_migrations(&db_path).expect("migrate db");
        let pool = create_pool(&db_path).expect("create pool");
        let mut conn = get_connection(&pool).expect("conn");
        diesel::sql_query("ALTER TABLE assets ADD COLUMN legacy_extra TEXT")
            .execute(&mut conn)
            .expect("add extra column");
        let insert_sql = format!(
            "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, provider_config, created_at, updated_at, legacy_extra) VALUES ('{}', 'INVESTMENT', 'Snapshot Asset', 'SNAP', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'legacy')",
            escape_sqlite_str(asset_id)
        );
        diesel::sql_query(insert_sql)
            .execute(&mut conn)
            .expect("insert asset");
        db_path
    }

    fn count_account_rows(
        pool: &Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        account_id: &str,
    ) -> i64 {
        let mut conn = get_connection(pool).expect("conn");
        accounts::table
            .filter(accounts::id.eq(account_id))
            .select(count_star())
            .first(&mut conn)
            .expect("count")
    }

    fn count_asset_rows(
        pool: &Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        asset_id: &str,
    ) -> i64 {
        let mut conn = get_connection(pool).expect("conn");
        assets::table
            .filter(assets::id.eq(asset_id))
            .select(count_star())
            .first(&mut conn)
            .expect("count")
    }

    fn count_platform_rows(
        pool: &Arc<Pool<r2d2::ConnectionManager<SqliteConnection>>>,
        platform_id: &str,
    ) -> i64 {
        let mut conn = get_connection(pool).expect("conn");
        platforms::table
            .filter(platforms::id.eq(platform_id))
            .select(count_star())
            .first(&mut conn)
            .expect("count")
    }

    fn snake_to_camel_case(input: &str) -> String {
        let mut parts = input.split('_');
        let Some(first) = parts.next() else {
            return String::new();
        };
        let mut output = first.to_string();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first_char) = chars.next() {
                output.push(first_char.to_ascii_uppercase());
                output.extend(chars);
            }
        }
        output
    }

    #[tokio::test]
    async fn creates_sync_foundation_tables() {
        let (pool, _writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");
        for table in [
            "sync_applied_events",
            "sync_cursor",
            "sync_outbox",
            "sync_entity_metadata",
            "sync_device_config",
            "sync_engine_state",
            "sync_table_state",
        ] {
            let sql = format!(
                "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='{}'",
                table
            );
            #[derive(diesel::QueryableByName)]
            struct CountRow {
                #[diesel(sql_type = diesel::sql_types::BigInt)]
                c: i64,
            }
            let row = diesel::sql_query(sql)
                .get_result::<CountRow>(&mut conn)
                .expect("table exists");
            assert_eq!(row.c, 1, "missing table {table}");
        }
    }

    #[tokio::test]
    async fn outbox_write_rollback_keeps_mutation_atomic() {
        let (pool, writer) = setup_db();

        let tx_result = writer
            .exec(|conn| {
                insert_account_for_test(conn, "acc-sync-rollback")?;

                let mut req = OutboxWriteRequest::new(
                    SyncEntity::Account,
                    "acc-sync-rollback",
                    SyncOperation::Create,
                    serde_json::json!({ "id": "acc-sync-rollback" }),
                );
                req.event_id = Some("fixed-event-id".to_string());
                insert_outbox_event(conn, req.clone())?;
                let _ = insert_outbox_event(conn, req)?;
                Ok(())
            })
            .await;

        assert!(
            tx_result.is_err(),
            "expected duplicate outbox event_id failure"
        );

        let mut conn = get_connection(&pool).expect("conn");
        let account_count: i64 = accounts::table
            .filter(accounts::id.eq("acc-sync-rollback"))
            .select(count_star())
            .first(&mut conn)
            .expect("count");
        assert_eq!(account_count, 0, "account insert should be rolled back");
    }

    #[tokio::test]
    async fn projected_outbox_rollback_keeps_mutation_atomic() {
        let (pool, writer) = setup_db();

        let tx_result = writer
            .exec_projected(|conn, projection| {
                insert_account_for_test(conn, "acc-sync-projected-rollback")?;

                let mut req = OutboxWriteRequest::new(
                    SyncEntity::Account,
                    "acc-sync-projected-rollback",
                    SyncOperation::Create,
                    serde_json::json!({ "id": "acc-sync-projected-rollback" }),
                );
                req.event_id = Some("fixed-projected-event-id".to_string());
                projection.queue_outbox(req.clone());
                projection.queue_outbox(req);
                Ok(())
            })
            .await;

        assert!(
            tx_result.is_err(),
            "expected duplicate outbox event_id failure"
        );

        let mut conn = get_connection(&pool).expect("conn");
        let account_count: i64 = accounts::table
            .filter(accounts::id.eq("acc-sync-projected-rollback"))
            .select(count_star())
            .first(&mut conn)
            .expect("count");
        assert_eq!(account_count, 0, "account insert should be rolled back");
    }

    #[tokio::test]
    async fn local_outbox_insert_updates_entity_metadata() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer.clone());

        writer
            .exec_projected(|_conn, projection| {
                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Goal,
                    "goal-local-delete",
                    SyncOperation::Delete,
                    serde_json::json!({ "id": "goal-local-delete" }),
                );
                request.event_id = Some("evt-local-delete".to_string());
                request.client_timestamp = "2026-02-12T00:00:10Z".to_string();
                projection.queue_outbox(request);
                Ok(())
            })
            .await
            .expect("write local outbox");

        let metadata = repo
            .get_entity_metadata(SyncEntity::Goal, "goal-local-delete")
            .expect("load metadata")
            .expect("metadata should exist");
        assert_eq!(metadata.last_event_id, "evt-local-delete");
        assert_eq!(metadata.last_client_timestamp, "2026-02-12T00:00:10Z");
        assert_eq!(metadata.last_op, SyncOperation::Delete);
        assert_eq!(metadata.last_seq, 0);
    }

    #[tokio::test]
    async fn remote_goal_update_does_not_resurrect_after_local_delete() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer.clone());

        writer
            .exec_projected(|conn, projection| {
                insert_goal_for_test(conn, "goal-delete-race")?;
                diesel::delete(goals::table.find("goal-delete-race"))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Goal,
                    "goal-delete-race",
                    SyncOperation::Delete,
                    serde_json::json!({ "id": "goal-delete-race" }),
                );
                request.event_id = Some("evt-local-goal-delete".to_string());
                request.client_timestamp = "2026-02-12T00:00:10Z".to_string();
                projection.queue_outbox(request);
                Ok(())
            })
            .await
            .expect("delete goal locally");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-delete-race".to_string(),
                SyncOperation::Update,
                "evt-mobile-goal-update-after-delete".to_string(),
                "2026-02-12T00:00:11Z".to_string(),
                25,
                serde_json::json!({
                    "id": "goal-delete-race",
                    "title": "Mobile copy touched after delete",
                    "description": null,
                    "target_amount": 1000.0,
                    "goal_type": "custom",
                    "status_lifecycle": "active",
                    "status_health": "on_track",
                    "priority": 1,
                    "cover_image_key": null,
                    "currency": "USD",
                    "start_date": null,
                    "target_date": null,
                    "summary_current_value": 100.0,
                    "summary_progress": 0.1,
                    "projected_completion_date": null,
                    "projected_value_at_target_date": null,
                    "created_at": "2026-02-12T00:00:00Z",
                    "updated_at": "2026-02-12T00:00:11Z",
                    "summary_target_amount": 1000.0
                }),
            )
            .await
            .expect("apply remote update");

        assert!(!applied, "remote update must be ignored after delete");
        let mut conn = get_connection(&pool).expect("conn");
        let goal_count: i64 = goals::table
            .filter(goals::id.eq("goal-delete-race"))
            .select(count_star())
            .first(&mut conn)
            .expect("count goals");
        assert_eq!(goal_count, 0, "remote update must not resurrect the goal");
    }

    #[tokio::test]
    async fn remote_snapshot_batch_event_is_preserved_before_account_arrives() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let orphan_account_id = "orphan-snapshot-account";

        let applied = repo
            .apply_remote_events_lww_batch(vec![(
                SyncEntity::Snapshot,
                "snap-orphan-remote".to_string(),
                SyncOperation::Update,
                "evt-orphan-snapshot".to_string(),
                "2026-02-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "snap-orphan-remote",
                    "accountId": orphan_account_id,
                    "snapshotDate": "2026-01-01",
                    "currency": "USD",
                    "positions": "{}",
                    "cashBalances": "{}",
                    "costBasis": "0",
                    "netContribution": "0",
                    "calculatedAt": "2026-01-01T00:00:00Z",
                    "netContributionBase": "0",
                    "cashTotalAccountCurrency": "0",
                    "cashTotalBaseCurrency": "0",
                    "source": "MANUAL_ENTRY",
                }),
            )])
            .await
            .expect("apply orphan snapshot event");

        assert_eq!(applied, 1);
        let mut conn = get_connection(&pool).expect("conn");
        let snapshot_count: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE account_id = '{}'",
            escape_sqlite_str(orphan_account_id)
        ))
        .get_result(&mut conn)
        .expect("count orphan snapshots");
        assert_eq!(snapshot_count.c, 1);

        let applied_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("evt-orphan-snapshot"))
            .select(count_star())
            .first(&mut conn)
            .expect("count applied event");
        assert_eq!(applied_count, 1);
    }

    #[tokio::test]
    async fn replay_single_event_foreign_key_error_includes_entity_table_context() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let err = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingActivityEvent,
                "missing-activity-for-event".to_string(),
                SyncOperation::Create,
                "evt-missing-spending-activity-event".to_string(),
                "2026-02-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "activity_id": "missing-activity-for-event",
                    "event_id": "missing-spending-event",
                    "created_at": "2026-02-01T00:00:00Z",
                    "updated_at": "2026-02-01T00:00:00Z",
                }),
            )
            .await
            .expect_err("missing FK should fail");

        let message = err.to_string();
        assert!(
            message.contains("entity=SpendingActivityEvent"),
            "{message}"
        );
        assert!(
            message.contains("table=spending_activity_events"),
            "{message}"
        );
        assert!(
            message.to_ascii_lowercase().contains("foreign key"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn replay_batch_foreign_key_error_includes_fk_check_table() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let err = repo
            .apply_remote_events_lww_batch(vec![(
                SyncEntity::SpendingActivityEvent,
                "missing-activity-in-batch".to_string(),
                SyncOperation::Create,
                "evt-missing-spending-activity-event-batch".to_string(),
                "2026-02-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "activity_id": "missing-activity-in-batch",
                    "event_id": "missing-spending-event-in-batch",
                    "created_at": "2026-02-01T00:00:00Z",
                    "updated_at": "2026-02-01T00:00:00Z",
                }),
            )])
            .await
            .expect_err("missing FK should fail");

        let message = err.to_string();
        assert!(
            message.contains("Replay batch foreign key check failed"),
            "{message}"
        );
        assert!(
            message.contains("table=spending_activity_events"),
            "{message}"
        );
        assert!(message.contains("parent="), "{message}");
    }

    #[tokio::test]
    async fn remote_snapshot_single_event_is_preserved_before_account_arrives() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let orphan_account_id = "orphan-single-snapshot-account";

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Snapshot,
                "snap-orphan-single".to_string(),
                SyncOperation::Update,
                "evt-orphan-single-snapshot".to_string(),
                "2026-02-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "snap-orphan-single",
                    "accountId": orphan_account_id,
                    "snapshotDate": "2026-01-01",
                    "currency": "USD",
                    "positions": "{}",
                    "cashBalances": "{}",
                    "costBasis": "0",
                    "netContribution": "0",
                    "calculatedAt": "2026-01-01T00:00:00Z",
                    "netContributionBase": "0",
                    "cashTotalAccountCurrency": "0",
                    "cashTotalBaseCurrency": "0",
                    "source": "MANUAL_ENTRY",
                }),
            )
            .await
            .expect("apply orphan snapshot event");

        assert!(applied);
        let mut conn = get_connection(&pool).expect("conn");
        let snapshot_count: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE account_id = '{}'",
            escape_sqlite_str(orphan_account_id)
        ))
        .get_result(&mut conn)
        .expect("count orphan snapshots");
        assert_eq!(snapshot_count.c, 1);

        let applied_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("evt-orphan-single-snapshot"))
            .select(count_star())
            .first(&mut conn)
            .expect("count applied event");
        assert_eq!(applied_count, 1);
        drop(conn);

        let account_applied = repo
            .apply_remote_event_lww(
                SyncEntity::Account,
                orphan_account_id.to_string(),
                SyncOperation::Create,
                "evt-orphan-single-account".to_string(),
                "2026-02-01T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "id": orphan_account_id,
                    "name": "Late Account",
                    "accountType": "cash",
                    "group": serde_json::Value::Null,
                    "currency": "USD",
                    "isDefault": false,
                    "platformId": serde_json::Value::Null,
                    "accountNumber": serde_json::Value::Null,
                    "meta": serde_json::Value::Null,
                    "provider": serde_json::Value::Null,
                    "providerAccountId": serde_json::Value::Null,
                    "isArchived": false,
                    "isActive": true,
                    "trackingMode": "portfolio"
                }),
            )
            .await
            .expect("apply late account event");

        assert!(account_applied);
        let mut conn = get_connection(&pool).expect("conn");
        let account_count = count_account_rows(&pool, orphan_account_id);
        assert_eq!(account_count, 1);
        let snapshot_count: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE account_id = '{}'",
            escape_sqlite_str(orphan_account_id)
        ))
        .get_result(&mut conn)
        .expect("count preserved snapshot after account arrives");
        assert_eq!(snapshot_count.c, 1);
    }

    #[tokio::test]
    async fn remote_goal_create_does_not_reuse_deleted_id() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer.clone());

        writer
            .exec_projected(|conn, projection| {
                insert_goal_for_test(conn, "goal-create-after-delete")?;
                diesel::delete(goals::table.find("goal-create-after-delete"))
                    .execute(conn)
                    .map_err(StorageError::from)?;

                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Goal,
                    "goal-create-after-delete",
                    SyncOperation::Delete,
                    serde_json::json!({ "id": "goal-create-after-delete" }),
                );
                request.event_id = Some("evt-local-goal-delete-before-create".to_string());
                request.client_timestamp = "2026-02-12T00:00:10Z".to_string();
                projection.queue_outbox(request);
                Ok(())
            })
            .await
            .expect("delete goal locally");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-create-after-delete".to_string(),
                SyncOperation::Create,
                "evt-remote-goal-create-after-delete".to_string(),
                "2026-02-12T00:00:12Z".to_string(),
                26,
                serde_json::json!({
                    "id": "goal-create-after-delete",
                    "title": "Reused ID",
                    "description": null,
                    "target_amount": 1000.0,
                    "goal_type": "custom",
                    "status_lifecycle": "active",
                    "status_health": "on_track",
                    "priority": 1,
                    "cover_image_key": null,
                    "currency": "USD",
                    "start_date": null,
                    "target_date": null,
                    "summary_current_value": 0.0,
                    "summary_progress": 0.0,
                    "projected_completion_date": null,
                    "projected_value_at_target_date": null,
                    "created_at": "2026-02-12T00:00:12Z",
                    "updated_at": "2026-02-12T00:00:12Z",
                    "summary_target_amount": 1000.0
                }),
            )
            .await
            .expect("apply remote create");

        assert!(!applied, "remote create must not reuse a deleted ID");
        let mut conn = get_connection(&pool).expect("conn");
        let goal_count: i64 = goals::table
            .filter(goals::id.eq("goal-create-after-delete"))
            .select(count_star())
            .first(&mut conn)
            .expect("count goals");
        assert_eq!(goal_count, 0, "remote create must not resurrect the goal");
    }

    #[tokio::test]
    async fn remote_goal_delete_wins_over_local_update_marker() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer.clone());

        writer
            .exec_projected(|conn, projection| {
                insert_goal_for_test(conn, "goal-delete-wins")?;
                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Goal,
                    "goal-delete-wins",
                    SyncOperation::Update,
                    serde_json::json!({ "id": "goal-delete-wins" }),
                );
                request.event_id = Some("evt-local-goal-update".to_string());
                request.client_timestamp = "2026-02-12T00:00:11Z".to_string();
                projection.queue_outbox(request);
                Ok(())
            })
            .await
            .expect("write local update marker");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-delete-wins".to_string(),
                SyncOperation::Delete,
                "evt-remote-goal-delete".to_string(),
                "2026-02-12T00:00:10Z".to_string(),
                26,
                serde_json::json!({ "id": "goal-delete-wins" }),
            )
            .await
            .expect("apply remote delete");

        assert!(applied, "delete should win over a local update marker");
        let mut conn = get_connection(&pool).expect("conn");
        let goal_count: i64 = goals::table
            .filter(goals::id.eq("goal-delete-wins"))
            .select(count_star())
            .first(&mut conn)
            .expect("count goals");
        assert_eq!(goal_count, 0, "delete must remove the goal");

        let metadata = repo
            .get_entity_metadata(SyncEntity::Goal, "goal-delete-wins")
            .expect("load metadata")
            .expect("metadata should exist");
        assert_eq!(metadata.last_event_id, "evt-remote-goal-delete");
        assert_eq!(metadata.last_op, SyncOperation::Delete);
    }

    #[tokio::test]
    async fn goal_summary_refresh_stays_local_and_does_not_write_sync_outbox() {
        let (pool, writer) = setup_db();
        let goal_repo = GoalRepository::new(pool.clone(), writer.clone());

        writer
            .exec(|conn| {
                insert_goal_for_test(conn, "goal-summary-cache")?;
                Ok(())
            })
            .await
            .expect("insert goal");

        let before_updated_at: String = {
            let mut conn = get_connection(&pool).expect("conn");
            goals::table
                .find("goal-summary-cache")
                .select(goals::updated_at)
                .first(&mut conn)
                .expect("load initial updated_at")
        };

        goal_repo
            .update_goal_summary_fields(
                "goal-summary-cache",
                GoalSummaryUpdate {
                    summary_target_amount: Some(2_000.0),
                    summary_current_value: Some(500.0),
                    summary_progress: Some(0.25),
                    projected_completion_date: Some("2026-12-31".to_string()),
                    projected_value_at_target_date: Some(2_100.0),
                    status_health: "on_track".to_string(),
                },
            )
            .await
            .expect("refresh summary");

        let mut conn = get_connection(&pool).expect("conn");
        let outbox_count: i64 = sync_outbox::table
            .select(count_star())
            .first(&mut conn)
            .expect("count outbox");
        let metadata_count: i64 = sync_entity_metadata::table
            .filter(sync_entity_metadata::entity.eq(enum_to_db(&SyncEntity::Goal).expect("entity")))
            .filter(sync_entity_metadata::entity_id.eq("goal-summary-cache"))
            .select(count_star())
            .first(&mut conn)
            .expect("count metadata");
        let (current_value, progress, status_health, after_updated_at): (
            Option<f64>,
            Option<f64>,
            String,
            String,
        ) = goals::table
            .find("goal-summary-cache")
            .select((
                goals::summary_current_value,
                goals::summary_progress,
                goals::status_health,
                goals::updated_at,
            ))
            .first(&mut conn)
            .expect("load summary fields");

        assert_eq!(outbox_count, 0);
        assert_eq!(metadata_count, 0);
        assert_eq!(current_value, Some(500.0));
        assert_eq!(progress, Some(0.25));
        assert_eq!(status_health, "on_track");
        assert_eq!(after_updated_at, before_updated_at);
    }

    #[tokio::test]
    async fn snapshot_restore_sets_cursor_and_is_idempotent() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_account("acc-from-snapshot");

        repo.restore_snapshot_tables_from_file(
            snapshot_path.clone(),
            vec!["accounts".to_string()],
            88,
            "device-1".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot");

        assert_eq!(repo.get_cursor().expect("cursor"), 88);
        assert_eq!(count_account_rows(&pool, "acc-from-snapshot"), 1);

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["accounts".to_string()],
            88,
            "device-1".to_string(),
            Some(1),
        )
        .await
        .expect("second restore");

        assert_eq!(repo.get_cursor().expect("cursor"), 88);
        assert_eq!(count_account_rows(&pool, "acc-from-snapshot"), 1);
    }

    #[tokio::test]
    async fn snapshot_restore_error_keeps_existing_cursor() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);
        repo.set_cursor(15).await.expect("set cursor");

        let broken_snapshot_path = tempdir()
            .expect("tempdir")
            .keep()
            .join("broken_snapshot.db");
        std::fs::write(&broken_snapshot_path, b"not-a-sqlite-db").expect("write broken file");

        let result = repo
            .restore_snapshot_tables_from_file(
                broken_snapshot_path.to_string_lossy().to_string(),
                vec!["accounts".to_string()],
                22,
                "device-2".to_string(),
                Some(1),
            )
            .await;
        assert!(result.is_err(), "restore should fail for invalid snapshot");
        assert_eq!(repo.get_cursor().expect("cursor"), 15);
    }

    #[tokio::test]
    async fn snapshot_restore_foreign_key_error_includes_table_context() {
        let (pool, writer) = setup_db();
        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-invalid-event").expect("insert account");
            insert_activity_for_snapshot_filter_test(
                &mut conn,
                "local-existing-activity-for-invalid-event",
                "acc-invalid-event",
                "MANUAL",
                None,
                None,
                0,
            )
            .expect("insert local activity");
        }
        let repo = AppSyncRepository::new(pool, writer);
        let snapshot_path = create_snapshot_db_with_invalid_spending_activity_event();

        let err = repo
            .restore_snapshot_tables_from_file(
                snapshot_path,
                vec!["spending_activity_events".to_string()],
                92,
                "device-invalid-spending-event-restore".to_string(),
                Some(1),
            )
            .await
            .expect_err("restore should fail for invalid FK");

        let message = err.to_string();
        assert!(
            message.contains("Snapshot restore failed for table=spending_activity_events")
                || message.contains("table=spending_activity_events"),
            "{message}"
        );
        assert!(
            message.to_ascii_lowercase().contains("foreign key"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn snapshot_restore_drops_orphan_snapshot_rows() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let orphan_account_id = "orphan-restore-account";
        let snapshot_path = create_snapshot_db_with_holding_snapshot(orphan_account_id);
        {
            let mut conn = get_connection(&pool).expect("conn");
            diesel::sql_query(format!(
                "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)
                 VALUES ('local-orphan-snapshot', '{}', '2025-12-31', 'USD', '{{}}', '{{}}', '0', '0', '2025-12-31T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
                escape_sqlite_str(orphan_account_id)
            ))
            .execute(&mut conn)
            .expect("insert local orphan snapshot");
        }

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["holdings_snapshots".to_string()],
            90,
            "device-orphan-snapshot".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot");

        let mut conn = get_connection(&pool).expect("conn");
        let snapshot_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM holdings_snapshots")
                .get_result(&mut conn)
                .expect("count snapshots");
        assert_eq!(snapshot_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_restore_uses_canonical_table_order_for_requested_tables() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let account_id = "acc-reordered-restore";
        let snapshot_path = create_snapshot_db_with_account_and_holding_snapshot(account_id);

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["holdings_snapshots".to_string(), "accounts".to_string()],
            91,
            "device-reordered-restore".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot");

        assert_eq!(count_account_rows(&pool, account_id), 1);
        let mut conn = get_connection(&pool).expect("conn");
        let snapshot_count: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE account_id = '{}'",
            escape_sqlite_str(account_id)
        ))
        .get_result(&mut conn)
        .expect("count restored snapshots");
        assert_eq!(snapshot_count.c, 1);
    }

    #[tokio::test]
    async fn snapshot_restore_orders_snapshot_positions_after_snapshot_parents() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let account_id = "acc-position-restore";
        let asset_id = "asset-position-restore";
        let snapshot_path =
            create_snapshot_db_with_account_asset_snapshot_position(account_id, asset_id);

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec![
                "snapshot_positions".to_string(),
                "holdings_snapshots".to_string(),
                "assets".to_string(),
                "accounts".to_string(),
            ],
            92,
            "device-position-restore".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot");

        let mut conn = get_connection(&pool).expect("conn");
        let position_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c
             FROM snapshot_positions
             WHERE snapshot_id = 'snap-acc-position-restore'
               AND asset_id = 'asset-position-restore'",
        )
        .get_result(&mut conn)
        .expect("count restored snapshot positions");
        assert_eq!(position_count.c, 1);
    }

    #[tokio::test]
    async fn snapshot_restore_skips_orphan_portfolio_accounts_and_clears_existing_rows() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_portfolio_accounts();

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-local-stale").expect("insert local account");
            insert_portfolio_for_test(&mut conn, "portfolio-local-stale", "Local Stale")
                .expect("insert local portfolio");
            insert_portfolio_account_for_test(
                &mut conn,
                "membership-local-stale",
                "portfolio-local-stale",
                "acc-local-stale",
                0,
            )
            .expect("insert local membership");
        }

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec![
                "accounts".to_string(),
                "portfolios".to_string(),
                "portfolio_accounts".to_string(),
            ],
            94,
            "device-portfolio-accounts-restore".to_string(),
            Some(1),
        )
        .await
        .expect("restore portfolio account snapshot");

        let mut conn = get_connection(&pool).expect("conn");
        let restored_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM portfolio_accounts")
                .get_result(&mut conn)
                .expect("count memberships");
        assert_eq!(restored_count.c, 1);

        let valid_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM portfolio_accounts WHERE id = 'membership-snapshot-valid'",
        )
        .get_result(&mut conn)
        .expect("count valid membership");
        assert_eq!(valid_count.c, 1);

        let stale_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM portfolio_accounts WHERE id = 'membership-local-stale'",
        )
        .get_result(&mut conn)
        .expect("count stale membership");
        assert_eq!(stale_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_restore_portfolio_accounts_only_does_not_clear_parent_tables() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_portfolio_accounts();

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-local-stale").expect("insert local account");
            insert_portfolio_for_test(&mut conn, "portfolio-local-stale", "Local Stale")
                .expect("insert local portfolio");
            insert_portfolio_account_for_test(
                &mut conn,
                "membership-local-stale",
                "portfolio-local-stale",
                "acc-local-stale",
                0,
            )
            .expect("insert local membership");
        }

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["portfolio_accounts".to_string()],
            95,
            "device-portfolio-accounts-only-restore".to_string(),
            Some(1),
        )
        .await
        .expect("restore portfolio memberships only");

        let mut conn = get_connection(&pool).expect("conn");
        let local_account_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM accounts WHERE id = 'acc-local-stale'")
                .get_result(&mut conn)
                .expect("count local account");
        assert_eq!(local_account_count.c, 1);

        let local_portfolio_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM portfolios WHERE id = 'portfolio-local-stale'",
        )
        .get_result(&mut conn)
        .expect("count local portfolio");
        assert_eq!(local_portfolio_count.c, 1);

        let membership_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM portfolio_accounts")
                .get_result(&mut conn)
                .expect("count memberships");
        assert_eq!(membership_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_restore_skips_activity_sidecars_without_syncable_activity() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_orphan_activity_sidecars();

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec![
                "spending_event_types".to_string(),
                "spending_events".to_string(),
                "activity_taxonomy_assignments".to_string(),
                "spending_activity_events".to_string(),
            ],
            96,
            "device-orphan-activity-sidecars-restore".to_string(),
            Some(1),
        )
        .await
        .expect("restore should skip sidecars without syncable activity");

        let mut conn = get_connection(&pool).expect("conn");
        let assignment_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM activity_taxonomy_assignments")
                .get_result(&mut conn)
                .expect("count activity assignments");
        assert_eq!(assignment_count.c, 0);

        let event_tag_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM spending_activity_events")
                .get_result(&mut conn)
                .expect("count activity events");
        assert_eq!(event_tag_count.c, 0);
    }

    #[tokio::test]
    async fn needs_bootstrap_when_last_cycle_is_stale_cursor() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        repo.reset_and_mark_bootstrap_complete("device-1".to_string(), Some(1))
            .await
            .expect("mark bootstrap complete");
        assert!(
            !repo.needs_bootstrap("device-1").expect("needs bootstrap"),
            "bootstrap should not be required immediately after completion"
        );

        repo.mark_cycle_outcome("stale_cursor".to_string(), 42, None)
            .await
            .expect("mark stale cursor cycle");
        assert!(
            repo.needs_bootstrap("device-1").expect("needs bootstrap"),
            "bootstrap should be required after stale cursor cycle"
        );
    }

    #[tokio::test]
    async fn local_sync_data_summary_reports_non_empty_tables() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let baseline = repo
            .get_local_sync_data_summary()
            .expect("baseline sync summary");

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-summary").expect("insert account");
        }

        let summary = repo
            .get_local_sync_data_summary()
            .expect("sync summary after insert");
        assert!(
            summary.total_rows > baseline.total_rows,
            "total_rows should increase after inserting sync data"
        );
        let account_row = summary
            .non_empty_tables
            .iter()
            .find(|row| row.table == "accounts")
            .expect("accounts table should be reported as non-empty");
        assert!(account_row.rows >= 1);
        assert!(summary.non_empty_tables.windows(2).all(|window| {
            let first = &window[0];
            let second = &window[1];
            first.rows > second.rows || (first.rows == second.rows && first.table <= second.table)
        }));
    }

    #[tokio::test]
    async fn overwrite_risk_summary_ignores_seeded_system_rows() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let raw_summary = repo
            .get_local_sync_data_summary()
            .expect("raw sync summary");
        let risk_summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");

        assert!(
            raw_summary.total_rows > 0,
            "migrations should seed sync tables"
        );
        assert_eq!(risk_summary.total_rows, 0);
        assert!(risk_summary.non_empty_tables.is_empty());
    }

    #[tokio::test]
    async fn overwrite_risk_summary_counts_accounts_goals_and_budgets() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-overwrite-risk").expect("insert account");
            insert_goal_for_test(&mut conn, "goal-overwrite-risk").expect("insert goal");
            conn.batch_execute(
                "INSERT INTO budget_targets \
                 (id, period_key, target_type, taxonomy_id, category_id, group_id, amount, created_at, updated_at) \
                 VALUES ('budget-target-overwrite-risk', '2026-01', 'group_buffer', NULL, NULL, \
                         '032ecb02-5912-42e8-9724-2cd566fc08d5', '100.00', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'); \
                 INSERT INTO budget_rollover_settings \
                 (id, target_type, taxonomy_id, category_id, group_id, enabled, start_month, \
                  starting_balance, created_at, updated_at) \
                 VALUES ('budget-rollover-overwrite-risk', 'group', NULL, NULL, \
                         '032ecb02-5912-42e8-9724-2cd566fc08d5', 1, '2026-01', '0', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .expect("insert budget rows");
        }

        let summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");

        assert_eq!(summary.total_rows, 4);
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "accounts" && row.rows == 1));
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "goals" && row.rows == 1));
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "budget_targets" && row.rows == 1));
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "budget_rollover_settings" && row.rows == 1));
    }

    #[tokio::test]
    async fn overwrite_risk_summary_ignores_broker_rehydratable_accounts() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        {
            let mut conn = get_connection(&pool).expect("conn");
            diesel::sql_query(
                "INSERT INTO platforms (id, name, url, external_id, kind, website_url, logo_url) \
                 VALUES ('broker-platform-risk', 'Broker Platform', '', 'external-platform-risk', \
                         'BROKERAGE', NULL, NULL)",
            )
            .execute(&mut conn)
            .expect("insert broker platform");
            diesel::sql_query(
                "INSERT INTO accounts \
                 (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
                  platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
                 VALUES ('broker-account-risk', 'Broker Account', 'cash', NULL, 'USD', 0, 1, \
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'broker-platform-risk', NULL, NULL, \
                         'SNAPTRADE', 'broker-provider-account-risk', 0, 'portfolio')",
            )
            .execute(&mut conn)
            .expect("insert broker account");
            insert_broker_import_run_for_test(&mut conn, "broker-run-risk", "broker-account-risk")
                .expect("insert broker import run");
            insert_activity_for_snapshot_filter_test(
                &mut conn,
                "broker-activity-risk",
                "broker-account-risk",
                "SNAPTRADE",
                Some("broker-run-risk"),
                Some("broker-row-risk"),
                0,
            )
            .expect("insert broker activity");
            diesel::sql_query(
                "INSERT INTO activity_taxonomy_assignments \
                 (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at) \
                 VALUES ('broker-assignment-risk', 'broker-activity-risk', 'spending_categories', \
                         'cat_food', 10000, 'rule', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert broker activity generated category sidecar");
            conn.batch_execute(
                "INSERT INTO import_templates \
                 (id, name, scope, kind, source_system, config_version, config, created_at, updated_at) \
                 VALUES ('broker-template-risk', 'Broker Template', 'USER', 'BROKER_ACTIVITY', \
                         'SNAPTRADE', 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                 INSERT INTO import_account_templates \
                 (id, account_id, context_kind, source_system, template_id, created_at, updated_at) \
                 VALUES ('broker-profile-risk', 'broker-account-risk', 'BROKER_ACTIVITY', \
                         'SNAPTRADE', 'broker-template-risk', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .expect("insert broker import profile");
        }

        let summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");

        assert_eq!(summary.total_rows, 0);
        assert!(summary.non_empty_tables.is_empty());
    }

    #[tokio::test]
    async fn overwrite_risk_summary_ignores_broker_activity_sidecars() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        {
            let mut conn = get_connection(&pool).expect("conn");
            conn.batch_execute(
                "INSERT INTO platforms (id, name, url, external_id, kind, website_url, logo_url) \
                 VALUES ('broker-platform-manual-risk', 'Broker Platform', '', 'external-manual-risk', \
                         'BROKERAGE', NULL, NULL);
                 INSERT INTO accounts \
                 (id, name, account_type, `group`, currency, is_default, is_active, created_at, updated_at, \
                  platform_id, account_number, meta, provider, provider_account_id, is_archived, tracking_mode) \
                 VALUES ('broker-account-manual-risk', 'Broker Account', 'cash', NULL, 'USD', 0, 1, \
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'broker-platform-manual-risk', NULL, NULL, \
                         'SNAPTRADE', 'broker-provider-account-manual-risk', 0, 'portfolio')",
            )
            .expect("insert broker account");
            insert_broker_import_run_for_test(
                &mut conn,
                "broker-run-manual-risk",
                "broker-account-manual-risk",
            )
            .expect("insert broker import run");
            insert_activity_for_snapshot_filter_test(
                &mut conn,
                "broker-activity-manual-risk",
                "broker-account-manual-risk",
                "SNAPTRADE",
                Some("broker-run-manual-risk"),
                Some("broker-row-manual-risk"),
                0,
            )
            .expect("insert broker activity");
            conn.batch_execute(
                "INSERT INTO activity_taxonomy_assignments \
                 (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at) \
                 VALUES ('broker-manual-assignment-risk', 'broker-activity-manual-risk', \
                         'spending_categories', 'cat_food', 10000, 'manual', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO spending_event_types (id, key, name, color, created_at, updated_at) \
                 VALUES ('broker-event-type-risk', 'broker_event', 'Broker Event', NULL, \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO spending_events \
                 (id, name, description, event_type_id, start_date, end_date, created_at, updated_at) \
                 VALUES ('broker-event-risk', 'Broker Event', NULL, 'broker-event-type-risk', \
                         '2026-01-01', '2026-01-02', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO spending_activity_events (activity_id, event_id, created_at, updated_at) \
                 VALUES ('broker-activity-manual-risk', 'broker-event-risk', \
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            )
            .expect("insert broker manual sidecars");
        }

        let summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");

        assert_eq!(summary.total_rows, 0);
        assert!(summary.non_empty_tables.is_empty());
    }

    #[tokio::test]
    async fn overwrite_risk_summary_ignores_standalone_asset_kinds() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let counted_kinds = [
            "PROPERTY",
            "VEHICLE",
            "COLLECTIBLE",
            "PRECIOUS_METAL",
            "PRIVATE_EQUITY",
            "LIABILITY",
            "OTHER",
        ];

        {
            let mut conn = get_connection(&pool).expect("conn");
            for kind in counted_kinds {
                insert_asset_kind_for_test(
                    &mut conn,
                    &format!("asset-{}", kind.to_ascii_lowercase()),
                    kind,
                )
                .expect("insert counted asset");
            }
            insert_asset_kind_for_test(&mut conn, "asset-investment", "INVESTMENT")
                .expect("insert investment asset");
            insert_asset_kind_for_test(&mut conn, "asset-fx", "FX").expect("insert fx asset");
        }

        let summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");

        assert_eq!(summary.total_rows, 0);
        assert!(summary.non_empty_tables.is_empty());
    }

    #[tokio::test]
    async fn overwrite_risk_summary_ignores_non_account_goal_budget_tables() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_asset_kind_for_test(&mut conn, "asset-supporting-table", "INVESTMENT")
                .expect("insert investment asset");
            insert_account_for_test(&mut conn, "acc-supporting-table").expect("insert account");
            insert_goal_for_test(&mut conn, "goal-supporting-table").expect("insert goal");
            diesel::sql_query(
                "INSERT INTO platforms (id, name, url, external_id, kind, website_url, logo_url) \
                 VALUES ('platform-risk', 'Platform Risk', '', NULL, 'BROKERAGE', NULL, NULL)",
            )
            .execute(&mut conn)
            .expect("insert platform");
            diesel::sql_query(
                "INSERT INTO market_data_custom_providers \
                 (id, code, name, description, enabled, priority, config, created_at, updated_at) \
                 VALUES ('provider-risk', 'RISK', 'Risk Provider', '', 1, 1, NULL, \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert custom provider");
            diesel::sql_query(
                "INSERT INTO quotes \
                 (id, asset_id, day, source, open, high, low, close, adjclose, volume, currency, notes, created_at, timestamp) \
                 VALUES ('quote-risk', 'asset-supporting-table', '2026-02-12', 'MANUAL', NULL, NULL, NULL, \
                         '10.00', NULL, NULL, 'USD', NULL, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert manual quote");
            diesel::sql_query(
                "INSERT INTO goal_plans \
                 (goal_id, plan_kind, planner_mode, settings_json, summary_json, version, created_at, updated_at) \
                 VALUES ('goal-supporting-table', 'retirement', NULL, '{}', '{}', 1, \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert goal plan");
            diesel::sql_query(
                "INSERT INTO goals_allocation \
                 (id, goal_id, account_id, share_percent, tax_bucket, created_at, updated_at) \
                 VALUES ('allocation-risk', 'goal-supporting-table', 'acc-supporting-table', 100.0, NULL, \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert goal allocation");
            diesel::sql_query(
                "INSERT INTO ai_threads (id, title, config_snapshot, is_pinned, created_at, updated_at) \
                 VALUES ('thread-risk', 'Risk Thread', NULL, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert ai thread");
            diesel::sql_query(
                "INSERT INTO ai_messages (id, thread_id, role, content_json, created_at) \
                 VALUES ('message-risk', 'thread-risk', 'user', '{\"text\":\"risk\"}', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert ai message");
            diesel::sql_query(
                "INSERT INTO ai_thread_tags (id, thread_id, tag, created_at) \
                 VALUES ('tag-risk', 'thread-risk', 'tax', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert ai thread tag");
            diesel::sql_query(
                "INSERT INTO contribution_limits \
                 (id, group_name, contribution_year, limit_amount, account_ids, created_at, updated_at, start_date, end_date) \
                 VALUES ('limit-risk', 'TFSA', 2026, 7000, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)",
            )
            .execute(&mut conn)
            .expect("insert contribution limit");
            diesel::sql_query(
                "INSERT INTO import_templates \
                 (id, name, scope, kind, source_system, config_version, config, created_at, updated_at) \
                 VALUES ('template-risk', 'Risk Template', 'USER', 'CSV_ACTIVITY', '', 1, '{}', \
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .execute(&mut conn)
            .expect("insert user import template");
            diesel::sql_query(
                "INSERT INTO import_account_templates \
                 (id, account_id, context_kind, source_system, template_id, created_at, updated_at) \
                 VALUES ('profile-risk', 'acc-supporting-table', 'account', 'CSV', 'template-risk', \
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            )
            .execute(&mut conn)
            .expect("insert import account template");
            diesel::sql_query(
                "INSERT INTO import_runs \
                 (id, account_id, source_system, run_type, mode, status, started_at, finished_at, \
                  review_mode, applied_at, checkpoint_in, checkpoint_out, summary, warnings, error, created_at, updated_at) \
                 VALUES ('run-risk', 'acc-supporting-table', 'CSV', 'IMPORT', 'INCREMENTAL', 'APPLIED', \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z', 'NEVER', '2026-02-12T00:01:00Z', \
                         NULL, NULL, NULL, NULL, NULL, '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z')",
            )
            .execute(&mut conn)
            .expect("insert import run");
            diesel::sql_query(
                "INSERT INTO activities \
                 (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, status, \
                  activity_date, settlement_date, quantity, unit_price, amount, fee, currency, fx_rate, notes, metadata, \
                  source_system, source_record_id, source_group_id, idempotency_key, import_run_id, is_user_modified, \
                  needs_review, created_at, updated_at) \
                 VALUES \
                 ('activity-risk', 'acc-supporting-table', NULL, 'DEPOSIT', NULL, NULL, NULL, 'COMPLETED', \
                  '2026-02-12', NULL, NULL, NULL, '100.00', NULL, 'USD', NULL, NULL, NULL, \
                  'CSV', 'row-1', NULL, NULL, 'run-risk', 1, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z'), \
                 ('activity-broker-ignore', 'acc-supporting-table', NULL, 'DEPOSIT', NULL, NULL, NULL, 'COMPLETED', \
                  '2026-02-12', NULL, NULL, NULL, '100.00', NULL, 'USD', NULL, NULL, NULL, \
                  'BROKER', 'broker-row-1', NULL, NULL, NULL, 0, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert activities");
            diesel::sql_query(
                "INSERT INTO taxonomies \
                 (id, name, color, description, is_system, is_single_select, sort_order, created_at, updated_at) \
                 VALUES ('taxonomy-risk', 'Risk Taxonomy', '#000000', NULL, 0, 0, 0, \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert custom taxonomy");
            diesel::sql_query(
                "INSERT INTO taxonomy_categories \
                 (id, taxonomy_id, parent_id, name, key, color, description, sort_order, created_at, updated_at) \
                 VALUES ('category-risk', 'custom_groups', NULL, 'Risk Category', 'risk_category', '#000000', NULL, 0, \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert custom group category");
            diesel::sql_query(
                "INSERT INTO asset_taxonomy_assignments \
                 (id, asset_id, taxonomy_id, category_id, weight, source, created_at, updated_at) \
                 VALUES ('assignment-risk', 'asset-supporting-table', 'custom_groups', 'category-risk', 10000, 'manual', \
                         '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
            )
            .execute(&mut conn)
            .expect("insert asset taxonomy assignment");
        }

        let summary = repo
            .get_local_sync_overwrite_risk_summary()
            .expect("overwrite risk summary");
        assert_eq!(summary.total_rows, 2);
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "accounts" && row.rows == 1));
        assert!(summary
            .non_empty_tables
            .iter()
            .any(|row| row.table == "goals" && row.rows == 1));
        assert!(summary
            .non_empty_tables
            .iter()
            .all(|row| matches!(row.table.as_str(), "accounts" | "goals")));
    }

    #[tokio::test]
    async fn ok_cycle_outcome_clears_previous_engine_error() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        repo.mark_engine_error("pull failed".to_string())
            .await
            .expect("mark error");

        let status_before = repo.get_engine_status().expect("status before");
        assert!(
            status_before.last_error.is_some(),
            "expected previous error to be set"
        );
        assert!(
            status_before.consecutive_failures > 0,
            "expected previous failure count to be > 0"
        );

        repo.mark_cycle_outcome("ok".to_string(), 7, None)
            .await
            .expect("mark ok");

        let status_after = repo.get_engine_status().expect("status after");
        assert_eq!(
            status_after.last_error, None,
            "ok outcome should clear stale last_error"
        );
        assert_eq!(
            status_after.consecutive_failures, 0,
            "ok outcome should reset failure counter"
        );
        assert_eq!(
            status_after.last_cycle_status.as_deref(),
            Some("ok"),
            "status should record successful cycle"
        );
    }

    #[tokio::test]
    async fn snapshot_restore_handles_source_with_extra_columns() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_assets_extra_column("asset-extra-column");

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["assets".to_string()],
            19,
            "device-1".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot with extra source columns");

        assert_eq!(count_asset_rows(&pool, "asset-extra-column"), 1);
        assert_eq!(repo.get_cursor().expect("cursor"), 19);
    }

    #[tokio::test]
    async fn snapshot_restore_resets_sync_control_state() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let snapshot_path = create_snapshot_db_with_account("acc-reset-state");

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_outbox_event(
                &mut conn,
                OutboxWriteRequest::new(
                    SyncEntity::Account,
                    "acc-local-dirty",
                    SyncOperation::Update,
                    serde_json::json!({ "id": "acc-local-dirty", "name": "dirty" }),
                ),
            )
            .expect("write outbox");
        }
        repo.upsert_entity_metadata(SyncEntityMetadata {
            entity: SyncEntity::Account,
            entity_id: "acc-local-dirty".to_string(),
            last_event_id: "evt-local".to_string(),
            last_client_timestamp: chrono::Utc::now().to_rfc3339(),
            last_op: SyncOperation::Update,
            last_seq: 123,
        })
        .await
        .expect("upsert metadata");
        repo.mark_applied_event(
            "evt-applied-local".to_string(),
            124,
            SyncEntity::Account,
            "acc-local-dirty".to_string(),
        )
        .await
        .expect("mark applied");

        repo.restore_snapshot_tables_from_file(
            snapshot_path,
            vec!["accounts".to_string()],
            200,
            "device-1".to_string(),
            Some(1),
        )
        .await
        .expect("restore snapshot");

        let mut conn = get_connection(&pool).expect("conn");
        let outbox_count: i64 = sync_outbox::table
            .select(count_star())
            .first(&mut conn)
            .expect("count outbox");
        let metadata_count: i64 = sync_entity_metadata::table
            .select(count_star())
            .first(&mut conn)
            .expect("count metadata");
        let applied_count: i64 = sync_applied_events::table
            .select(count_star())
            .first(&mut conn)
            .expect("count applied");

        assert_eq!(outbox_count, 0);
        assert_eq!(metadata_count, 0);
        assert_eq!(applied_count, 0);
    }

    #[tokio::test]
    async fn reset_local_sync_session_clears_control_plane_and_zeroes_cursors() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        {
            let mut conn = get_connection(&pool).expect("conn");
            insert_account_for_test(&mut conn, "acc-keep").expect("insert account");
            insert_outbox_event(
                &mut conn,
                OutboxWriteRequest::new(
                    SyncEntity::Account,
                    "acc-dirty",
                    SyncOperation::Update,
                    serde_json::json!({ "id": "acc-dirty", "name": "dirty" }),
                ),
            )
            .expect("insert outbox");
        }

        repo.upsert_entity_metadata(SyncEntityMetadata {
            entity: SyncEntity::Account,
            entity_id: "acc-dirty".to_string(),
            last_event_id: "evt-dirty".to_string(),
            last_client_timestamp: chrono::Utc::now().to_rfc3339(),
            last_op: SyncOperation::Update,
            last_seq: 42,
        })
        .await
        .expect("upsert metadata");
        repo.mark_applied_event(
            "evt-applied".to_string(),
            43,
            SyncEntity::Account,
            "acc-dirty".to_string(),
        )
        .await
        .expect("mark applied");
        repo.upsert_device_config("device-1".to_string(), Some(3), "trusted".to_string())
            .await
            .expect("upsert device config");
        repo.set_cursor(15).await.expect("set cursor");
        repo.mark_engine_error("sync failed".to_string())
            .await
            .expect("mark engine error");

        repo.reset_local_sync_session()
            .await
            .expect("reset local sync session");

        let mut conn = get_connection(&pool).expect("conn");
        let outbox_count: i64 = sync_outbox::table
            .select(count_star())
            .first(&mut conn)
            .expect("count outbox");
        let metadata_count: i64 = sync_entity_metadata::table
            .select(count_star())
            .first(&mut conn)
            .expect("count metadata");
        let applied_count: i64 = sync_applied_events::table
            .select(count_star())
            .first(&mut conn)
            .expect("count applied");
        let device_config_count: i64 = sync_device_config::table
            .select(count_star())
            .first(&mut conn)
            .expect("count device config");

        assert_eq!(outbox_count, 0);
        assert_eq!(metadata_count, 0);
        assert_eq!(applied_count, 0);
        assert_eq!(device_config_count, 0);
        assert_eq!(
            count_account_rows(&pool, "acc-keep"),
            1,
            "app data must remain"
        );
        assert_eq!(repo.get_cursor().expect("cursor"), 0);

        let status = repo.get_engine_status().expect("engine status");
        assert_eq!(status.last_error, None);
        assert_eq!(status.last_cycle_status, None);
    }

    #[tokio::test]
    async fn reset_and_mark_bootstrap_complete_recreates_current_device_config() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        repo.set_cursor(21).await.expect("set cursor");
        repo.upsert_device_config("old-device".to_string(), Some(2), "trusted".to_string())
            .await
            .expect("upsert old device config");

        repo.reset_and_mark_bootstrap_complete("device-9".to_string(), Some(7))
            .await
            .expect("mark bootstrap complete");

        let mut conn = get_connection(&pool).expect("conn");
        let configs = sync_device_config::table
            .load::<SyncDeviceConfigDB>(&mut conn)
            .expect("load device configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].device_id, "device-9");
        assert_eq!(configs[0].key_version, Some(7));
        assert_eq!(configs[0].trust_state, "trusted");
        assert!(configs[0].last_bootstrap_at.is_some());

        assert_eq!(repo.get_cursor().expect("cursor"), 0);
        assert!(
            !repo.needs_bootstrap("device-9").expect("needs bootstrap"),
            "bootstrap should be marked complete for the current device"
        );
    }

    #[tokio::test]
    async fn outbox_uses_trusted_device_key_version_by_default() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer.clone());

        repo.upsert_device_config("device-1".to_string(), Some(3), "trusted".to_string())
            .await
            .expect("upsert device config");

        writer
            .exec(|conn| {
                insert_outbox_event(
                    conn,
                    OutboxWriteRequest::new(
                        SyncEntity::Account,
                        "acc-key-version",
                        SyncOperation::Create,
                        serde_json::json!({ "id": "acc-key-version" }),
                    ),
                )?;
                Ok(())
            })
            .await
            .expect("write outbox");

        let pending = repo.list_pending_outbox(10).expect("list pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].payload_key_version, 3);
    }

    #[tokio::test]
    async fn local_outbox_metadata_preserves_remote_last_seq() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer.clone());

        repo.upsert_entity_metadata(SyncEntityMetadata {
            entity: SyncEntity::Account,
            entity_id: "acc-seq-preserve".to_string(),
            last_event_id: "evt-remote".to_string(),
            last_client_timestamp: "2026-02-12T00:00:00Z".to_string(),
            last_op: SyncOperation::Update,
            last_seq: 123,
        })
        .await
        .expect("seed remote metadata");

        writer
            .exec(|conn| {
                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Account,
                    "acc-seq-preserve",
                    SyncOperation::Update,
                    serde_json::json!({ "id": "acc-seq-preserve" }),
                );
                request.event_id = Some("evt-local".to_string());
                request.client_timestamp = "2026-02-12T00:00:01Z".to_string();
                insert_outbox_event(conn, request)?;
                Ok(())
            })
            .await
            .expect("write local outbox");

        let metadata = repo
            .get_entity_metadata(SyncEntity::Account, "acc-seq-preserve")
            .expect("load metadata")
            .expect("metadata exists");
        assert_eq!(metadata.last_event_id, "evt-local");
        assert_eq!(metadata.last_seq, 123);
    }

    async fn insert_outbox_row_for_prune_test(
        repo: &AppSyncRepository,
        writer: &WriteHandle,
        event_id: &str,
        status: SyncOutboxStatus,
        created_at: chrono::DateTime<Utc>,
    ) {
        let event_id_value = event_id.to_string();
        writer
            .exec(move |conn| {
                let mut request = OutboxWriteRequest::new(
                    SyncEntity::Account,
                    format!("019cb093-06a8-7534-8677-{}", &event_id_value[0..12]),
                    SyncOperation::Update,
                    serde_json::json!({ "id": event_id_value }),
                );
                request.event_id = Some(event_id_value.clone());
                insert_outbox_event(conn, request)?;
                diesel::update(sync_outbox::table.find(event_id_value))
                    .set((
                        sync_outbox::status.eq(enum_to_db(&status)?),
                        sync_outbox::sent.eq(if status == SyncOutboxStatus::Sent {
                            1
                        } else {
                            0
                        }),
                        sync_outbox::created_at.eq(created_at.to_rfc3339()),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .expect("insert prune test outbox row");

        assert!(
            repo.list_pending_outbox(100).is_ok(),
            "repo remains usable after prune test insert"
        );
    }

    #[tokio::test]
    async fn prune_sync_outbox_deletes_only_old_sent_and_dead_rows() {
        let (_pool, writer) = setup_db();
        let repo = AppSyncRepository::new(_pool, writer.clone());
        let now = Utc::now();

        insert_outbox_row_for_prune_test(
            &repo,
            &writer,
            "sent-old-0001",
            SyncOutboxStatus::Sent,
            now - chrono::Duration::days(8),
        )
        .await;
        insert_outbox_row_for_prune_test(
            &repo,
            &writer,
            "sent-new-0001",
            SyncOutboxStatus::Sent,
            now - chrono::Duration::days(6),
        )
        .await;
        insert_outbox_row_for_prune_test(
            &repo,
            &writer,
            "dead-old-0001",
            SyncOutboxStatus::Dead,
            now - chrono::Duration::days(31),
        )
        .await;
        insert_outbox_row_for_prune_test(
            &repo,
            &writer,
            "dead-new-0001",
            SyncOutboxStatus::Dead,
            now - chrono::Duration::days(29),
        )
        .await;
        insert_outbox_row_for_prune_test(
            &repo,
            &writer,
            "pending-old1",
            SyncOutboxStatus::Pending,
            now - chrono::Duration::days(90),
        )
        .await;

        let deleted = repo
            .prune_sync_outbox(
                now - chrono::Duration::days(7),
                now - chrono::Duration::days(30),
            )
            .await
            .expect("prune sync outbox");

        assert_eq!(deleted, 2);

        let mut conn = get_connection(&repo.pool).expect("conn");
        let remaining_ids = sync_outbox::table
            .select(sync_outbox::event_id)
            .order(sync_outbox::event_id.asc())
            .load::<String>(&mut conn)
            .expect("remaining ids");
        assert_eq!(
            remaining_ids,
            vec![
                "dead-new-0001".to_string(),
                "pending-old1".to_string(),
                "sent-new-0001".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_outbox_payload_keys_to_snake_case() {
        let payload = normalize_outbox_payload(serde_json::json!({
            "id": "goal-outbox-camel",
            "targetAmount": 5000.0,
            "statusLifecycle": "active"
        }))
        .expect("normalize payload");
        assert!(payload.get("target_amount").is_some());
        assert!(payload.get("status_lifecycle").is_some());
        assert!(payload.get("targetAmount").is_none());
        assert!(payload.get("statusLifecycle").is_none());
    }

    #[test]
    fn normalize_outbox_payload_rejects_conflicting_aliases() {
        let result = normalize_outbox_payload(serde_json::json!({
            "id": "goal-outbox-conflict",
            "statusLifecycle": "active",
            "status_lifecycle": "archived"
        }));
        assert!(
            result.is_err(),
            "expected conflicting payload aliases to be rejected"
        );
    }

    #[tokio::test]
    async fn payload_normalization_supports_camel_case_for_all_sync_tables() {
        let (pool, _writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");

        for table_name in APP_SYNC_TABLES {
            let catalog = load_payload_column_catalog(&mut conn, table_name).expect("catalog");

            let camel_case_fields = catalog
                .writable
                .iter()
                .map(|column| {
                    (
                        snake_to_camel_case(column),
                        serde_json::Value::String("v".to_string()),
                    )
                })
                .collect::<Vec<_>>();

            let normalized = normalize_payload_fields(&mut conn, table_name, camel_case_fields)
                .unwrap_or_else(|err| {
                    panic!("normalize failed for table '{}': {}", table_name, err)
                });

            let normalized_columns = normalized
                .iter()
                .map(|(column, _)| column.clone())
                .collect::<BTreeSet<_>>();
            let expected_columns = catalog.writable.iter().cloned().collect::<BTreeSet<_>>();
            assert_eq!(
                normalized_columns, expected_columns,
                "normalized columns mismatch for table '{}'",
                table_name
            );
        }
    }

    #[tokio::test]
    async fn entity_mapping_targets_valid_tables_and_primary_keys() {
        let (pool, _writer) = setup_db();
        let mut conn = get_connection(&pool).expect("conn");

        let entities = [
            SyncEntity::Account,
            SyncEntity::Asset,
            SyncEntity::Quote,
            SyncEntity::AssetTaxonomyAssignment,
            SyncEntity::Activity,
            SyncEntity::ActivityImportProfile,
            SyncEntity::Goal,
            SyncEntity::GoalsAllocation,
            SyncEntity::AiThread,
            SyncEntity::AiMessage,
            SyncEntity::AiThreadTag,
            SyncEntity::ContributionLimit,
            SyncEntity::Platform,
            SyncEntity::Snapshot,
            SyncEntity::AllocationTarget,
            SyncEntity::AllocationTargetWeight,
            SyncEntity::AllocationTargetConstraint,
        ];

        for entity in entities {
            let (table_name, pk_name) =
                entity_storage_mapping(&entity).expect("entity storage mapping");
            assert!(
                APP_SYNC_TABLES.contains(&table_name),
                "entity {:?} mapped to non-sync table '{}'",
                entity,
                table_name
            );

            let catalog = load_payload_column_catalog(&mut conn, table_name).expect("catalog");
            assert!(
                catalog.writable.contains(pk_name) || catalog.readonly.contains(pk_name),
                "entity {:?} PK '{}' not found in table '{}'",
                entity,
                pk_name,
                table_name
            );
        }
    }

    #[tokio::test]
    async fn replay_rejects_payload_with_mismatched_pk() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let result = repo
            .apply_remote_event_lww(
                SyncEntity::Account,
                "account-entity-id".to_string(),
                SyncOperation::Update,
                "evt-1".to_string(),
                "2026-02-12T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "different-account-id"
                }),
            )
            .await;

        assert!(result.is_err(), "expected PK mismatch to be rejected");
    }

    #[tokio::test]
    async fn replay_applies_platform_create_then_update() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let platform_id = "platform-sync-1".to_string();

        let created = repo
            .apply_remote_event_lww(
                SyncEntity::Platform,
                platform_id.clone(),
                SyncOperation::Create,
                "evt-platform-create".to_string(),
                "2026-02-16T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": platform_id,
                    "name": "Initial Platform",
                    "url": "https://broker.example/initial",
                    "external_id": "ext-platform-1",
                    "kind": "BROKERAGE",
                    "website_url": "https://broker.example",
                    "logo_url": "https://broker.example/logo.png"
                }),
            )
            .await
            .expect("apply platform create");
        assert!(created, "expected platform create to apply");

        let updated = repo
            .apply_remote_event_lww(
                SyncEntity::Platform,
                "platform-sync-1".to_string(),
                SyncOperation::Update,
                "evt-platform-update".to_string(),
                "2026-02-16T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "id": "platform-sync-1",
                    "name": "Renamed Platform",
                    "url": "https://broker.example/updated",
                    "external_id": "ext-platform-1",
                    "kind": "BROKERAGE",
                    "website_url": "https://broker.example/updated",
                    "logo_url": "https://broker.example/logo-v2.png"
                }),
            )
            .await
            .expect("apply platform update");
        assert!(updated, "expected platform update to apply");
        assert_eq!(count_platform_rows(&pool, "platform-sync-1"), 1);

        let mut conn = get_connection(&pool).expect("conn");
        let (name_value, url_value): (Option<String>, String) = platforms::table
            .filter(platforms::id.eq("platform-sync-1"))
            .select((platforms::name, platforms::url))
            .first(&mut conn)
            .expect("platform row");
        assert_eq!(name_value.as_deref(), Some("Renamed Platform"));
        assert_eq!(url_value, "https://broker.example/updated");
    }

    #[tokio::test]
    async fn replay_accepts_camel_case_goal_payload() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-camel-case".to_string(),
                SyncOperation::Create,
                "evt-goal-camel".to_string(),
                "2026-02-19T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-camel-case",
                    "title": "Emergency Fund",
                    "description": "6 months expenses",
                    "targetAmount": 50000.0,
                    "statusLifecycle": "achieved"
                }),
            )
            .await
            .expect("apply goal create");
        assert!(applied, "expected goal create to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let (target_amount_value, status_lifecycle_value): (f64, String) = goals::table
            .filter(goals::id.eq("goal-camel-case"))
            .select((goals::target_amount, goals::status_lifecycle))
            .first(&mut conn)
            .expect("goal row");
        assert_eq!(target_amount_value, 50000.0);
        assert_eq!(status_lifecycle_value, "achieved");
    }

    #[tokio::test]
    async fn replay_maps_legacy_account_type_to_securities() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Account,
                "acc-legacy-account-type".to_string(),
                SyncOperation::Create,
                "evt-legacy-account-type".to_string(),
                "2026-05-25T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "acc-legacy-account-type",
                    "name": "Legacy Account Type",
                    "account_type": "TFSA",
                    "group": serde_json::Value::Null,
                    "currency": "USD",
                    "is_default": false,
                    "is_active": true,
                    "platform_id": serde_json::Value::Null,
                    "account_number": serde_json::Value::Null,
                    "meta": serde_json::Value::Null,
                    "provider": serde_json::Value::Null,
                    "provider_account_id": serde_json::Value::Null,
                    "is_archived": false,
                    "tracking_mode": "NOT_SET"
                }),
            )
            .await
            .expect("apply account create");
        assert!(applied, "expected account create to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let account_type_value: String = accounts::table
            .filter(accounts::id.eq("acc-legacy-account-type"))
            .select(accounts::account_type)
            .first(&mut conn)
            .expect("account row");
        assert_eq!(account_type_value, account_types::SECURITIES);
    }

    #[tokio::test]
    async fn replay_accepts_legacy_goal_is_achieved_payload() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-legacy-achieved".to_string(),
                SyncOperation::Create,
                "evt-goal-legacy-achieved".to_string(),
                "2026-03-30T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-legacy-achieved",
                    "title": "Legacy Goal",
                    "description": "Created before goals refactor",
                    "targetAmount": 10000.0,
                    "isAchieved": true
                }),
            )
            .await
            .expect("apply legacy goal create");
        assert!(applied, "expected legacy goal create to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let (target_amount_value, status_lifecycle_value): (f64, String) = goals::table
            .filter(goals::id.eq("goal-legacy-achieved"))
            .select((goals::target_amount, goals::status_lifecycle))
            .first(&mut conn)
            .expect("goal row");
        assert_eq!(target_amount_value, 10000.0);
        assert_eq!(status_lifecycle_value, "achieved");
    }

    #[tokio::test]
    async fn replay_accepts_equivalent_legacy_and_current_goal_lifecycle_aliases() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-equivalent-lifecycle".to_string(),
                SyncOperation::Create,
                "evt-goal-equivalent-lifecycle".to_string(),
                "2026-03-30T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-equivalent-lifecycle",
                    "title": "Equivalent Legacy Goal",
                    "targetAmount": 12000.0,
                    "isAchieved": " TRUE ",
                    "statusLifecycle": "achieved"
                }),
            )
            .await
            .expect("apply equivalent lifecycle aliases");
        assert!(applied, "expected equivalent lifecycle aliases to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let status_lifecycle_value: String = goals::table
            .filter(goals::id.eq("goal-equivalent-lifecycle"))
            .select(goals::status_lifecycle)
            .first(&mut conn)
            .expect("goal row");
        assert_eq!(status_lifecycle_value, "achieved");
    }

    #[tokio::test]
    async fn replay_rejects_conflicting_legacy_goal_lifecycle_aliases() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let result = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-conflicting-lifecycle".to_string(),
                SyncOperation::Create,
                "evt-goal-conflicting-lifecycle".to_string(),
                "2026-03-30T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-conflicting-lifecycle",
                    "title": "Conflicting Legacy Goal",
                    "targetAmount": 12000.0,
                    "isAchieved": true,
                    "statusLifecycle": "active"
                }),
            )
            .await;

        assert!(
            result.is_err(),
            "expected conflicting lifecycle aliases to be rejected"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("multiple values"),
            "error should mention conflicting alias values: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn replay_maps_legacy_null_goal_lifecycle_to_active() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-null-lifecycle".to_string(),
                SyncOperation::Create,
                "evt-goal-null-lifecycle".to_string(),
                "2026-03-30T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-null-lifecycle",
                    "title": "Null Legacy Goal",
                    "targetAmount": 12000.0,
                    "isAchieved": null
                }),
            )
            .await
            .expect("apply null legacy lifecycle");
        assert!(applied, "expected null legacy lifecycle to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let status_lifecycle_value: String = goals::table
            .filter(goals::id.eq("goal-null-lifecycle"))
            .select(goals::status_lifecycle)
            .first(&mut conn)
            .expect("goal row");
        assert_eq!(status_lifecycle_value, "active");
    }

    #[tokio::test]
    async fn replay_accepts_legacy_goals_allocation_percent_payload() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-legacy-allocation").expect("insert account");
        drop(conn);

        let goal_created = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-legacy-allocation".to_string(),
                SyncOperation::Create,
                "evt-goal-for-legacy-allocation".to_string(),
                "2026-03-30T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-legacy-allocation",
                    "title": "Legacy Allocation Goal",
                    "targetAmount": 25000.0,
                    "statusLifecycle": "active"
                }),
            )
            .await
            .expect("apply goal create");
        assert!(goal_created, "expected goal create to apply");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::GoalsAllocation,
                "allocation-legacy-percent".to_string(),
                SyncOperation::Create,
                "evt-allocation-legacy-percent".to_string(),
                "2026-03-30T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "id": "allocation-legacy-percent",
                    "goalId": "goal-legacy-allocation",
                    "accountId": "acc-legacy-allocation",
                    "percentAllocation": 33.5
                }),
            )
            .await
            .expect("apply legacy allocation create");
        assert!(applied, "expected legacy allocation create to apply");

        let mut conn = get_connection(&pool).expect("conn");
        let share_percent_value: f64 = goals_allocation::table
            .filter(goals_allocation::id.eq("allocation-legacy-percent"))
            .select(goals_allocation::share_percent)
            .first(&mut conn)
            .expect("goals allocation row");
        assert_eq!(share_percent_value, 33.5);
    }

    #[tokio::test]
    async fn replay_accepts_import_profile_payload() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-import-profile").expect("insert account");

        // Insert a template that the account link can reference
        diesel::insert_into(import_templates::table)
            .values((
                import_templates::id.eq("tmpl-import-profile"),
                import_templates::name.eq("Broker Mapping"),
                import_templates::scope.eq("ACCOUNT"),
                import_templates::config.eq("{\"rules\":[]}"),
                import_templates::created_at.eq(chrono::NaiveDateTime::parse_from_str(
                    "2026-02-19 00:00:00",
                    "%Y-%m-%d %H:%M:%S",
                )
                .unwrap()),
                import_templates::updated_at.eq(chrono::NaiveDateTime::parse_from_str(
                    "2026-02-19 00:00:00",
                    "%Y-%m-%d %H:%M:%S",
                )
                .unwrap()),
            ))
            .execute(&mut conn)
            .expect("insert template");

        // Current format: entity_id is the UUID `id` column; payload includes `id`.
        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::ActivityImportProfile,
                "link-uuid-001".to_string(),
                SyncOperation::Create,
                "evt-import-profile-new".to_string(),
                "2026-02-19T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "link-uuid-001",
                    "accountId": "acc-import-profile",
                    "importType": "ACTIVITY",
                    "templateId": "tmpl-import-profile",
                    "createdAt": "2026-02-19 00:00:00",
                    "updatedAt": "2026-02-19 00:00:00"
                }),
            )
            .await
            .expect("apply import profile create");
        assert!(applied, "expected import profile create to apply");

        let template_id_value: String = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-import-profile"))
            .filter(import_account_templates::context_kind.eq("CSV_ACTIVITY"))
            .select(import_account_templates::template_id)
            .first(&mut conn)
            .expect("import account template row");
        assert_eq!(template_id_value, "tmpl-import-profile");

        // Legacy format (pre-id-column): entity_id was the account_id UUID, no `id` in payload.
        // The generic replay injects `id = entity_id`, so this maps cleanly for migrated rows
        // (migration sets id = account_id for all pre-existing rows).
        insert_account_for_test(&mut conn, "acc-import-legacy").expect("insert account");
        let applied_legacy = repo
            .apply_remote_event_lww(
                SyncEntity::ActivityImportProfile,
                "acc-import-legacy".to_string(), // old format: entity_id = account_id
                SyncOperation::Create,
                "evt-import-profile-legacy".to_string(),
                "2026-02-19T00:00:00Z".to_string(),
                2,
                serde_json::json!({
                    // no "id" field — legacy payload
                    "accountId": "acc-import-legacy",
                    "importType": "ACTIVITY",
                    "templateId": "tmpl-import-profile",
                    "createdAt": "2026-02-19 00:00:00",
                    "updatedAt": "2026-02-19 00:00:00"
                }),
            )
            .await
            .expect("apply legacy import profile create");
        assert!(
            applied_legacy,
            "expected legacy import profile create to apply"
        );

        let legacy_id: String = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-import-legacy"))
            .select(import_account_templates::id)
            .first(&mut conn)
            .expect("legacy import account template row");
        // id was injected from entity_id (= account_id), matching migration behaviour
        assert_eq!(legacy_id, "acc-import-legacy");
    }

    #[tokio::test]
    async fn replay_updates_import_profile_with_stable_id() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-import-update").expect("insert account");

        diesel::insert_into(import_templates::table)
            .values(vec![
                (
                    import_templates::id.eq("tmpl-import-a"),
                    import_templates::name.eq("Broker Mapping A"),
                    import_templates::scope.eq("ACCOUNT"),
                    import_templates::config.eq("{\"rules\":[]}"),
                    import_templates::created_at.eq(chrono::NaiveDateTime::parse_from_str(
                        "2026-02-19 00:00:00",
                        "%Y-%m-%d %H:%M:%S",
                    )
                    .unwrap()),
                    import_templates::updated_at.eq(chrono::NaiveDateTime::parse_from_str(
                        "2026-02-19 00:00:00",
                        "%Y-%m-%d %H:%M:%S",
                    )
                    .unwrap()),
                ),
                (
                    import_templates::id.eq("tmpl-import-b"),
                    import_templates::name.eq("Broker Mapping B"),
                    import_templates::scope.eq("ACCOUNT"),
                    import_templates::config.eq("{\"rules\":[]}"),
                    import_templates::created_at.eq(chrono::NaiveDateTime::parse_from_str(
                        "2026-02-19 00:00:00",
                        "%Y-%m-%d %H:%M:%S",
                    )
                    .unwrap()),
                    import_templates::updated_at.eq(chrono::NaiveDateTime::parse_from_str(
                        "2026-02-19 00:00:00",
                        "%Y-%m-%d %H:%M:%S",
                    )
                    .unwrap()),
                ),
            ])
            .execute(&mut conn)
            .expect("insert templates");

        let created = repo
            .apply_remote_event_lww(
                SyncEntity::ActivityImportProfile,
                "link-uuid-stable".to_string(),
                SyncOperation::Create,
                "evt-import-profile-create".to_string(),
                "2026-02-19T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "link-uuid-stable",
                    "accountId": "acc-import-update",
                    "importType": "ACTIVITY",
                    "templateId": "tmpl-import-a",
                    "createdAt": "2026-02-19 00:00:00",
                    "updatedAt": "2026-02-19 00:00:00"
                }),
            )
            .await
            .expect("apply import profile create");
        assert!(created, "expected import profile create to apply");

        let updated = repo
            .apply_remote_event_lww(
                SyncEntity::ActivityImportProfile,
                "link-uuid-stable".to_string(),
                SyncOperation::Update,
                "evt-import-profile-update".to_string(),
                "2026-02-19T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "id": "link-uuid-stable",
                    "accountId": "acc-import-update",
                    "importType": "ACTIVITY",
                    "templateId": "tmpl-import-b",
                    "createdAt": "2026-02-19 00:00:00",
                    "updatedAt": "2026-02-19 00:00:01"
                }),
            )
            .await
            .expect("apply import profile update");
        assert!(updated, "expected import profile update to apply");

        let row_count: i64 = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-import-update"))
            .filter(import_account_templates::context_kind.eq("CSV_ACTIVITY"))
            .select(count_star())
            .first(&mut conn)
            .expect("import account template count");
        assert_eq!(row_count, 1, "update should not duplicate the link row");

        let (link_id, template_id): (String, String) = import_account_templates::table
            .filter(import_account_templates::account_id.eq("acc-import-update"))
            .filter(import_account_templates::context_kind.eq("CSV_ACTIVITY"))
            .select((
                import_account_templates::id,
                import_account_templates::template_id,
            ))
            .first(&mut conn)
            .expect("import account template row");
        assert_eq!(link_id, "link-uuid-stable");
        assert_eq!(template_id, "tmpl-import-b");
    }

    #[tokio::test]
    async fn replay_batch_applies_out_of_order_account_and_platform_events() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_events_lww_batch(vec![
                (
                    SyncEntity::Account,
                    "acc-batch-platform".to_string(),
                    SyncOperation::Create,
                    "evt-account-create".to_string(),
                    "2026-02-17T00:00:00Z".to_string(),
                    10,
                    serde_json::json!({
                        "id": "acc-batch-platform",
                        "name": "Batch Account",
                        "account_type": "cash",
                        "group": serde_json::Value::Null,
                        "currency": "USD",
                        "is_default": false,
                        "is_active": true,
                        "platform_id": "platform-batch",
                        "account_number": serde_json::Value::Null,
                        "meta": serde_json::Value::Null,
                        "provider": serde_json::Value::Null,
                        "provider_account_id": serde_json::Value::Null,
                        "is_archived": false,
                        "tracking_mode": "portfolio"
                    }),
                ),
                (
                    SyncEntity::Platform,
                    "platform-batch".to_string(),
                    SyncOperation::Create,
                    "evt-platform-create".to_string(),
                    "2026-02-17T00:00:01Z".to_string(),
                    11,
                    serde_json::json!({
                        "id": "platform-batch",
                        "name": "Batch Platform",
                        "url": "https://batch.example",
                        "external_id": serde_json::Value::Null,
                        "kind": "BROKERAGE",
                        "website_url": serde_json::Value::Null,
                        "logo_url": serde_json::Value::Null
                    }),
                ),
            ])
            .await
            .expect("apply replay batch");

        assert_eq!(applied, 2, "both events should apply in one batch");
        assert_eq!(count_account_rows(&pool, "acc-batch-platform"), 1);
        assert_eq!(count_platform_rows(&pool, "platform-batch"), 1);

        let mut conn = get_connection(&pool).expect("conn");
        let account_platform_id: Option<String> = accounts::table
            .filter(accounts::id.eq("acc-batch-platform"))
            .select(accounts::platform_id)
            .first(&mut conn)
            .expect("account row");
        assert_eq!(account_platform_id.as_deref(), Some("platform-batch"));
    }

    #[tokio::test]
    async fn snapshot_export_returns_sqlite_image() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-export").expect("insert account");

        let payload = repo
            .export_snapshot_sqlite_image(vec!["accounts".to_string()])
            .await
            .expect("export snapshot");
        assert!(
            payload.starts_with(b"SQLite format 3\0"),
            "expected exported payload to be sqlite image"
        );
    }

    #[tokio::test]
    async fn snapshot_export_filters_broker_snapshots_and_manual_quotes() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-export-filter").expect("insert account");
        diesel::sql_query(
            "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, provider_config, created_at, updated_at)
             VALUES ('asset-export-filter', 'INVESTMENT', 'Export Asset', 'EXPA', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .execute(&mut conn)
        .expect("insert asset");

        diesel::sql_query(format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source)
             VALUES
             ('11111111-1111-4111-8111-111111111111', 'acc-export-filter', '2026-01-01', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY'),
             ('22222222-2222-4222-8222-222222222222', 'acc-export-filter', '2026-01-02', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-02T00:00:00Z', '0', '0', '0', 'BROKER_IMPORTED'),
             ('33333333-3333-4333-8333-333333333333', 'acc-export-filter', '2026-01-03', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-03T00:00:00Z', '0', '0', '0', 'CALCULATED'),
             ('66666666-6666-4666-8666-666666666666', '{}', '2026-01-04', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-04T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
            escape_sqlite_str("orphan-export-filter")
        ))
        .execute(&mut conn)
        .expect("insert snapshots");

        diesel::sql_query(
            "INSERT INTO quotes (id, asset_id, day, source, open, high, low, close, adjclose, volume, currency, notes, created_at, timestamp)
             VALUES
             ('44444444-4444-4444-8444-444444444444', 'asset-export-filter', '2026-01-01', 'MANUAL', NULL, NULL, NULL, '100', NULL, NULL, 'USD', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
             ('55555555-5555-4555-8555-555555555555', 'asset-export-filter', '2026-01-02', 'YAHOO', NULL, NULL, NULL, '101', NULL, NULL, 'USD', NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
        )
        .execute(&mut conn)
        .expect("insert quotes");

        let payload = repo
            .export_snapshot_sqlite_image(vec![
                "holdings_snapshots".to_string(),
                "quotes".to_string(),
            ])
            .await
            .expect("export snapshot with filters");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");
        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");

        let snapshot_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM holdings_snapshots")
                .get_result(&mut exported_conn)
                .expect("count snapshot rows");
        assert_eq!(
            snapshot_count.c, 1,
            "manual snapshots should export; broker snapshots stay local"
        );

        let broker_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE source = 'BROKER_IMPORTED'",
        )
        .get_result(&mut exported_conn)
        .expect("count broker snapshots");
        assert_eq!(broker_count.c, 0, "broker snapshots should not export");

        let calculated_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM holdings_snapshots WHERE source = 'CALCULATED'",
        )
        .get_result(&mut exported_conn)
        .expect("count calculated snapshots");
        assert_eq!(
            calculated_count.c, 0,
            "calculated snapshots should not export"
        );

        let quote_count: CountRow = diesel::sql_query("SELECT COUNT(*) AS c FROM quotes")
            .get_result(&mut exported_conn)
            .expect("count quote rows");
        assert_eq!(quote_count.c, 1, "manual quotes only should export");

        let provider_quote_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM quotes WHERE source != 'MANUAL'")
                .get_result(&mut exported_conn)
                .expect("count provider quote rows");
        assert_eq!(
            provider_quote_count.c, 0,
            "provider quotes should not export"
        );
    }

    #[tokio::test]
    async fn snapshot_export_skips_orphan_portfolio_accounts() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-export-portfolio").expect("insert account");
        insert_portfolio_for_test(&mut conn, "portfolio-export", "Export Portfolio")
            .expect("insert portfolio");
        insert_portfolio_account_for_test(
            &mut conn,
            "membership-export-valid",
            "portfolio-export",
            "acc-export-portfolio",
            0,
        )
        .expect("insert valid membership");
        insert_orphan_portfolio_account_for_test(
            &mut conn,
            "membership-export-orphan",
            "portfolio-export",
            "acc-export-missing",
        );
        drop(conn);

        let payload = repo
            .export_snapshot_sqlite_image(vec!["portfolio_accounts".to_string()])
            .await
            .expect("export portfolio memberships");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("portfolio-accounts-snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");
        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");

        let membership_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM portfolio_accounts")
                .get_result(&mut exported_conn)
                .expect("count memberships");
        assert_eq!(membership_count.c, 1);

        let orphan_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM portfolio_accounts WHERE id = 'membership-export-orphan'",
        )
        .get_result(&mut exported_conn)
        .expect("count orphan membership");
        assert_eq!(orphan_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_export_filters_activity_sidecars_to_user_syncable_activities() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-activity-sidecar").expect("insert account");
        insert_broker_import_run_for_test(
            &mut conn,
            "broker-import-sidecar",
            "acc-activity-sidecar",
        )
        .expect("insert broker import run");
        insert_activity_for_snapshot_filter_test(
            &mut conn,
            "manual-activity-sidecar",
            "acc-activity-sidecar",
            "MANUAL",
            None,
            None,
            0,
        )
        .expect("insert manual activity");
        insert_activity_for_snapshot_filter_test(
            &mut conn,
            "broker-activity-sidecar",
            "acc-activity-sidecar",
            "SNAPTRADE",
            Some("broker-import-sidecar"),
            Some("broker-record-sidecar"),
            1,
        )
        .expect("insert user-modified broker activity");
        insert_spending_event_for_snapshot_filter_test(&mut conn, "event-sidecar")
            .expect("insert event");
        insert_activity_sidecars_for_snapshot_filter_test(
            &mut conn,
            "manual-activity-sidecar",
            "manual-sidecar",
            "event-sidecar",
        )
        .expect("insert manual sidecars");
        insert_activity_sidecars_for_snapshot_filter_test(
            &mut conn,
            "broker-activity-sidecar",
            "broker-sidecar",
            "event-sidecar",
        )
        .expect("insert broker sidecars");
        drop(conn);

        let payload = repo
            .export_snapshot_sqlite_image(vec![
                "activities".to_string(),
                "spending_event_types".to_string(),
                "spending_events".to_string(),
                "activity_taxonomy_assignments".to_string(),
                "spending_activity_events".to_string(),
            ])
            .await
            .expect("export activity sidecar snapshot");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("activity-sidecars-snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");
        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");

        let activity_count: CountRow = diesel::sql_query("SELECT COUNT(*) AS c FROM activities")
            .get_result(&mut exported_conn)
            .expect("count activities");
        assert_eq!(activity_count.c, 1);

        let broker_activity_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM activities WHERE id = 'broker-activity-sidecar'",
        )
        .get_result(&mut exported_conn)
        .expect("count broker activity");
        assert_eq!(broker_activity_count.c, 0);

        let assignment_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM activity_taxonomy_assignments")
                .get_result(&mut exported_conn)
                .expect("count activity assignments");
        assert_eq!(assignment_count.c, 1);

        let broker_assignment_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM activity_taxonomy_assignments WHERE activity_id = 'broker-activity-sidecar'",
        )
        .get_result(&mut exported_conn)
        .expect("count broker activity assignment");
        assert_eq!(broker_assignment_count.c, 0);

        let event_tag_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM spending_activity_events")
                .get_result(&mut exported_conn)
                .expect("count activity event tags");
        assert_eq!(event_tag_count.c, 1);

        let broker_event_tag_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM spending_activity_events WHERE activity_id = 'broker-activity-sidecar'",
        )
        .get_result(&mut exported_conn)
        .expect("count broker activity event tag");
        assert_eq!(broker_event_tag_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_upload_validation_fails_with_portfolio_repair_message() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_portfolio_for_test(&mut conn, "portfolio-upload", "Retirement")
            .expect("insert portfolio");
        insert_orphan_portfolio_account_for_test(
            &mut conn,
            "membership-upload-orphan",
            "portfolio-upload",
            "acc-upload-missing",
        );
        drop(conn);

        let err = repo
            .validate_snapshot_upload_integrity(vec!["portfolio_accounts".to_string()])
            .await
            .expect_err("upload validation should fail");
        let message = err.to_string();

        assert!(
            message.contains("Portfolio \"Retirement\" contains a deleted account link"),
            "{message}"
        );
        assert!(message.contains("Settings > Portfolios"), "{message}");
        assert!(message.contains("acc-upload-missing"), "{message}");
    }

    #[tokio::test]
    async fn snapshot_upload_validation_ignores_missing_portfolio_memberships() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-upload-existing").expect("insert account");
        insert_missing_portfolio_account_for_test(
            &mut conn,
            "membership-upload-missing-portfolio",
            "portfolio-upload-missing",
            "acc-upload-existing",
        );
        drop(conn);

        repo.validate_snapshot_upload_integrity(vec!["portfolio_accounts".to_string()])
            .await
            .expect("missing portfolio membership should be skipped by snapshot upload validation");
    }

    #[tokio::test]
    async fn snapshot_export_keeps_csv_import_parent_and_excludes_broker_rows() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }
        #[derive(diesel::QueryableByName)]
        struct ImportRunIdRow {
            #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
            import_run_id: Option<String>,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-activity-broker-parent").expect("insert account");
        conn.batch_execute(
            "INSERT INTO import_runs
             (id, account_id, source_system, run_type, mode, status, started_at, finished_at,
              review_mode, applied_at, checkpoint_in, checkpoint_out, summary, warnings, error, created_at, updated_at)
             VALUES
             ('run-csv-parent', 'acc-activity-broker-parent', 'CSV', 'IMPORT',
              'INCREMENTAL', 'APPLIED', '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z',
              'NEVER', '2026-02-12T00:01:00Z', NULL, NULL, NULL, NULL, NULL,
              '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z'),
             ('run-broker-parent', 'acc-activity-broker-parent', 'SNAPTRADE', 'SYNC',
              'INCREMENTAL', 'APPLIED', '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z',
              'NEVER', '2026-02-12T00:01:00Z', NULL, NULL, NULL, NULL, NULL,
              '2026-02-12T00:00:00Z', '2026-02-12T00:01:00Z');
             INSERT INTO activities
             (id, account_id, asset_id, activity_type, activity_type_override, source_type, subtype, status,
              activity_date, settlement_date, quantity, unit_price, amount, fee, currency, fx_rate, notes, metadata,
              source_system, source_record_id, source_group_id, idempotency_key, import_run_id, is_user_modified,
              needs_review, created_at, updated_at)
             VALUES
             ('activity-csv-imported', 'acc-activity-broker-parent', NULL, 'DEPOSIT',
              NULL, NULL, NULL, 'COMPLETED', '2026-02-12', NULL, NULL, NULL, '100.00',
              NULL, 'USD', NULL, NULL, NULL, 'CSV', 'csv-row-1', NULL, NULL,
              'run-csv-parent', 0, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z'),
             ('activity-broker-modified', 'acc-activity-broker-parent', NULL, 'DEPOSIT',
              NULL, NULL, NULL, 'COMPLETED', '2026-02-12', NULL, NULL, NULL, '100.00',
              NULL, 'USD', NULL, NULL, NULL, 'SNAPTRADE', 'broker-row-1', NULL, NULL,
              'run-broker-parent', 1, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
        )
        .expect("insert csv and broker activities");

        let payload = repo
            .export_snapshot_sqlite_image(vec![
                "accounts".to_string(),
                "import_runs".to_string(),
                "activities".to_string(),
            ])
            .await
            .expect("export snapshot");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");

        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");
        let exported_run_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM import_runs")
                .get_result(&mut exported_conn)
                .expect("count exported import runs");
        assert_eq!(exported_run_count.c, 1);
        let exported_activity_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM activities")
                .get_result(&mut exported_conn)
                .expect("count exported activities");
        assert_eq!(exported_activity_count.c, 1);
        let exported_activity: ImportRunIdRow = diesel::sql_query(
            "SELECT import_run_id FROM activities WHERE id = 'activity-csv-imported'",
        )
        .get_result(&mut exported_conn)
        .expect("load exported activity");
        assert_eq!(
            exported_activity.import_run_id.as_deref(),
            Some("run-csv-parent")
        );
        let exported_broker_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM import_runs WHERE id = 'run-broker-parent'
             UNION ALL
             SELECT COUNT(*) AS c FROM activities WHERE id = 'activity-broker-modified'",
        )
        .get_results::<CountRow>(&mut exported_conn)
        .expect("count exported broker rows")
        .into_iter()
        .fold(CountRow { c: 0 }, |mut acc, row| {
            acc.c += row.c;
            acc
        });
        assert_eq!(exported_broker_count.c, 0);
        drop(exported_conn);

        let (restore_pool, restore_writer) = setup_db();
        let restore_repo = AppSyncRepository::new(restore_pool.clone(), restore_writer);
        restore_repo
            .restore_snapshot_tables_from_file(
                exported_path.to_string_lossy().to_string(),
                vec![
                    "activities".to_string(),
                    "import_runs".to_string(),
                    "accounts".to_string(),
                ],
                203,
                "device-activity-broker-parent".to_string(),
                Some(1),
            )
            .await
            .expect("restore snapshot");

        let mut restore_conn = get_connection(&restore_pool).expect("conn");
        let restored_activity: ImportRunIdRow = diesel::sql_query(
            "SELECT import_run_id FROM activities WHERE id = 'activity-csv-imported'",
        )
        .get_result(&mut restore_conn)
        .expect("load restored activity");
        assert_eq!(
            restored_activity.import_run_id.as_deref(),
            Some("run-csv-parent")
        );
        let restored_run_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM import_runs WHERE id = 'run-csv-parent'")
                .get_result(&mut restore_conn)
                .expect("count restored import run");
        assert_eq!(restored_run_count.c, 1);
        let restored_broker_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM import_runs WHERE id = 'run-broker-parent'
             UNION ALL
             SELECT COUNT(*) AS c FROM activities WHERE id = 'activity-broker-modified'",
        )
        .get_results::<CountRow>(&mut restore_conn)
        .expect("count restored broker rows")
        .into_iter()
        .fold(CountRow { c: 0 }, |mut acc, row| {
            acc.c += row.c;
            acc
        });
        assert_eq!(restored_broker_count.c, 0);
    }

    #[tokio::test]
    async fn snapshot_export_restores_allocation_weights_for_custom_taxonomy() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        conn.batch_execute(
            "INSERT INTO taxonomies
             (id, name, color, description, is_system, is_single_select, sort_order, created_at, updated_at, scope)
             VALUES ('taxonomy-allocation-custom', 'Allocation Custom', '#000000', NULL, 0, 0, 0,
                     '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z', 'asset');
             INSERT INTO taxonomy_categories
             (id, taxonomy_id, parent_id, name, key, color, description, sort_order, created_at, updated_at, icon)
             VALUES ('category-allocation-custom', 'taxonomy-allocation-custom', NULL, 'Growth', 'growth',
                     '#000000', NULL, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z', NULL);
             INSERT INTO allocation_targets
             (id, name, scope_type, scope_id, taxonomy_id, trigger_type, drift_band_bps, rebalance_goal,
              min_trade_amount, whole_shares_only, allow_sells, created_at, updated_at, archived_at)
             VALUES ('target-allocation-custom', 'Custom Allocation', 'all', NULL, 'taxonomy-allocation-custom',
                     'threshold', 500, 'nearest_band', '0', 0, 0,
                     '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z', NULL);
             INSERT INTO allocation_target_weights
             (id, target_id, taxonomy_id, category_id, target_bps, is_locked, is_required, created_at, updated_at)
             VALUES ('weight-allocation-custom', 'target-allocation-custom', 'taxonomy-allocation-custom',
                     'category-allocation-custom', 10000, 0, 1,
                     '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
        )
        .expect("insert allocation target with custom taxonomy");

        let payload = repo
            .export_snapshot_sqlite_image(vec![
                "taxonomies".to_string(),
                "taxonomy_categories".to_string(),
                "allocation_targets".to_string(),
                "allocation_target_weights".to_string(),
            ])
            .await
            .expect("export snapshot");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");

        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");
        let exported_category_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c
             FROM taxonomy_categories
             WHERE taxonomy_id = 'taxonomy-allocation-custom'
               AND id = 'category-allocation-custom'",
        )
        .get_result(&mut exported_conn)
        .expect("count exported custom taxonomy category");
        assert_eq!(exported_category_count.c, 1);
        drop(exported_conn);

        let (restore_pool, restore_writer) = setup_db();
        let restore_repo = AppSyncRepository::new(restore_pool.clone(), restore_writer);
        restore_repo
            .restore_snapshot_tables_from_file(
                exported_path.to_string_lossy().to_string(),
                vec![
                    "allocation_target_weights".to_string(),
                    "allocation_targets".to_string(),
                    "taxonomy_categories".to_string(),
                    "taxonomies".to_string(),
                ],
                202,
                "device-allocation-custom".to_string(),
                Some(1),
            )
            .await
            .expect("restore allocation snapshot");

        let mut restore_conn = get_connection(&restore_pool).expect("conn");
        let weight_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c
             FROM allocation_target_weights
             WHERE id = 'weight-allocation-custom'",
        )
        .get_result(&mut restore_conn)
        .expect("count restored allocation weight");
        assert_eq!(weight_count.c, 1);
    }

    #[tokio::test]
    async fn snapshot_restore_skips_budget_rows_with_missing_category_dependencies() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        conn.batch_execute(
            "INSERT INTO taxonomy_categories
             (id, taxonomy_id, parent_id, name, key, color, description, sort_order, created_at, updated_at, icon)
             VALUES
             ('cat_future_budget', 'spending_categories', NULL, 'Future Budget Seed', 'future_budget_seed',
              '#000000', NULL, 501, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z', NULL),
             ('budget-category-custom', 'spending_categories', NULL, 'Custom Budget Category', 'custom_budget_category',
              '#000000', NULL, 502, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z', NULL);
             INSERT INTO budget_groups
             (id, name, key, color, icon, sort_order, is_system, created_at, updated_at)
             VALUES
             ('budget-group-custom', 'Custom Budget Group', 'custom-budget-group',
              '#000000', NULL, 502, 0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z');
             INSERT INTO budget_group_assignments
             (id, group_id, taxonomy_id, category_id, is_system, created_at, updated_at)
             VALUES
             ('budget-assignment-future', 'budget-group-custom', 'spending_categories', 'cat_future_budget',
              1, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z'),
             ('budget-assignment-custom', 'budget-group-custom', 'spending_categories', 'budget-category-custom',
              0, '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z');
             INSERT INTO budget_targets
             (id, period_key, target_type, taxonomy_id, category_id, group_id, amount, created_at, updated_at)
             VALUES
             ('budget-target-future', 'default', 'category', 'spending_categories', 'cat_future_budget',
              NULL, '100', '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z'),
             ('budget-target-custom', 'default', 'category', 'spending_categories', 'budget-category-custom',
              NULL, '100', '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z');
             INSERT INTO budget_rollover_settings
             (id, target_type, taxonomy_id, category_id, group_id, enabled, start_month, starting_balance, created_at, updated_at)
             VALUES
             ('budget-rollover-future', 'category', 'spending_categories', 'cat_future_budget',
              NULL, 1, '2026-01', '0', '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z'),
             ('budget-rollover-custom', 'category', 'spending_categories', 'budget-category-custom',
              NULL, 1, '2026-01', '0', '2026-02-12T00:00:00Z', '2026-02-12T00:00:00Z')",
        )
        .expect("insert budget dependency rows");

        let payload = repo
            .export_snapshot_sqlite_image(vec![
                "budget_groups".to_string(),
                "taxonomy_categories".to_string(),
                "budget_group_assignments".to_string(),
                "budget_targets".to_string(),
                "budget_rollover_settings".to_string(),
            ])
            .await
            .expect("export budget snapshot");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("budget-snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");

        let (restore_pool, restore_writer) = setup_db();
        let restore_repo = AppSyncRepository::new(restore_pool.clone(), restore_writer);
        restore_repo
            .restore_snapshot_tables_from_file(
                exported_path.to_string_lossy().to_string(),
                vec![
                    "budget_group_assignments".to_string(),
                    "budget_targets".to_string(),
                    "budget_rollover_settings".to_string(),
                    "taxonomy_categories".to_string(),
                    "budget_groups".to_string(),
                ],
                204,
                "device-budget-dependencies".to_string(),
                Some(1),
            )
            .await
            .expect("restore budget snapshot");

        let mut restore_conn = get_connection(&restore_pool).expect("conn");
        let custom_assignment_count: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c
             FROM budget_group_assignments
             WHERE id = 'budget-assignment-custom'",
        )
        .get_result(&mut restore_conn)
        .expect("count custom budget assignment");
        assert_eq!(custom_assignment_count.c, 1);

        let missing_dependency_rows: CountRow = diesel::sql_query(
            "SELECT COUNT(*) AS c FROM budget_group_assignments WHERE id = 'budget-assignment-future'
             UNION ALL
             SELECT COUNT(*) AS c FROM budget_targets WHERE id = 'budget-target-future'
             UNION ALL
             SELECT COUNT(*) AS c FROM budget_rollover_settings WHERE id = 'budget-rollover-future'",
        )
        .get_results::<CountRow>(&mut restore_conn)
        .expect("count skipped budget rows")
        .into_iter()
        .fold(CountRow { c: 0 }, |mut acc, row| {
            acc.c += row.c;
            acc
        });
        assert_eq!(missing_dependency_rows.c, 0);
    }

    #[tokio::test]
    async fn snapshot_export_only_includes_spending_settings() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        diesel::replace_into(app_settings::table)
            .values(vec![
                (
                    app_settings::setting_key.eq("spending.enabled"),
                    app_settings::setting_value.eq("true"),
                ),
                (
                    app_settings::setting_key.eq("spending.account_ids"),
                    app_settings::setting_value.eq("[\"acc-1\"]"),
                ),
                (
                    app_settings::setting_key.eq("theme"),
                    app_settings::setting_value.eq("dark"),
                ),
            ])
            .execute(&mut conn)
            .expect("insert app settings");

        let payload = repo
            .export_snapshot_sqlite_image(vec!["app_settings".to_string()])
            .await
            .expect("export app_settings");

        let exported_dir = tempdir().expect("tempdir");
        let exported_path = exported_dir.path().join("settings-snapshot.db");
        std::fs::write(&exported_path, payload).expect("write snapshot db");
        let mut exported_conn =
            SqliteConnection::establish(exported_path.to_string_lossy().as_ref())
                .expect("open snapshot db");

        let settings_count: CountRow = diesel::sql_query("SELECT COUNT(*) AS c FROM app_settings")
            .get_result(&mut exported_conn)
            .expect("count settings");
        assert_eq!(settings_count.c, 2);

        let theme_count: CountRow =
            diesel::sql_query("SELECT COUNT(*) AS c FROM app_settings WHERE setting_key = 'theme'")
                .get_result(&mut exported_conn)
                .expect("count theme setting");
        assert_eq!(theme_count.c, 0);
    }

    #[test]
    fn quote_identifier_escapes_backticks() {
        assert_eq!(quote_identifier("col`name"), "`col``name`");
    }

    #[test]
    fn escape_sqlite_str_escapes_single_quotes() {
        assert_eq!(escape_sqlite_str("O'Brien"), "O''Brien");
    }

    #[test]
    fn json_value_to_sql_literal_handles_injection_attempt() {
        let malicious = serde_json::Value::String("'; DROP TABLE accounts; --".to_string());
        let sql = json_value_to_sql_literal(&malicious);
        assert_eq!(sql, "'''; DROP TABLE accounts; --'");
    }

    #[tokio::test]
    async fn replay_rejects_unknown_columns() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let result = repo
            .apply_remote_event_lww(
                SyncEntity::Account,
                "acc-unknown-col".to_string(),
                SyncOperation::Create,
                "evt-unk-col".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "acc-unknown-col",
                    "nonexistent_column": "value"
                }),
            )
            .await;

        assert!(result.is_err(), "expected unknown column to be rejected");
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("nonexistent_column"),
            "error should mention the bad column: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn replay_spending_setting_skips_non_spending_keys() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingSetting,
                "spending.enabled".to_string(),
                SyncOperation::Update,
                "evt-spending-setting".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "settingKey": "spending.enabled",
                    "settingValue": "true"
                }),
            )
            .await
            .expect("apply spending setting");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let value = app_settings::table
            .filter(app_settings::setting_key.eq("spending.enabled"))
            .select(app_settings::setting_value)
            .first::<String>(&mut conn)
            .expect("spending setting value");
        assert_eq!(value, "true");

        let skipped = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingSetting,
                "theme".to_string(),
                SyncOperation::Update,
                "evt-theme-setting".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "settingKey": "theme",
                    "settingValue": "dark"
                }),
            )
            .await
            .expect("unsupported app setting should be skipped, not fatal");
        assert!(
            !skipped,
            "unsupported app setting should not apply an entity change"
        );

        let applied_event_count: i64 = sync_applied_events::table
            .filter(sync_applied_events::event_id.eq("evt-theme-setting"))
            .count()
            .get_result(&mut conn)
            .expect("applied event count");
        assert_eq!(applied_event_count, 1);

        let theme_count: i64 = app_settings::table
            .filter(app_settings::setting_key.eq("theme"))
            .count()
            .get_result(&mut conn)
            .expect("theme setting count");
        assert_eq!(theme_count, 0);
    }

    #[tokio::test]
    async fn replay_spending_preset_rule_deletion_applies_and_deletes() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let entity_id = preset_rule_deletion_id("ca", "groceries");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                entity_id.clone(),
                SyncOperation::Update,
                "evt-preset-rule-deletion-upsert".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries",
                    "ruleId": "rule-ca-groceries",
                    "deletedAt": "2026-02-15T00:00:00Z"
                }),
            )
            .await
            .expect("apply preset rule deletion");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let tombstone_count: i64 = spending_preset_rule_deletions::table
            .filter(spending_preset_rule_deletions::preset_id.eq("ca"))
            .filter(spending_preset_rule_deletions::preset_rule_key.eq("groceries"))
            .count()
            .get_result(&mut conn)
            .expect("count preset deletion");
        assert_eq!(tombstone_count, 1);
        drop(conn);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                entity_id,
                SyncOperation::Delete,
                "evt-preset-rule-deletion-delete".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries"
                }),
            )
            .await
            .expect("delete preset rule deletion");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let tombstone_count: i64 = spending_preset_rule_deletions::table
            .filter(spending_preset_rule_deletions::preset_id.eq("ca"))
            .filter(spending_preset_rule_deletions::preset_rule_key.eq("groceries"))
            .count()
            .get_result(&mut conn)
            .expect("count preset deletion");
        assert_eq!(tombstone_count, 0);
    }

    #[tokio::test]
    async fn replay_spending_preset_rule_deletion_recreates_after_delete() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let entity_id = preset_rule_deletion_id("ca", "groceries");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                entity_id.clone(),
                SyncOperation::Update,
                "evt-preset-rule-deletion-upsert".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries",
                    "ruleId": "rule-ca-groceries",
                    "deletedAt": "2026-02-15T00:00:00Z"
                }),
            )
            .await
            .expect("apply preset rule deletion");
        assert!(applied);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                entity_id.clone(),
                SyncOperation::Delete,
                "evt-preset-rule-deletion-delete".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries"
                }),
            )
            .await
            .expect("delete preset rule deletion");
        assert!(applied);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                entity_id,
                SyncOperation::Update,
                "evt-preset-rule-deletion-recreate".to_string(),
                "2026-02-15T00:00:02Z".to_string(),
                3,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries",
                    "ruleId": "rule-ca-groceries",
                    "deletedAt": "2026-02-15T00:00:02Z"
                }),
            )
            .await
            .expect("recreate preset rule deletion");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let tombstone_count: i64 = spending_preset_rule_deletions::table
            .filter(spending_preset_rule_deletions::preset_id.eq("ca"))
            .filter(spending_preset_rule_deletions::preset_rule_key.eq("groceries"))
            .count()
            .get_result(&mut conn)
            .expect("count preset deletion");
        assert_eq!(tombstone_count, 1);
    }

    #[tokio::test]
    async fn replay_spending_preset_rule_deletion_rejects_mismatched_entity_id() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let err = repo
            .apply_remote_event_lww(
                SyncEntity::SpendingPresetRuleDeletion,
                "wrong-entity-id".to_string(),
                SyncOperation::Update,
                "evt-preset-rule-deletion-mismatch".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "presetId": "ca",
                    "presetRuleKey": "groceries",
                    "ruleId": "rule-ca-groceries",
                    "deletedAt": "2026-02-15T00:00:00Z"
                }),
            )
            .await
            .expect_err("mismatched entity id should fail replay");

        assert!(err.to_string().contains("does not match payload key"));

        let mut conn = get_connection(&pool).expect("conn");
        let tombstone_count: i64 = spending_preset_rule_deletions::table
            .count()
            .get_result(&mut conn)
            .expect("count preset deletion");
        assert_eq!(tombstone_count, 0);
    }

    #[tokio::test]
    async fn replay_addon_storage_applies_and_deletes() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let entity_id = addon_storage_id("addon-a", "prefs");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id.clone(),
                SyncOperation::Update,
                "evt-addon-storage-upsert".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "addonId": "addon-a",
                    "key": "prefs",
                    "value": "v1"
                }),
            )
            .await
            .expect("apply addon storage upsert");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let value: Option<String> = addon_storage::table
            .filter(addon_storage::addon_id.eq("addon-a"))
            .filter(addon_storage::key.eq("prefs"))
            .select(addon_storage::value)
            .first::<String>(&mut conn)
            .optional()
            .expect("query addon storage");
        assert_eq!(value.as_deref(), Some("v1"));
        drop(conn);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id,
                SyncOperation::Delete,
                "evt-addon-storage-delete".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                2,
                serde_json::json!({
                    "addonId": "addon-a",
                    "key": "prefs"
                }),
            )
            .await
            .expect("apply addon storage delete");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let count: i64 = addon_storage::table
            .filter(addon_storage::addon_id.eq("addon-a"))
            .filter(addon_storage::key.eq("prefs"))
            .count()
            .get_result(&mut conn)
            .expect("count addon storage");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn replay_addon_storage_stale_delete_does_not_clobber_newer_value() {
        // A delete is just another write for a reusable key: an older delete must
        // NOT wipe a newer value. (Under the old tombstone logic a delete always
        // won over a prior non-delete regardless of timestamp.)
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let entity_id = addon_storage_id("addon-a", "prefs");

        assert!(repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id.clone(),
                SyncOperation::Update,
                "evt-update-new".to_string(),
                "2026-02-15T00:00:05Z".to_string(),
                1,
                serde_json::json!({ "addonId": "addon-a", "key": "prefs", "value": "v2" }),
            )
            .await
            .expect("apply newer update"));

        // Older delete arrives after the newer update — must be rejected by LWW.
        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id,
                SyncOperation::Delete,
                "evt-delete-stale".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                2,
                serde_json::json!({ "addonId": "addon-a", "key": "prefs" }),
            )
            .await
            .expect("apply stale delete");
        assert!(!applied, "a stale delete must not be applied");

        let mut conn = get_connection(&pool).expect("conn");
        let value: Option<String> = addon_storage::table
            .filter(addon_storage::addon_id.eq("addon-a"))
            .filter(addon_storage::key.eq("prefs"))
            .select(addon_storage::value)
            .first::<String>(&mut conn)
            .optional()
            .expect("query addon storage");
        assert_eq!(
            value.as_deref(),
            Some("v2"),
            "newer value must survive a stale delete"
        );
    }

    #[tokio::test]
    async fn replay_addon_storage_newer_update_after_older_delete_reapplies() {
        // A deleted key can be legitimately re-created: a newer update after an
        // older delete must apply. (Under the old tombstone logic, once last_op
        // was Delete, every later create/update was permanently swallowed.)
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let entity_id = addon_storage_id("addon-a", "prefs");

        assert!(repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id.clone(),
                SyncOperation::Delete,
                "evt-delete-old".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                1,
                serde_json::json!({ "addonId": "addon-a", "key": "prefs" }),
            )
            .await
            .expect("apply older delete"));

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                entity_id,
                SyncOperation::Update,
                "evt-update-newer".to_string(),
                "2026-02-15T00:00:05Z".to_string(),
                2,
                serde_json::json!({ "addonId": "addon-a", "key": "prefs", "value": "v3" }),
            )
            .await
            .expect("apply newer update");
        assert!(
            applied,
            "a newer update after an older delete must be applied"
        );

        let mut conn = get_connection(&pool).expect("conn");
        let value: Option<String> = addon_storage::table
            .filter(addon_storage::addon_id.eq("addon-a"))
            .filter(addon_storage::key.eq("prefs"))
            .select(addon_storage::value)
            .first::<String>(&mut conn)
            .optional()
            .expect("query addon storage");
        assert_eq!(
            value.as_deref(),
            Some("v3"),
            "re-created key must hold the newer value"
        );
    }

    #[tokio::test]
    async fn replay_addon_storage_rejects_mismatched_entity_id() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let err = repo
            .apply_remote_event_lww(
                SyncEntity::AddonStorage,
                "wrong-entity-id".to_string(),
                SyncOperation::Update,
                "evt-addon-storage-mismatch".to_string(),
                "2026-02-15T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "addonId": "addon-a",
                    "key": "prefs",
                    "value": "v1"
                }),
            )
            .await
            .expect_err("mismatched entity id should fail replay");

        assert!(err.to_string().contains("does not match payload key"));

        let mut conn = get_connection(&pool).expect("conn");
        let count: i64 = addon_storage::table
            .count()
            .get_result(&mut conn)
            .expect("count addon storage");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn replay_batch_skips_unsupported_spending_setting_without_aborting() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_events_lww_batch(vec![
                (
                    SyncEntity::SpendingSetting,
                    "theme".to_string(),
                    SyncOperation::Update,
                    "evt-theme-setting-batch".to_string(),
                    "2026-02-15T00:00:00Z".to_string(),
                    1,
                    serde_json::json!({
                        "settingKey": "theme",
                        "settingValue": "dark"
                    }),
                ),
                (
                    SyncEntity::SpendingSetting,
                    "spending.enabled".to_string(),
                    SyncOperation::Update,
                    "evt-spending-setting-batch".to_string(),
                    "2026-02-15T00:00:01Z".to_string(),
                    2,
                    serde_json::json!({
                        "settingKey": "spending.enabled",
                        "settingValue": "true"
                    }),
                ),
            ])
            .await
            .expect("batch should not abort on unsupported app setting");

        assert_eq!(applied, 1);

        let mut conn = get_connection(&pool).expect("conn");
        let applied_event_count: i64 = sync_applied_events::table
            .filter(
                sync_applied_events::event_id
                    .eq_any(["evt-theme-setting-batch", "evt-spending-setting-batch"]),
            )
            .count()
            .get_result(&mut conn)
            .expect("applied event count");
        assert_eq!(applied_event_count, 2);

        let value = app_settings::table
            .filter(app_settings::setting_key.eq("spending.enabled"))
            .select(app_settings::setting_value)
            .first::<String>(&mut conn)
            .expect("spending setting value");
        assert_eq!(value, "true");
    }

    #[tokio::test]
    async fn replay_budget_target_rejects_invalid_decimal_amount() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let err = repo
            .apply_remote_event_lww(
                SyncEntity::BudgetTarget,
                "target-invalid".to_string(),
                SyncOperation::Create,
                "evt-budget-target-invalid".to_string(),
                "2026-02-15T00:00:01Z".to_string(),
                1,
                serde_json::json!({
                    "id": "target-invalid",
                    "periodKey": "2026-05",
                    "targetType": "category",
                    "taxonomyId": "spending_categories",
                    "categoryId": "cat_food",
                    "groupId": null,
                    "amount": "bad",
                    "createdAt": "2026-02-15T00:00:01Z",
                    "updatedAt": "2026-02-15T00:00:01Z"
                }),
            )
            .await
            .expect_err("invalid decimal should fail replay");

        assert!(err.to_string().contains("valid decimal"));
    }

    #[tokio::test]
    async fn replay_rejects_conflicting_alias_columns() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool, writer);

        let result = repo
            .apply_remote_event_lww(
                SyncEntity::Goal,
                "goal-conflict".to_string(),
                SyncOperation::Create,
                "evt-goal-conflict".to_string(),
                "2026-02-19T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "goal-conflict",
                    "title": "Conflicting Goal",
                    "description": serde_json::Value::Null,
                    "targetAmount": 10.0,
                    "statusLifecycle": "active",
                    "status_lifecycle": "archived"
                }),
            )
            .await;

        assert!(
            result.is_err(),
            "expected conflicting aliases to be rejected"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("multiple values"),
            "error should mention conflicting alias values: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn replay_custom_taxonomy_create_upserts_taxonomy_and_categories() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::CustomTaxonomy,
                "tax-custom-1".to_string(),
                SyncOperation::Create,
                "evt-tax-create".to_string(),
                "2026-03-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "taxonomy": {
                        "id": "tax-custom-1",
                        "name": "My Sectors",
                        "color": "#ff0000",
                        "description": null,
                        "isSystem": 0,
                        "isSingleSelect": 0,
                        "sortOrder": 99,
                        "createdAt": "2026-03-01T00:00:00+00:00",
                        "updatedAt": "2026-03-01T00:00:00+00:00"
                    },
                    "categories": [
                        {
                            "id": "cat-a",
                            "taxonomyId": "tax-custom-1",
                            "parentId": null,
                            "name": "Tech",
                            "key": "tech",
                            "color": "#00ff00",
                            "description": null,
                            "sortOrder": 1,
                            "createdAt": "2026-03-01T00:00:00+00:00",
                            "updatedAt": "2026-03-01T00:00:00+00:00"
                        },
                        {
                            "id": "cat-b",
                            "taxonomyId": "tax-custom-1",
                            "parentId": null,
                            "name": "Finance",
                            "key": "finance",
                            "color": "#0000ff",
                            "description": "Financial sector",
                            "sortOrder": 2,
                            "createdAt": "2026-03-01T00:00:00+00:00",
                            "updatedAt": "2026-03-01T00:00:00+00:00"
                        }
                    ]
                }),
            )
            .await
            .expect("apply custom taxonomy create");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");
        let tax_name: String = taxonomies::table
            .find("tax-custom-1")
            .select(taxonomies::name)
            .first(&mut conn)
            .expect("taxonomy row");
        assert_eq!(tax_name, "My Sectors");

        let cat_count: i64 = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq("tax-custom-1"))
            .select(count_star())
            .first(&mut conn)
            .expect("category count");
        assert_eq!(cat_count, 2);
    }

    #[tokio::test]
    async fn replay_custom_taxonomy_update_adds_and_removes_categories() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        // First: create with two categories
        repo.apply_remote_event_lww(
            SyncEntity::CustomTaxonomy,
            "tax-upd-1".to_string(),
            SyncOperation::Create,
            "evt-1".to_string(),
            "2026-03-01T00:00:00Z".to_string(),
            1,
            serde_json::json!({
                "taxonomy": {
                    "id": "tax-upd-1", "name": "Original", "color": "#aaa",
                    "description": null, "isSystem": 0, "isSingleSelect": 0,
                    "sortOrder": 1,
                    "createdAt": "2026-03-01T00:00:00+00:00",
                    "updatedAt": "2026-03-01T00:00:00+00:00"
                },
                "categories": [
                    { "id": "c1", "taxonomyId": "tax-upd-1", "parentId": null,
                      "name": "Cat1", "key": "c1", "color": "#111",
                      "description": null, "sortOrder": 1,
                      "createdAt": "2026-03-01T00:00:00+00:00",
                      "updatedAt": "2026-03-01T00:00:00+00:00" },
                    { "id": "c2", "taxonomyId": "tax-upd-1", "parentId": null,
                      "name": "Cat2", "key": "c2", "color": "#222",
                      "description": null, "sortOrder": 2,
                      "createdAt": "2026-03-01T00:00:00+00:00",
                      "updatedAt": "2026-03-01T00:00:00+00:00" }
                ]
            }),
        )
        .await
        .expect("create");

        // Update: remove c2, add c3, rename taxonomy
        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::CustomTaxonomy,
                "tax-upd-1".to_string(),
                SyncOperation::Update,
                "evt-2".to_string(),
                "2026-03-02T00:00:00Z".to_string(),
                2,
                serde_json::json!({
                    "taxonomy": {
                        "id": "tax-upd-1", "name": "Renamed", "color": "#bbb",
                        "description": "Now with description", "isSystem": 0,
                        "isSingleSelect": 1, "sortOrder": 1,
                        "createdAt": "2026-03-01T00:00:00+00:00",
                        "updatedAt": "2026-03-02T00:00:00+00:00"
                    },
                    "categories": [
                        { "id": "c1", "taxonomyId": "tax-upd-1", "parentId": null,
                          "name": "Cat1-updated", "key": "c1", "color": "#111",
                          "description": null, "sortOrder": 1,
                          "createdAt": "2026-03-01T00:00:00+00:00",
                          "updatedAt": "2026-03-02T00:00:00+00:00" },
                        { "id": "c3", "taxonomyId": "tax-upd-1", "parentId": null,
                          "name": "Cat3-new", "key": "c3", "color": "#333",
                          "description": null, "sortOrder": 2,
                          "createdAt": "2026-03-02T00:00:00+00:00",
                          "updatedAt": "2026-03-02T00:00:00+00:00" }
                    ]
                }),
            )
            .await
            .expect("update");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");

        // Taxonomy was renamed
        let name: String = taxonomies::table
            .find("tax-upd-1")
            .select(taxonomies::name)
            .first(&mut conn)
            .expect("taxonomy");
        assert_eq!(name, "Renamed");

        // c1 was updated, c2 was deleted, c3 was added
        let cat_ids: Vec<String> = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq("tax-upd-1"))
            .select(taxonomy_categories::id)
            .order(taxonomy_categories::sort_order.asc())
            .load(&mut conn)
            .expect("cats");
        assert_eq!(cat_ids, vec!["c1", "c3"]);

        // c1 name was updated
        let c1_name: String = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq("tax-upd-1"))
            .filter(taxonomy_categories::id.eq("c1"))
            .select(taxonomy_categories::name)
            .first(&mut conn)
            .expect("c1");
        assert_eq!(c1_name, "Cat1-updated");
    }

    #[tokio::test]
    async fn replay_custom_taxonomy_delete_cascades() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        // Create a taxonomy with categories
        repo.apply_remote_event_lww(
            SyncEntity::CustomTaxonomy,
            "tax-del-1".to_string(),
            SyncOperation::Create,
            "evt-del-1".to_string(),
            "2026-03-01T00:00:00Z".to_string(),
            1,
            serde_json::json!({
                "taxonomy": {
                    "id": "tax-del-1", "name": "ToDelete", "color": "#000",
                    "description": null, "isSystem": 0, "isSingleSelect": 0,
                    "sortOrder": 1,
                    "createdAt": "2026-03-01T00:00:00+00:00",
                    "updatedAt": "2026-03-01T00:00:00+00:00"
                },
                "categories": [
                    { "id": "dc1", "taxonomyId": "tax-del-1", "parentId": null,
                      "name": "D1", "key": "d1", "color": "#111",
                      "description": null, "sortOrder": 1,
                      "createdAt": "2026-03-01T00:00:00+00:00",
                      "updatedAt": "2026-03-01T00:00:00+00:00" }
                ]
            }),
        )
        .await
        .expect("create for delete test");

        // Delete the taxonomy
        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::CustomTaxonomy,
                "tax-del-1".to_string(),
                SyncOperation::Delete,
                "evt-del-2".to_string(),
                "2026-03-02T00:00:00Z".to_string(),
                2,
                serde_json::json!({ "id": "tax-del-1" }),
            )
            .await
            .expect("delete");
        assert!(applied);

        let mut conn = get_connection(&pool).expect("conn");

        // Taxonomy gone
        let tax_count: i64 = taxonomies::table
            .filter(taxonomies::id.eq("tax-del-1"))
            .select(count_star())
            .first(&mut conn)
            .expect("tax count");
        assert_eq!(tax_count, 0);

        // Categories cascaded
        let cat_count: i64 = taxonomy_categories::table
            .filter(taxonomy_categories::taxonomy_id.eq("tax-del-1"))
            .select(count_star())
            .first(&mut conn)
            .expect("cat count");
        assert_eq!(cat_count, 0);
    }

    #[tokio::test]
    async fn replay_custom_taxonomy_rejects_system_payload() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);

        let result = repo
            .apply_remote_event_lww(
                SyncEntity::CustomTaxonomy,
                "instrument_type".to_string(),
                SyncOperation::Update,
                "evt-system-hack".to_string(),
                "2026-03-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "taxonomy": {
                        "id": "instrument_type", "name": "Hacked", "color": "#000",
                        "description": null, "isSystem": 1, "isSingleSelect": 0,
                        "sortOrder": 1,
                        "createdAt": "2026-03-01T00:00:00+00:00",
                        "updatedAt": "2026-03-01T00:00:00+00:00"
                    },
                    "categories": []
                }),
            )
            .await;

        assert!(result.is_err(), "should reject system taxonomy payload");
        assert!(
            result.unwrap_err().to_string().contains("system taxonomy"),
            "error should mention system taxonomy"
        );
    }

    #[tokio::test]
    async fn replay_import_run_upserts_user_initiated_run() {
        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");
        insert_account_for_test(&mut conn, "acc-import-run").expect("insert account");

        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::ImportRun,
                "run-csv-1".to_string(),
                SyncOperation::Create,
                "evt-run-1".to_string(),
                "2026-03-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": "run-csv-1",
                    "account_id": "acc-import-run",
                    "source_system": "csv",
                    "run_type": "IMPORT",
                    "mode": "INCREMENTAL",
                    "status": "APPLIED",
                    "started_at": "2026-03-01T00:00:00+00:00",
                    "finished_at": "2026-03-01T00:01:00+00:00",
                    "review_mode": "NEVER",
                    "applied_at": "2026-03-01T00:01:00+00:00",
                    "checkpoint_in": null,
                    "checkpoint_out": null,
                    "summary": null,
                    "warnings": null,
                    "error": null,
                    "created_at": "2026-03-01T00:00:00+00:00",
                    "updated_at": "2026-03-01T00:01:00+00:00"
                }),
            )
            .await
            .expect("apply import run create");
        assert!(applied);

        let source: String = crate::schema::import_runs::table
            .find("run-csv-1")
            .select(crate::schema::import_runs::source_system)
            .first(&mut conn)
            .expect("import run row");
        assert_eq!(source, "csv");
    }

    /// Regression: sync upsert on `holdings_snapshots` updates the JSON
    /// `positions` column in place, but SQLite does not cascade-update the
    /// sibling `snapshot_positions` rows. Replay must rebuild the relational
    /// rows so reads do not keep returning the receiving device's old state.
    #[tokio::test]
    async fn replay_snapshot_rebuilds_stale_snapshot_positions() {
        #[derive(diesel::QueryableByName)]
        struct CountRow {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            c: i64,
        }
        #[derive(diesel::QueryableByName)]
        struct AssetIdRow {
            #[diesel(sql_type = diesel::sql_types::Text)]
            asset_id: String,
        }

        let (pool, writer) = setup_db();
        let repo = AppSyncRepository::new(pool.clone(), writer);
        let mut conn = get_connection(&pool).expect("conn");

        insert_account_for_test(&mut conn, "acc-sync-snap").expect("insert account");
        diesel::sql_query(
            "INSERT INTO assets (id, kind, name, display_code, notes, metadata, is_active, quote_mode, quote_ccy, instrument_type, instrument_symbol, instrument_exchange_mic, provider_config, created_at, updated_at)
             VALUES ('asset-sync-snap-old', 'INVESTMENT', 'Old Asset', 'OLD', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                    ('asset-sync-snap-new', 'INVESTMENT', 'New Asset', 'NEW', NULL, NULL, 1, 'MANUAL', 'USD', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .execute(&mut conn)
        .expect("insert assets");

        let snap_id = "snap-sync-stale";
        // Seed: receiving device already has the snapshot + relational
        // positions for "old asset".
        diesel::sql_query(format!(
            "INSERT INTO holdings_snapshots (id, account_id, snapshot_date, currency, positions, cash_balances, cost_basis, net_contribution, calculated_at, net_contribution_base, cash_total_account_currency, cash_total_base_currency, source) \
             VALUES ('{}', 'acc-sync-snap', '2026-01-01', 'USD', '{{}}', '{{}}', '0', '0', '2026-01-01T00:00:00Z', '0', '0', '0', 'MANUAL_ENTRY')",
            snap_id
        ))
        .execute(&mut conn)
        .expect("insert snapshot");

        diesel::sql_query(format!(
            "INSERT INTO snapshot_positions (snapshot_id, asset_id, quantity, average_cost, total_cost_basis, currency, inception_date, is_alternative, contract_multiplier, created_at, last_updated) \
             VALUES ('{}', 'asset-sync-snap-old', '5', '100', '500', 'USD', '2026-01-01T00:00:00Z', 0, '1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            snap_id
        ))
        .execute(&mut conn)
        .expect("insert stale snapshot_positions");

        // Sanity check: relational row exists.
        let before: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM snapshot_positions WHERE snapshot_id = '{}'",
            snap_id
        ))
        .get_result(&mut conn)
        .expect("count before");
        assert_eq!(before.c, 1);

        drop(conn);

        // Remote sync sends an updated snapshot for the same id with
        // positions JSON referencing the new asset.
        let applied = repo
            .apply_remote_event_lww(
                SyncEntity::Snapshot,
                snap_id.to_string(),
                SyncOperation::Update,
                "evt-snap-update".to_string(),
                "2026-02-01T00:00:00Z".to_string(),
                1,
                serde_json::json!({
                    "id": snap_id,
                    "accountId": "acc-sync-snap",
                    "snapshotDate": "2026-01-01",
                    "currency": "USD",
                    "positions": "{\"asset-sync-snap-new\":{\"id\":\"POS-asset-sync-snap-new-acc-sync-snap\",\"accountId\":\"acc-sync-snap\",\"assetId\":\"asset-sync-snap-new\",\"quantity\":\"7\",\"averageCost\":\"110\",\"totalCostBasis\":\"770\",\"currency\":\"USD\",\"inceptionDate\":\"2026-01-01T00:00:00Z\",\"contractMultiplier\":\"1\",\"createdAt\":\"2026-01-01T00:00:00Z\",\"lastUpdated\":\"2026-01-01T00:00:00Z\"}}",
                    "cashBalances": "{}",
                    "costBasis": "0",
                    "netContribution": "0",
                    "calculatedAt": "2026-02-01T00:00:00Z",
                    "netContributionBase": "0",
                    "cashTotalAccountCurrency": "0",
                    "cashTotalBaseCurrency": "0",
                    "source": "MANUAL_ENTRY",
                }),
            )
            .await
            .expect("apply snapshot update");
        assert!(applied, "snapshot update event must apply");

        let mut conn = get_connection(&pool).expect("conn");
        // The relational rows for the snapshot must be rebuilt from the
        // freshly synced JSON, not left pointing at the old local asset.
        let after: CountRow = diesel::sql_query(format!(
            "SELECT COUNT(*) AS c FROM snapshot_positions WHERE snapshot_id = '{}'",
            snap_id
        ))
        .get_result(&mut conn)
        .expect("count after");
        assert_eq!(
            after.c, 1,
            "synced relational rows must be rebuilt on sync upsert"
        );
        let row: AssetIdRow = diesel::sql_query(format!(
            "SELECT asset_id FROM snapshot_positions WHERE snapshot_id = '{}'",
            snap_id
        ))
        .get_result(&mut conn)
        .expect("snapshot position asset");
        assert_eq!(row.asset_id, "asset-sync-snap-new");
    }
}
