//! Event planning functions for translating domain events into actions.
//!
//! These functions analyze batches of domain events and determine what
//! platform-specific actions need to be triggered.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use wealthfolio_core::accounts::TrackingMode;
use wealthfolio_core::events::DomainEvent;
use wealthfolio_core::utils::time_utils::activity_date_in_user_timezone;

use crate::events::PortfolioRequestPayload;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetClassificationChangePlan {
    pub asset_ids: Vec<String>,
    pub taxonomy_ids: Vec<String>,
}

/// Plans a UI cache refresh for asset classification changes.
pub fn plan_asset_classification_change(
    events: &[DomainEvent],
) -> Option<AssetClassificationChangePlan> {
    let mut asset_ids: HashSet<String> = HashSet::new();
    let mut taxonomy_ids: HashSet<String> = HashSet::new();
    let mut has_event = false;

    for event in events {
        if let DomainEvent::AssetClassificationsChanged {
            asset_ids: changed_asset_ids,
            taxonomy_ids: changed_taxonomy_ids,
        } = event
        {
            has_event = true;
            asset_ids.extend(
                changed_asset_ids
                    .iter()
                    .filter(|id| !id.is_empty())
                    .cloned(),
            );
            taxonomy_ids.extend(
                changed_taxonomy_ids
                    .iter()
                    .filter(|id| !id.is_empty())
                    .cloned(),
            );
        }
    }

    if !has_event {
        return None;
    }

    let mut asset_ids = asset_ids.into_iter().collect::<Vec<_>>();
    asset_ids.sort();
    let mut taxonomy_ids = taxonomy_ids.into_iter().collect::<Vec<_>>();
    taxonomy_ids.sort();

    Some(AssetClassificationChangePlan {
        asset_ids,
        taxonomy_ids,
    })
}

/// Plans a portfolio recalculation job from a batch of domain events.
///
/// Merges account_ids and asset_ids from:
/// - ActivitiesChanged
/// - HoldingsChanged
/// - AccountsChanged
/// - AssetsUpdated
///
/// Also carries through asset IDs from AssetsCreated when a recalc-triggering
/// event exists in the same batch.
///
/// Returns `None` if no events require portfolio recalculation.
pub fn plan_portfolio_job(
    events: &[DomainEvent],
    timezone: &str,
) -> Option<PortfolioRequestPayload> {
    let mut account_ids: HashSet<String> = HashSet::new();
    let mut asset_ids: HashSet<String> = HashSet::new();
    let mut has_recalc_events = false;
    let mut recalculate_all_accounts = false;
    let mut min_activity_at_utc: Option<DateTime<Utc>> = None;

    for event in events {
        match event {
            DomainEvent::ActivitiesChanged {
                account_ids: acc_ids,
                asset_ids: a_ids,
                earliest_activity_at_utc,
                ..
            } => {
                has_recalc_events = true;
                account_ids.extend(acc_ids.iter().cloned());
                asset_ids.extend(a_ids.iter().cloned());
                min_activity_at_utc = match (min_activity_at_utc, earliest_activity_at_utc) {
                    (Some(current), Some(new)) => Some(current.min(*new)),
                    (None, Some(new)) => Some(*new),
                    (current, None) => current,
                };
            }
            DomainEvent::AssetSplitActivitiesChanged {
                asset_ids: ids,
                earliest_activity_at_utc,
            } => {
                has_recalc_events = true;
                recalculate_all_accounts = true;
                asset_ids.extend(ids.iter().filter(|id| !id.is_empty()).cloned());
                min_activity_at_utc = match (min_activity_at_utc, earliest_activity_at_utc) {
                    (Some(current), Some(new)) => Some(current.min(*new)),
                    (None, Some(new)) => Some(*new),
                    (current, None) => current,
                };
            }
            DomainEvent::HoldingsChanged {
                account_ids: acc_ids,
                asset_ids: a_ids,
            } => {
                has_recalc_events = true;
                account_ids.extend(acc_ids.iter().cloned());
                asset_ids.extend(a_ids.iter().cloned());
            }
            DomainEvent::AccountsChanged {
                account_ids: acc_ids,
                ..
            } => {
                has_recalc_events = true;
                account_ids.extend(acc_ids.iter().cloned());
            }
            DomainEvent::ManualSnapshotSaved { account_id } => {
                has_recalc_events = true;
                account_ids.insert(account_id.clone());
            }
            DomainEvent::DeviceSyncPullComplete => {
                has_recalc_events = true;
                recalculate_all_accounts = true;
            }
            DomainEvent::AssetsUpdated { asset_ids: ids } => {
                has_recalc_events = true;
                for id in ids {
                    if !id.is_empty() {
                        asset_ids.insert(id.clone());
                    }
                }
            }
            // AssetsCreated: include IDs for sync (e.g., FX assets), but don't trigger recalc alone
            DomainEvent::AssetsCreated { asset_ids: ids } => {
                for id in ids {
                    if !id.is_empty() {
                        asset_ids.insert(id.clone());
                    }
                }
            }
            DomainEvent::AssetClassificationsChanged { .. } => {}
            DomainEvent::AssetsMerged { .. } => {}
            DomainEvent::TrackingModeChanged {
                account_id,
                old_mode,
                new_mode,
                ..
            } => {
                if *old_mode == TrackingMode::Holdings && *new_mode == TrackingMode::Transactions {
                    account_ids.insert(account_id.clone());
                    has_recalc_events = true;
                }
            }
        }
    }

    if !has_recalc_events {
        return None;
    }

    // Build the payload using the builder pattern
    let mut builder = PortfolioRequestPayload::builder();

    // Set account IDs if we have specific ones, otherwise None means all
    if !recalculate_all_accounts && !account_ids.is_empty() {
        builder = builder.account_ids(Some(account_ids.into_iter().collect()));
    }

    // Use incremental sync with the collected asset IDs
    let sync_mode = if asset_ids.is_empty() {
        wealthfolio_core::quotes::MarketSyncMode::Incremental { asset_ids: None }
    } else {
        wealthfolio_core::quotes::MarketSyncMode::Incremental {
            asset_ids: Some(asset_ids.into_iter().collect()),
        }
    };
    builder = builder.market_sync_mode(sync_mode);
    builder = builder.since_date(if recalculate_all_accounts {
        None
    } else {
        min_activity_at_utc.map(|instant| activity_date_in_user_timezone(instant, timezone))
    });

    Some(builder.build())
}

