//! In-memory doubles for the repositories and services the calculation path
//! depends on. They mirror the storage semantics that affect results (sparse
//! quote seeding, lot sync rules, snapshot overwrite ranges, DB rounding) so
//! the legacy capture harness observes what production observes. Methods the
//! calculation path never calls panic loudly instead of returning fake data.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Mutex, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rust_decimal::Decimal;

use crate::accounts::{
    Account, AccountAccountingSettings, AccountRepositoryTrait, AccountUpdate, NewAccount,
};
use crate::activities::*;
use crate::assets::AssetRepositoryTrait;
use crate::assets::{Asset, InstrumentType, NewAsset, ProviderProfile, UpdateAssetProfile};
use crate::constants::DECIMAL_PRECISION;
use crate::errors::{DatabaseError, Error, Result};
use crate::fx::currency::{get_normalization_rule, normalize_currency_code};
use crate::fx::{ExchangeRate, FxRepositoryTrait};
use crate::limits::ContributionActivity;
use crate::lots::{AssetLotView, LotDisposal, LotRecord, LotRepositoryTrait};
use crate::portfolio::snapshot::{
    AccountStateSnapshot, Position, SnapshotRepositoryTrait, SnapshotSource,
};
use crate::portfolio::valuation::{
    DailyAccountValuation, NegativeBalanceInfo, ValuationRepositoryTrait,
};
use crate::quotes::*;

macro_rules! not_needed {
    ($method:literal) => {
        unimplemented!(concat!(
            "in-memory test double: `",
            $method,
            "` is not used by the calculation path"
        ))
    };
}

fn not_found(what: impl Into<String>) -> Error {
    Error::Database(DatabaseError::NotFound(what.into()))
}

fn midnight_utc(day: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight"))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

pub struct InMemoryAccountRepository {
    accounts: Vec<Account>,
    accounting: RwLock<HashMap<String, AccountAccountingSettings>>,
}

impl InMemoryAccountRepository {
    pub fn new(accounts: Vec<Account>) -> Self {
        Self {
            accounts,
            accounting: RwLock::new(HashMap::new()),
        }
    }

    /// Overrides the default FIFO/GENERIC/ACCOUNT settings of one account.
    pub fn set_accounting_settings(&self, settings: AccountAccountingSettings) {
        self.accounting
            .write()
            .unwrap()
            .insert(settings.account_id.clone(), settings);
    }
}

#[async_trait]
impl AccountRepositoryTrait for InMemoryAccountRepository {
    fn get_accounting_settings_by_account_ids(
        &self,
        account_ids: &[String],
    ) -> Result<HashMap<String, AccountAccountingSettings>> {
        let overrides = self.accounting.read().unwrap();
        Ok(account_ids
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    overrides.get(id).cloned().unwrap_or_else(|| {
                        AccountAccountingSettings::default_for_account(id.clone())
                    }),
                )
            })
            .collect())
    }

    async fn create(&self, _new_account: NewAccount) -> Result<Account> {
        not_needed!("AccountRepositoryTrait::create")
    }

    async fn update(&self, _account_update: AccountUpdate) -> Result<Account> {
        not_needed!("AccountRepositoryTrait::update")
    }

    async fn delete(&self, _account_id: &str) -> Result<usize> {
        not_needed!("AccountRepositoryTrait::delete")
    }

    fn get_by_id(&self, account_id: &str) -> Result<Account> {
        self.accounts
            .iter()
            .find(|account| account.id == account_id)
            .cloned()
            .ok_or_else(|| not_found(format!("account {account_id}")))
    }

    fn list(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>> {
        Ok(self
            .accounts
            .iter()
            .filter(|account| is_active_filter.is_none_or(|flag| account.is_active == flag))
            .filter(|account| is_archived_filter.is_none_or(|flag| account.is_archived == flag))
            .filter(|account| account_ids.is_none_or(|ids| ids.contains(&account.id)))
            .cloned()
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

pub struct InMemoryAssetRepository {
    assets: Vec<Asset>,
}

impl InMemoryAssetRepository {
    pub fn new(assets: Vec<Asset>) -> Self {
        Self { assets }
    }
}

#[async_trait]
impl AssetRepositoryTrait for InMemoryAssetRepository {
    async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
        not_needed!("AssetRepositoryTrait::create")
    }

    async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
        not_needed!("AssetRepositoryTrait::create_batch")
    }

    async fn update_profile(&self, _asset_id: &str, _payload: UpdateAssetProfile) -> Result<Asset> {
        not_needed!("AssetRepositoryTrait::update_profile")
    }

    async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
        not_needed!("AssetRepositoryTrait::update_quote_mode")
    }

    fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
        self.assets
            .iter()
            .find(|asset| asset.id == asset_id)
            .cloned()
            .ok_or_else(|| not_found(format!("asset {asset_id}")))
    }

    fn list(&self) -> Result<Vec<Asset>> {
        Ok(self.assets.clone())
    }

    fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
        Ok(self
            .assets
            .iter()
            .filter(|asset| asset_ids.contains(&asset.id))
            .cloned()
            .collect())
    }

    async fn delete(&self, _asset_id: &str) -> Result<()> {
        not_needed!("AssetRepositoryTrait::delete")
    }

    fn search_by_symbol(&self, query: &str) -> Result<Vec<Asset>> {
        let query = query.to_ascii_uppercase();
        Ok(self
            .assets
            .iter()
            .filter(|asset| {
                asset
                    .instrument_symbol
                    .as_deref()
                    .is_some_and(|symbol| symbol.to_ascii_uppercase().contains(&query))
            })
            .cloned()
            .collect())
    }

    fn find_by_instrument_key(&self, instrument_key: &str) -> Result<Option<Asset>> {
        Ok(self
            .assets
            .iter()
            .find(|asset| asset.instrument_key.as_deref() == Some(instrument_key))
            .cloned())
    }

    async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
        not_needed!("AssetRepositoryTrait::cleanup_legacy_metadata")
    }

    async fn deactivate(&self, _asset_id: &str) -> Result<()> {
        not_needed!("AssetRepositoryTrait::deactivate")
    }

    async fn reactivate(&self, _asset_id: &str) -> Result<()> {
        not_needed!("AssetRepositoryTrait::reactivate")
    }

    async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
        not_needed!("AssetRepositoryTrait::copy_user_metadata")
    }

    async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
        not_needed!("AssetRepositoryTrait::deactivate_orphaned_investments")
    }
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

/// Rows ordered like the SQLite repository: `activity_date ASC`, ties in
/// insertion order (the scan order the legacy pipeline inherits).
pub struct InMemoryActivityRepository {
    activities: RwLock<Vec<Activity>>,
    archived_accounts: HashSet<String>,
}

impl InMemoryActivityRepository {
    pub fn new(mut activities: Vec<Activity>, archived_accounts: HashSet<String>) -> Self {
        activities.sort_by_key(|activity| activity.activity_date);
        Self {
            activities: RwLock::new(activities),
            archived_accounts,
        }
    }

