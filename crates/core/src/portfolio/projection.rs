//! Storage contract for kernel projections (architecture §3.3). Triggers record
//! what the stored rows no longer reflect in the same transaction as the fact
//! that changed; a run reads those markers, rewrites rows one window at a
//! time, then commits the lot book and clears the markers it consumed.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::errors::Result;
use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::valuation::DailyAccountValuation;

/// "Recompute everything": the day the triggers write for a change that has
/// no date (account or asset facts, policy, the first run).
pub const GENESIS: NaiveDate = wealthfolio_portfolio_engine::BEGINNING;

/// What a marker says is stale.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MarkerScope {
    /// The account's facts changed: refold it.
    Account(String),
    /// An asset's facts changed: refold its holders.
    Asset(String),
    /// An asset's prices changed: revalue its holders.
    Prices(String),
    /// An FX asset's rates changed: revalue every account, and refold those
    /// with activity, from the day after the pair's previous observation.
    Fx(String),
    /// Policy (base currency, timezone) changed: refold every account.
    All,
}

impl MarkerScope {
    pub fn parse(key: &str) -> Self {
        if key == "@all" {
            Self::All
        } else if let Some(asset) = key.strip_prefix("a:") {
            Self::Asset(asset.to_string())
        } else if let Some(asset) = key.strip_prefix("q:") {
            Self::Prices(asset.to_string())
        } else if let Some(asset) = key.strip_prefix("fx:") {
            Self::Fx(asset.to_string())
        } else {
            Self::Account(key.to_string())
        }
    }

    /// The stored `scope` key.
    pub fn key(&self) -> String {
        match self {
            Self::Account(id) => id.clone(),
            Self::Asset(id) => format!("a:{id}"),
            Self::Prices(id) => format!("q:{id}"),
            Self::Fx(id) => format!("fx:{id}"),
            Self::All => "@all".to_string(),
        }
    }
}

/// A pending invalidation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionMarker {
    pub scope: MarkerScope,
    /// First local day whose stored rows are stale.
    pub dirty_from: NaiveDate,
    /// Bumped by every write to the marker: a run clears it only when the
    /// version it read is still current.
    pub version: i64,
}

/// What the last fold of an account had to decide about one of its
/// activities (architecture §4.5), kept for the read path and the health
/// center.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActivityIssueKind {
    /// Rejected: it contributed nothing to the stored rows, and performance
    /// leaves it out too.
    #[default]
    Rejected,
    /// Reduced more units than were held: the held units were disposed and
    /// the rest has no lot.
    Oversold,
    /// Posted without a final amount: it booked no cash.
    MissingAmount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityIssue {
    pub activity_id: String,
    #[serde(default)]
    pub kind: ActivityIssueKind,
    pub message: String,
}

/// One account's rows for one window of a run: stored rows dated from `start`
/// through `end` (or onwards when `end` is `None`) are replaced.
#[derive(Debug, Clone)]
pub struct WindowRows {
    pub account_id: String,
    pub start: NaiveDate,
    pub end: Option<NaiveDate>,
    /// `None` leaves the account's snapshots alone (holdings-mode accounts own
    /// their observed snapshots; a revalue keeps the calculated ones).
    pub snapshots: Option<Vec<AccountStateSnapshot>>,
    pub valuations: Vec<DailyAccountValuation>,
}

/// A refolded account's lot book from `since`: every lot still open plus the
/// lots closed on or after it, and the disposals dated on or after it.
#[derive(Debug, Clone)]
pub struct LotBook {
    pub account_id: String,
    pub since: NaiveDate,
    pub lots: Vec<LotRecord>,
    pub disposals: Vec<LotDisposal>,
}

/// What a run commits last, in one transaction.
#[derive(Debug, Clone, Default)]
pub struct RunCompletion {
    pub lot_books: Vec<LotBook>,
    /// Refolded accounts' activity issues, replacing the stored list.
    pub activity_issues: Vec<(String, Vec<ActivityIssue>)>,
    /// Markers the run consumed; each clears only if its version is unchanged.
    pub consumed: Vec<ProjectionMarker>,
}

#[async_trait]
pub trait ProjectionStoreTrait: Send + Sync {
    /// Every marker with a dirty day.
    fn pending_markers(&self) -> Result<Vec<ProjectionMarker>>;

    /// The latest stored valuation day of every account that has one.
    fn last_valued_days(&self) -> Result<HashMap<String, NaiveDate>>;

    /// Stored activity issues of the accounts.
    fn activity_issues(&self, account_ids: &[String]) -> Result<Vec<ActivityIssue>>;

    /// Replaces the rows of one window, every account in one transaction.
    async fn write_window(&self, rows: Vec<WindowRows>) -> Result<()>;

    /// Writes the lot books and activity issues and clears the consumed
    /// markers.
    async fn complete_run(&self, completion: RunCompletion) -> Result<()>;

    /// Marks `scope` stale from `from` (a forced rebuild, synced facts).
    async fn invalidate(&self, scope: MarkerScope, from: NaiveDate) -> Result<()>;
}
