//! Storage contract for kernel projections: one atomic write per account
//! (keyframes, lots, disposals, valuations and the watermark row) and the
//! watermark reads the consistency check needs (architecture §3.3).

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::errors::Result;
use crate::lots::{LotDisposal, LotRecord};
use crate::portfolio::snapshot::AccountStateSnapshot;
use crate::portfolio::valuation::DailyAccountValuation;

/// What was last projected for an account and from which facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionWatermark {
    pub account_id: String,
    /// Engine that wrote the rows (`kernel`).
    pub engine: String,
    /// Serialized [`crate::portfolio::coordinator::AccountFingerprint`].
    pub fingerprint: String,
    /// Policy day the projection ran for.
    pub as_of: NaiveDate,
    pub computed_at: DateTime<Utc>,
}

/// The kernel's projection state of one account at the end of a chunk: the
/// starting point of a resumed run (architecture §3.3 chunk watermark). `state` is
/// the account's `AccountState` as JSON; `transfer_cache` the closure's
/// in-flight transfer lots at that date, also JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionCheckpoint {
    pub account_id: String,
    pub date: NaiveDate,
    pub state: String,
    pub transfer_cache: String,
}

/// Everything one account's projection writes, committed together.
#[derive(Debug, Clone)]
pub struct AccountProjection {
    pub account_id: String,
    /// `None` leaves the account's snapshots alone (holdings-mode accounts
    /// own their observed snapshots).
    pub snapshots: Option<Vec<AccountStateSnapshot>>,
    /// `None` leaves lot rows alone.
    pub lots: Option<Vec<LotRecord>>,
    pub disposals: Option<Vec<LotDisposal>>,
    pub valuations: Vec<DailyAccountValuation>,
    pub watermark: ProjectionWatermark,
    /// `Some(date)`: a resumed run; rows dated on or after it are replaced
    /// and earlier rows are kept. `None`: every row of the account is replaced.
    pub since: Option<NaiveDate>,
    /// `None` leaves the stored checkpoints alone (a revalue-only run).
    pub checkpoints: Option<Vec<ProjectionCheckpoint>>,
}

#[async_trait]
pub trait ProjectionStoreTrait: Send + Sync {
    fn get_watermarks(&self, account_ids: &[String]) -> Result<Vec<ProjectionWatermark>>;

    /// Every stored checkpoint of the accounts, any date order.
    fn get_checkpoints(&self, account_ids: &[String]) -> Result<Vec<ProjectionCheckpoint>>;

    /// Replaces the account's projected rows and its watermark in ONE
    /// transaction, so an interrupted job never leaves a partial account.
    async fn persist_account_projection(&self, projection: AccountProjection) -> Result<()>;
}
