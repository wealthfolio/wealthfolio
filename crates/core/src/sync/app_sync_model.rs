//! App/device sync domain models and adapter contracts.

use serde::{Deserialize, Serialize};

/// Canonical list of local tables that participate in app-side device sync.
/// Order matters: parent tables before children (FK dependencies).
pub const APP_SYNC_TABLES: &[&str] = &[
    // Base tables (no FK deps)
    "platforms",
    "assets",
    // Per-addon key-value storage. Composite PK (addon_id, key), no FK deps.
    "addon_storage",
    // No FK deps
    "market_data_custom_providers",
    // Depends on: assets
    "quotes",
    "goals",
    "goal_plans",
    "ai_threads",
    "contribution_limits",
    // Depends on: platforms
    "accounts",
    // Depends on: accounts
    "import_runs",
    // Depends on: accounts, assets, import_runs
    "activities",
    // No FK deps
    "import_templates",
    // Spending settings only; storage filters to spending.* keys.
    "app_settings",
    // Spending budget groups have no FK deps.
    "budget_groups",
    // Spending event types — no FK deps.
    "spending_event_types",
    // Depends on: import_templates
    "import_account_templates",
    // No FK deps (base table)
    "taxonomies",
    // Depends on: taxonomies
    "taxonomy_categories",
    // Depends on: assets, taxonomy_categories
    "asset_taxonomy_assignments",
    // Spending activity↔category join. Depends on: activities, taxonomies, taxonomy_categories
    "activity_taxonomy_assignments",
    // Spending activity split lines. Depends on: activities, taxonomies, taxonomy_categories
    "spending_activity_splits",
    // Spending categorization rules. Depends on: accounts (optional FK), taxonomies, taxonomy_categories
    "spending_categorization_rules",
    // Preset rule deletion memory. Depends logically on spending_categorization_rules payloads.
    "spending_preset_rule_deletions",
    // Spending events. Depends on: spending_event_types
    "spending_events",
    // Spending activity↔event tag. Depends on: activities, spending_events
    "spending_activity_events",
    // Depends on: budget_groups, taxonomy_categories
    "budget_group_assignments",
    "budget_targets",
    "budget_rollover_settings",
    // Depends on: accounts, goals
    "goals_allocation",
    // Depends on: ai_threads
    "ai_messages",
    // Depends on: ai_threads
    "ai_thread_tags",
    // No FK deps (account_id has no FK constraint)
    "holdings_snapshots",
    // Depends on: holdings_snapshots, assets
    "snapshot_positions",
    // No FK deps
    "portfolios",
    // Depends on: portfolios, accounts
    "portfolio_accounts",
    // Depends on: taxonomy_categories, portfolios/accounts by optional scope.
    "allocation_targets",
    // Depends on: allocation_targets, taxonomy_categories.
    "allocation_target_weights",
    // Depends on: allocation_targets.
    "allocation_target_constraints",
];

/// Entity names used by incremental sync events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncEntity {
    Account,
    Asset,
    Quote,
    AssetTaxonomyAssignment,
    Activity,
    BrokerActivityUserPatch,
    ActivityImportProfile,
    ImportTemplate,
    Goal,
    GoalPlan,
    GoalsAllocation,
    AiThread,
    AiMessage,
    AiThreadTag,
    ContributionLimit,
    Platform,
    Snapshot,
    CustomProvider,
    CustomTaxonomy,
    ImportRun,
    Portfolio,
    PortfolioAccount,
    AllocationTarget,
    AllocationTargetWeight,
    AllocationTargetConstraint,
    // Spending module (wealthfolio-spending crate). Prefixed with `Spending*`
    // because the bare names (`Event`, `EventType`, `CategorizationRule`)
    // would clash with the codebase's existing event-system vocabulary
    // (DomainEvent, EventBus, sync_applied_events, etc.).
    SpendingSetting,
    ActivityTaxonomyAssignment,
    SpendingActivitySplit,
    SpendingActivityEvent,
    SpendingCategorizationRule,
    SpendingPresetRuleDeletion,
    SpendingEvent,
    SpendingEventType,
    BudgetGroup,
    BudgetGroupAssignment,
    BudgetTarget,
    BudgetRolloverSetting,
    // Per-addon key-value storage (composite PK). Custom apply branch.
    AddonStorage,
}