    /// Applies a lifecycle mutation: replacements by id, removals, appends;
    /// rows are re-sorted by date with ties keeping their insertion order.
    pub fn apply(&self, add: Vec<Activity>, update: Vec<Activity>, remove: &[String]) {
        let mut rows = self.activities.write().unwrap_or_else(|p| p.into_inner());
        for updated in update {
            if let Some(slot) = rows.iter_mut().find(|row| row.id == updated.id) {
                *slot = updated;
            }
        }
        rows.retain(|row| !remove.contains(&row.id));
        rows.extend(add);
        rows.sort_by_key(|activity| activity.activity_date);
    }

    /// Current rows (every account, every status).
    pub fn all(&self) -> Vec<Activity> {
        self.activities
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn visible(&self) -> Vec<Activity> {
        self.activities
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|activity| !self.archived_accounts.contains(&activity.account_id))
            .cloned()
            .collect()
    }
}

#[async_trait]
impl ActivityRepositoryTrait for InMemoryActivityRepository {
    fn get_activity(&self, activity_id: &str) -> Result<Activity> {
        self.all()
            .into_iter()
            .find(|activity| activity.id == activity_id)
            .ok_or_else(|| not_found(format!("activity {activity_id}")))
    }

    fn find_transfer_counterpart(
        &self,
        group_id: &str,
        exclude_id: &str,
    ) -> Result<Option<Activity>> {
        Ok(self.visible().into_iter().find(|activity| {
            activity.source_group_id.as_deref() == Some(group_id) && activity.id != exclude_id
        }))
    }

    fn get_activities(&self) -> Result<Vec<Activity>> {
        Ok(self.visible())
    }

    fn get_activities_including_archived_accounts(&self) -> Result<Vec<Activity>> {
        Ok(self.activities.read().unwrap().clone())
    }

    fn get_activities_by_account_ids_including_archived(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<Activity>> {
        Ok(self
            .activities
            .read()
            .unwrap()
            .iter()
            .filter(|a| account_ids.contains(&a.account_id))
            .cloned()
            .collect())
    }

    fn get_activities_by_source_group_ids(&self, group_ids: &[String]) -> Result<Vec<Activity>> {
        Ok(self
            .activities
            .read()
            .unwrap()
            .iter()
            .filter(|a| {
                a.source_group_id
                    .as_deref()
                    .is_some_and(|g| group_ids.iter().any(|w| w == g))
            })
            .cloned()
            .collect())
    }

    fn get_activities_by_account_id(&self, account_id: &str) -> Result<Vec<Activity>> {
        Ok(self
            .visible()
            .into_iter()
            .filter(|activity| activity.account_id == account_id)
            .collect())
    }

    fn get_activities_by_account_ids(&self, account_ids: &[String]) -> Result<Vec<Activity>> {
        Ok(self
            .visible()
            .into_iter()
            .filter(|activity| account_ids.contains(&activity.account_id))
            .collect())
    }

    fn get_trading_activities(&self) -> Result<Vec<Activity>> {
        Ok(self
            .visible()
            .into_iter()
            .filter(|activity| {
                matches!(
                    activity.effective_type(),
                    ACTIVITY_TYPE_BUY | ACTIVITY_TYPE_SELL
                )
            })
            .collect())
    }

    fn get_income_activities(&self) -> Result<Vec<Activity>> {
        Ok(self
            .visible()
            .into_iter()
            .filter(|activity| {
                matches!(
                    activity.effective_type(),
                    ACTIVITY_TYPE_DIVIDEND | ACTIVITY_TYPE_INTEREST
                )
            })
            .collect())
    }

    fn get_contribution_activities(
        &self,
        _account_ids: &[String],
        _start_utc: DateTime<Utc>,
        _end_exclusive_utc: DateTime<Utc>,
    ) -> Result<Vec<ContributionActivity>> {
        not_needed!("ActivityRepositoryTrait::get_contribution_activities")
    }

    #[allow(clippy::too_many_arguments)]
    fn search_activities(
        &self,
        _page: i64,
        _page_size: i64,
        _account_id_filter: Option<Vec<String>>,
        _activity_type_filter: Option<Vec<String>>,
        _asset_id_keyword: Option<String>,
        _sort: Option<Sort>,
        _needs_review_filter: Option<bool>,
        _date_from: Option<NaiveDate>,
        _date_to: Option<NaiveDate>,
        _instrument_type_filter: Option<Vec<String>>,
        _activity_id_filter: Option<Vec<String>>,
    ) -> Result<ActivitySearchResponse> {
        not_needed!("ActivityRepositoryTrait::search_activities")
    }

    async fn create_activity(&self, _new_activity: NewActivity) -> Result<Activity> {
        not_needed!("ActivityRepositoryTrait::create_activity")
    }

    async fn update_activity(&self, _activity_update: ActivityUpdate) -> Result<Activity> {
        not_needed!("ActivityRepositoryTrait::update_activity")
    }

    async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
        not_needed!("ActivityRepositoryTrait::delete_activity")
    }

    async fn link_transfer_activities(
        &self,
        _activity_a_id: String,
        _activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        not_needed!("ActivityRepositoryTrait::link_transfer_activities")
    }

    async fn unlink_transfer_activities(
        &self,
        _activity_a_id: String,
        _activity_b_id: String,
    ) -> Result<(Activity, Activity)> {
        not_needed!("ActivityRepositoryTrait::unlink_transfer_activities")
    }

    async fn bulk_mutate_activities(
        &self,
        _creates: Vec<NewActivity>,
        _updates: Vec<ActivityUpdate>,
        _delete_ids: Vec<String>,
    ) -> Result<ActivityBulkMutationResult> {
        not_needed!("ActivityRepositoryTrait::bulk_mutate_activities")
    }

    async fn create_activities(&self, _activities: Vec<NewActivity>) -> Result<usize> {
        not_needed!("ActivityRepositoryTrait::create_activities")
    }

    fn get_first_activity_date(
        &self,
        account_ids: Option<&[String]>,
    ) -> Result<Option<DateTime<Utc>>> {
        Ok(self
            .visible()
            .into_iter()
            .filter(|activity| account_ids.is_none_or(|ids| ids.contains(&activity.account_id)))
            .map(|activity| activity.activity_date)
            .min())
    }

    fn get_import_mapping(
        &self,
        _account_id: &str,
        _context_kind: &str,
    ) -> Result<Option<ImportMapping>> {
        not_needed!("ActivityRepositoryTrait::get_import_mapping")
    }

