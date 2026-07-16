//! SQLite storage implementation for sync (platforms, app sync state, import runs).

pub mod app_sync;
pub(crate) mod broker_activity_patch;
pub mod import_run;
pub mod platform;
pub mod state;

use serde::Serialize;
use uuid::Uuid;
use wealthfolio_core::portfolio::snapshot::SnapshotSource;
use wealthfolio_core::sync::{SyncEntity, SyncOperation};
use wealthfolio_core::Result;

/// Broker ingest aliases. `import_run` includes both broker ingest and manual CSV imports.
pub mod broker_ingest {
    pub use super::import_run::{ImportRunDB, ImportRunRepository};
    pub use super::platform::{Platform, PlatformDB, PlatformRepository};
    pub use super::state::{
        BrokerSyncState, BrokerSyncStateDB, BrokerSyncStateRepository, PlaidInvestmentsCheckpoint,
        PlaidSyncCheckpoint, SnapTradeCheckpoint, SyncStatus,
    };
}

// Re-export for convenience
pub(crate) use app_sync::flush_projected_outbox;
pub use app_sync::{
    AppSyncRepository, OutboxWriteRequest, SqliteSyncEngineDbPorts, SyncLocalDataSummary,
    SyncTableRowCount,
};
pub use import_run::{ImportRunDB, ImportRunRepository};
pub use platform::{Platform, PlatformDB, PlatformRepository};
pub use state::{
    BrokerSyncState, BrokerSyncStateDB, BrokerSyncStateRepository, PlaidInvestmentsCheckpoint,
    PlaidSyncCheckpoint, SnapTradeCheckpoint, SyncStatus,
};

pub fn should_sync_outbox_for_account_create(provider_account_id: Option<&str>) -> bool {
    provider_account_id.is_none_or(|id| id.trim().is_empty())
}

pub fn should_sync_outbox_for_platform(platform_id: &str, external_id: Option<&str>) -> bool {
    external_id.is_none_or(|id| id.trim().is_empty()) && Uuid::parse_str(platform_id).is_ok()
}

pub fn should_sync_outbox_for_activity(
    source_system: Option<&str>,
    _is_user_modified: bool,
    import_run_id: Option<&str>,
    source_record_id: Option<&str>,
) -> bool {
    let normalized_source = source_system
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase());
    if let Some(source) = normalized_source {
        return matches!(source.as_str(), "MANUAL" | "CSV");
    }

    import_run_id.is_none_or(|value| value.trim().is_empty())
        && source_record_id.is_none_or(|value| value.trim().is_empty())
}

/// Import runs sync only user-authored CSV/manual imports. Broker run history
/// and cursors are local state; each device refreshes them from broker APIs.
pub fn should_sync_outbox_for_import_run(run_type: &str, source_system: &str) -> bool {
    run_type.eq_ignore_ascii_case("IMPORT")
        && (source_system.eq_ignore_ascii_case("CSV")
            || source_system.eq_ignore_ascii_case("MANUAL"))
}

pub fn should_sync_outbox_for_snapshot_source(source: SnapshotSource) -> bool {
    matches!(
        source,
        SnapshotSource::ManualEntry | SnapshotSource::CsvImport
    )
}

/// Centralized metadata for mapping DB models to sync outbox entities.
pub trait SyncOutboxModel: Serialize {
    const ENTITY: SyncEntity;
    /// Borrowed single-column row identifier. Generic outbox writers use
    /// `sync_entity_id_owned()` so composite-key models can override the sync ID.
    fn sync_entity_id(&self) -> &str;
    /// Returns the entity ID as an owned String. Override for composite PKs.
    fn sync_entity_id_owned(&self) -> String {
        self.sync_entity_id().to_string()
    }
    fn should_sync_outbox(&self, _op: SyncOperation) -> bool {
        true
    }
    fn should_sync_outbox_delete(_entity_id: &str) -> bool {
        true
    }
    fn delete_payload(entity_id: &str) -> serde_json::Value {
        serde_json::json!({ "id": entity_id })
    }
}