/// Plans broker sync for eligible tracking mode changes.
///
/// Returns account IDs that need broker sync when:
/// - is_connected == true
/// - old_mode != new_mode
/// - Transition is: NOT_SET -> TRANSACTIONS/HOLDINGS or HOLDINGS -> TRANSACTIONS
pub fn plan_broker_sync(events: &[DomainEvent]) -> Vec<String> {
    let mut account_ids = Vec::new();

    for event in events {
        if let DomainEvent::TrackingModeChanged {
            account_id,
            old_mode,
            new_mode,
            is_connected,
        } = event
        {
            // Skip if not connected or mode didn't change
            if !is_connected || old_mode == new_mode {
                continue;
            }

            // Check for eligible transitions:
            // - NOT_SET -> TRANSACTIONS
            // - NOT_SET -> HOLDINGS
            // - HOLDINGS -> TRANSACTIONS
            let eligible = matches!(
                (old_mode, new_mode),
                (TrackingMode::NotSet, TrackingMode::Transactions)
                    | (TrackingMode::NotSet, TrackingMode::Holdings)
                    | (TrackingMode::Holdings, TrackingMode::Transactions)
            );

            if eligible {
                account_ids.push(account_id.clone());
            }
        }
    }

    account_ids
}

/// Plans asset enrichment for newly created assets.
///
/// Returns asset IDs from AssetsCreated events.
pub fn plan_asset_enrichment(events: &[DomainEvent]) -> Vec<String> {
    let mut asset_ids: HashSet<String> = HashSet::new();

    for event in events {
        if let DomainEvent::AssetsCreated {
            asset_ids: a_ids, ..
        } = event
        {
            asset_ids.extend(a_ids.iter().cloned());
        }
    }

    asset_ids.into_iter().collect()
}