/// Supported sync operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncOperation {
    Create,
    Update,
    Delete,
}

/// Local outbox lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncOutboxStatus {
    Pending,
    Sent,
    Dead,
}

/// Sync outbox event payload stored locally before server push.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutboxEvent {
    pub event_id: String,
    pub entity: SyncEntity,
    pub entity_id: String,
    pub op: SyncOperation,
    pub client_timestamp: String,
    pub payload: String,
    pub payload_key_version: i32,
    pub sent: bool,
    pub status: SyncOutboxStatus,
    pub retry_count: i32,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,
    pub created_at: String,
}

/// LWW metadata tracked per entity row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntityMetadata {
    pub entity: SyncEntity,
    pub entity_id: String,
    pub last_event_id: String,
    pub last_client_timestamp: String,
    pub last_op: SyncOperation,
    pub last_seq: i64,
}

/// Lightweight sync engine status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEngineStatus {
    pub cursor: i64,
    pub last_push_at: Option<String>,
    pub last_pull_at: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failures: i32,
    pub next_retry_at: Option<String>,
    pub last_cycle_status: Option<String>,
    pub last_cycle_duration_ms: Option<i64>,
}

/// Replay result for one pulled event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReplayResult {
    pub event_id: String,
    pub entity: SyncEntity,
    pub entity_id: String,
    pub applied: bool,
    pub skipped_reason: Option<String>,
}

/// Envelope used for encrypted sync payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelopeV1 {
    pub version: i32,
    pub entity: SyncEntity,
    pub op: SyncOperation,
    pub body: String,
}

/// Trigger source for sync cycles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncCycleTrigger {
    Startup,
    Foreground,
    LocalMutation,
    Periodic,
    Manual,
}

/// Context for applying events locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncApplyContext {
    LocalMutation,
    RemoteReplay,
}

/// Determines whether an incoming remote mutation should overwrite local state.
///
/// Rule:
/// 1. higher client timestamp wins
/// 2. if equal, lexicographically greater event_id wins
pub fn should_apply_lww(
    local_client_timestamp: &str,
    local_event_id: &str,
    remote_client_timestamp: &str,
    remote_event_id: &str,
) -> bool {
    let local_parsed = chrono::DateTime::parse_from_rfc3339(local_client_timestamp)
        .map(|dt| dt.timestamp_millis());
    let remote_parsed = chrono::DateTime::parse_from_rfc3339(remote_client_timestamp)
        .map(|dt| dt.timestamp_millis());

    if let (Ok(local_ts), Ok(remote_ts)) = (local_parsed, remote_parsed) {
        if remote_ts > local_ts {
            return true;
        }
        if remote_ts == local_ts {
            return remote_event_id > local_event_id;
        }
        return false;
    }

    // Fallback to lexical ordering when one/both timestamps are non-RFC3339.
    if remote_client_timestamp > local_client_timestamp {
        return true;
    }
    if remote_client_timestamp == local_client_timestamp {
        return remote_event_id > local_event_id;
    }
    false
}

/// Entity adapter contract used by the sync engine.
///
/// Implementations can be incremental; the trait is intentionally stable to
/// avoid future refactors when more entities are wired.
pub trait EntitySyncAdapter: Send + Sync {
    fn entity(&self) -> SyncEntity;

    fn serialize_create(&self, entity_id: &str) -> Result<serde_json::Value, String>;
    fn serialize_update(&self, entity_id: &str) -> Result<serde_json::Value, String>;
    fn serialize_delete(&self, entity_id: &str) -> Result<serde_json::Value, String>;

    fn apply_event_lww(
        &self,
        entity_id: &str,
        event_id: &str,
        client_timestamp: &str,
        payload: &serde_json::Value,
        previous: Option<&SyncEntityMetadata>,
        context: SyncApplyContext,
    ) -> Result<bool, String>;