pub fn outbox_request_for_model<T: SyncOutboxModel>(
    model: &T,
    op: SyncOperation,
) -> Result<OutboxWriteRequest> {
    Ok(OutboxWriteRequest::new(
        T::ENTITY,
        model.sync_entity_id_owned(),
        op,
        serde_json::to_value(model)?,
    ))
}

pub fn outbox_delete_request_for_model<T: SyncOutboxModel>(
    entity_id: impl Into<String>,
) -> OutboxWriteRequest {
    let entity_id = entity_id.into();
    OutboxWriteRequest::new(
        T::ENTITY,
        entity_id.clone(),
        SyncOperation::Delete,
        T::delete_payload(&entity_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_outbox_rules_match_local_manual_and_csv_rows() {
        assert!(should_sync_outbox_for_activity(
            Some("MANUAL"),
            false,
            None,
            None
        ));
        assert!(should_sync_outbox_for_activity(
            Some("csv"),
            false,
            None,
            None
        ));
        assert!(should_sync_outbox_for_activity(None, false, None, None));
        assert!(!should_sync_outbox_for_activity(
            Some("SNAPTRADE"),
            false,
            None,
            None
        ));
        assert!(!should_sync_outbox_for_activity(
            None,
            false,
            Some("run-1"),
            None
        ));
        assert!(!should_sync_outbox_for_activity(
            None,
            false,
            None,
            Some("provider-1")
        ));
        assert!(!should_sync_outbox_for_activity(
            Some("SNAPTRADE"),
            true,
            Some("run-1"),
            Some("provider-1")
        ));
    }

    #[test]
    fn snapshot_outbox_rules_include_only_user_authored_sources() {
        assert!(should_sync_outbox_for_snapshot_source(
            SnapshotSource::ManualEntry
        ));
        assert!(should_sync_outbox_for_snapshot_source(
            SnapshotSource::CsvImport
        ));
        assert!(!should_sync_outbox_for_snapshot_source(
            SnapshotSource::Synthetic
        ));
        assert!(!should_sync_outbox_for_snapshot_source(
            SnapshotSource::BrokerImported
        ));
        assert!(!should_sync_outbox_for_snapshot_source(
            SnapshotSource::Calculated
        ));
    }

    #[test]
    fn import_run_outbox_rules_only_sync_user_authored_imports() {
        assert!(should_sync_outbox_for_import_run("IMPORT", "csv"));
        assert!(should_sync_outbox_for_import_run("IMPORT", "CSV"));
        assert!(should_sync_outbox_for_import_run("IMPORT", "manual"));
        assert!(should_sync_outbox_for_import_run("IMPORT", "MANUAL"));
        assert!(!should_sync_outbox_for_import_run("SYNC", "snaptrade"));
        assert!(!should_sync_outbox_for_import_run("SYNC", "plaid"));
        assert!(!should_sync_outbox_for_import_run("SYNC", "csv"));
        assert!(!should_sync_outbox_for_import_run("IMPORT", "snaptrade"));
        assert!(!should_sync_outbox_for_import_run("IMPORT", "plaid"));
    }

    #[test]
    fn account_and_platform_outbox_rules_exclude_external_records() {
        assert!(should_sync_outbox_for_account_create(None));
        assert!(!should_sync_outbox_for_account_create(Some(
            "provider-account-1"
        )));
        assert!(should_sync_outbox_for_platform(
            "f2a56a18-f7ff-49c4-bf1c-eed77bcd4b8e",
            None
        ));
        assert!(!should_sync_outbox_for_platform(
            "f2a56a18-f7ff-49c4-bf1c-eed77bcd4b8e",
            Some("external-platform-1")
        ));
        assert!(!should_sync_outbox_for_platform("COINBASE", None));
    }
}