    async fn save_import_mapping(&self, _mapping: &ImportMapping) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::save_import_mapping")
    }

    async fn link_account_template(
        &self,
        _account_id: &str,
        _template_id: &str,
        _context_kind: &str,
    ) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::link_account_template")
    }

    fn list_import_templates(&self) -> Result<Vec<ImportTemplate>> {
        not_needed!("ActivityRepositoryTrait::list_import_templates")
    }

    fn get_import_template(&self, _template_id: &str) -> Result<Option<ImportTemplate>> {
        not_needed!("ActivityRepositoryTrait::get_import_template")
    }

    async fn save_import_template(&self, _template: &ImportTemplate) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::save_import_template")
    }

    async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::delete_import_template")
    }

    fn get_broker_sync_profile(
        &self,
        _account_id: &str,
        _source_system: &str,
    ) -> Result<Option<ImportTemplate>> {
        not_needed!("ActivityRepositoryTrait::get_broker_sync_profile")
    }

    async fn save_broker_sync_profile(&self, _template: &ImportTemplate) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::save_broker_sync_profile")
    }

    async fn link_broker_sync_profile(
        &self,
        _account_id: &str,
        _template_id: &str,
        _source_system: &str,
    ) -> Result<()> {
        not_needed!("ActivityRepositoryTrait::link_broker_sync_profile")
    }

    fn calculate_average_cost(&self, _account_id: &str, _asset_id: &str) -> Result<Decimal> {
        not_needed!("ActivityRepositoryTrait::calculate_average_cost")
    }

    fn get_income_activities_data(
        &self,
        _account_ids: Option<&[String]>,
    ) -> Result<Vec<IncomeData>> {
        not_needed!("ActivityRepositoryTrait::get_income_activities_data")
    }

    fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
        self.get_first_activity_date(None)?
            .ok_or_else(|| not_found("no activities"))
    }

    #[allow(clippy::type_complexity)]
    fn get_activity_bounds_for_assets(
        &self,
        _asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        not_needed!("ActivityRepositoryTrait::get_activity_bounds_for_assets")
    }

    #[allow(clippy::type_complexity)]
    fn get_holdings_snapshot_bounds_for_assets(
        &self,
        _asset_ids: &[String],
    ) -> Result<HashMap<String, (Option<NaiveDate>, Option<NaiveDate>)>> {
        not_needed!("ActivityRepositoryTrait::get_holdings_snapshot_bounds_for_assets")
    }

    fn check_existing_duplicates(
        &self,
        _idempotency_keys: &[String],
    ) -> Result<HashMap<String, String>> {
        not_needed!("ActivityRepositoryTrait::check_existing_duplicates")
    }

    async fn bulk_upsert(&self, _activities: Vec<ActivityUpsert>) -> Result<BulkUpsertResult> {
        not_needed!("ActivityRepositoryTrait::bulk_upsert")
    }

    async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
        not_needed!("ActivityRepositoryTrait::reassign_asset")
    }

    async fn get_activity_accounts_and_currencies_by_asset_id(
        &self,
        _asset_id: &str,
    ) -> Result<(Vec<String>, Vec<String>)> {
        not_needed!("ActivityRepositoryTrait::get_activity_accounts_and_currencies_by_asset_id")
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

type SnapshotRows = HashMap<String, BTreeMap<NaiveDate, AccountStateSnapshot>>;

/// Keyframe store. Mirrors the SQLite round trip that matters for results:
/// lots are not persisted with positions (the relational `snapshot_positions`
/// table has no lots) and the aggregate scalars are stored at
/// `DECIMAL_PRECISION`.
pub struct InMemorySnapshotRepository {
    rows: Mutex<SnapshotRows>,
    archived_accounts: HashSet<String>,
}

impl InMemorySnapshotRepository {
    pub fn new(archived_accounts: HashSet<String>) -> Self {
        Self {
            rows: Mutex::new(HashMap::new()),
            archived_accounts,
        }
    }

    fn stored(snapshot: &AccountStateSnapshot) -> AccountStateSnapshot {
        let mut stored = snapshot.clone();
        for position in stored.positions.values_mut() {
            position.lots.clear();
        }
        stored.cost_basis = stored.cost_basis.round_dp(DECIMAL_PRECISION);
        stored.net_contribution = stored.net_contribution.round_dp(DECIMAL_PRECISION);
        stored.net_contribution_base = stored.net_contribution_base.round_dp(DECIMAL_PRECISION);
        stored.cash_total_account_currency = stored
            .cash_total_account_currency
            .round_dp(DECIMAL_PRECISION);
        stored.cash_total_base_currency =
            stored.cash_total_base_currency.round_dp(DECIMAL_PRECISION);
        stored
    }

    fn upsert(rows: &mut SnapshotRows, snapshot: &AccountStateSnapshot) {
        rows.entry(snapshot.account_id.clone())
            .or_default()
            .insert(snapshot.snapshot_date, Self::stored(snapshot));
    }

    fn rows(&self) -> std::sync::MutexGuard<'_, SnapshotRows> {
        self.rows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[async_trait]
impl SnapshotRepositoryTrait for InMemorySnapshotRepository {
    async fn save_snapshots(&self, snapshots: &[AccountStateSnapshot]) -> Result<()> {
        let mut rows = self.rows();
        for snapshot in snapshots {
            Self::upsert(&mut rows, snapshot);
        }
        Ok(())
    }

    fn get_snapshots_by_account(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        Ok(self
            .rows()
            .get(account_id)
            .map(|by_date| {
                by_date
                    .values()
                    .filter(|snapshot| {
                        start_date.is_none_or(|start| snapshot.snapshot_date >= start)
                    })
                    .filter(|snapshot| end_date.is_none_or(|end| snapshot.snapshot_date <= end))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }

    fn get_latest_snapshot_before_date(
        &self,
        account_id: &str,
        date: NaiveDate,
    ) -> Result<Option<AccountStateSnapshot>> {
        Ok(self
            .rows()
            .get(account_id)
            .and_then(|by_date| by_date.range(..=date).next_back().map(|(_, s)| s.clone())))
    }

    fn get_latest_snapshots_before_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        let mut result = HashMap::new();
        for account_id in account_ids {
            if let Some(snapshot) = self.get_latest_snapshot_before_date(account_id, date)? {
                result.insert(account_id.clone(), snapshot);
            }
        }
        Ok(result)
    }

    fn get_all_latest_snapshots(
        &self,
        account_ids: &[String],
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        let rows = self.rows();
        Ok(account_ids
            .iter()
            .filter_map(|account_id| {
                rows.get(account_id)
                    .and_then(|by_date| by_date.values().next_back())
                    .map(|snapshot| (account_id.clone(), snapshot.clone()))
            })
            .collect())
    }

    async fn delete_snapshots_by_account_ids(&self, account_ids: &[String]) -> Result<usize> {
        let mut rows = self.rows();
        Ok(account_ids
            .iter()
            .filter_map(|account_id| rows.remove(account_id))
            .map(|by_date| by_date.len())
            .sum())
    }

    async fn delete_snapshots_for_account_and_dates(
        &self,
        account_id: &str,
        dates_to_delete: &[NaiveDate],
    ) -> Result<()> {
        if let Some(by_date) = self.rows().get_mut(account_id) {
            for date in dates_to_delete {
                by_date.remove(date);
            }
        }
        Ok(())
    }

    fn get_all_non_archived_account_snapshots(
        &self,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        let rows = self.rows();
        let mut account_ids: Vec<&String> = rows
            .keys()
            .filter(|account_id| !self.archived_accounts.contains(*account_id))
            .collect();
        account_ids.sort();
        Ok(account_ids
            .into_iter()
            .flat_map(|account_id| rows[account_id].values())
            .filter(|snapshot| start_date.is_none_or(|start| snapshot.snapshot_date >= start))
            .filter(|snapshot| end_date.is_none_or(|end| snapshot.snapshot_date <= end))
            .cloned()
            .collect())
    }

    fn get_earliest_snapshot_date(&self, account_id: &str) -> Result<Option<NaiveDate>> {
        Ok(self
            .rows()
            .get(account_id)
            .and_then(|by_date| by_date.keys().next().copied()))
    }

    async fn overwrite_all_snapshots_for_account(
        &self,
        account_id: &str,
        snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        let mut rows = self.rows();
        // Calculated rows are replaced; observed rows stay (REG-0913).
        if let Some(by_date) = rows.get_mut(account_id) {
            by_date.retain(|_, snapshot| snapshot.source != SnapshotSource::Calculated);
        }
        for snapshot in snapshots_to_save {
            Self::upsert(&mut rows, snapshot);
        }
        Ok(())
    }

    async fn save_or_update_snapshot(&self, snapshot: &AccountStateSnapshot) -> Result<()> {
        Self::upsert(&mut self.rows(), snapshot);
        Ok(())
    }

    fn get_snapshot_positions(&self, snapshot_id: &str) -> Result<HashMap<String, Position>> {
        Ok(self
            .rows()
            .values()
            .flat_map(|by_date| by_date.values())
            .find(|snapshot| snapshot.id == snapshot_id)
            .map(|snapshot| snapshot.positions.clone())
            .unwrap_or_default())
    }

    fn get_snapshot_positions_batch(
        &self,
        snapshot_ids: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>> {
        let mut result = HashMap::new();
        for snapshot_id in snapshot_ids {
            let positions = self.get_snapshot_positions(snapshot_id)?;
            if !positions.is_empty() {
                result.insert(snapshot_id.clone(), positions);
            }
        }
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Valuations
// ---------------------------------------------------------------------------

type ValuationRows = HashMap<String, BTreeMap<NaiveDate, DailyAccountValuation>>;

/// Dense daily valuation store; every decimal is stored at `DECIMAL_PRECISION`
/// like the SQLite model does.
#[derive(Default)]
pub struct InMemoryValuationRepository {
    rows: Mutex<ValuationRows>,
}

impl InMemoryValuationRepository {
    fn stored(row: &DailyAccountValuation) -> DailyAccountValuation {
        let r = |value: Decimal| value.round_dp(DECIMAL_PRECISION);
        DailyAccountValuation {
            fx_rate_to_base: r(row.fx_rate_to_base),
            cash_balance: r(row.cash_balance),
            investment_market_value: r(row.investment_market_value),
            total_value: r(row.total_value),
            cost_basis: r(row.cost_basis),
            book_basis: r(row.book_basis),
            net_contribution: r(row.net_contribution),
            cash_balance_base: r(row.cash_balance_base),
            investment_market_value_base: r(row.investment_market_value_base),
            total_value_base: r(row.total_value_base),
            cost_basis_base: r(row.cost_basis_base),
            book_basis_base: r(row.book_basis_base),
            net_contribution_base: r(row.net_contribution_base),
            external_inflow_base: r(row.external_inflow_base),
            external_outflow_base: r(row.external_outflow_base),
            performance_eligible_value_base: r(row.performance_eligible_value_base),
            ..row.clone()
        }
    }

    fn rows(&self) -> std::sync::MutexGuard<'_, ValuationRows> {
        self.rows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn upsert(rows: &mut ValuationRows, row: &DailyAccountValuation) {
        rows.entry(row.account_id.clone())
            .or_default()
            .insert(row.valuation_date, Self::stored(row));
    }
}

#[async_trait]
impl ValuationRepositoryTrait for InMemoryValuationRepository {
    async fn replace_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
        valuation_records: &[DailyAccountValuation],
    ) -> Result<()> {
        let mut rows = self.rows();
        match since_date {
            Some(since) => {
                if let Some(by_date) = rows.get_mut(account_id) {
                    by_date.retain(|date, _| *date < since);
                }
            }
            None => {
                rows.remove(account_id);
            }
        }
        for row in valuation_records {
            Self::upsert(&mut rows, row);
        }
        Ok(())
    }

    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        Ok(self
            .rows()
            .get(account_id)
            .map(|by_date| {
                by_date
                    .values()
                    .filter(|row| start_date.is_none_or(|start| row.valuation_date >= start))
                    .filter(|row| end_date.is_none_or(|end| row.valuation_date <= end))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }

    fn get_historical_valuations_for_accounts(
        &self,
        account_ids: &[String],
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        let mut rows: Vec<DailyAccountValuation> = account_ids
            .iter()
            .map(|account_id| self.get_historical_valuations(account_id, start_date, end_date))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        rows.sort_by(|a, b| {
            a.valuation_date
                .cmp(&b.valuation_date)
                .then_with(|| a.account_id.cmp(&b.account_id))
        });
        Ok(rows)
    }

    async fn delete_valuations_for_account(
        &self,
        account_id: &str,
        since_date: Option<NaiveDate>,
    ) -> Result<()> {
        let mut rows = self.rows();
        match since_date {
            Some(since) => {
                if let Some(by_date) = rows.get_mut(account_id) {
                    by_date.retain(|date, _| *date < since);
                }
            }
            None => {
                rows.remove(account_id);
            }
        }
        Ok(())
    }

    fn get_latest_valuations(&self, account_ids: &[String]) -> Result<Vec<DailyAccountValuation>> {
        let rows = self.rows();
        Ok(account_ids
            .iter()
            .filter_map(|account_id| rows.get(account_id))
            .filter_map(|by_date| by_date.values().next_back().cloned())
            .collect())
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<DailyAccountValuation>> {
        let rows = self.rows();
        Ok(account_ids
            .iter()
            .filter_map(|account_id| rows.get(account_id))
            .filter_map(|by_date| by_date.get(&date).cloned())
            .collect())
    }

    fn get_accounts_with_negative_balance(
        &self,
        account_ids: &[String],
    ) -> Result<Vec<NegativeBalanceInfo>> {
        let rows = self.rows();
        Ok(account_ids
            .iter()
            .filter_map(|account_id| {
                rows.get(account_id)?
                    .values()
                    .find(|row| row.total_value < Decimal::ZERO)
                    .map(|row| NegativeBalanceInfo {
                        account_id: account_id.clone(),
                        first_negative_date: row.valuation_date,
                        cash_balance: row.cash_balance,
                        total_value: row.total_value,
                        account_currency: row.account_currency.clone(),
                    })
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

/// Lot and disposal read models with the SQLite sync rules: open lots are
/// upserted and stale open rows removed, closures flip rows to closed with
/// zero remaining, unknown assets are dropped and unknown opening activities
/// (compiler-generated ids) are nulled.
pub struct InMemoryLotRepository {
    lots: Mutex<BTreeMap<String, LotRecord>>,
    disposals: Mutex<Vec<LotDisposal>>,
    activity_ids: HashSet<String>,
    asset_ids: HashSet<String>,
}

impl InMemoryLotRepository {
    pub fn new(activity_ids: HashSet<String>, asset_ids: HashSet<String>) -> Self {
        Self {
            lots: Mutex::new(BTreeMap::new()),
            disposals: Mutex::new(Vec::new()),
            activity_ids,
            asset_ids,
        }
    }

    fn lots(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, LotRecord>> {
        self.lots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn disposals(&self) -> std::sync::MutexGuard<'_, Vec<LotDisposal>> {
        self.disposals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn normalize(&self, mut lot: LotRecord) -> Option<LotRecord> {
        if !self.asset_ids.contains(&lot.asset_id) {
            return None;
        }
        if lot
            .open_activity_id
            .as_deref()
            .is_some_and(|id| !self.activity_ids.contains(id))
        {
            lot.open_activity_id = None;
        }
        Some(lot)
    }

    fn sorted(mut lots: Vec<LotRecord>) -> Vec<LotRecord> {
        lots.sort_by(|a, b| a.open_date.cmp(&b.open_date).then_with(|| a.id.cmp(&b.id)));
        lots
    }
}

#[async_trait]
impl LotRepositoryTrait for InMemoryLotRepository {
    async fn replace_lots_for_account(&self, account_id: &str, lots: &[LotRecord]) -> Result<()> {
        let mut store = self.lots();
        store.retain(|_, lot| lot.account_id != account_id);
        for lot in lots {
            if let Some(lot) = self.normalize(lot.clone()) {
                store.insert(lot.id.clone(), lot);
            }
        }
        Ok(())
    }

    async fn get_open_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>> {
        Ok(Self::sorted(
            self.lots()
                .values()
                .filter(|lot| lot.account_id == account_id && !lot.is_closed)
                .cloned()
                .collect(),
        ))
    }

    async fn get_all_open_lots(&self) -> Result<Vec<LotRecord>> {
        Ok(Self::sorted(
            self.lots()
                .values()
                .filter(|lot| !lot.is_closed)
                .cloned()
                .collect(),
        ))
    }

    async fn get_all_lots_for_account(&self, account_id: &str) -> Result<Vec<LotRecord>> {
        Ok(Self::sorted(
            self.lots()
                .values()
                .filter(|lot| lot.account_id == account_id)
                .cloned()
                .collect(),
        ))
    }

    async fn get_lots_for_asset(&self, asset_id: &str) -> Result<Vec<LotRecord>> {
        Ok(Self::sorted(
            self.lots()
                .values()
                .filter(|lot| lot.asset_id == asset_id)
                .cloned()
                .collect(),
        ))
    }

    async fn get_asset_lot_view(
        &self,
        _asset_id: &str,
        _include_snapshot_positions: bool,
    ) -> Result<Vec<AssetLotView>> {
        not_needed!("LotRepositoryTrait::get_asset_lot_view")
    }

    async fn get_all_lots(&self) -> Result<Vec<LotRecord>> {
        Ok(Self::sorted(self.lots().values().cloned().collect()))
    }

    async fn sync_lot_disposals_for_account(
        &self,
        account_id: &str,
        affected_activity_ids: &[String],
        disposals: &[LotDisposal],
        replace_all: bool,
    ) -> Result<()> {
        let mut store = self.disposals();
        if replace_all {
            store.retain(|disposal| disposal.account_id != account_id);
        } else if !affected_activity_ids.is_empty() {
            store.retain(|disposal| {
                disposal.account_id != account_id
                    || !affected_activity_ids.contains(&disposal.disposal_activity_id)
            });
        }
        store.extend(disposals.iter().cloned());
        Ok(())
    }

    async fn get_lot_disposals_for_account(&self, account_id: &str) -> Result<Vec<LotDisposal>> {
        let mut rows: Vec<LotDisposal> = self
            .disposals()
            .iter()
            .filter(|disposal| disposal.account_id == account_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            a.disposal_date
                .cmp(&b.disposal_date)
                .then_with(|| a.disposal_activity_id.cmp(&b.disposal_activity_id))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rows)
    }

    fn get_lot_disposals_for_accounts_in_date_range_sync(
        &self,
        account_ids: &[String],
        start_date_exclusive: NaiveDate,
        end_date_inclusive: NaiveDate,
    ) -> Result<Vec<LotDisposal>> {
        let mut rows: Vec<LotDisposal> = self
            .disposals()
            .iter()
            .filter(|disposal| account_ids.contains(&disposal.account_id))
            .filter(|disposal| {
                NaiveDate::parse_from_str(&disposal.disposal_date, "%Y-%m-%d")
                    .is_ok_and(|date| date > start_date_exclusive && date <= end_date_inclusive)
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            a.disposal_date
                .cmp(&b.disposal_date)
                .then_with(|| a.disposal_activity_id.cmp(&b.disposal_activity_id))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rows)
    }

    async fn get_open_position_quantities(&self) -> Result<HashMap<String, Decimal>> {
        let mut quantities: HashMap<String, Decimal> = HashMap::new();
        for lot in self.lots().values().filter(|lot| !lot.is_closed) {
            let remaining = Decimal::from_str(&lot.remaining_quantity).unwrap_or_default();
            let split_ratio = Decimal::from_str(&lot.split_ratio)
                .ok()
                .filter(|ratio| !ratio.is_zero())
                .unwrap_or(Decimal::ONE);
            *quantities.entry(lot.asset_id.clone()).or_default() += remaining * split_ratio;
        }
        Ok(quantities)
    }

    fn count_lots(&self) -> Result<i64> {
        Ok(self.lots().len() as i64)
    }
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/// Quote service over fixture observations. Implements the sparse reads the
/// valuation path uses (in-range keyframes plus one pre-range seed per asset)
/// and the latest-on-or-before lookups; provider/sync methods are not needed.
pub struct InMemoryQuoteService {
    quotes_by_asset: RwLock<HashMap<String, Vec<Quote>>>,
    assets: HashMap<String, Asset>,
}

impl InMemoryQuoteService {
    /// Persisted quotes of one asset inside the range plus one pre-range seed.
    fn sparse_quotes_for_asset(
        &self,
        asset_id: &str,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Vec<Quote> {
        let mut quotes: Vec<Quote> = self
            .series(asset_id)
            .iter()
            .filter(|quote| {
                let day = quote.timestamp.date_naive();
                day >= start && day <= end
            })
            .cloned()
            .map(|quote| self.reconciled(quote))
            .collect();
        if let Some(seed_day) = start.checked_sub_signed(Duration::days(1)) {
            quotes.extend(self.latest_on_or_before(asset_id, seed_day));
        }
        quotes.sort_by_key(|quote| quote.timestamp);
        quotes.dedup_by(|left, right| left.timestamp.date_naive() == right.timestamp.date_naive());
        quotes
    }

    pub fn new(quotes: Vec<Quote>, assets: Vec<Asset>) -> Self {
        let service = Self {
            quotes_by_asset: RwLock::new(HashMap::new()),
            assets: assets
                .into_iter()
                .map(|asset| (asset.id.clone(), asset))
                .collect(),
        };
        service.add_quotes(quotes);
        service
    }

    /// Adds observations, replacing any existing one for the same asset and day.
    pub fn add_quotes(&self, quotes: Vec<Quote>) {
        let mut store = self
            .quotes_by_asset
            .write()
            .unwrap_or_else(|p| p.into_inner());
        for quote in quotes {
            let series = store.entry(quote.asset_id.clone()).or_default();
            series
                .retain(|existing| existing.timestamp.date_naive() != quote.timestamp.date_naive());
            series.push(quote);
            series.sort_by_key(|quote| quote.timestamp);
        }
    }

    pub fn all_quotes(&self) -> Vec<Quote> {
        self.quotes_by_asset
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .flatten()
            .cloned()
            .collect()
    }

    fn series(&self, asset_id: &str) -> Vec<Quote> {
        self.quotes_by_asset
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(asset_id)
            .cloned()
            .unwrap_or_default()
    }

    fn latest_on_or_before(&self, asset_id: &str, day: NaiveDate) -> Option<Quote> {
        self.series(asset_id)
            .iter()
            .rev()
            .find(|quote| quote.timestamp.date_naive() <= day)
            .cloned()
            .map(|quote| self.reconciled(quote))
    }

    /// Mirrors `reconcile_quote_currency`: a minor-unit asset code wins over a
    /// major-unit quote code for the same currency; everything else stands.
    fn reconciled(&self, mut quote: Quote) -> Quote {
        if let Some(asset) = self.assets.get(&quote.asset_id) {
            let asset_ccy = asset.quote_ccy.as_str();
            let quote_ccy = quote.currency.as_str();
            let same_major = !asset_ccy.is_empty()
                && !quote_ccy.is_empty()
                && asset_ccy != quote_ccy
                && normalize_currency_code(asset_ccy) == normalize_currency_code(quote_ccy);
            if same_major
                && get_normalization_rule(asset_ccy).is_some()
                && get_normalization_rule(quote_ccy).is_none()
            {
                quote.currency = asset_ccy.to_string();
            }
        }
        quote
    }
}

#[async_trait]
impl QuoteServiceTrait for InMemoryQuoteService {
    fn get_latest_quote(&self, symbol: &str) -> Result<Quote> {
        self.series(symbol)
            .last()
            .cloned()
            .map(|quote| self.reconciled(quote))
            .ok_or_else(|| not_found(format!("quote for {symbol}")))
    }

    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>> {
        Ok(symbols
            .iter()
            .filter_map(|symbol| {
                self.get_latest_quote(symbol)
                    .ok()
                    .map(|q| (symbol.clone(), q))
            })
            .collect())
    }

    fn get_latest_quotes_as_of(
        &self,
        symbols: &[String],
        as_of: NaiveDate,
    ) -> Result<HashMap<String, Quote>> {
        Ok(symbols
            .iter()
            .filter_map(|symbol| {
                self.latest_on_or_before(symbol, as_of)
                    .map(|quote| (symbol.clone(), quote))
            })
            .collect())
    }

    fn get_sparse_asset_market_facts(
        &self,
        requests: &[(String, NaiveDate)],
    ) -> Result<SparseAssetMarketFacts> {
        let mut facts = SparseAssetMarketFacts::default();
        for (asset_id, day) in requests {
            if asset_id.is_empty() {
                continue;
            }
            if let Some(asset) = self.assets.get(asset_id) {
                facts
                    .assets_by_id
                    .entry(asset_id.clone())
                    .or_insert_with(|| asset.clone());
            }
            if let Some(mut quote) = self.latest_on_or_before(asset_id, *day) {
                // The store stamps the requested day, not the observation day.
                quote.timestamp = midnight_utc(*day);
                facts
                    .quotes_by_request
                    .insert((asset_id.clone(), *day), quote);
            }
        }
        Ok(facts)
    }

    fn get_latest_quotes_snapshot(
        &self,
        _asset_ids: &[String],
    ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
        not_needed!("QuoteServiceTrait::get_latest_quotes_snapshot")
    }

    fn get_latest_quotes_pair(
        &self,
        _symbols: &[String],
    ) -> Result<HashMap<String, LatestQuotePair>> {
        not_needed!("QuoteServiceTrait::get_latest_quotes_pair")
    }

    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>> {
        Ok(self
            .series(symbol)
            .iter()
            .cloned()
            .map(|quote| self.reconciled(quote))
            .collect())
    }

    fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
        let store = self
            .quotes_by_asset
            .read()
            .unwrap_or_else(|p| p.into_inner());
        Ok(store
            .iter()
            .map(|(asset_id, series)| {
                (
                    asset_id.clone(),
                    series
                        .iter()
                        .cloned()
                        .map(|quote| (quote.timestamp.date_naive(), self.reconciled(quote)))
                        .collect(),
                )
            })
            .collect())
    }

    fn get_quotes_in_range(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let mut symbols: Vec<&String> = symbols.iter().collect();
        symbols.sort();
        Ok(symbols
            .into_iter()
            .flat_map(|symbol| self.series(symbol))
            .filter(|quote| {
                let day = quote.timestamp.date_naive();
                day >= start && day <= end
            })
            .map(|quote| self.reconciled(quote))
            .collect())
    }

    fn get_sparse_quotes_in_range(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let mut quotes = Vec::new();
        for symbol in symbols {
            quotes.extend(self.sparse_quotes_for_asset(symbol, start, end));
        }
        Ok(quotes)
    }

    fn get_quotes_in_range_filled(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        let mut symbols: Vec<&String> = symbols.iter().collect();
        symbols.sort();
        let mut filled = Vec::new();
        for symbol in symbols {
            let mut day = start;
            while day <= end {
                if let Some(mut quote) = self.latest_on_or_before(symbol, day) {
                    quote.timestamp = midnight_utc(day);
                    filled.push(quote);
                }
                day = day.succ_opt().expect("date range");
            }
        }
        Ok(filled)
    }

    async fn get_daily_quotes(
        &self,
        _asset_ids: &HashSet<String>,
        _start: NaiveDate,
        _end: NaiveDate,
    ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>> {
        not_needed!("QuoteServiceTrait::get_daily_quotes")
    }

    async fn add_quote(&self, _quote: &Quote) -> Result<Quote> {
        not_needed!("QuoteServiceTrait::add_quote")
    }

    async fn update_quote(&self, _quote: Quote) -> Result<Quote> {
        not_needed!("QuoteServiceTrait::update_quote")
    }

    async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
        not_needed!("QuoteServiceTrait::delete_quote")
    }

    async fn bulk_upsert_quotes(&self, _quotes: Vec<Quote>) -> Result<usize> {
        not_needed!("QuoteServiceTrait::bulk_upsert_quotes")
    }

    async fn search_symbol(&self, _query: &str) -> Result<Vec<SymbolSearchResult>> {
        not_needed!("QuoteServiceTrait::search_symbol")
    }

    async fn search_symbol_with_currency(
        &self,
        _query: &str,
        _account_currency: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>> {
        not_needed!("QuoteServiceTrait::search_symbol_with_currency")
    }

    async fn get_asset_profile(&self, _asset: &Asset) -> Result<ProviderProfile> {
        not_needed!("QuoteServiceTrait::get_asset_profile")
    }

    async fn fetch_quotes_from_provider(
        &self,
        _asset_id: &str,
        _start: NaiveDate,
        _end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        not_needed!("QuoteServiceTrait::fetch_quotes_from_provider")
    }

    async fn fetch_quotes_for_symbol(
        &self,
        _asset_id: &str,
        _currency: &str,
        _start: NaiveDate,
        _end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        not_needed!("QuoteServiceTrait::fetch_quotes_for_symbol")
    }

    async fn sync(&self, _mode: SyncMode, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
        not_needed!("QuoteServiceTrait::sync")
    }

    async fn resync(&self, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
        not_needed!("QuoteServiceTrait::resync")
    }

    async fn refresh_sync_state(&self) -> Result<()> {
        not_needed!("QuoteServiceTrait::refresh_sync_state")
    }

    fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
        not_needed!("QuoteServiceTrait::get_sync_plan")
    }

    async fn handle_activity_created(
        &self,
        _symbol: &str,
        _activity_date: NaiveDate,
    ) -> Result<()> {
        not_needed!("QuoteServiceTrait::handle_activity_created")
    }

    async fn handle_activity_deleted(&self, _symbol: &str) -> Result<()> {
        not_needed!("QuoteServiceTrait::handle_activity_deleted")
    }

    async fn delete_sync_state(&self, _symbol: &str) -> Result<()> {
        not_needed!("QuoteServiceTrait::delete_sync_state")
    }

    fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>> {
        not_needed!("QuoteServiceTrait::get_symbols_needing_sync")
    }

    fn get_sync_state(&self, _symbol: &str) -> Result<Option<QuoteSyncState>> {
        not_needed!("QuoteServiceTrait::get_sync_state")
    }

    async fn mark_profile_enriched(&self, _symbol: &str) -> Result<()> {
        not_needed!("QuoteServiceTrait::mark_profile_enriched")
    }

    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
        not_needed!("QuoteServiceTrait::get_assets_needing_profile_enrichment")
    }

    fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
        not_needed!("QuoteServiceTrait::get_sync_states_with_errors")
    }

    async fn reset_sync_errors(&self, _asset_ids: &[String]) -> Result<()> {
        not_needed!("QuoteServiceTrait::reset_sync_errors")
    }

    async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> Result<()> {
        not_needed!("QuoteServiceTrait::reset_sync_state_for_profile_change")
    }

    async fn update_position_status_from_holdings(
        &self,
        _current_holdings: &HashMap<String, Decimal>,
    ) -> Result<()> {
        // Quote-sync planning state is irrelevant to the calculation path.
        Ok(())
    }

    async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
        not_needed!("QuoteServiceTrait::get_providers_info")
    }

    async fn update_provider_settings(
        &self,
        _provider_id: &str,
        _priority: i32,
        _enabled: bool,
    ) -> Result<()> {
        not_needed!("QuoteServiceTrait::update_provider_settings")
    }

    async fn check_quotes_import(
        &self,
        _content: &[u8],
        _has_header_row: bool,
    ) -> Result<Vec<QuoteImport>> {
        not_needed!("QuoteServiceTrait::check_quotes_import")
    }

    async fn import_quotes(
        &self,
        _quotes: Vec<QuoteImport>,
        _overwrite: bool,
    ) -> Result<Vec<QuoteImport>> {
        not_needed!("QuoteServiceTrait::import_quotes")
    }
}

// ---------------------------------------------------------------------------
// FX rates
// ---------------------------------------------------------------------------

/// FX observation store behind the real `FxService`, so the legacy resolution
/// ladder (converter, inverse, latest-of-any-date fallback) is captured as is.
pub struct InMemoryFxRepository {
    rates: RwLock<Vec<ExchangeRate>>,
}

impl InMemoryFxRepository {
    pub fn new(rates: Vec<ExchangeRate>) -> Self {
        let repository = Self {
            rates: RwLock::new(Vec::new()),
        };
        repository.add_rates(rates);
        repository
    }

    /// Adds observations; the `FxService` converter must be re-initialized
    /// afterwards (the hosts do that at the start of every job).
    pub fn add_rates(&self, rates: Vec<ExchangeRate>) {
        let mut store = self.rates.write().unwrap_or_else(|p| p.into_inner());
        store.extend(rates);
        store.sort_by_key(|rate| rate.timestamp);
    }

    pub fn all_rates(&self) -> Vec<ExchangeRate> {
        self.rates.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn latest(&self, from: &str, to: &str) -> Option<ExchangeRate> {
        self.rates
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .rev()
            .find(|rate| rate.from_currency == from && rate.to_currency == to)
            .cloned()
    }

    fn pair_from_symbol(symbol: &str) -> Option<(String, String)> {
        let raw = symbol.strip_prefix("FX:").unwrap_or(symbol);
        if let Some((from, to)) = raw.split_once('/').or_else(|| raw.split_once(':')) {
            return Some((from.to_string(), to.to_string()));
        }
        (raw.len() == 6).then(|| (raw[..3].to_string(), raw[3..].to_string()))
    }
}

#[async_trait]
impl FxRepositoryTrait for InMemoryFxRepository {
    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        let mut latest: BTreeMap<(String, String), ExchangeRate> = BTreeMap::new();
        for rate in self.all_rates().iter() {
            latest.insert(
                (rate.from_currency.clone(), rate.to_currency.clone()),
                rate.clone(),
            );
        }
        Ok(latest.into_values().collect())
    }

    fn get_historical_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        Ok(self.all_rates())
    }

    fn get_latest_exchange_rate(&self, from: &str, to: &str) -> Result<Option<ExchangeRate>> {
        Ok(self.latest(from, to))
    }

    fn get_latest_exchange_rate_by_symbol(&self, symbol: &str) -> Result<Option<ExchangeRate>> {
        Ok(Self::pair_from_symbol(symbol).and_then(|(from, to)| self.latest(&from, &to)))
    }

    fn get_historical_quotes(
        &self,
        _symbol: &str,
        _start_date: NaiveDateTime,
        _end_date: NaiveDateTime,
    ) -> Result<Vec<Quote>> {
        not_needed!("FxRepositoryTrait::get_historical_quotes")
    }

    async fn add_quote(
        &self,
        _symbol: String,
        _date: String,
        _rate: Decimal,
        _source: String,
    ) -> Result<Quote> {
        not_needed!("FxRepositoryTrait::add_quote")
    }

    async fn save_exchange_rate(&self, _rate: ExchangeRate) -> Result<ExchangeRate> {
        not_needed!("FxRepositoryTrait::save_exchange_rate")
    }

    async fn update_exchange_rate(&self, _rate: &ExchangeRate) -> Result<ExchangeRate> {
        not_needed!("FxRepositoryTrait::update_exchange_rate")
    }

    async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
        not_needed!("FxRepositoryTrait::delete_exchange_rate")
    }

    async fn create_fx_asset(
        &self,
        _from_currency: &str,
        _to_currency: &str,
        _source: &str,
    ) -> Result<String> {
        not_needed!("FxRepositoryTrait::create_fx_asset")
    }
}

#[allow(dead_code)]
fn _assert_instrument_type_in_scope(_: Option<InstrumentType>) {}

// ------------------------------------------------------------ projections

use crate::portfolio::projection::{
    AccountProjection, ProjectionCheckpoint, ProjectionStoreTrait, ProjectionWatermark,
};
use std::sync::Arc;

/// Projection store over the other doubles (not transactional; tests only).
pub struct InMemoryProjectionStore {
    watermarks: RwLock<HashMap<String, ProjectionWatermark>>,
    checkpoints: RwLock<HashMap<String, Vec<ProjectionCheckpoint>>>,
    /// Number of upcoming persists that fail (retry tests).
    failures_to_inject: std::sync::atomic::AtomicUsize,
    snapshots: Arc<dyn SnapshotRepositoryTrait>,
    lots: Arc<dyn LotRepositoryTrait>,
    valuations: Arc<dyn ValuationRepositoryTrait>,
}

impl InMemoryProjectionStore {
    pub fn new(
        snapshots: Arc<dyn SnapshotRepositoryTrait>,
        lots: Arc<dyn LotRepositoryTrait>,
        valuations: Arc<dyn ValuationRepositoryTrait>,
    ) -> Self {
        Self {
            watermarks: RwLock::new(HashMap::new()),
            checkpoints: RwLock::new(HashMap::new()),
            failures_to_inject: std::sync::atomic::AtomicUsize::new(0),
            snapshots,
            lots,
            valuations,
        }
    }

    /// Makes the next `count` persists fail with a storage error.
    pub fn fail_next_persists(&self, count: usize) {
        self.failures_to_inject
            .store(count, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait]
impl ProjectionStoreTrait for InMemoryProjectionStore {
    fn get_watermarks(&self, account_ids: &[String]) -> Result<Vec<ProjectionWatermark>> {
        let watermarks = self.watermarks.read().unwrap_or_else(|p| p.into_inner());
        Ok(account_ids
            .iter()
            .filter_map(|id| watermarks.get(id).cloned())
            .collect())
    }

    fn get_checkpoints(&self, account_ids: &[String]) -> Result<Vec<ProjectionCheckpoint>> {
        let checkpoints = self.checkpoints.read().unwrap_or_else(|p| p.into_inner());
        Ok(account_ids
            .iter()
            .flat_map(|id| checkpoints.get(id).cloned().unwrap_or_default())
            .collect())
    }

    async fn persist_account_projection(&self, projection: AccountProjection) -> Result<()> {
        use std::sync::atomic::Ordering;
        let pending = self.failures_to_inject.load(Ordering::SeqCst);
        if pending > 0 {
            self.failures_to_inject.store(pending - 1, Ordering::SeqCst);
            return Err(crate::Error::Unexpected(
                "injected projection persist failure".to_string(),
            ));
        }
        let account_id = projection.account_id.clone();
        let since = projection.since;
        if let Some(snapshots) = &projection.snapshots {
            match since {
                Some(since) => {
                    let stale: Vec<NaiveDate> = self
                        .snapshots
                        .get_snapshots_by_account(&account_id, None, None)?
                        .into_iter()
                        .filter(|s| {
                            s.source == SnapshotSource::Calculated && s.snapshot_date >= since
                        })
                        .map(|s| s.snapshot_date)
                        .collect();
                    self.snapshots
                        .delete_snapshots_for_account_and_dates(&account_id, &stale)
                        .await?;
                    self.snapshots.save_snapshots(snapshots).await?;
                }
                None => {
                    self.snapshots
                        .overwrite_all_snapshots_for_account(&account_id, snapshots)
                        .await?;
                }
            }
        }
        if let Some(lots) = &projection.lots {
            let mut rows: Vec<LotRecord> = match since {
                Some(since) => self
                    .lots
                    .get_all_lots_for_account(&account_id)
                    .await?
                    .into_iter()
                    .filter(|lot| {
                        lot.is_closed
                            && lot
                                .close_date
                                .as_deref()
                                .and_then(|d| d.parse::<NaiveDate>().ok())
                                .is_some_and(|d| d < since)
                    })
                    .collect(),
                None => Vec::new(),
            };
            rows.extend(lots.iter().cloned());
            self.lots
                .replace_lots_for_account(&account_id, &rows)
                .await?;
        }
        if let Some(disposals) = &projection.disposals {
            let mut rows: Vec<LotDisposal> = match since {
                Some(since) => self
                    .lots
                    .get_lot_disposals_for_account(&account_id)
                    .await?
                    .into_iter()
                    .filter(|d| {
                        d.disposal_date
                            .parse::<NaiveDate>()
                            .is_ok_and(|date| date < since)
                    })
                    .collect(),
                None => Vec::new(),
            };
            rows.extend(disposals.iter().cloned());
            self.lots
                .sync_lot_disposals_for_account(&account_id, &[], &rows, true)
                .await?;
        }
        self.valuations
            .replace_valuations_for_account(&account_id, since, &projection.valuations)
            .await?;
        if let Some(checkpoints) = &projection.checkpoints {
            let mut store = self.checkpoints.write().unwrap_or_else(|p| p.into_inner());
            let rows = store.entry(account_id.clone()).or_default();
            match since {
                Some(since) => rows.retain(|c| c.date < since),
                None => rows.clear(),
            }
            rows.extend(checkpoints.iter().cloned());
            rows.sort_by_key(|c| c.date);
        }
        self.watermarks
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(account_id, projection.watermark);
        Ok(())
    }
}