/// Plans an auto-categorization pass over spending accounts touched by this batch.
///
/// Returns the unique set of opted-in spending account IDs that appeared in any
/// `ActivitiesChanged` event. Empty result means no work to do.
///
/// Other events (DeviceSyncPullComplete, asset events, holdings events, account
/// events, tracking-mode changes) are intentionally ignored:
///   - device-sync propagates `activity_taxonomy_assignments` rows directly, so
///     newly-pulled activities arrive pre-categorized; rerunning rules would be
///     redundant and could clash with sync conflict resolution.
///   - asset / holdings / account events don't change spending activities.
pub fn plan_categorization_job(
    events: &[DomainEvent],
    opted_in_accounts: &HashSet<String>,
) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    for event in events {
        if let DomainEvent::ActivitiesChanged { account_ids, .. } = event {
            for id in account_ids {
                if opted_in_accounts.contains(id) {
                    out.insert(id.clone());
                }
            }
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use wealthfolio_core::events::CurrencyChange;

    #[test]
    fn test_plan_portfolio_job_empty_events() {
        let events: Vec<DomainEvent> = vec![];
        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_activities_changed() {
        let events = vec![DomainEvent::ActivitiesChanged {
            account_ids: vec!["acc1".to_string()],
            asset_ids: vec!["AAPL".to_string()],
            currencies: vec!["USD".to_string()],
            earliest_activity_at_utc: None,
        }];

        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_some());

        let payload = result.unwrap();
        assert!(payload.account_ids.is_some());
        let account_ids = payload.account_ids.unwrap();
        assert!(account_ids.contains(&"acc1".to_string()));
    }

    #[test]
    fn test_split_activity_change_recalculates_all_accounts() {
        let events = vec![
            DomainEvent::ActivitiesChanged {
                account_ids: vec!["edited-account".to_string()],
                asset_ids: vec!["VGT".to_string()],
                currencies: vec!["USD".to_string()],
                earliest_activity_at_utc: None,
            },
            DomainEvent::asset_split_activities_changed(vec!["VGT".to_string()], None),
        ];

        let payload = plan_portfolio_job(&events, "UTC").unwrap();

        assert!(payload.account_ids.is_none());
        assert!(payload.since_date.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_converts_utc_timestamp_using_timezone() {
        let events = vec![DomainEvent::ActivitiesChanged {
            account_ids: vec!["acc1".to_string()],
            asset_ids: vec!["AAPL".to_string()],
            currencies: vec!["USD".to_string()],
            earliest_activity_at_utc: Some(Utc.with_ymd_and_hms(2025, 1, 1, 1, 30, 0).unwrap()),
        }];

        let payload = plan_portfolio_job(&events, "America/Toronto").unwrap();
        assert_eq!(
            payload.since_date.map(|date| date.to_string()),
            Some("2024-12-31".to_string())
        );
    }

    #[test]
    fn test_plan_portfolio_job_accounts_changed_no_fake_fx_ids() {
        let events = vec![DomainEvent::AccountsChanged {
            account_ids: vec!["acc1".to_string()],
            currency_changes: vec![CurrencyChange {
                account_id: "acc1".to_string(),
                old_currency: Some("EUR".to_string()),
                new_currency: "GBP".to_string(),
            }],
        }];

        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_some());

        let payload = result.unwrap();
        // FX assets are synced via AssetsCreated events, not constructed from currencies
        if let wealthfolio_core::quotes::MarketSyncMode::Incremental { asset_ids } =
            payload.market_sync_mode
        {
            assert!(asset_ids.is_none());
        } else {
            panic!("Expected Incremental sync mode");
        }
    }

    #[test]
    fn test_plan_portfolio_job_holdings_to_transactions_triggers_recalc() {
        let events = vec![DomainEvent::TrackingModeChanged {
            account_id: "acc1".to_string(),
            old_mode: TrackingMode::Holdings,
            new_mode: TrackingMode::Transactions,
            is_connected: true,
        }];

        let result = plan_portfolio_job(&events, "UTC").unwrap();
        assert_eq!(result.account_ids, Some(vec!["acc1".to_string()]));
        assert!(result.since_date.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_transactions_to_holdings_does_not_trigger_recalc() {
        let events = vec![DomainEvent::TrackingModeChanged {
            account_id: "acc1".to_string(),
            old_mode: TrackingMode::Transactions,
            new_mode: TrackingMode::Holdings,
            is_connected: true,
        }];

        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_assets_created_contributes_ids() {
        let events = vec![
            DomainEvent::ActivitiesChanged {
                account_ids: vec!["acc1".to_string()],
                asset_ids: vec!["equity-uuid".to_string()],
                currencies: vec!["USD".to_string()],
                earliest_activity_at_utc: None,
            },
            DomainEvent::AssetsCreated {
                asset_ids: vec!["fx-uuid".to_string()],
            },
        ];

        let result = plan_portfolio_job(&events, "UTC").unwrap();
        if let wealthfolio_core::quotes::MarketSyncMode::Incremental { asset_ids } =
            result.market_sync_mode
        {
            let ids = asset_ids.unwrap();
            assert!(ids.contains(&"equity-uuid".to_string()));
            assert!(ids.contains(&"fx-uuid".to_string()));
        } else {
            panic!("Expected Incremental sync mode");
        }
    }

    #[test]
    fn test_plan_portfolio_job_assets_created_no_recalc() {
        let events = vec![DomainEvent::AssetsCreated {
            asset_ids: vec!["AAPL".to_string()],
        }];

        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_assets_updated_triggers_recalc() {
        let events = vec![DomainEvent::AssetsUpdated {
            asset_ids: vec!["asset-1".to_string()],
        }];

        let result = plan_portfolio_job(&events, "UTC").unwrap();
        assert!(result.account_ids.is_none());

        if let wealthfolio_core::quotes::MarketSyncMode::Incremental { asset_ids } =
            result.market_sync_mode
        {
            assert_eq!(asset_ids, Some(vec!["asset-1".to_string()]));
        } else {
            panic!("Expected Incremental sync mode");
        }
    }

    #[test]
    fn test_plan_portfolio_job_asset_classifications_changed_does_not_trigger_recalc() {
        let events = vec![DomainEvent::asset_classifications_changed(
            vec!["asset-1".to_string()],
            vec!["asset_classes".to_string()],
        )];

        assert!(plan_portfolio_job(&events, "UTC").is_none());
    }

    #[test]
    fn test_plan_asset_classification_change_deduplicates_ids() {
        let events = vec![
            DomainEvent::asset_classifications_changed(
                vec!["asset-2".to_string(), "asset-1".to_string()],
                vec!["regions".to_string()],
            ),
            DomainEvent::asset_classifications_changed(
                vec!["asset-1".to_string(), "".to_string()],
                vec!["regions".to_string(), "asset_classes".to_string()],
            ),
        ];

        let plan = plan_asset_classification_change(&events).unwrap();
        assert_eq!(
            plan.asset_ids,
            vec!["asset-1".to_string(), "asset-2".to_string()]
        );
        assert_eq!(
            plan.taxonomy_ids,
            vec!["asset_classes".to_string(), "regions".to_string()]
        );
    }

    #[test]
    fn test_plan_broker_sync_not_connected() {
        let events = vec![DomainEvent::TrackingModeChanged {
            account_id: "acc1".to_string(),
            old_mode: TrackingMode::NotSet,
            new_mode: TrackingMode::Transactions,
            is_connected: false, // Not connected
        }];

        let result = plan_broker_sync(&events);
        assert!(result.is_empty());
    }

    #[test]
    fn test_plan_broker_sync_eligible_transition() {
        let events = vec![DomainEvent::TrackingModeChanged {
            account_id: "acc1".to_string(),
            old_mode: TrackingMode::NotSet,
            new_mode: TrackingMode::Transactions,
            is_connected: true,
        }];

        let result = plan_broker_sync(&events);
        assert_eq!(result, vec!["acc1".to_string()]);
    }

    #[test]
    fn test_plan_broker_sync_ineligible_transition() {
        // TRANSACTIONS -> HOLDINGS is not an eligible transition
        let events = vec![DomainEvent::TrackingModeChanged {
            account_id: "acc1".to_string(),
            old_mode: TrackingMode::Transactions,
            new_mode: TrackingMode::Holdings,
            is_connected: true,
        }];

        let result = plan_broker_sync(&events);
        assert!(result.is_empty());
    }

    #[test]
    fn test_plan_asset_enrichment() {
        let events = vec![
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string(), "MSFT".to_string()],
            },
            DomainEvent::AssetsCreated {
                asset_ids: vec!["GOOG".to_string()],
            },
        ];

        let result = plan_asset_enrichment(&events);
        assert_eq!(result.len(), 3);
        assert!(result.contains(&"AAPL".to_string()));
        assert!(result.contains(&"MSFT".to_string()));
        assert!(result.contains(&"GOOG".to_string()));
    }

    #[test]
    fn test_plan_asset_enrichment_deduplicates() {
        let events = vec![
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string()],
            },
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string()], // Duplicate
            },
        ];

        let result = plan_asset_enrichment(&events);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_plan_portfolio_job_device_sync_pull_complete() {
        let events = vec![DomainEvent::device_sync_pull_complete()];

        let result = plan_portfolio_job(&events, "UTC");
        assert!(result.is_some());

        let payload = result.unwrap();
        // DeviceSyncPullComplete should trigger recalculation for all accounts
        assert!(payload.account_ids.is_none());
    }

    #[test]
    fn test_plan_portfolio_job_device_sync_pull_complete_triggers_incremental_sync() {
        let events = vec![DomainEvent::device_sync_pull_complete()];

        let result = plan_portfolio_job(&events, "UTC").unwrap();

        // Should use incremental sync mode
        if let wealthfolio_core::quotes::MarketSyncMode::Incremental { asset_ids } =
            result.market_sync_mode
        {
            assert!(asset_ids.is_none());
        } else {
            panic!("Expected Incremental sync mode");
        }
    }

    // ── plan_categorization_job ──────────────────────────────────────────────

    fn opted_in(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_plan_categorization_job_filters_to_opted_in_accounts() {
        let events = vec![DomainEvent::ActivitiesChanged {
            account_ids: vec!["acc1".to_string(), "acc2".to_string(), "acc3".to_string()],
            asset_ids: vec![],
            currencies: vec![],
            earliest_activity_at_utc: None,
        }];
        // Only acc1 and acc3 are opted into spending.
        let result = plan_categorization_job(&events, &opted_in(&["acc1", "acc3"]));
        let mut sorted = result.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["acc1".to_string(), "acc3".to_string()]);
    }

    #[test]
    fn test_plan_categorization_job_empty_when_no_overlap() {
        let events = vec![DomainEvent::ActivitiesChanged {
            account_ids: vec!["acc-non-spending".to_string()],
            asset_ids: vec![],
            currencies: vec![],
            earliest_activity_at_utc: None,
        }];
        let result = plan_categorization_job(&events, &opted_in(&["acc-spending"]));
        assert!(result.is_empty());
    }

    #[test]
    fn test_plan_categorization_job_empty_when_no_activity_events() {
        let events = vec![
            DomainEvent::AssetsCreated {
                asset_ids: vec!["AAPL".to_string()],
            },
            DomainEvent::device_sync_pull_complete(),
            DomainEvent::holdings_changed(vec!["acc1".to_string()], vec![]),
        ];
        // Device sync, asset events, and holdings changes must not trigger categorization.
        let result = plan_categorization_job(&events, &opted_in(&["acc1"]));
        assert!(result.is_empty());
    }

    #[test]
    fn test_plan_categorization_job_coalesces_multiple_events() {
        let events = vec![
            DomainEvent::ActivitiesChanged {
                account_ids: vec!["acc1".to_string()],
                asset_ids: vec![],
                currencies: vec![],
                earliest_activity_at_utc: None,
            },
            DomainEvent::ActivitiesChanged {
                account_ids: vec!["acc1".to_string(), "acc2".to_string()],
                asset_ids: vec![],
                currencies: vec![],
                earliest_activity_at_utc: None,
            },
        ];
        let result = plan_categorization_job(&events, &opted_in(&["acc1", "acc2"]));
        let mut sorted = result.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["acc1".to_string(), "acc2".to_string()]);
    }

    #[test]
    fn test_plan_categorization_job_empty_opted_in_yields_no_work() {
        let events = vec![DomainEvent::ActivitiesChanged {
            account_ids: vec!["acc1".to_string()],
            asset_ids: vec![],
            currencies: vec![],
            earliest_activity_at_utc: None,
        }];
        let result = plan_categorization_job(&events, &HashSet::new());
        assert!(result.is_empty());
    }
}
