//! Captured accounting inputs for one holdings read. Storage captures these
//! together; core interprets them after the read transaction has ended.
use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::NaiveDate;

use crate::accounts::{Account, TrackingMode};
use crate::activities::Activity;
use crate::assets::Asset;
use crate::fx::ExchangeRate;
use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::projection::{ActivityIssue, MarkerScope, ProjectionMarker};
use crate::portfolio::snapshot::{AccountStateSnapshot, SnapshotSource};

#[derive(Default)]
pub struct HoldingsRead {
    pub day: NaiveDate,
    pub accounts: Vec<Account>,
    pub snapshots: HashMap<String, AccountStateSnapshot>,
    pub unavailable_accounts: HashSet<String>,
    pub assets: HashMap<String, Asset>,
    /// Requested accounts and their transitive transfer counterparties, plus
    /// split rows for held assets (including splits recorded in other accounts).
    pub activities: Vec<Activity>,
    pub fx_rates: Vec<ExchangeRate>,
    pub lots: Vec<LotRecord>,
    pub accounts_with_open_lots: HashSet<String>,
    pub disposals: Vec<LotDisposal>,
    pub markers: Vec<ProjectionMarker>,
    pub issues: Vec<ActivityIssue>,
    pub last_valued: HashMap<String, NaiveDate>,
    pub base_currency: String,
    pub timezone: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncompleteHoldingsAccount {
    pub account_id: String,
    pub status: &'static str,
    pub reason_code: &'static str,
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsScope {
    pub holdings: Vec<super::Holding>,
    pub incomplete_accounts: Vec<IncompleteHoldingsAccount>,
}

impl HoldingsScope {
    pub fn require_complete(self) -> crate::Result<Vec<super::Holding>> {
        if self.incomplete_accounts.is_empty() {
            return Ok(self.holdings);
        }
        if self
            .incomplete_accounts
            .iter()
            .any(|account| account.status == "unavailable")
        {
            return Err(crate::Error::HoldingsUnavailable(
                "accounting inputs are missing or invalid".into(),
            ));
        }
        Err(crate::Error::HoldingsPending(
            self.incomplete_accounts
                .into_iter()
                .map(|a| a.account_id)
                .collect(),
        ))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingsListResponse {
    pub holdings: Vec<super::HoldingListItem>,
    pub incomplete_accounts: Vec<IncompleteHoldingsAccount>,
}

impl From<HoldingsScope> for HoldingsListResponse {
    fn from(scope: HoldingsScope) -> Self {
        Self {
            holdings: scope.holdings.into_iter().map(Into::into).collect(),
            incomplete_accounts: scope.incomplete_accounts,
        }
    }
}

impl HoldingsRead {
    pub fn carry_observed_splits(&mut self) -> crate::Result<()> {
        let timezone = crate::utils::time_utils::parse_user_timezone_or_default(&self.timezone);
        let splits = wealthfolio_portfolio_engine::group_splits(
            self.activities
                .iter()
                .map(crate::portfolio::coordinator::raw_activity)
                .filter_map(|raw| {
                    wealthfolio_portfolio_engine::SplitRow::from_raw(&raw, &timezone)
                }),
        );
        for (id, snapshot) in &mut self.snapshots {
            if self
                .accounts
                .iter()
                .any(|a| a.id == *id && a.tracking_mode == TrackingMode::Holdings)
            {
                crate::portfolio::snapshot::snapshot_service::carry_snapshot_splits(
                    snapshot, &splits, self.day,
                )?;
            }
        }
        Ok(())
    }

    /// Marker dependencies include closed positions and transfer counterparties;
    /// limiting these to today's open assets can expose an obsolete lot book.
    pub fn history_pending(&self, account_id: &str, day: NaiveDate) -> bool {
        let mut accounts = BTreeSet::from([account_id.to_string()]);
        loop {
            let groups: HashSet<&str> = self
                .activities
                .iter()
                .filter(|a| accounts.contains(&a.account_id))
                .filter_map(|a| a.source_group_id.as_deref())
                .collect();
            let partners: Vec<String> = self
                .activities
                .iter()
                .filter(|a| {
                    a.source_group_id
                        .as_deref()
                        .is_some_and(|g| groups.contains(g))
                })
                .map(|a| a.account_id.clone())
                .collect();
            let before = accounts.len();
            accounts.extend(partners);
            if accounts.len() == before {
                break;
            }
        }
        let assets: HashSet<&str> = self
            .activities
            .iter()
            .filter(|a| accounts.contains(&a.account_id))
            .filter_map(|a| a.asset_id.as_deref())
            .chain(
                self.snapshots
                    .iter()
                    .filter(|(id, _)| accounts.contains(*id))
                    .flat_map(|(_, snapshot)| snapshot.positions.keys().map(String::as_str)),
            )
            .collect();
        self.markers.iter().any(|marker| match &marker.scope {
            MarkerScope::All | MarkerScope::Fx(_) => true,
            MarkerScope::Account(id) => accounts.contains(id),
            MarkerScope::Asset(id) | MarkerScope::Prices(id) => assets.contains(id.as_str()),
        }) || self
            .last_valued
            .get(account_id)
            .is_some_and(|last| *last < day)
    }

    pub fn position_pending(&self, account_id: &str, day: NaiveDate) -> bool {
        let observed = self
            .accounts
            .iter()
            .any(|a| a.id == account_id && a.tracking_mode == TrackingMode::Holdings);
        !observed
            && (self.history_pending(account_id, day)
                || self
                    .snapshots
                    .get(account_id)
                    .is_some_and(|s| s.base_currency.is_none())
                || (!self.last_valued.contains_key(account_id)
                    && self.activities.iter().any(|a| a.account_id == account_id)))
    }

    /// Selection matches SnapshotService's tracking-mode rule. The retained
    /// snapshots from the other mode remain stored but cannot enter this view.
    pub fn reads_snapshot(account: &Account, snapshot: &AccountStateSnapshot) -> bool {
        (account.tracking_mode == TrackingMode::Holdings)
            != (snapshot.source == SnapshotSource::Calculated)
    }
}
