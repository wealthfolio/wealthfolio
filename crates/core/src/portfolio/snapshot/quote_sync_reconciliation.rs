use std::collections::HashMap;

use rust_decimal::Decimal;

use crate::errors::Result;
use crate::quotes::QuoteServiceTrait;

use super::{AccountStateSnapshot, SnapshotServiceTrait};

pub fn holdings_quantities(snapshot: &AccountStateSnapshot) -> HashMap<String, Decimal> {
    snapshot
        .positions
        .iter()
        .map(|(asset_id, position)| (asset_id.clone(), position.quantity))
        .collect()
}

pub async fn reconcile_quote_sync_from_snapshot(
    quote_service: &dyn QuoteServiceTrait,
    snapshot: &AccountStateSnapshot,
) -> Result<()> {
    let current_holdings = holdings_quantities(snapshot);
    quote_service
        .update_position_status_from_holdings(&current_holdings)
        .await
}

pub async fn reconcile_quote_sync_from_latest_account_snapshots(
    snapshot_service: &dyn SnapshotServiceTrait,
    quote_service: &dyn QuoteServiceTrait,
    account_ids: &[String],
) -> Result<bool> {
    let current_holdings = latest_account_snapshot_holdings(snapshot_service, account_ids)?;

    quote_service
        .update_position_status_from_holdings(&current_holdings)
        .await?;
    Ok(true)
}

fn latest_account_snapshot_holdings(
    snapshot_service: &dyn SnapshotServiceTrait,
    account_ids: &[String],
) -> Result<HashMap<String, Decimal>> {
    let mut current_holdings: HashMap<String, Decimal> = HashMap::new();
    for account_id in account_ids {
        let Some(snapshot) = snapshot_service.get_latest_holdings_snapshot(account_id)? else {
            continue;
        };
        for (asset_id, quantity) in holdings_quantities(&snapshot) {
            *current_holdings.entry(asset_id).or_insert(Decimal::ZERO) += quantity;
        }
    }

    Ok(current_holdings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::NaiveDate;
    use rust_decimal_macros::dec;

    use crate::portfolio::snapshot::{Position, SnapshotRecalcMode};

    #[derive(Default)]
    struct MockSnapshotService {
        snapshots: HashMap<String, AccountStateSnapshot>,
    }

    #[async_trait]
    impl SnapshotServiceTrait for MockSnapshotService {
        async fn recalculate_holdings_snapshots(
            &self,
            _account_ids: Option<&[String]>,
            _mode: SnapshotRecalcMode,
        ) -> Result<usize> {
            unimplemented!()
        }

        fn get_holdings_keyframes(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!()
        }

        fn get_daily_holdings_snapshots(
            &self,
            _account_id: &str,
            _start_date: Option<NaiveDate>,
            _end_date: Option<NaiveDate>,
        ) -> Result<Vec<AccountStateSnapshot>> {
            unimplemented!()
        }

        fn get_latest_holdings_snapshot(
            &self,
            account_id: &str,
        ) -> Result<Option<AccountStateSnapshot>> {
            Ok(self.snapshots.get(account_id).cloned())
        }

        async fn save_manual_snapshot(
            &self,
            _account_id: &str,
            _snapshot: AccountStateSnapshot,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn update_snapshots_source(
            &self,
            _account_id: &str,
            _new_source: &str,
        ) -> Result<usize> {
            unimplemented!()
        }

        async fn ensure_holdings_history(&self, _account_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn delete_snapshot_for_account(
            &self,
            _account_id: &str,
            _dates: &[NaiveDate],
        ) -> Result<()> {
            unimplemented!()
        }
    }

    fn snapshot(account_id: &str, positions: &[(&str, Decimal)]) -> AccountStateSnapshot {
        let mut snapshot = AccountStateSnapshot {
            account_id: account_id.to_string(),
            snapshot_date: NaiveDate::from_ymd_opt(2026, 5, 1).unwrap(),
            currency: "USD".to_string(),
            ..AccountStateSnapshot::default()
        };
        for (asset_id, quantity) in positions {
            snapshot.positions.insert(
                (*asset_id).to_string(),
                Position {
                    account_id: account_id.to_string(),
                    asset_id: (*asset_id).to_string(),
                    quantity: *quantity,
                    ..Position::default()
                },
            );
        }
        snapshot
    }

    #[test]
    fn latest_holdings_returns_empty_when_no_account_has_snapshot() {
        let service = MockSnapshotService::default();
        let result = latest_account_snapshot_holdings(&service, &["acc-1".to_string()])
            .expect("snapshot lookup should succeed");

        assert!(result.is_empty());
    }

    #[test]
    fn latest_holdings_uses_available_snapshots_when_an_account_is_missing() {
        let mut service = MockSnapshotService::default();
        service.snapshots.insert(
            "acc-1".to_string(),
            snapshot("acc-1", &[("asset-a", dec!(3))]),
        );

        let result =
            latest_account_snapshot_holdings(&service, &["acc-1".to_string(), "acc-2".to_string()])
                .expect("snapshot lookup should succeed");

        assert_eq!(result.get("asset-a"), Some(&dec!(3)));
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn latest_holdings_keeps_empty_snapshot_distinct_from_missing_snapshot() {
        let mut service = MockSnapshotService::default();
        service
            .snapshots
            .insert("acc-1".to_string(), snapshot("acc-1", &[]));

        let result = latest_account_snapshot_holdings(&service, &["acc-1".to_string()])
            .expect("snapshot lookup should succeed");

        assert!(result.is_empty());
    }

    #[test]
    fn latest_holdings_aggregates_quantities_across_accounts() {
        let mut service = MockSnapshotService::default();
        service.snapshots.insert(
            "acc-1".to_string(),
            snapshot("acc-1", &[("asset-a", dec!(3)), ("asset-b", dec!(1))]),
        );
        service.snapshots.insert(
            "acc-2".to_string(),
            snapshot("acc-2", &[("asset-a", dec!(2))]),
        );

        let result =
            latest_account_snapshot_holdings(&service, &["acc-1".to_string(), "acc-2".to_string()])
                .expect("snapshot lookup should succeed");

        assert_eq!(result.get("asset-a"), Some(&dec!(5)));
        assert_eq!(result.get("asset-b"), Some(&dec!(1)));
    }
}
