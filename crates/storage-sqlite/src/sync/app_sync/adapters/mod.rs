//! Adapter namespace for entity-specific sync serialization/apply logic.
//!
//! In v2, most replay is handled by a generic rowset applier in `AppSyncRepository`.
//! This module is the stable extension point for richer per-entity semantics.

use wealthfolio_core::sync::SyncEntity;

#[derive(Debug, Clone)]
pub struct EntityAdapterDescriptor {
    pub entity: SyncEntity,
    pub table_name: &'static str,
}

pub fn default_adapter_descriptors() -> Vec<EntityAdapterDescriptor> {
    vec![
        EntityAdapterDescriptor {
            entity: SyncEntity::Account,
            table_name: "accounts",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Asset,
            table_name: "assets",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Quote,
            table_name: "quotes",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AssetTaxonomyAssignment,
            table_name: "asset_taxonomy_assignments",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Activity,
            table_name: "activities",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::ActivityImportProfile,
            table_name: "import_account_templates",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::ImportTemplate,
            table_name: "import_templates",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Goal,
            table_name: "goals",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::GoalPlan,
            table_name: "goal_plans",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::GoalsAllocation,
            table_name: "goals_allocation",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AiThread,
            table_name: "ai_threads",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AiMessage,
            table_name: "ai_messages",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AiThreadTag,
            table_name: "ai_thread_tags",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::ContributionLimit,
            table_name: "contribution_limits",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Platform,
            table_name: "platforms",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Snapshot,
            table_name: "holdings_snapshots",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::CustomProvider,
            table_name: "market_data_custom_providers",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::ImportRun,
            table_name: "import_runs",
        },
        // CustomTaxonomy is a bundle entity covering both taxonomies and taxonomy_categories.
        // It does not map 1:1 to a single table, but we register it for adapter discovery.
        EntityAdapterDescriptor {
            entity: SyncEntity::CustomTaxonomy,
            table_name: "taxonomies",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::Portfolio,
            table_name: "portfolios",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::PortfolioAccount,
            table_name: "portfolio_accounts",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AllocationTarget,
            table_name: "allocation_targets",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AllocationTargetWeight,
            table_name: "allocation_target_weights",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AllocationTargetConstraint,
            table_name: "allocation_target_constraints",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingSetting,
            table_name: "app_settings",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::ActivityTaxonomyAssignment,
            table_name: "activity_taxonomy_assignments",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingActivitySplit,
            table_name: "spending_activity_splits",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingActivityEvent,
            table_name: "spending_activity_events",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingCategorizationRule,
            table_name: "spending_categorization_rules",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingPresetRuleDeletion,
            table_name: "spending_preset_rule_deletions",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingEvent,
            table_name: "spending_events",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::SpendingEventType,
            table_name: "spending_event_types",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::BudgetGroup,
            table_name: "budget_groups",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::BudgetGroupAssignment,
            table_name: "budget_group_assignments",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::BudgetTarget,
            table_name: "budget_targets",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::BudgetRolloverSetting,
            table_name: "budget_rollover_settings",
        },
        EntityAdapterDescriptor {
            entity: SyncEntity::AddonStorage,
            table_name: "addon_storage",
        },
    ]
}
