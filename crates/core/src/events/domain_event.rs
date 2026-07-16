//! Domain event types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::accounts::TrackingMode;

/// Domain events emitted by core services after successful mutations.
///
/// These events represent facts about domain data changes. Runtime adapters
/// translate them into platform-specific actions (portfolio recalculation,
/// asset enrichment, broker sync, etc.).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEvent {
    /// Activities were created, updated, or deleted.
    ActivitiesChanged {
        account_ids: Vec<String>,
        asset_ids: Vec<String>,
        /// Currencies observed in affected activities (for FX sync planning)
        currencies: Vec<String>,
        /// Earliest affected activity timestamp in UTC, if known.
        /// Runtime planners convert this to a local business date using the current timezone.
        earliest_activity_at_utc: Option<DateTime<Utc>>,
    },

    /// Account-level split activities changed. Since split price adjustments are shared by
    /// asset, every account valuation may need to be rebuilt.
    AssetSplitActivitiesChanged {
        asset_ids: Vec<String>,
        earliest_activity_at_utc: Option<DateTime<Utc>>,
    },

    /// Holdings snapshots were created or updated.
    HoldingsChanged {
        account_ids: Vec<String>,
        asset_ids: Vec<String>,
    },

    /// Accounts were created, updated, or deleted.
    AccountsChanged {
        account_ids: Vec<String>,
        /// Currency changes for FX asset sync planning
        currency_changes: Vec<CurrencyChange>,
    },

    /// New assets were created (not updates).
    AssetsCreated { asset_ids: Vec<String> },

    /// Existing assets were updated and require quote sync/recalculation.
    AssetsUpdated { asset_ids: Vec<String> },

    /// Asset taxonomy assignments changed.
    AssetClassificationsChanged {
        asset_ids: Vec<String>,
        taxonomy_ids: Vec<String>,
    },

    /// UNKNOWN asset was merged into a resolved asset.
    AssetsMerged {
        /// The UNKNOWN asset ID being merged (source)
        source_id: String,
        /// The resolved asset ID (target)
        target_id: String,
        /// Number of activities migrated
        activities_migrated: u32,
    },

    /// Account tracking mode was changed.
    TrackingModeChanged {
        account_id: String,
        old_mode: TrackingMode,
        new_mode: TrackingMode,
        /// Whether this is a connected (broker-linked) account
        is_connected: bool,
    },

    /// Manual snapshot was saved (manual entry, CSV import, broker import).
    /// Triggers portfolio recalculation for the affected account.
    ManualSnapshotSaved { account_id: String },

    /// Device sync pulled changes from another device.
    /// Triggers full portfolio recalculation for all accounts.
    DeviceSyncPullComplete,
}

/// Represents a currency change on an account for FX sync planning.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CurrencyChange {
    pub account_id: String,
    pub old_currency: Option<String>,
    pub new_currency: String,
}

impl DomainEvent {
    /// Creates an ActivitiesChanged event.
    pub fn activities_changed(
        account_ids: Vec<String>,
        asset_ids: Vec<String>,
        currencies: Vec<String>,
        earliest_activity_at_utc: Option<DateTime<Utc>>,
    ) -> Self {
        Self::ActivitiesChanged {
            account_ids,
            asset_ids,
            currencies,
            earliest_activity_at_utc,
        }
    }

    pub fn asset_split_activities_changed(
        asset_ids: Vec<String>,
        earliest_activity_at_utc: Option<DateTime<Utc>>,
    ) -> Self {
        Self::AssetSplitActivitiesChanged {
            asset_ids,
            earliest_activity_at_utc,
        }
    }

    /// Creates a HoldingsChanged event.
    pub fn holdings_changed(account_ids: Vec<String>, asset_ids: Vec<String>) -> Self {
        Self::HoldingsChanged {
            account_ids,
            asset_ids,
        }
    }

    /// Creates an AccountsChanged event.
    pub fn accounts_changed(
        account_ids: Vec<String>,
        currency_changes: Vec<CurrencyChange>,
    ) -> Self {
        Self::AccountsChanged {
            account_ids,
            currency_changes,
        }
    }

    /// Creates an AssetsCreated event.
    pub fn assets_created(asset_ids: Vec<String>) -> Self {
        Self::AssetsCreated { asset_ids }
    }

    /// Creates an AssetsUpdated event.
    pub fn assets_updated(asset_ids: Vec<String>) -> Self {
        Self::AssetsUpdated { asset_ids }
    }

