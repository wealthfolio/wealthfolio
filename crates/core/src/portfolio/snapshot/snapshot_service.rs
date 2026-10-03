//! Holdings snapshots: stored keyframes (calculated by the coordinator or
//! observed for holdings-tracked accounts) served to readers, plus manual
//! snapshot writes that raise `HoldingsChanged`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::NaiveDate;
use log::{debug, info, warn};
use rust_decimal::Decimal;

use super::date_policy::{validate_snapshot_read_date, validate_snapshot_write_date};
use super::holdings_timeline::HoldingsTimeline;
use super::snapshot_model::{AccountStateSnapshot, SnapshotMetadata, SnapshotSource};
use super::snapshot_traits::SnapshotRepositoryTrait;
use crate::accounts::{Account, AccountRepositoryTrait, TrackingMode};
use crate::activities::ActivityRepositoryTrait;
use crate::errors::{Error, Result};
use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::lots::{AssetLotSource, AssetLotView};
use crate::portfolio::coordinator::raw_activity;
use crate::utils::time_utils::{parse_user_timezone_or_default, user_today};
use wealthfolio_portfolio_engine as engine;

#[async_trait]
pub trait SnapshotServiceTrait: Send + Sync {
    /// Retrieves calculated **holdings** keyframe snapshots for a specific real account within a date range.
    /// Does NOT reconstruct daily snapshots; returns only the saved keyframes.
    fn get_holdings_keyframes(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>>;

    /// Retrieves lightweight snapshot metadata, including malformed stored
    /// dates that cannot be represented by `AccountStateSnapshot`.
    fn get_snapshot_metadata(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<SnapshotMetadata>> {
        self.get_holdings_keyframes(account_id, start_date, end_date)
            .map(|snapshots| snapshots.iter().map(SnapshotMetadata::from).collect())
    }

    /// Builds a sparse holdings timeline whose day iterator borrows active keyframes.
    fn get_holdings_timeline(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<HoldingsTimeline>;

    /// Retrieves the most recent **holdings** snapshot for a specific account,
    /// read today (see [`Self::get_latest_snapshots_as_of`]).
    /// Returns `Ok(None)` when no snapshot exists yet. Valuation fields will be zero or default.
    fn get_latest_holdings_snapshot(
        &self,
        account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>>;

    /// The latest snapshot of each account on or before `day`, with its
    /// positions, read on `day`: a holdings account's snapshot states
    /// quantities as of its date, so they are carried across the splits
    /// recorded since, as valuation carries them (engine rules R1.5). Other
    /// accounts' snapshots are projections whose lots are already split.
    fn get_latest_snapshots_as_of(
        &self,
        account_ids: &[String],
        day: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>>;

    /// Carries the snapshot rows of an asset's lot view, read on `day`, as
    /// [`Self::get_latest_snapshots_as_of`] carries snapshots: units multiply
    /// by the splits recorded since the snapshot's date, unit costs divide.
    fn carry_lot_view_rows(&self, rows: &mut [AssetLotView], day: NaiveDate) -> Result<()>;

    /// Saves a manual snapshot for the given account.
    /// - The snapshot's source is preserved from the input (e.g., ManualEntry or CsvImport).
    /// - If a snapshot exists for the same date, it is updated in place.
    /// - If the date is different from existing snapshots, a new snapshot is created.
    /// - Triggers valuation recalculation for the account after saving.
    async fn save_manual_snapshot(
        &self,
        account_id: &str,
        snapshot: AccountStateSnapshot,
    ) -> Result<()>;

    /// Delete snapshot(s) on the given dates.
    /// Keep UI/API callers behind the snapshot service boundary even though
    /// deletion currently delegates directly to storage. Higher-level
    /// orchestration (valuation recalc, frontend events) stays with the caller.
    async fn delete_snapshot_for_account(
        &self,
        account_id: &str,
        dates: &[NaiveDate],
    ) -> Result<()>;

    /// Deletes one snapshot by row ID, including a row whose stored date is
    /// malformed and therefore cannot use the date-based API.
    async fn delete_snapshot_for_account_by_id(
        &self,
        account_id: &str,
        snapshot_id: &str,
    ) -> Result<()> {
        let metadata = self
            .get_snapshot_metadata(account_id, None, None)?
            .into_iter()
            .find(|snapshot| snapshot.id == snapshot_id)
            .ok_or_else(|| {
                Error::Repository(format!(
                    "Snapshot {snapshot_id} for account {account_id} was not found"
                ))
            })?;
        let date = NaiveDate::parse_from_str(&metadata.snapshot_date, "%Y-%m-%d")
            .map_err(|error| Error::Repository(error.to_string()))?;
        self.delete_snapshot_for_account(account_id, &[date]).await
    }
}

/// Snapshot reads and manual writes over the snapshot repository.
#[derive(Clone)]
pub struct SnapshotService {
    timezone: Arc<RwLock<String>>,
    account_repository: Arc<dyn AccountRepositoryTrait>,
    snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    event_sink: Arc<dyn DomainEventSink>,
}

/// What [`SnapshotService`] carries holdings positions across (engine rules
/// R1.5).
#[derive(Default)]
struct SplitCarry {
    holdings: HashSet<String>,
    splits: Vec<engine::SplitEvent>,
}

impl SplitCarry {
    /// The factor of the splits after `as_of` up to `day` for `asset` held
    /// by `account`: one for an account that is not a holdings account (its
    /// lots are already split); `None` when out of range.
    fn factor(
        &self,
        account: &str,
        asset: &str,
        as_of: NaiveDate,
        day: NaiveDate,
    ) -> Option<Decimal> {
        if !self.holdings.contains(account) {
            return Some(Decimal::ONE);
        }
        engine::split_quantity_factor(
            &self.splits,
            &engine::model::AssetId::new(asset),
            as_of,
            day,
        )
    }
}

/// Whether reads use `snapshot` of an account tracked in `mode` (engine rules
/// R1.1, R1.2): a holdings account is read from its own snapshots, any other
/// from the projection's. A snapshot an account kept from the other mode stays
/// stored, for a switch back, but is not read.
fn is_read(mode: TrackingMode, snapshot: &AccountStateSnapshot) -> bool {
    (mode == TrackingMode::Holdings) != (snapshot.source == SnapshotSource::Calculated)
}

/// A quantity and its unit cost carried by `factor`: units multiply, unit
/// cost divides, total cost is unchanged. `None` when out of range.
fn carried(
    quantity: Decimal,
    unit_cost: Decimal,
    factor: Option<Decimal>,
) -> Option<(Decimal, Decimal)> {
    match factor? {
        factor if factor == Decimal::ONE => Some((quantity, unit_cost)),
        factor => Some((
            quantity.checked_mul(factor)?,
            unit_cost.checked_div(factor)?,
        )),
    }
}

impl SnapshotService {
    pub fn new(
        timezone: Arc<RwLock<String>>,
        account_repository: Arc<dyn AccountRepositoryTrait>,
        snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
    ) -> Self {
        Self {
            timezone,
            account_repository,
            snapshot_repository,
            activity_repository,
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    /// The splits a read on `day` carries holdings positions across (engine
    /// rules R1.5): those of the assets `held` by holdings accounts as of an
    /// earlier day, `(account, asset, as_of)`, grouped as the engine groups
    /// them.
    fn split_carry<'a>(
        &self,
        held: impl IntoIterator<Item = (&'a str, &'a str, NaiveDate)>,
        day: NaiveDate,
    ) -> Result<SplitCarry> {
        let held: Vec<(&str, &str, NaiveDate)> = held
            .into_iter()
            .filter(|(_, _, as_of)| *as_of < day)
            .collect();
        let account_ids: Vec<String> = held
            .iter()
            .map(|(account, _, _)| account.to_string())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if account_ids.is_empty() {
            return Ok(SplitCarry::default());
        }
        let holdings: HashSet<String> = self
            .account_repository
            .list(None, None, Some(&account_ids))?
            .into_iter()
            .filter(|account| account.tracking_mode == TrackingMode::Holdings)
            .map(|account| account.id)
            .collect();
        let assets: Vec<String> = held
            .iter()
            .filter(|(account, _, _)| holdings.contains(*account))
            .map(|(_, asset, _)| asset.to_string())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if assets.is_empty() {
            return Ok(SplitCarry::default());
        }
        let timezone = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        let splits = engine::group_splits(
            self.activity_repository
                .get_split_activities_by_asset_ids(&assets)?
                .iter()
                .map(raw_activity)
                .filter_map(|raw| engine::SplitRow::from_raw(&raw, &timezone)),
        );
        Ok(SplitCarry { holdings, splits })
    }

    /// Carries holdings accounts' snapshot quantities to `day`.
    fn carry_splits(
        &self,
        snapshots: &mut HashMap<String, AccountStateSnapshot>,
        day: NaiveDate,
    ) -> Result<()> {
        let carry = self.split_carry(
            snapshots.values().flat_map(|snapshot| {
                snapshot.positions.keys().map(|asset| {
                    (
                        snapshot.account_id.as_str(),
                        asset.as_str(),
                        snapshot.snapshot_date,
                    )
                })
            }),
            day,
        )?;
        for snapshot in snapshots.values_mut() {
            for position in snapshot.positions.values_mut() {
                let factor = carry.factor(
                    &snapshot.account_id,
                    &position.asset_id,
                    snapshot.snapshot_date,
                    day,
                );
                match carried(position.quantity, position.average_cost, factor) {
                    Some((quantity, average_cost)) => {
                        position.quantity = quantity;
                        position.average_cost = average_cost;
                    }
                    None => warn!(
                        "Split factor for {} in snapshot {} is out of range; quantities read as stored",
                        position.asset_id, snapshot.id
                    ),
                }
            }
        }
        Ok(())
    }

    /// The accounts' tracking modes; an account not found is left out.
    fn tracking_modes(&self, account_ids: &[String]) -> Result<HashMap<String, TrackingMode>> {
        Ok(self
            .account_repository
            .list(None, None, Some(account_ids))?
            .into_iter()
            .map(|account| (account.id, account.tracking_mode))
            .collect())
    }

    /// Replaces each latest snapshot (on or before `day`) that reads do not
    /// use with the latest one they do, if any (see [`is_read`]).
    fn keep_read(
        &self,
        snapshots: &mut HashMap<String, AccountStateSnapshot>,
        day: NaiveDate,
    ) -> Result<()> {
        let account_ids: Vec<String> = snapshots.keys().cloned().collect();
        for (account_id, mode) in self.tracking_modes(&account_ids)? {
            if snapshots
                .get(&account_id)
                .is_none_or(|snapshot| is_read(mode, snapshot))
            {
                continue;
            }
            let read = if mode == TrackingMode::Holdings {
                self.snapshot_repository
                    .get_snapshots_by_account(&account_id, None, Some(day))?
                    .into_iter()
                    .filter(|snapshot| is_read(mode, snapshot))
                    .max_by_key(|snapshot| snapshot.snapshot_date)
            } else {
                self.snapshot_repository
                    .get_latest_calculated_snapshot_on_or_before(&account_id, day)?
            };
            match read {
                Some(snapshot) => snapshots.insert(account_id, snapshot),
                None => snapshots.remove(&account_id),
            };
        }
        Ok(())
    }

    /// An account's snapshots in a range, those reads use (see [`is_read`]).
    fn read_snapshots(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        let mut snapshots = self
            .snapshot_repository
            .get_snapshots_by_account(account_id, start_date, end_date)?;
        if let Some(mode) = self
            .tracking_modes(&[account_id.to_string()])?
            .remove(account_id)
        {
            snapshots.retain(|snapshot| is_read(mode, snapshot));
        }
        Ok(snapshots)
    }

    fn create_initial_snapshot(account: &Account, date: NaiveDate) -> AccountStateSnapshot {
        AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(&account.id, date),
            account_id: account.id.clone(),
            snapshot_date: date,
            currency: account.currency.clone(),
            positions: HashMap::new(),
            cash_balances: HashMap::new(),
            cost_basis: Decimal::ZERO,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: Decimal::ZERO,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: crate::utils::clock::now().naive_utc(),
            source: SnapshotSource::Calculated,
        }
    }

    /// Sets the domain event sink for emitting HoldingsChanged events.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    fn user_today(&self) -> NaiveDate {
        let tz = parse_user_timezone_or_default(&self.timezone.read().unwrap());
        user_today(tz)
    }

    /// Emits a HoldingsChanged event for the given accounts and assets.
    fn emit_holdings_changed(&self, account_ids: Vec<String>, asset_ids: Vec<String>) {
        if !account_ids.is_empty() {
            self.event_sink.emit(DomainEvent::HoldingsChanged {
                account_ids,
                asset_ids,
            });
        }
    }
}

#[async_trait]
impl SnapshotServiceTrait for SnapshotService {
    fn get_holdings_keyframes(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        debug!(
            "Getting saved holdings keyframes for {} from {:?} to {:?}",
            account_id, start_date_opt, end_date_opt
        );
        // Directly fetch from the repository without reconstruction
        self.read_snapshots(account_id, start_date_opt, end_date_opt)
    }

    fn get_holdings_timeline(
        &self,
        account_id: &str,
        start_date_opt: Option<NaiveDate>,
        end_date_opt: Option<NaiveDate>,
    ) -> Result<HoldingsTimeline> {
        debug!(
            "Building holdings timeline for {} from {:?} to {:?}",
            account_id, start_date_opt, end_date_opt
        );

        let today = self.user_today();
        if let Some(start_date) = start_date_opt {
            validate_snapshot_read_date(
                account_id,
                start_date,
                SnapshotSource::Calculated.as_str(),
                today,
            )?;
        }
        if let Some(end_date) = end_date_opt {
            validate_snapshot_read_date(
                account_id,
                end_date,
                SnapshotSource::Calculated.as_str(),
                today,
            )?;
        }
        let all_keyframes = self.read_snapshots(account_id, None, None)?;
        let deferred_future_snapshots = all_keyframes
            .iter()
            .any(|snapshot| snapshot.snapshot_date > today);
        for snapshot in &all_keyframes {
            validate_snapshot_read_date(
                account_id,
                snapshot.snapshot_date,
                snapshot.source.as_str(),
                today,
            )?;
        }
        let eligible_keyframes: Vec<_> = all_keyframes
            .into_iter()
            .filter(|snapshot| snapshot.snapshot_date <= today)
            .collect();
        // Match the former dense engine's BTreeMap behavior: for duplicate dates,
        // the last repository row wins.
        let eligible_keyframes: Vec<_> = eligible_keyframes
            .into_iter()
            .map(|snapshot| (snapshot.snapshot_date, snapshot))
            .collect::<BTreeMap<_, _>>()
            .into_values()
            .collect();
        let earliest_snapshot_date = eligible_keyframes
            .iter()
            .map(|snapshot| snapshot.snapshot_date)
            .min();

        let start_date = match start_date_opt {
            Some(date) => {
                // Before the first holdings snapshot the value is unknown, not zero.
                // Keep partial valuation rebuilds consistent with full rebuilds.
                match earliest_snapshot_date {
                    Some(first)
                        if date < first
                            && self.account_repository.get_by_id(account_id)?.tracking_mode
                                == TrackingMode::Holdings =>
                    {
                        first
                    }
                    _ => date,
                }
            }
            None => match earliest_snapshot_date {
                Some(date) => date,
                None => {
                    debug!(
                        "No snapshots found for account {}. Returning empty.",
                        account_id
                    );
                    return Ok(HoldingsTimeline::new(
                        None,
                        today,
                        Vec::new(),
                        None,
                        deferred_future_snapshots,
                    ));
                }
            },
        };

        let end_date = end_date_opt.unwrap_or(today).min(today);

        if start_date > end_date {
            warn!(
                "get_holdings_timeline: Start date {} is after end date {}. Returning empty.",
                start_date, end_date
            );
            return Ok(HoldingsTimeline::new(
                None,
                end_date,
                Vec::new(),
                None,
                deferred_future_snapshots,
            ));
        }

        let anchor = eligible_keyframes
            .iter()
            .filter(|snapshot| snapshot.snapshot_date <= start_date)
            .max_by_key(|snapshot| snapshot.snapshot_date)
            .cloned();
        let mut timeline_keyframes = Vec::new();
        if let Some(anchor) = anchor {
            timeline_keyframes.push(anchor);
        }
        timeline_keyframes.extend(eligible_keyframes.into_iter().filter(|snapshot| {
            snapshot.snapshot_date > start_date && snapshot.snapshot_date <= end_date
        }));
        timeline_keyframes.sort_by_key(|snapshot| snapshot.snapshot_date);

        if timeline_keyframes.is_empty() {
            return Ok(HoldingsTimeline::new(
                None,
                end_date,
                Vec::new(),
                None,
                deferred_future_snapshots,
            ));
        }

        let empty_state = if timeline_keyframes
            .first()
            .is_some_and(|snapshot| snapshot.snapshot_date > start_date)
        {
            let account = self.account_repository.get_by_id(account_id).map_err(|_| {
                Error::Repository(format!(
                    "Account not found while building holdings timeline: {}",
                    account_id
                ))
            })?;
            Some(Self::create_initial_snapshot(
                &account,
                start_date.pred_opt().unwrap_or(start_date),
            ))
        } else {
            None
        };

        Ok(HoldingsTimeline::new(
            Some(start_date),
            end_date,
            timeline_keyframes,
            empty_state,
            deferred_future_snapshots,
        ))
    }

    fn get_latest_holdings_snapshot(
        &self,
        account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>> {
        let today = self.user_today();
        // The date passed to get_latest_snapshot_before_date is exclusive, so use tomorrow to include today.
        let tomorrow = today.succ_opt().unwrap_or(today);
        let mut snapshots: HashMap<String, AccountStateSnapshot> = self
            .snapshot_repository
            .get_latest_snapshot_before_date(account_id, tomorrow)?
            .map(|snapshot| (account_id.to_string(), snapshot))
            .into_iter()
            .collect();
        self.keep_read(&mut snapshots, tomorrow)?;
        if snapshots.is_empty() {
            // It's possible no snapshot exists yet, which is not necessarily an error,
            // but we should inform the caller.
            debug!(
                "No snapshot found for account {} on or before {}",
                account_id, today
            );
            return Ok(None);
        }
        self.carry_splits(&mut snapshots, today)?;
        Ok(snapshots.remove(account_id))
    }

    fn get_latest_snapshots_as_of(
        &self,
        account_ids: &[String],
        day: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        let mut snapshots = self
            .snapshot_repository
            .get_latest_snapshots_before_date(account_ids, day)?;
        self.keep_read(&mut snapshots, day)?;
        if snapshots.is_empty() {
            return Ok(snapshots);
        }
        let snapshot_ids: Vec<String> = snapshots
            .values()
            .map(|snapshot| snapshot.id.clone())
            .collect();
        let mut positions = self
            .snapshot_repository
            .get_snapshot_positions_batch(&snapshot_ids)?;
        for snapshot in snapshots.values_mut() {
            if let Some(positions) = positions.remove(&snapshot.id) {
                snapshot.positions = positions;
            }
        }
        self.carry_splits(&mut snapshots, day)?;
        Ok(snapshots)
    }

    fn carry_lot_view_rows(&self, rows: &mut [AssetLotView], day: NaiveDate) -> Result<()> {
        let as_of = |row: &AssetLotView| {
            (row.source == AssetLotSource::SnapshotPosition)
                .then_some(row.snapshot_date.as_deref())
                .flatten()
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        };
        let carry = self.split_carry(
            rows.iter().filter_map(|row| {
                as_of(row).map(|as_of| (row.account_id.as_str(), row.asset_id.as_str(), as_of))
            }),
            day,
        )?;
        for row in rows.iter_mut() {
            let Some(as_of) = as_of(row) else {
                continue;
            };
            let factor = carry.factor(&row.account_id, &row.asset_id, as_of, day);
            let quantity = carried(row.quantity, row.unit_cost, factor);
            let valuation_unit_cost = carried(row.quantity, row.valuation_unit_cost, factor);
            match quantity.zip(valuation_unit_cost) {
                Some(((quantity, unit_cost), (_, valuation_unit_cost))) => {
                    row.quantity = quantity;
                    row.original_quantity = quantity;
                    row.remaining_quantity = quantity;
                    row.unit_cost = unit_cost;
                    row.valuation_unit_cost = valuation_unit_cost;
                }
                None => warn!(
                    "Split factor for {} in lot row {} is out of range; quantities read as stored",
                    row.asset_id, row.id
                ),
            }
        }
        Ok(())
    }

    async fn save_manual_snapshot(
        &self,
        account_id: &str,
        mut snapshot: AccountStateSnapshot,
    ) -> Result<()> {
        // Ensure the snapshot has the correct account_id
        snapshot.account_id = account_id.to_string();

        validate_snapshot_write_date(
            account_id,
            snapshot.snapshot_date,
            snapshot.source.as_str(),
            self.user_today(),
        )?;

        // Note: snapshot.source is preserved from the caller (ManualEntry or CsvImport)

        // Generate the snapshot ID based on account_id and date
        snapshot.id = AccountStateSnapshot::stable_id(account_id, snapshot.snapshot_date);

        // Check if content is unchanged from existing snapshot on the same date (skip if identical)
        // Only compare against the same date because stable IDs are date-based.
        let same_date_snapshots = self.snapshot_repository.get_snapshots_by_account(
            account_id,
            Some(snapshot.snapshot_date),
            Some(snapshot.snapshot_date),
        )?;

        if let Some(existing) = same_date_snapshots.into_iter().next() {
            if existing.is_content_equal(&snapshot) {
                debug!(
                    "Snapshot content unchanged for account {} on {}, skipping save",
                    account_id, snapshot.snapshot_date
                );
                // ManualSnapshotService may already have updated quote mode or
                // persisted a manual quote before this snapshot-level no-op.
                // Keep the dated recalculation signal even when the snapshot
                // row itself does not need to be rewritten.
                let asset_ids: Vec<String> = snapshot
                    .positions
                    .values()
                    .map(|position| position.asset_id.clone())
                    .collect();
                self.emit_holdings_changed(vec![account_id.to_string()], asset_ids);
                return Ok(());
            }
        }

        // Update the calculated_at timestamp
        snapshot.calculated_at = crate::utils::clock::now().naive_utc();

        // Save or update the snapshot using repository method
        self.snapshot_repository
            .save_or_update_snapshot(&snapshot)
            .await?;

        info!(
            "Saved manual snapshot for account {} on date {}",
            account_id, snapshot.snapshot_date
        );

        // Emit HoldingsChanged event after successful save
        let asset_ids: Vec<String> = snapshot
            .positions
            .values()
            .map(|p| p.asset_id.clone())
            .collect();
        self.emit_holdings_changed(vec![account_id.to_string()], asset_ids);

        Ok(())
    }

    async fn delete_snapshot_for_account(
        &self,
        account_id: &str,
        dates: &[NaiveDate],
    ) -> Result<()> {
        self.snapshot_repository
            .delete_snapshots_for_account_and_dates(account_id, dates)
            .await?;
        Ok(())
    }

    fn get_snapshot_metadata(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<SnapshotMetadata>> {
        self.snapshot_repository
            .get_snapshot_metadata_by_account(account_id, start_date, end_date)
    }

    async fn delete_snapshot_for_account_by_id(
        &self,
        account_id: &str,
        snapshot_id: &str,
    ) -> Result<()> {
        self.snapshot_repository
            .delete_snapshot_for_account_by_id(account_id, snapshot_id)
            .await
    }
}