    fn export_for_snapshot_import(&self) -> Result<Vec<serde_json::Value>, String>;
    fn import_from_snapshot_rowset(&self, rows: &[serde_json::Value]) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::{should_apply_lww, SyncEntity};

    #[test]
    fn lww_newer_timestamp_wins() {
        assert!(should_apply_lww(
            "2026-01-01T00:00:00.000Z",
            "a",
            "2026-01-01T00:00:01.000Z",
            "b"
        ));
    }

    #[test]
    fn lww_event_id_tiebreaker() {
        assert!(should_apply_lww(
            "2026-01-01T00:00:00.000Z",
            "0001",
            "2026-01-01T00:00:00.000Z",
            "0002"
        ));
    }

    #[test]
    fn lww_uses_timestamp_value_not_lexical_format() {
        assert!(should_apply_lww(
            "2026-01-01T01:00:00+01:00",
            "0001",
            "2026-01-01T00:00:00Z",
            "0002"
        ));
    }

    #[test]
    fn sync_entity_serialization_matches_backend_contract() {
        let actual = [
            SyncEntity::Account,
            SyncEntity::Asset,
            SyncEntity::Quote,
            SyncEntity::AssetTaxonomyAssignment,
            SyncEntity::Activity,
            SyncEntity::BrokerActivityUserPatch,
            SyncEntity::ActivityImportProfile,
            SyncEntity::Goal,
            SyncEntity::GoalPlan,
            SyncEntity::GoalsAllocation,
            SyncEntity::AiThread,
            SyncEntity::AiMessage,
            SyncEntity::AiThreadTag,
            SyncEntity::ContributionLimit,
            SyncEntity::Platform,
            SyncEntity::Snapshot,
            SyncEntity::CustomProvider,
            SyncEntity::CustomTaxonomy,
            SyncEntity::ImportRun,
            SyncEntity::Portfolio,
            SyncEntity::PortfolioAccount,
            SyncEntity::AllocationTarget,
            SyncEntity::AllocationTargetWeight,
            SyncEntity::AllocationTargetConstraint,
            SyncEntity::SpendingSetting,
            SyncEntity::ActivityTaxonomyAssignment,
            SyncEntity::SpendingActivitySplit,
            SyncEntity::SpendingActivityEvent,
            SyncEntity::SpendingCategorizationRule,
            SyncEntity::SpendingPresetRuleDeletion,
            SyncEntity::SpendingEvent,
            SyncEntity::SpendingEventType,
            SyncEntity::BudgetGroup,
            SyncEntity::BudgetGroupAssignment,
            SyncEntity::BudgetTarget,
            SyncEntity::BudgetRolloverSetting,
            SyncEntity::AddonStorage,
        ]
        .iter()
        .map(|entity| serde_json::to_string(entity).expect("serialize sync entity"))
        .collect::<Vec<_>>();

        let expected = vec![
            "\"account\"",
            "\"asset\"",
            "\"quote\"",
            "\"asset_taxonomy_assignment\"",
            "\"activity\"",
            "\"broker_activity_user_patch\"",
            "\"activity_import_profile\"",
            "\"goal\"",
            "\"goal_plan\"",
            "\"goals_allocation\"",
            "\"ai_thread\"",
            "\"ai_message\"",
            "\"ai_thread_tag\"",
            "\"contribution_limit\"",
            "\"platform\"",
            "\"snapshot\"",
            "\"custom_provider\"",
            "\"custom_taxonomy\"",
            "\"import_run\"",
            "\"portfolio\"",
            "\"portfolio_account\"",
            "\"allocation_target\"",
            "\"allocation_target_weight\"",
            "\"allocation_target_constraint\"",
            "\"spending_setting\"",
            "\"activity_taxonomy_assignment\"",
            "\"spending_activity_split\"",
            "\"spending_activity_event\"",
            "\"spending_categorization_rule\"",
            "\"spending_preset_rule_deletion\"",
            "\"spending_event\"",
            "\"spending_event_type\"",
            "\"budget_group\"",
            "\"budget_group_assignment\"",
            "\"budget_target\"",
            "\"budget_rollover_setting\"",
            "\"addon_storage\"",
        ];

        assert_eq!(actual, expected);
    }
}