    /// Creates an AssetClassificationsChanged event.
    pub fn asset_classifications_changed(
        asset_ids: Vec<String>,
        taxonomy_ids: Vec<String>,
    ) -> Self {
        Self::AssetClassificationsChanged {
            asset_ids,
            taxonomy_ids,
        }
    }

    /// Creates an AssetsMerged event.
    pub fn assets_merged(source_id: String, target_id: String, activities_migrated: u32) -> Self {
        Self::AssetsMerged {
            source_id,
            target_id,
            activities_migrated,
        }
    }

    /// Creates a TrackingModeChanged event.
    pub fn tracking_mode_changed(
        account_id: String,
        old_mode: TrackingMode,
        new_mode: TrackingMode,
        is_connected: bool,
    ) -> Self {
        Self::TrackingModeChanged {
            account_id,
            old_mode,
            new_mode,
            is_connected,
        }
    }

    /// Creates a ManualSnapshotSaved event.
    pub fn manual_snapshot_saved(account_id: String) -> Self {
        Self::ManualSnapshotSaved { account_id }
    }

    /// Creates a DeviceSyncPullComplete event.
    /// Triggers full portfolio recalculation for all accounts.
    pub fn device_sync_pull_complete() -> Self {
        Self::DeviceSyncPullComplete
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_domain_event_serialization() {
        let timestamp = Utc.with_ymd_and_hms(2024, 6, 15, 14, 30, 0).unwrap();
        let event = DomainEvent::activities_changed(
            vec!["acc1".to_string()],
            vec!["AAPL".to_string()],
            vec!["USD".to_string()],
            Some(timestamp),
        );

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("activities_changed"));

        let deserialized: DomainEvent = serde_json::from_str(&json).unwrap();
        match deserialized {
            DomainEvent::ActivitiesChanged {
                account_ids,
                asset_ids,
                currencies,
                earliest_activity_at_utc,
            } => {
                assert_eq!(account_ids, vec!["acc1"]);
                assert_eq!(asset_ids, vec!["AAPL"]);
                assert_eq!(currencies, vec!["USD"]);
                assert_eq!(earliest_activity_at_utc, Some(timestamp));
            }
            _ => panic!("Expected ActivitiesChanged"),
        }
    }

    #[test]
    fn test_tracking_mode_changed_serialization() {
        let event = DomainEvent::tracking_mode_changed(
            "acc1".to_string(),
            TrackingMode::NotSet,
            TrackingMode::Transactions,
            true,
        );

        let json = serde_json::to_string(&event).unwrap();
        let deserialized: DomainEvent = serde_json::from_str(&json).unwrap();

        match deserialized {
            DomainEvent::TrackingModeChanged {
                account_id,
                old_mode,
                new_mode,
                is_connected,
            } => {
                assert_eq!(account_id, "acc1");
                assert_eq!(old_mode, TrackingMode::NotSet);
                assert_eq!(new_mode, TrackingMode::Transactions);
                assert!(is_connected);
            }
            _ => panic!("Expected TrackingModeChanged"),
        }
    }

    #[test]
    fn test_assets_updated_serialization() {
        let event = DomainEvent::assets_updated(vec!["asset-1".to_string()]);
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("assets_updated"));

        let deserialized: DomainEvent = serde_json::from_str(&json).unwrap();
        match deserialized {
            DomainEvent::AssetsUpdated { asset_ids } => {
                assert_eq!(asset_ids, vec!["asset-1".to_string()]);
            }
            _ => panic!("Expected AssetsUpdated"),
        }
    }

    #[test]
    fn test_asset_classifications_changed_serialization() {
        let event = DomainEvent::asset_classifications_changed(
            vec!["asset-1".to_string()],
            vec!["asset_classes".to_string()],
        );
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("asset_classifications_changed"));

        let deserialized: DomainEvent = serde_json::from_str(&json).unwrap();
        match deserialized {
            DomainEvent::AssetClassificationsChanged {
                asset_ids,
                taxonomy_ids,
            } => {
                assert_eq!(asset_ids, vec!["asset-1".to_string()]);
                assert_eq!(taxonomy_ids, vec!["asset_classes".to_string()]);
            }
            _ => panic!("Expected AssetClassificationsChanged"),
        }
    }

    #[test]
    fn test_device_sync_pull_complete_serialization() {
        let event = DomainEvent::device_sync_pull_complete();
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("device_sync_pull_complete"));

        let deserialized: DomainEvent = serde_json::from_str(&json).unwrap();
        assert!(matches!(deserialized, DomainEvent::DeviceSyncPullComplete));
    }
}
