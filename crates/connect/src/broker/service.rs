//! Service for synchronizing broker data to the local database.

use async_trait::async_trait;
use log::{debug, info, warn};
use std::sync::{Arc, RwLock};

use super::mapping;
use super::models::{
    AccountUniversalActivity, BrokerAccount, BrokerConnection, HoldingsBalance, HoldingsDiff,
    HoldingsOptionPosition, HoldingsOptionSymbol, HoldingsPosition, NewAccountInfo,
    SyncAccountsResponse, SyncConnectionsResponse,
};
use super::traits::{BrokerSyncServiceTrait, PlatformRepositoryTrait};
use crate::broker_ingest::{
    BrokerSyncState, BrokerSyncStateRepositoryTrait, ImportRun, ImportRunMode,
    ImportRunRepositoryTrait, ImportRunStatus, ImportRunSummary, ImportRunType, ReviewMode,
};
use crate::platform::Platform;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;
use std::collections::{hash_map::Entry, HashMap, HashSet};
use wealthfolio_core::accounts::{
    account_types, Account, AccountServiceTrait, NewAccount, TrackingMode,
};
use wealthfolio_core::activities::{
    compute_idempotency_key, ActivityRepositoryTrait, ActivityServiceTrait, ActivityUpsert,
    NewActivity, ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_SELL,
};
use wealthfolio_core::assets::{
    build_option_metadata, Asset, AssetServiceTrait, AssetSpec, InstrumentType, OptionSpec,
    CONTRACT_MULTIPLIER_METADATA_KEY,
};
use wealthfolio_core::errors::Result;
use wealthfolio_core::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use wealthfolio_core::fx::currency::{normalize_amount, normalize_currency_code};
use wealthfolio_core::portfolio::snapshot::{
    AccountStateSnapshot, Position, SnapshotRepositoryTrait, SnapshotServiceTrait, SnapshotSource,
};
use wealthfolio_core::quotes::constants::DATA_SOURCE_BROKER;
use wealthfolio_core::quotes::model::Quote;
use wealthfolio_core::quotes::store::QuoteStore;
use wealthfolio_core::utils::time_utils::{parse_user_timezone_or_default, user_today};

const DEFAULT_BROKERAGE_PROVIDER: &str = "snaptrade";
/// Precision used for holdings normalization/diff comparisons.
/// Higher than generic valuation precision to preserve crypto fidelity.
const HOLDINGS_DECIMAL_PRECISION: u32 = 12;

fn normalize_holdings_money(amount: Decimal, currency: &str) -> (Decimal, String) {
    let (amount, currency) = normalize_amount(amount, currency);
    (
        amount.round_dp(HOLDINGS_DECIMAL_PRECISION),
        currency.to_string(),
    )
}

fn exact_positive_contract_multiplier(value: Option<f64>) -> Option<Decimal> {
    value
        .and_then(Decimal::from_f64)
        .filter(|multiplier| *multiplier > Decimal::ZERO)
}

fn positive_contract_multiplier(value: Option<f64>, fallback: Decimal) -> Decimal {
    exact_positive_contract_multiplier(value).unwrap_or(fallback)
}

fn normalize_regular_average_cost(
    amount: Decimal,
    currency: &str,
    contract_multiplier: Decimal,
) -> Decimal {
    let normalized = normalize_holdings_money(amount, currency).0;
    (normalized * contract_multiplier).round_dp(HOLDINGS_DECIMAL_PRECISION)
}

/// Applies the asset's declared multiplier to a position the broker supplied
/// none for.
///
/// Without this the position is stored with a bare default — 1 for regular
/// holdings, 100/10 for options — and since valuation reads the position rather
/// than the asset, every sync silently reverts a user-set multiplier. CFDs hit
/// this on every sync: the upstream contract has no multiplier field for them
/// at all, so a hand-entered value is the only one that will ever exist.
///
/// Average cost is rescaled exactly as the broker's own value would have been,
/// so the per-position-unit basis stays consistent with the new multiplier.
fn apply_declared_contract_multiplier(position: &mut HoldingsPositionData, declared: Decimal) {
    if declared <= Decimal::ZERO
        || declared == position.contract_multiplier
        || position.contract_multiplier <= Decimal::ZERO
    {
        return;
    }

    if position.rescale_average_cost_with_multiplier {
        position.average_cost = position.average_cost.map(|cost| {
            (cost * declared / position.contract_multiplier).round_dp(HOLDINGS_DECIMAL_PRECISION)
        });
    }
    position.contract_multiplier = declared;
}

fn option_contract_multiplier(option: &HoldingsOptionSymbol) -> Decimal {
    let legacy_fallback = if option.is_mini_option.unwrap_or(false) {
        Decimal::from(10)
    } else {
        Decimal::from(100)
    };
    positive_contract_multiplier(option.multiplier, legacy_fallback)
}

fn structured_holdings_option_metadata(
    option: &HoldingsOptionSymbol,
    multiplier: Decimal,
) -> Option<serde_json::Value> {
    // Non-OCC brokerage identifiers are still valid holdings. Build the option metadata from the
    // structured contract fields so the position remains correctly valued and visible for review.
    let underlying = option.underlying_symbol.as_ref()?.symbol.as_deref()?.trim();
    if underlying.is_empty() {
        return None;
    }
    let expiration =
        NaiveDate::parse_from_str(option.expiration_date.as_deref()?, "%Y-%m-%d").ok()?;
    let right = match option.option_type.as_deref()?.to_ascii_uppercase().as_str() {
        "CALL" => "CALL",
        "PUT" => "PUT",
        _ => return None,
    };
    let strike = option
        .strike_price
        .and_then(Decimal::from_f64)
        .filter(|value| *value > Decimal::ZERO)?;

    Some(serde_json::json!({
        "option": OptionSpec {
            underlying_asset_id: underlying.to_uppercase(),
            expiration,
            right: right.to_string(),
            strike,
            multiplier,
            occ_symbol: None,
        }
    }))
}

fn holdings_option_metadata(
    option: &HoldingsOptionSymbol,
    ticker: &str,
    multiplier: Decimal,
) -> serde_json::Value {
    build_option_metadata(ticker, multiplier)
        .or_else(|| structured_holdings_option_metadata(option, multiplier))
        .unwrap_or_else(|| top_level_contract_multiplier_metadata(multiplier))
}

fn top_level_contract_multiplier_metadata(multiplier: Decimal) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        CONTRACT_MULTIPLIER_METADATA_KEY.to_string(),
        serde_json::json!(multiplier),
    );
    serde_json::Value::Object(metadata)
}

fn regular_contract_multiplier_metadata(multiplier: Option<Decimal>) -> Option<serde_json::Value> {
    multiplier
        .filter(|multiplier| *multiplier != Decimal::ONE)
        .map(top_level_contract_multiplier_metadata)
}

fn record_authoritative_multiplier(
    multipliers: &mut HashMap<String, Decimal>,
    spec_key: &str,
    multiplier: Option<Decimal>,
) -> bool {
    let Some(multiplier) = multiplier else {
        return false;
    };
    match multipliers.entry(spec_key.to_string()) {
        Entry::Vacant(entry) => {
            entry.insert(multiplier);
            true
        }
        Entry::Occupied(entry) => {
            if *entry.get() != multiplier {
                warn!(
                    "Broker returned inconsistent contract multipliers for {}; retaining the first",
                    spec_key
                );
            }
            false
        }
    }
}

fn contract_multiplier_metadata_update(
    asset: &Asset,
    incoming: Option<&serde_json::Value>,
    multiplier: Decimal,
) -> Option<serde_json::Value> {
    if asset.contract_multiplier() == multiplier {
        return None;
    }

    let mut metadata = asset
        .metadata
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(incoming) = incoming.and_then(serde_json::Value::as_object) {
        metadata.extend(incoming.clone());
    }

    if asset.is_option() {
        // Test the shape the reader will actually see. `OptionSpec` fields are
        // non-Option with no serde defaults, so a partial spec fails to
        // deserialize and `Asset::contract_multiplier()` silently falls back to
        // the 100 default. Writing into such a spec — and dropping the
        // top-level key with it — would lose this value entirely.
        let mut candidate = metadata
            .get("option")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if let Some(option) = candidate.as_object_mut() {
            option.insert("multiplier".to_string(), serde_json::json!(multiplier));
        }

        if serde_json::from_value::<OptionSpec>(candidate.clone()).is_ok() {
            metadata.insert("option".to_string(), candidate);
            metadata.remove(CONTRACT_MULTIPLIER_METADATA_KEY);
        } else {
            // Leave the partial spec alone — it still carries strike/expiry for
            // display — and keep the multiplier where the resolver will find it.
            metadata.insert(
                CONTRACT_MULTIPLIER_METADATA_KEY.to_string(),
                serde_json::json!(multiplier),
            );
        }
    } else if multiplier == Decimal::ONE {
        metadata.remove(CONTRACT_MULTIPLIER_METADATA_KEY);
    } else {
        metadata.insert(
            CONTRACT_MULTIPLIER_METADATA_KEY.to_string(),
            serde_json::json!(multiplier),
        );
    }

    Some(serde_json::Value::Object(metadata))
}

#[derive(Debug, Clone)]
struct HoldingsPositionData {
    spec_key: String,
    quantity: Decimal,
    quote_price: Decimal,
    quote_currency: String,
    average_cost: Option<Decimal>,
    position_currency: String,
    contract_multiplier: Decimal,
    rescale_average_cost_with_multiplier: bool,
    /// False when the broker supplied no multiplier and this value is only a
    /// default. The asset's declared multiplier then wins — see
    /// `apply_declared_contract_multiplier`.
    multiplier_from_broker: bool,
}

/// Service for syncing broker data to the local database
pub struct BrokerSyncService {
    account_service: Arc<dyn AccountServiceTrait>,
    asset_service: Arc<dyn AssetServiceTrait>,
    activity_service: Arc<dyn ActivityServiceTrait>,
    activity_repository: Arc<dyn ActivityRepositoryTrait>,
    platform_repository: Arc<dyn PlatformRepositoryTrait>,
    brokers_sync_state_repository: Arc<dyn BrokerSyncStateRepositoryTrait>,
    import_run_repository: Arc<dyn ImportRunRepositoryTrait>,
    snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
    snapshot_service: Option<Arc<dyn SnapshotServiceTrait>>,
    quote_store: Option<Arc<dyn QuoteStore>>,
    event_sink: Arc<dyn DomainEventSink>,
    timezone: Arc<RwLock<String>>,
}

impl BrokerSyncService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        account_service: Arc<dyn AccountServiceTrait>,
        asset_service: Arc<dyn AssetServiceTrait>,
        activity_service: Arc<dyn ActivityServiceTrait>,
        activity_repository: Arc<dyn ActivityRepositoryTrait>,
        platform_repository: Arc<dyn PlatformRepositoryTrait>,
        brokers_sync_state_repository: Arc<dyn BrokerSyncStateRepositoryTrait>,
        import_run_repository: Arc<dyn ImportRunRepositoryTrait>,
        snapshot_repository: Arc<dyn SnapshotRepositoryTrait>,
    ) -> Self {
        Self {
            account_service,
            asset_service,
            activity_service,
            activity_repository,
            platform_repository,
            brokers_sync_state_repository,
            import_run_repository,
            snapshot_repository,
            snapshot_service: None,
            quote_store: None,
            event_sink: Arc::new(NoOpDomainEventSink),
            timezone: Arc::new(RwLock::new(String::new())),
        }
    }

    /// Sets the snapshot service for emitting HoldingsChanged events during broker sync.
    pub fn with_snapshot_service(
        mut self,
        snapshot_service: Arc<dyn SnapshotServiceTrait>,
    ) -> Self {
        self.snapshot_service = Some(snapshot_service);
        self
    }

    /// Sets the quote store for saving broker-provided prices as quotes.
    pub fn with_quote_store(mut self, quote_store: Arc<dyn QuoteStore>) -> Self {
        self.quote_store = Some(quote_store);
        self
    }

    /// Sets the domain event sink for emitting events during broker sync.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    pub fn with_timezone(mut self, timezone: Arc<RwLock<String>>) -> Self {
        self.timezone = timezone;
        self
    }

    fn user_today(&self) -> NaiveDate {
        user_today(parse_user_timezone_or_default(
            &self.timezone.read().unwrap(),
        ))
    }
}

#[async_trait]
impl BrokerSyncServiceTrait for BrokerSyncService {
    /// Sync connections from the broker API to local platforms table
    async fn sync_connections(
        &self,
        connections: Vec<BrokerConnection>,
    ) -> Result<SyncConnectionsResponse> {
        let mut platforms_created = 0;
        let mut platforms_updated = 0;

        for connection in &connections {
            if let Some(brokerage) = &connection.brokerage {
                // Use slug as the platform ID, fall back to UUID if no slug
                let platform_id = brokerage
                    .slug
                    .clone()
                    .unwrap_or_else(|| brokerage.id.clone().unwrap_or_default());

                if platform_id.is_empty() {
                    warn!(
                        "Skipping connection with no brokerage slug or id: {:?}",
                        connection.id
                    );
                    continue;
                }

                // Check if platform already exists
                let existing = self.platform_repository.get_by_id(&platform_id)?;

                let platform = Platform {
                    id: platform_id.clone(),
                    name: brokerage.display_name.clone().or(brokerage.name.clone()),
                    url: format!(
                        "https://{}.com",
                        platform_id.to_lowercase().replace('_', "")
                    ),
                    external_id: brokerage.id.clone(),
                    kind: "BROKERAGE".to_string(),
                    website_url: None,
                    logo_url: brokerage
                        .aws_s3_square_logo_url
                        .clone()
                        .or(brokerage.aws_s3_logo_url.clone()),
                };

                self.platform_repository.upsert(platform).await?;

                if existing.is_some() {
                    platforms_updated += 1;
                    debug!("Updated platform: {}", platform_id);
                } else {
                    platforms_created += 1;
                    info!("Created platform: {}", platform_id);
                }
            }
        }

        Ok(SyncConnectionsResponse {
            synced: connections.len(),
            platforms_created,
            platforms_updated,
        })
    }

    /// Sync accounts from the broker API to local accounts table
    async fn sync_accounts(
        &self,
        broker_accounts: Vec<BrokerAccount>,
    ) -> Result<SyncAccountsResponse> {
        let mut created = 0;
        let updated = 0; // Reserved for future use when we implement account updates
        let mut skipped = 0;
        let mut created_accounts: Vec<(String, String)> = Vec::new();
        let mut new_accounts_info: Vec<NewAccountInfo> = Vec::new();
        let base_currency = self.account_service.get_base_currency();

        // Get all existing accounts with provider_account_id to check for updates
        let existing_accounts = self.account_service.get_all_accounts()?;
        let provider_account_id_map: std::collections::HashMap<String, Account> = existing_accounts
            .into_iter()
            .filter_map(|a| a.provider_account_id.clone().map(|id| (id, a)))
            .collect();

        for broker_account in &broker_accounts {
            // Get the provider account ID - skip if missing
            let provider_account_id = match &broker_account.id {
                Some(id) if !id.is_empty() => id.clone(),
                _ => {
                    debug!(
                        "Skipping account with no provider ID: {}",
                        broker_account.display_name()
                    );
                    skipped += 1;
                    continue;
                }
            };

            // Check if account already exists by provider_account_id
            if let Some(_existing) = provider_account_id_map.get(&provider_account_id) {
                // Account exists - for now we skip updates to preserve user customizations
                // In the future, we might want to update certain fields selectively
                debug!(
                    "Account already synced, skipping: {} ({})",
                    broker_account.display_name(),
                    provider_account_id
                );
                skipped += 1;
                continue;
            }

            // Determine platform_id from institution_name
            // We need to find the platform that matches this broker account's connection
            let platform_id = self.find_platform_for_account(broker_account)?;

            let account_type = broker_account.get_account_type();
            let tracking_mode = default_tracking_mode_for_broker_account_type(&account_type);

            // Create new broker account with tracking mode matching the canonical account type.
            let new_account = NewAccount {
                id: None, // Let the repository generate a UUID
                name: broker_account.display_name(),
                account_type: account_type.clone(),
                group: None,
                currency: broker_account.get_currency(base_currency.as_deref()),
                is_default: false,
                is_active: broker_account.status.as_deref() != Some("closed"),
                platform_id,
                account_number: broker_account.account_number.clone(),
                meta: broker_account.to_meta_json(),
                provider: Some("SNAPTRADE".to_string()),
                provider_account_id: Some(provider_account_id.clone()),
                is_archived: false,
                tracking_mode,
            };

            // Create the account via AccountService (handles FX rate registration)
            let account = self.account_service.create_account(new_account).await?;

            // Collect info for NewAccountInfo
            new_accounts_info.push(NewAccountInfo {
                local_account_id: account.id.clone(),
                provider_account_id: provider_account_id.clone(),
                default_name: broker_account.display_name(),
                currency: account.currency.clone(),
                institution_name: broker_account.institution_name.clone(),
            });

            created_accounts.push((account.id.clone(), account.currency.clone()));

            created += 1;
            info!(
                "Created account: {} ({}) -> {}",
                broker_account.display_name(),
                provider_account_id,
                account_type
            );
        }

        Ok(SyncAccountsResponse {
            synced: broker_accounts.len(),
            created,
            updated,
            skipped,
            created_accounts,
            new_accounts_info,
        })
    }

    /// Get all synced accounts (accounts with provider_account_id set)
    fn get_synced_accounts(&self) -> Result<Vec<Account>> {
        let all_accounts = self.account_service.get_all_accounts()?;
        Ok(all_accounts
            .into_iter()
            .filter(|a| a.provider_account_id.is_some())
            .collect())
    }

    fn has_broker_imported_holdings_snapshot(&self, account_id: &str) -> Result<bool> {
        let tomorrow = self.user_today() + chrono::Days::new(1);
        Ok(self
            .snapshot_repository
            .get_latest_snapshot_before_date(account_id, tomorrow)?
            .map(|snapshot| snapshot.source == SnapshotSource::BrokerImported)
            .unwrap_or(false))
    }

    /// Get all platforms
    fn get_platforms(&self) -> Result<Vec<Platform>> {
        self.platform_repository.list()
    }

    fn get_activity_sync_state(&self, account_id: &str) -> Result<Option<BrokerSyncState>> {
        self.brokers_sync_state_repository
            .get_by_account_id(account_id)
    }

    async fn mark_activity_sync_attempt(&self, account_id: String) -> Result<()> {
        self.brokers_sync_state_repository
            .upsert_attempt(account_id, DEFAULT_BROKERAGE_PROVIDER.to_string())
            .await
    }

    async fn upsert_account_activities(
        &self,
        account_id: String,
        import_run_id: Option<String>,
        activities_data: Vec<AccountUniversalActivity>,
    ) -> Result<(usize, usize, Vec<String>, usize)> {
        if activities_data.is_empty() {
            return Ok((0, 0, Vec::new(), 0));
        }

        let account = self.account_service.get_account(&account_id)?;
        let base_currency = self
            .account_service
            .get_base_currency()
            .filter(|c| !c.trim().is_empty());
        let account_currency = if !account.currency.is_empty() {
            Some(account.currency.clone())
        } else {
            base_currency.clone()
        };

        // 1. Map broker data → NewActivity (dedup by activity ID)
        let mut seen_activity_ids: HashSet<String> = HashSet::new();
        let mut new_activities: Vec<NewActivity> = Vec::new();

        for activity in &activities_data {
            if let Some(new_act) = mapping::map_broker_activity(
                activity,
                &account_id,
                account_currency.as_deref(),
                base_currency.as_deref(),
            ) {
                let activity_id = new_act.id.as_deref().unwrap_or("").to_string();
                if seen_activity_ids.insert(activity_id) {
                    new_activities.push(new_act);
                }
            }
        }

        if new_activities.is_empty() {
            return Ok((0, 0, Vec::new(), 0));
        }

        // 2. Use sync preparation for asset creation + FX registration
        let prepare_result = self
            .activity_service
            .prepare_activities_for_sync(new_activities, &account)
            .await?;
        let new_asset_ids = prepare_result.created_asset_ids.clone();

        let assets_created = prepare_result.assets_created as usize;

        // Count needs_review activities
        let needs_review_count = prepare_result
            .prepared
            .iter()
            .filter(|p| p.activity.needs_review.unwrap_or(false))
            .count();

        // 3. Convert prepared activities into ActivityUpsert payloads
        //    and collect quote data from trade activities
        let mut activity_upserts: Vec<ActivityUpsert> = Vec::new();
        let mut quote_data: Vec<(String, Decimal, DateTime<Utc>, String)> = Vec::new(); // (asset_id, price, datetime, currency)

        for prepared in prepare_result.prepared {
            let act = prepared.activity;
            let asset_id = prepared.resolved_asset_id.clone();
            let activity_id = act.id.unwrap_or_default();
            if activity_id.is_empty() {
                continue;
            }

            // Parse activity date for idempotency key computation
            let activity_datetime: DateTime<Utc> = DateTime::parse_from_rfc3339(&act.activity_date)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now());

            // Collect quote data from BUY/SELL activities with a resolved asset and non-zero price
            if act.activity_type == ACTIVITY_TYPE_BUY || act.activity_type == ACTIVITY_TYPE_SELL {
                if let (Some(ref aid), Some(price)) = (&asset_id, act.unit_price) {
                    if price > Decimal::ZERO {
                        quote_data.push((
                            aid.clone(),
                            price,
                            activity_datetime,
                            act.currency.clone(),
                        ));
                    }
                }
            }

            // Compute idempotency key for content-based deduplication
            let idempotency_key = compute_idempotency_key(
                &account_id,
                &act.activity_type,
                &activity_datetime,
                asset_id.as_deref(),
                act.quantity,
                act.unit_price,
                act.amount,
                act.fee,
                &act.currency,
                act.source_record_id.as_deref(),
                act.notes.as_deref(),
            );

            activity_upserts.push(ActivityUpsert {
                id: activity_id,
                account_id: act.account_id,
                asset_id,
                activity_type: act.activity_type,
                subtype: act.subtype,
                activity_date: act.activity_date,
                quantity: act.quantity,
                unit_price: act.unit_price,
                currency: act.currency,
                fee: act.fee,
                tax: act.tax,
                amount: act.amount,
                status: act.status,
                notes: act.notes,
                fx_rate: act.fx_rate,
                metadata: act.metadata,
                needs_review: act.needs_review,
                source_system: act.source_system,
                source_record_id: act.source_record_id,
                source_group_id: act.source_group_id,
                idempotency_key: Some(idempotency_key),
                import_run_id: import_run_id.clone(),
            });
        }

        let activities_count = activity_upserts.len();

        debug!(
            "Preparing to upsert {} activities and {} assets for account {}",
            activities_count, assets_created, account_id
        );

        let bulk_result = self
            .activity_service
            .upsert_activities_bulk(activity_upserts)
            .await?;
        let activities_upserted = bulk_result.upserted;

        // 3b. Create quotes from trade activity prices (dedup by asset+date, last write wins)
        if let Some(ref quote_store) = self.quote_store {
            let now = Utc::now();
            let mut quotes_map: HashMap<String, Quote> = HashMap::new();

            for (asset_id, price, activity_datetime, currency) in &quote_data {
                let date_str = activity_datetime.format("%Y-%m-%d").to_string();
                let quote_id = format!("{}_{}_{}", asset_id, date_str, DATA_SOURCE_BROKER);
                quotes_map.insert(
                    quote_id.clone(),
                    Quote {
                        id: quote_id,
                        asset_id: asset_id.clone(),
                        timestamp: *activity_datetime,
                        open: *price,
                        high: *price,
                        low: *price,
                        close: *price,
                        adjclose: *price,
                        volume: Decimal::ZERO,
                        currency: currency.clone(),
                        data_source: DATA_SOURCE_BROKER.to_string(),
                        created_at: now,
                        notes: None,
                    },
                );
            }

            let quotes: Vec<Quote> = quotes_map.into_values().collect();

            if !quotes.is_empty() {
                match quote_store.upsert_quotes(&quotes).await {
                    Ok(count) => {
                        debug!(
                            "Saved {} broker-provided quotes from activities for account {}",
                            count, account_id
                        );
                    }
                    Err(e) => {
                        warn!(
                            "Failed to save broker quotes from activities for account {}: {}",
                            account_id, e
                        );
                    }
                }
            }
        }

        debug!(
            "Upserted {} activities for account {} ({} assets created, {} new asset IDs, {} need review)",
            activities_count,
            account_id,
            assets_created,
            new_asset_ids.len(),
            needs_review_count
        );

        Ok((
            activities_upserted,
            assets_created,
            new_asset_ids,
            needs_review_count,
        ))
    }

    async fn finalize_activity_sync_success(
        &self,
        account_id: String,
        last_synced_date: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        self.brokers_sync_state_repository
            .upsert_success(
                account_id,
                DEFAULT_BROKERAGE_PROVIDER.to_string(),
                last_synced_date,
                import_run_id,
            )
            .await
    }

    async fn finalize_activity_sync_failure(
        &self,
        account_id: String,
        error: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        self.brokers_sync_state_repository
            .upsert_failure(
                account_id,
                DEFAULT_BROKERAGE_PROVIDER.to_string(),
                error,
                import_run_id,
            )
            .await
    }

    async fn finalize_activity_sync_needs_review(
        &self,
        account_id: String,
        warning: String,
        import_run_id: Option<String>,
    ) -> Result<()> {
        self.brokers_sync_state_repository
            .upsert_needs_review(
                account_id,
                DEFAULT_BROKERAGE_PROVIDER.to_string(),
                warning,
                import_run_id,
            )
            .await
    }

    fn get_all_sync_states(&self) -> Result<Vec<BrokerSyncState>> {
        self.brokers_sync_state_repository.get_all()
    }

    fn get_import_runs(
        &self,
        run_type: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<ImportRun>> {
        let runs = match run_type {
            Some(rt) => self
                .import_run_repository
                .get_by_run_type(rt, limit, offset),
            None => self.import_run_repository.get_all(limit, offset),
        }?;
        Ok(runs)
    }

    async fn create_import_run(&self, account_id: &str, mode: ImportRunMode) -> Result<ImportRun> {
        let import_run = ImportRun::new(
            account_id.to_string(),
            DEFAULT_BROKERAGE_PROVIDER.to_string(),
            ImportRunType::Sync,
            mode,
            ReviewMode::Never,
        );

        self.import_run_repository.create(import_run).await
    }

    async fn finalize_import_run(
        &self,
        run_id: &str,
        summary: ImportRunSummary,
        status: ImportRunStatus,
        error: Option<String>,
    ) -> Result<()> {
        // Get the existing run
        let run = self.import_run_repository.get_by_id(run_id)?;
        if let Some(mut import_run) = run {
            import_run.summary = Some(summary);
            import_run.status = status.clone();
            import_run.finished_at = Some(Utc::now());
            import_run.updated_at = Utc::now();

            if let Some(err) = error {
                import_run.error = Some(err);
            }

            if status == ImportRunStatus::Applied {
                import_run.applied_at = Some(Utc::now());
            }

            self.import_run_repository.update(import_run).await?;
        } else {
            warn!("Import run not found: {}", run_id);
        }

        Ok(())
    }

    async fn save_broker_holdings(
        &self,
        account_id: String,
        balances: Vec<HoldingsBalance>,
        positions: Vec<HoldingsPosition>,
        option_positions: Vec<HoldingsOptionPosition>,
    ) -> Result<(HoldingsDiff, usize, Vec<String>)> {
        use std::collections::VecDeque;

        // Get the account to determine its currency
        let account = self.account_service.get_account(&account_id)?;
        let account_currency = account.currency.clone();

        let today = self.user_today();
        let now = chrono::Utc::now();

        // Build cash balances HashMap
        let mut cash_balances: HashMap<String, Decimal> = HashMap::new();
        for balance in &balances {
            if let (Some(currency), Some(cash)) = (
                balance.currency.as_ref().and_then(|c| c.code.clone()),
                balance.cash,
            ) {
                let cash_decimal = Decimal::from_f64(cash).unwrap_or(Decimal::ZERO);
                *cash_balances.entry(currency).or_insert(Decimal::ZERO) += cash_decimal;
            }
        }

        // 1. Build AssetSpecs and position data from broker positions
        let mut asset_specs: Vec<AssetSpec> = Vec::new();
        // Canonical instrument key → index into asset_specs
        let mut spec_key_to_idx: HashMap<String, usize> = HashMap::new();
        let mut authoritative_multipliers: HashMap<String, Decimal> = HashMap::new();
        let mut position_data: Vec<HoldingsPositionData> = Vec::new();

        for pos in &positions {
            let symbol_info = pos.symbol.as_ref().and_then(|s| s.symbol.as_ref());
            let symbol_type_code = symbol_info
                .and_then(|s| s.symbol_type.as_ref())
                .and_then(|t| t.code.clone());
            let is_crypto_asset = mapping::is_broker_crypto(symbol_type_code.as_deref());

            let raw_symbol = symbol_info
                .and_then(|s| s.raw_symbol.clone())
                .filter(|s| !s.trim().is_empty());
            let api_symbol = symbol_info
                .and_then(|s| s.symbol.clone())
                .filter(|s| !s.trim().is_empty());

            // Same normalization as the activity path, so a position and a trade in
            // the same instrument resolve to one asset. See `normalize_broker_symbol`.
            let normalized_symbol = mapping::normalize_broker_symbol(
                api_symbol.as_deref(),
                raw_symbol.as_deref(),
                symbol_info
                    .and_then(|s| s.exchange.as_ref())
                    .and_then(|e| {
                        mapping::broker_exchange_mic(e.mic_code.as_deref(), e.code.as_deref())
                    })
                    .as_deref(),
                is_crypto_asset,
            );
            let (symbol, exchange_mic) = match normalized_symbol {
                Some(normalized) => (normalized.symbol, normalized.exchange_mic),
                None if is_crypto_asset => {
                    debug!("Skipping crypto position without symbol");
                    continue;
                }
                None => {
                    debug!("Skipping position without symbol");
                    continue;
                }
            };

            let units = pos.units.unwrap_or(0.0);
            if units == 0.0 {
                debug!("Skipping position {} with zero units", symbol);
                continue;
            }

            let raw_quote_currency = pos
                .currency
                .as_ref()
                .and_then(|c| c.code.clone())
                .unwrap_or_else(|| account_currency.clone());
            let position_currency = normalize_currency_code(&raw_quote_currency).to_string();

            let instrument_type =
                map_broker_symbol_type(symbol_type_code.as_deref(), is_crypto_asset);
            let exact_multiplier = exact_positive_contract_multiplier(pos.contract_multiplier);
            let contract_multiplier = exact_multiplier.unwrap_or(Decimal::ONE);

            let asset_name = symbol_info.and_then(|s| s.name.clone().or(s.description.clone()));

            let spec = AssetSpec {
                name: asset_name,
                metadata: regular_contract_multiplier_metadata(exact_multiplier),
                ..AssetSpec::market_instrument(
                    symbol.clone(),
                    symbol.clone(),
                    exchange_mic,
                    instrument_type,
                    raw_quote_currency.clone(),
                )
            };

            let spec_key = spec.instrument_key().unwrap_or_else(|| {
                format!(
                    "{}:{}:{}",
                    symbol.to_uppercase(),
                    raw_quote_currency.to_uppercase(),
                    if is_crypto_asset { "CRYPTO" } else { "EQUITY" }
                )
            });

            if record_authoritative_multiplier(
                &mut authoritative_multipliers,
                &spec_key,
                exact_multiplier,
            ) {
                if let Some(existing_idx) = spec_key_to_idx.get(&spec_key) {
                    asset_specs[*existing_idx].metadata = spec.metadata.clone();
                }
            }

            if !spec_key_to_idx.contains_key(&spec_key) {
                let idx = asset_specs.len();
                asset_specs.push(spec);
                spec_key_to_idx.insert(spec_key.clone(), idx);
            }

            let quantity = Decimal::from_f64(units)
                .unwrap_or(Decimal::ZERO)
                .round_dp(HOLDINGS_DECIMAL_PRECISION);
            let raw_price = Decimal::from_f64(pos.price.unwrap_or(0.0)).unwrap_or(Decimal::ZERO);
            let quote_price = raw_price.round_dp(HOLDINGS_DECIMAL_PRECISION);
            // SnapTrade reports regular-position average cost per underlying unit. Store it per
            // broker position unit so quantity * average_cost remains the complete cost basis.
            let avg_cost = pos
                .average_purchase_price
                .and_then(Decimal::from_f64)
                .map(|value| {
                    normalize_regular_average_cost(value, &raw_quote_currency, contract_multiplier)
                });

            position_data.push(HoldingsPositionData {
                spec_key,
                quantity,
                quote_price,
                quote_currency: raw_quote_currency,
                average_cost: avg_cost,
                position_currency,
                contract_multiplier,
                rescale_average_cost_with_multiplier: true,
                multiplier_from_broker: exact_multiplier.is_some(),
            });
        }

        // 1b. Build AssetSpecs and position data from option positions
        for opt_pos in &option_positions {
            let option_symbol = match opt_pos.resolved_option_symbol() {
                Some(s) => s,
                None => {
                    debug!("Skipping option position without symbol");
                    continue;
                }
            };

            let ticker = match option_symbol
                .ticker
                .as_ref()
                .filter(|t| !t.trim().is_empty())
            {
                Some(t) => t.clone(),
                None => {
                    debug!("Skipping option position without OCC ticker");
                    continue;
                }
            };

            let units = opt_pos.units.unwrap_or(0.0);
            if units == 0.0 {
                debug!("Skipping option position {} with zero units", ticker);
                continue;
            }

            // Normalize OCC symbol
            let normalized_ticker =
                wealthfolio_core::utils::occ_symbol::normalize_option_symbol(&ticker)
                    .unwrap_or_else(|| ticker.clone());

            let raw_quote_currency = opt_pos
                .currency
                .as_ref()
                .and_then(|c| c.code.clone())
                .unwrap_or_else(|| account_currency.clone());
            let position_currency = normalize_currency_code(&raw_quote_currency).to_string();

            let exact_multiplier = exact_positive_contract_multiplier(option_symbol.multiplier);
            let multiplier = option_contract_multiplier(option_symbol);
            let metadata = holdings_option_metadata(option_symbol, &normalized_ticker, multiplier);

            let asset_name = option_symbol
                .underlying_symbol
                .as_ref()
                .and_then(|u| u.description.clone());

            let spec = AssetSpec {
                name: asset_name,
                metadata: Some(metadata),
                ..AssetSpec::market_instrument(
                    normalized_ticker.clone(),
                    normalized_ticker.clone(),
                    None, // OCC symbols are globally unique
                    InstrumentType::Option,
                    raw_quote_currency.clone(),
                )
            };

            let spec_key = spec
                .instrument_key()
                .unwrap_or_else(|| format!("OPTION:{}", normalized_ticker.to_uppercase()));

            if record_authoritative_multiplier(
                &mut authoritative_multipliers,
                &spec_key,
                exact_multiplier,
            ) {
                if let Some(existing_idx) = spec_key_to_idx.get(&spec_key) {
                    asset_specs[*existing_idx].metadata = spec.metadata.clone();
                }
            }

            if !spec_key_to_idx.contains_key(&spec_key) {
                let idx = asset_specs.len();
                asset_specs.push(spec);
                spec_key_to_idx.insert(spec_key.clone(), idx);
            }

            let quantity = Decimal::from_f64(units)
                .unwrap_or(Decimal::ZERO)
                .round_dp(HOLDINGS_DECIMAL_PRECISION);
            let raw_price =
                Decimal::from_f64(opt_pos.price.unwrap_or(0.0)).unwrap_or(Decimal::ZERO);
            let quote_price = raw_price.round_dp(HOLDINGS_DECIMAL_PRECISION);
            // The holdings aggregation API already reports option average cost per contract.
            // Unlike regular contracts, applying the multiplier again would double-scale it.
            let avg_cost = opt_pos
                .average_purchase_price
                .and_then(Decimal::from_f64)
                .map(|value| normalize_holdings_money(value, &raw_quote_currency).0);

            position_data.push(HoldingsPositionData {
                spec_key,
                quantity,
                quote_price,
                quote_currency: raw_quote_currency,
                average_cost: avg_cost,
                position_currency,
                contract_multiplier: multiplier,
                rescale_average_cost_with_multiplier: false,
                multiplier_from_broker: exact_multiplier.is_some(),
            });
        }

        // 2. Ensure assets exist via service layer (dedup by instrument_key)
        let ensure_result = self
            .asset_service
            .ensure_assets(asset_specs.clone(), self.activity_repository.as_ref())
            .await?;

        let assets_created = ensure_result.created_ids.len();
        let new_asset_ids = ensure_result.created_ids.clone();

        // Build instrument_key → asset_id lookup
        let mut key_to_asset_id: HashMap<String, String> = HashMap::new();
        for asset in ensure_result.assets.values() {
            if let Some(ref key) = asset.instrument_key {
                key_to_asset_id.insert(key.clone(), asset.id.clone());
            }
        }

        // Also map by direct asset id
        for id in ensure_result.assets.keys() {
            key_to_asset_id.insert(id.clone(), id.clone());
        }

        // 3. Build spec_key → asset_id mapping
        let mut spec_key_to_asset_id: HashMap<String, String> = HashMap::new();
        for (spec_key, idx) in &spec_key_to_idx {
            let spec = &asset_specs[*idx];
            // Try instrument_key first
            if let Some(ikey) = spec.instrument_key() {
                if let Some(asset_id) = key_to_asset_id.get(&ikey) {
                    spec_key_to_asset_id.insert(spec_key.clone(), asset_id.clone());
                    continue;
                }
            }
            // Fall back to ID if provided
            if let Some(ref id) = spec.id {
                if let Some(asset_id) = key_to_asset_id.get(id) {
                    spec_key_to_asset_id.insert(spec_key.clone(), asset_id.clone());
                }
            }
        }

        // Broker multipliers are asset economics shared by every account. New assets already carry
        // this metadata through AssetSpec; existing assets are updated only when the resolved value
        // changes. A failed backfill is best-effort and will be retried by the next holdings sync.
        for (spec_key, multiplier) in &authoritative_multipliers {
            let Some(asset_id) = spec_key_to_asset_id.get(spec_key) else {
                continue;
            };
            let Some(asset) = ensure_result.assets.get(asset_id) else {
                continue;
            };
            let incoming_metadata = spec_key_to_idx
                .get(spec_key)
                .and_then(|idx| asset_specs.get(*idx))
                .and_then(|spec| spec.metadata.as_ref());
            let Some(metadata) =
                contract_multiplier_metadata_update(asset, incoming_metadata, *multiplier)
            else {
                continue;
            };

            if let Err(error) = self
                .asset_service
                .update_asset_metadata(asset_id, metadata)
                .await
            {
                warn!(
                    "Could not persist broker contract multiplier for asset {}: {}",
                    asset_id, error
                );
            }
        }

        // 3b. Create quotes from broker-provided prices
        if let Some(ref quote_store) = self.quote_store {
            let today_date = today.format("%Y-%m-%d").to_string();
            let mut quotes: Vec<Quote> = Vec::new();

            for position in &position_data {
                if position.quote_price <= Decimal::ZERO {
                    continue;
                }
                let asset_id = match spec_key_to_asset_id.get(&position.spec_key) {
                    Some(id) => id,
                    None => continue,
                };

                quotes.push(Quote {
                    id: format!("{}_{}_{}", asset_id, today_date, DATA_SOURCE_BROKER),
                    asset_id: asset_id.clone(),
                    timestamp: now,
                    open: position.quote_price,
                    high: position.quote_price,
                    low: position.quote_price,
                    close: position.quote_price,
                    adjclose: position.quote_price,
                    volume: Decimal::ZERO,
                    currency: position.quote_currency.clone(),
                    data_source: DATA_SOURCE_BROKER.to_string(),
                    created_at: now,
                    notes: None,
                });
            }

            if !quotes.is_empty() {
                match quote_store.upsert_quotes(&quotes).await {
                    Ok(count) => {
                        debug!(
                            "Saved {} broker-provided quotes for account {}",
                            count, account_id
                        );
                    }
                    Err(e) => {
                        warn!(
                            "Failed to save broker quotes for account {}: {}",
                            account_id, e
                        );
                    }
                }
            }
        }

        let tomorrow = today + chrono::Days::new(1);
        let latest = self
            .snapshot_repository
            .get_latest_snapshot_before_date(&account_id, tomorrow)?;

        // 4. Build positions_map using resolved asset IDs.
        // Pre-sum quantities per asset so the cost-basis fallback below compares the latest
        // snapshot against the COMBINED position rather than an individual split row. A broker
        // that splits one holding across rows (margin/cash) and omits average_purchase_price
        // would otherwise never match the prior quantity, skip the "quantity unchanged -> reuse
        // prior cost" fallback, and overwrite a previously known basis with zero.
        // Positions the broker gave no multiplier for fall back to the asset's
        // declared value rather than a bare default, so a user-set multiplier
        // survives the sync instead of being overwritten on the position that
        // valuation actually reads.
        for position in &mut position_data {
            if position.multiplier_from_broker {
                continue;
            }
            // `authoritative_multipliers` first: it holds the value this sync
            // just persisted, while `ensure_result.assets` still holds the
            // asset as it was before that write. A broker that splits one
            // holding across rows supplies the multiplier on only some of them,
            // and reading the stale map would give those rows a different
            // multiplier from their siblings.
            let declared = authoritative_multipliers
                .get(&position.spec_key)
                .copied()
                .or_else(|| {
                    spec_key_to_asset_id
                        .get(&position.spec_key)
                        .and_then(|asset_id| ensure_result.assets.get(asset_id))
                        .map(|asset| asset.contract_multiplier())
                });
            let Some(declared) = declared else {
                continue;
            };
            apply_declared_contract_multiplier(position, declared);
        }

        let combined_quantities =
            Self::combined_quantities_by_asset(&position_data, &spec_key_to_asset_id);
        let mut positions_map: HashMap<String, Position> = HashMap::new();
        let mut total_cost_basis = Decimal::ZERO;

        for position in &position_data {
            let asset_id = match spec_key_to_asset_id.get(&position.spec_key) {
                Some(id) => id.clone(),
                None => {
                    warn!(
                        "Could not resolve asset for position key '{}'",
                        position.spec_key
                    );
                    continue;
                }
            };

            // Resolve cost against the combined quantity (all split rows for this asset) so the
            // prior-cost fallback works even when the broker splits the holding into rows.
            let combined_quantity = combined_quantities
                .get(&asset_id)
                .copied()
                .unwrap_or(position.quantity);
            let avg_cost = Self::resolve_position_average_cost(
                position.average_cost,
                latest
                    .as_ref()
                    .and_then(|snapshot| snapshot.positions.get(&asset_id)),
                combined_quantity,
                &position.position_currency,
                position.contract_multiplier,
                position.rescale_average_cost_with_multiplier,
            );
            let position_cost_basis =
                (position.quantity * avg_cost).round_dp(HOLDINGS_DECIMAL_PRECISION);
            total_cost_basis += position_cost_basis;

            let new_position = Position {
                id: format!("{}_{}", account_id, asset_id),
                account_id: account_id.clone(),
                asset_id: asset_id.clone(),
                quantity: position.quantity,
                average_cost: avg_cost,
                total_cost_basis: position_cost_basis,
                currency: position.position_currency.clone(),
                inception_date: now,
                lots: VecDeque::new(),
                created_at: now,
                last_updated: now,
                is_alternative: false,
                contract_multiplier: position.contract_multiplier,
                cost_basis_account: None,
                cost_basis_base: None,
            };

            // Brokers (e.g. Fidelity via SnapTrade) can report multiple position rows for the
            // same instrument — one per lot type (margin vs. cash sub-account) or per tax lot.
            // They all resolve to the same asset_id, so merge them into a single holding by
            // summing quantities and cost basis and recomputing the weighted-average cost.
            // Without this, each later row would overwrite the previous one, undercounting the
            // position (e.g. a margin + non-margin VTI lot would show only half the shares).
            match positions_map.entry(asset_id) {
                Entry::Occupied(mut existing) => {
                    Self::merge_broker_position(existing.get_mut(), new_position);
                }
                Entry::Vacant(slot) => {
                    slot.insert(new_position);
                }
            }
        }

        // Calculate cash totals
        let cash_total = cash_balances
            .get(&account_currency)
            .copied()
            .unwrap_or(Decimal::ZERO);

        // Build the snapshot
        let snapshot = AccountStateSnapshot {
            id: AccountStateSnapshot::stable_id(&account_id, today),
            account_id: account_id.clone(),
            snapshot_date: today,
            currency: account_currency,
            positions: positions_map.clone(),
            cash_balances,
            cost_basis: total_cost_basis,
            net_contribution: Decimal::ZERO,
            net_contribution_base: Decimal::ZERO,
            cash_total_account_currency: cash_total,
            cash_total_base_currency: Decimal::ZERO,
            calculated_at: now.naive_utc(),
            source: SnapshotSource::BrokerImported,
        };

        let positions_count = positions_map.len();

        // Check if content is unchanged from latest snapshot (skip if identical)
        let diff = Self::compute_holdings_diff(latest.as_ref(), &positions_map);

        if Self::should_preserve_manual_snapshot_for_date(latest.as_ref(), today) {
            info!(
                "Skipping broker snapshot save for account {} on {} because a manual snapshot already exists for that date",
                account_id, today
            );
            return Ok((diff, assets_created, new_asset_ids));
        }

        if let Some(existing) = latest {
            if existing.is_content_equal(&snapshot) {
                debug!(
                    "Broker holdings unchanged for account {}, skipping save",
                    account_id
                );
                return Ok((diff, 0, vec![]));
            }
        }

        // Save snapshot via SnapshotService if available (it emits HoldingsChanged internally).
        // Otherwise persist via repository and emit events manually.
        if let Some(ref snapshot_service) = self.snapshot_service {
            snapshot_service
                .save_manual_snapshot(&account_id, snapshot)
                .await?;
        } else {
            self.snapshot_repository
                .save_or_update_snapshot(&snapshot)
                .await?;

            self.event_sink.emit(DomainEvent::HoldingsChanged {
                account_ids: vec![account_id.clone()],
                asset_ids: new_asset_ids.clone(),
                earliest_snapshot_date: today,
            });
        }

        info!(
            "Saved broker holdings for account {}: {} positions (+{}, {} updated, {} removed, {} unchanged), {} assets created, {} new asset IDs",
            account_id,
            positions_count,
            diff.added_positions,
            diff.updated_positions,
            diff.removed_positions,
            diff.unchanged_positions,
            assets_created,
            new_asset_ids.len()
        );

        let mut saved_diff = diff;
        saved_diff.snapshot_saved = true;
        Ok((saved_diff, assets_created, new_asset_ids))
    }
}

impl BrokerSyncService {
    fn should_preserve_manual_snapshot_for_date(
        latest_snapshot: Option<&AccountStateSnapshot>,
        snapshot_date: NaiveDate,
    ) -> bool {
        matches!(
            latest_snapshot,
            Some(snapshot)
                if snapshot.snapshot_date == snapshot_date
                    && snapshot.source == SnapshotSource::ManualEntry
        )
    }

    /// Sum position quantities per resolved asset. Used so the cost-basis fallback can compare
    /// the latest snapshot against the combined position rather than an individual split row
    /// (brokers may report one holding as several rows — e.g. margin vs. cash sub-account).
    fn combined_quantities_by_asset(
        position_data: &[HoldingsPositionData],
        spec_key_to_asset_id: &HashMap<String, String>,
    ) -> HashMap<String, Decimal> {
        let mut totals: HashMap<String, Decimal> = HashMap::new();
        for position in position_data {
            if let Some(asset_id) = spec_key_to_asset_id.get(&position.spec_key) {
                *totals.entry(asset_id.clone()).or_insert(Decimal::ZERO) += position.quantity;
            }
        }
        totals
    }

    fn resolve_position_average_cost(
        broker_average_cost: Option<Decimal>,
        latest_position: Option<&Position>,
        quantity: Decimal,
        currency: &str,
        contract_multiplier: Decimal,
        rescale_with_multiplier: bool,
    ) -> Decimal {
        if let Some(avg_cost) = broker_average_cost {
            return avg_cost.round_dp(HOLDINGS_DECIMAL_PRECISION);
        }

        if let Some(previous) = latest_position {
            let same_quantity = previous.quantity.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == quantity.round_dp(HOLDINGS_DECIMAL_PRECISION);
            if same_quantity && previous.currency == currency {
                let previous_average_cost = previous.average_cost;
                if rescale_with_multiplier {
                    let previous_multiplier = if previous.contract_multiplier > Decimal::ZERO {
                        previous.contract_multiplier
                    } else {
                        Decimal::ONE
                    };
                    return (previous_average_cost * contract_multiplier / previous_multiplier)
                        .round_dp(HOLDINGS_DECIMAL_PRECISION);
                }
                return previous_average_cost.round_dp(HOLDINGS_DECIMAL_PRECISION);
            }
        }

        Decimal::ZERO
    }

    /// Merge an additional broker-reported lot into an existing position for the same asset.
    ///
    /// Some brokers (notably Fidelity via SnapTrade) return one position row per lot type
    /// (margin vs. cash sub-account) or per tax lot, all for the same instrument. Quantities and
    /// cost basis are summed and the average cost is recomputed as a quantity-weighted average so
    /// the merged holding reflects the full position rather than a single lot.
    fn merge_broker_position(existing: &mut Position, incoming: Position) {
        if existing
            .contract_multiplier
            .round_dp(HOLDINGS_DECIMAL_PRECISION)
            != incoming
                .contract_multiplier
                .round_dp(HOLDINGS_DECIMAL_PRECISION)
        {
            warn!(
                "Broker returned inconsistent contract multipliers for asset {}; retaining the first",
                existing.asset_id
            );
        }
        let combined_quantity =
            (existing.quantity + incoming.quantity).round_dp(HOLDINGS_DECIMAL_PRECISION);
        let combined_cost_basis = (existing.total_cost_basis + incoming.total_cost_basis)
            .round_dp(HOLDINGS_DECIMAL_PRECISION);

        existing.average_cost = if combined_quantity == Decimal::ZERO {
            Decimal::ZERO
        } else {
            (combined_cost_basis / combined_quantity).round_dp(HOLDINGS_DECIMAL_PRECISION)
        };
        existing.quantity = combined_quantity;
        existing.total_cost_basis = combined_cost_basis;
        existing.last_updated = incoming.last_updated;
    }

    fn compute_holdings_diff(
        latest_snapshot: Option<&AccountStateSnapshot>,
        current_positions: &HashMap<String, Position>,
    ) -> HoldingsDiff {
        let mut diff = HoldingsDiff {
            total_positions: current_positions.len(),
            ..Default::default()
        };

        if let Some(latest) = latest_snapshot {
            for (asset_id, current_position) in current_positions {
                match latest.positions.get(asset_id) {
                    Some(previous_position) => {
                        if Self::positions_equal_for_diff(previous_position, current_position) {
                            diff.unchanged_positions += 1;
                        } else {
                            diff.updated_positions += 1;
                        }
                    }
                    None => {
                        diff.added_positions += 1;
                    }
                }
            }

            diff.removed_positions = latest
                .positions
                .keys()
                .filter(|asset_id| !current_positions.contains_key(*asset_id))
                .count();
        } else {
            diff.added_positions = current_positions.len();
        }

        diff
    }

    fn positions_equal_for_diff(a: &Position, b: &Position) -> bool {
        a.asset_id == b.asset_id
            && a.quantity.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == b.quantity.round_dp(HOLDINGS_DECIMAL_PRECISION)
            && a.average_cost.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == b.average_cost.round_dp(HOLDINGS_DECIMAL_PRECISION)
            && a.total_cost_basis.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == b.total_cost_basis.round_dp(HOLDINGS_DECIMAL_PRECISION)
            && a.currency == b.currency
            && a.contract_multiplier.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == b.contract_multiplier.round_dp(HOLDINGS_DECIMAL_PRECISION)
    }

    /// Find the platform ID for a broker account using institution/broker metadata.
    fn find_platform_for_account(&self, broker_account: &BrokerAccount) -> Result<Option<String>> {
        let platforms = self.platform_repository.list()?;
        const MIN_PARTIAL_MATCH_LEN: usize = 6;
        let is_confident_partial_match = |left: &str, right: &str| -> bool {
            let (shorter, longer) = if left.len() <= right.len() {
                (left, right)
            } else {
                (right, left)
            };
            if shorter.len() < MIN_PARTIAL_MATCH_LEN {
                return false;
            }
            if !longer.contains(shorter) {
                return false;
            }
            // Require at least one meaningful token from shorter to be present in longer.
            shorter
                .split('_')
                .filter(|t| t.len() >= 3)
                .any(|token| longer.contains(token))
        };

        let mut name_candidates: Vec<String> = Vec::new();
        if let Some(name) = broker_account
            .institution_name
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            name_candidates.push(name.to_string());
        }

        let mut external_id_candidates: Vec<String> = Vec::new();
        if let Some(meta) = broker_account.meta.as_ref() {
            let read_path = |path: &[&str]| -> Option<String> {
                let mut value = meta;
                for key in path {
                    value = value.get(*key)?;
                }
                value
                    .as_str()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };

            for path in [
                &["institution_name"][..],
                &["institutionName"][..],
                &["brokerage_name"][..],
                &["brokerageName"][..],
                &["institution", "name"][..],
                &["brokerage", "name"][..],
                &["brokerage", "display_name"][..],
                &["brokerage", "displayName"][..],
            ] {
                if let Some(name) = read_path(path) {
                    name_candidates.push(name);
                }
            }

            for path in [
                &["brokerage_id"][..],
                &["brokerageId"][..],
                &["brokerage", "id"][..],
                &["brokerage", "uuid"][..],
            ] {
                if let Some(external_id) = read_path(path) {
                    external_id_candidates.push(external_id);
                }
            }
        }

        if let Some(auth_id) = broker_account
            .brokerage_authorization
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            external_id_candidates.push(auth_id.to_string());
        }

        name_candidates.sort();
        name_candidates.dedup();
        external_id_candidates.sort();
        external_id_candidates.dedup();

        // 1) Match by known external IDs first (most reliable)
        for candidate in &external_id_candidates {
            for platform in &platforms {
                if platform.external_id.as_deref() == Some(candidate.as_str()) {
                    return Ok(Some(platform.id.clone()));
                }
            }
        }

        // 2) Match by normalized institution/broker names
        for candidate in &name_candidates {
            let candidate_norm = candidate.to_uppercase().replace([' ', '-'], "_");

            for platform in &platforms {
                let id_norm = platform.id.to_uppercase();
                if id_norm == candidate_norm
                    || is_confident_partial_match(&candidate_norm, &id_norm)
                {
                    return Ok(Some(platform.id.clone()));
                }
            }

            for platform in &platforms {
                if let Some(name) = &platform.name {
                    let name_norm = name.to_uppercase().replace([' ', '-'], "_");
                    if name_norm == candidate_norm
                        || is_confident_partial_match(&candidate_norm, &name_norm)
                    {
                        return Ok(Some(platform.id.clone()));
                    }
                }
            }
        }

        warn!(
            "No existing platform found for broker account (institution={:?}, external_ids={:?})",
            broker_account.institution_name, external_id_candidates
        );
        Ok(None)
    }
}

/// Maps a SnapTrade symbol type code to our InstrumentType.
///
/// SnapTrade codes: ad (ADR), bnd (Bond), cs (Common Stock), cef (Closed End Fund),
/// crypto (Cryptocurrency), et (ETF), oef (Open Ended Fund), pm (Precious Metals),
/// ps (Preferred Stock), rt (Right), struct (Structured Product), ut (Unit),
/// wi (When Issued), wt (Warrant).
fn map_broker_symbol_type(code: Option<&str>, is_crypto_fallback: bool) -> InstrumentType {
    match code.map(|c| c.to_lowercase()).as_deref() {
        Some("crypto" | "cryptocurrency") => InstrumentType::Crypto,
        Some("bnd") => InstrumentType::Bond,
        Some("pm") => InstrumentType::Metal,
        Some("fx") => InstrumentType::Fx,
        Some(_) => InstrumentType::Equity,
        None if is_crypto_fallback => InstrumentType::Crypto,
        None => InstrumentType::Equity,
    }
}

fn default_tracking_mode_for_broker_account_type(account_type: &str) -> TrackingMode {
    if account_type == account_types::CREDIT_CARD {
        TrackingMode::Transactions
    } else {
        TrackingMode::Holdings
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::str::FromStr;

    use chrono::{NaiveDate, Utc};
    use rust_decimal::Decimal;
    use wealthfolio_core::portfolio::snapshot::{AccountStateSnapshot, Position, SnapshotSource};

    use super::{
        contract_multiplier_metadata_update, default_tracking_mode_for_broker_account_type,
        holdings_option_metadata, normalize_holdings_money, normalize_regular_average_cost,
        option_contract_multiplier, positive_contract_multiplier,
        regular_contract_multiplier_metadata, BrokerSyncService,
    };
    use crate::broker::models::{
        HoldingsOptionPosition, HoldingsOptionSymbol, HoldingsPosition, HoldingsUnderlyingSymbol,
    };
    use wealthfolio_core::accounts::{account_types, TrackingMode};
    use wealthfolio_core::assets::{
        Asset, AssetSpec, InstrumentType, OptionSpec, CONTRACT_MULTIPLIER_METADATA_KEY,
    };

    fn decimal(value: &str) -> Decimal {
        Decimal::from_str(value).expect("valid decimal")
    }

    fn position_without_broker_multiplier(
        multiplier: Decimal,
        average_cost: Option<Decimal>,
        rescale: bool,
    ) -> super::HoldingsPositionData {
        super::HoldingsPositionData {
            spec_key: "SEC:CFD".to_string(),
            quantity: decimal("10"),
            quote_price: decimal("100"),
            quote_currency: "USD".to_string(),
            average_cost,
            position_currency: "USD".to_string(),
            contract_multiplier: multiplier,
            rescale_average_cost_with_multiplier: rescale,
            multiplier_from_broker: false,
        }
    }

    #[test]
    fn declared_multiplier_replaces_the_default_and_rescales_cost() {
        // A CFD: the upstream contract has no multiplier field at all, so the
        // position lands on 1 and would silently revert a user-set value.
        let mut position =
            position_without_broker_multiplier(Decimal::ONE, Some(decimal("20")), true);

        super::apply_declared_contract_multiplier(&mut position, decimal("50"));

        assert_eq!(position.contract_multiplier, decimal("50"));
        assert_eq!(position.average_cost, Some(decimal("1000")));
    }

    #[test]
    fn declared_multiplier_leaves_option_cost_alone() {
        // Option average cost is already per contract, so it must not rescale.
        let mut position =
            position_without_broker_multiplier(decimal("100"), Some(decimal("250")), false);

        super::apply_declared_contract_multiplier(&mut position, decimal("115"));

        assert_eq!(position.contract_multiplier, decimal("115"));
        assert_eq!(position.average_cost, Some(decimal("250")));
    }

    #[test]
    fn declared_multiplier_is_a_noop_when_it_matches_or_is_invalid() {
        let mut position =
            position_without_broker_multiplier(decimal("50"), Some(decimal("20")), true);

        super::apply_declared_contract_multiplier(&mut position, decimal("50"));
        assert_eq!(position.average_cost, Some(decimal("20")));

        super::apply_declared_contract_multiplier(&mut position, Decimal::ZERO);
        assert_eq!(position.contract_multiplier, decimal("50"));
        assert_eq!(position.average_cost, Some(decimal("20")));
    }

    #[test]
    fn declared_multiplier_handles_a_missing_average_cost() {
        let mut position = position_without_broker_multiplier(Decimal::ONE, None, true);

        super::apply_declared_contract_multiplier(&mut position, decimal("50"));

        assert_eq!(position.contract_multiplier, decimal("50"));
        assert_eq!(position.average_cost, None);
    }

    #[test]
    fn normalize_holdings_money_converts_gbp_minor_units_to_major_units() {
        let (price, currency) = normalize_holdings_money(decimal("85"), "GBp");
        let (average_cost, cost_currency) = normalize_holdings_money(decimal("82.5"), "GBX");

        assert_eq!(price, decimal("0.85"));
        assert_eq!(currency, "GBP");
        assert_eq!(average_cost, decimal("0.825"));
        assert_eq!(cost_currency, "GBP");
        assert_eq!((decimal("10") * average_cost).round_dp(12), decimal("8.25"));
    }

    #[test]
    fn holdings_asset_spec_preserves_raw_quote_currency_metadata() {
        let spec = AssetSpec::market_instrument(
            "VUSA".to_string(),
            "VUSA".to_string(),
            Some("XLON".to_string()),
            InstrumentType::Equity,
            "GBp".to_string(),
        );
        let (broker_price, broker_currency) = normalize_holdings_money(decimal("85"), "GBp");

        assert_eq!(spec.quote_ccy, "GBp");
        assert_eq!(broker_price, decimal("0.85"));
        assert_eq!(broker_currency, "GBP");
    }

    #[test]
    fn holdings_position_data_keeps_quote_values_in_raw_quote_units() {
        let raw_quote_currency = "GBp".to_string();
        let position_currency =
            wealthfolio_core::fx::currency::normalize_currency_code(&raw_quote_currency)
                .to_string();
        let position = super::HoldingsPositionData {
            spec_key: "SEC:VUSA:XLON".to_string(),
            quantity: decimal("10"),
            quote_price: decimal("85"),
            quote_currency: raw_quote_currency,
            average_cost: Some(normalize_holdings_money(decimal("82.5"), "GBp").0),
            position_currency,
            contract_multiplier: Decimal::ONE,
            rescale_average_cost_with_multiplier: true,
            multiplier_from_broker: true,
        };

        assert_eq!(position.quote_price, decimal("85"));
        assert_eq!(position.quote_currency, "GBp");
        assert_eq!(position.average_cost, Some(decimal("0.825")));
        assert_eq!(position.position_currency, "GBP");
    }

    #[test]
    fn regular_contract_average_cost_is_stored_per_position_unit() {
        assert_eq!(
            normalize_regular_average_cost(decimal("12.5"), "USD", decimal("50")),
            decimal("625")
        );
        assert_eq!(
            normalize_regular_average_cost(decimal("82.5"), "GBp", decimal("10")),
            decimal("8.25")
        );
    }

    #[test]
    fn regular_asset_metadata_stores_only_non_default_multiplier() {
        assert!(regular_contract_multiplier_metadata(None).is_none());
        assert!(regular_contract_multiplier_metadata(Some(Decimal::ONE)).is_none());

        let metadata = regular_contract_multiplier_metadata(Some(decimal("50")))
            .expect("non-default multiplier metadata");
        let asset = Asset {
            instrument_type: Some(InstrumentType::Equity),
            metadata: Some(metadata),
            ..Default::default()
        };

        assert_eq!(asset.contract_multiplier(), decimal("50"));
    }

    #[test]
    fn asset_multiplier_update_compares_resolved_value() {
        let asset = Asset {
            instrument_type: Some(InstrumentType::Equity),
            metadata: Some(serde_json::json!({
                "contractMultiplier": "50",
                "identifiers": { "isin": "US0378331005" }
            })),
            ..Default::default()
        };

        assert!(contract_multiplier_metadata_update(&asset, None, decimal("50")).is_none());

        let updated = contract_multiplier_metadata_update(&asset, None, Decimal::ONE)
            .expect("changed multiplier");
        assert!(updated.get(CONTRACT_MULTIPLIER_METADATA_KEY).is_none());
        assert_eq!(
            updated["identifiers"],
            asset.metadata.unwrap()["identifiers"]
        );
    }

    #[test]
    fn fractional_asset_multiplier_is_value_stable() {
        let asset = Asset {
            instrument_type: Some(InstrumentType::Equity),
            metadata: Some(serde_json::json!({ "contractMultiplier": 0.1 })),
            ..Default::default()
        };

        assert_eq!(asset.contract_multiplier(), decimal("0.1"));
        assert!(contract_multiplier_metadata_update(&asset, None, decimal("0.1")).is_none());
    }

    #[test]
    fn option_multiplier_update_changes_nested_spec() {
        let asset = Asset {
            instrument_type: Some(InstrumentType::Option),
            metadata: Some(serde_json::json!({
                "option": {
                    "underlyingAssetId": "AAPL",
                    "expiration": "2026-12-18",
                    "right": "CALL",
                    "strike": "150",
                    "multiplier": "100"
                },
                "identifiers": { "occ": "AAPL  261218C00150000" }
            })),
            ..Default::default()
        };

        let updated = contract_multiplier_metadata_update(&asset, None, decimal("50"))
            .expect("changed multiplier");
        let spec: OptionSpec =
            serde_json::from_value(updated["option"].clone()).expect("valid option spec");

        assert_eq!(spec.multiplier, decimal("50"));
        assert_eq!(
            updated["identifiers"],
            asset.metadata.unwrap()["identifiers"]
        );
        assert!(updated.get(CONTRACT_MULTIPLIER_METADATA_KEY).is_none());
    }

    #[test]
    fn partial_option_spec_keeps_multiplier_at_top_level() {
        // A broker identifier that is not valid OCC can yield an option asset
        // whose spec is missing contract fields. Writing the multiplier inside
        // it — and removing the top-level key — would make the spec fail to
        // parse and silently resolve back to the 100 default.
        let asset = Asset {
            instrument_type: Some(InstrumentType::Option),
            metadata: Some(serde_json::json!({
                "option": { "right": "CALL", "multiplier": "100" }
            })),
            ..Default::default()
        };

        let updated = contract_multiplier_metadata_update(&asset, None, decimal("10"))
            .expect("changed multiplier");

        assert_eq!(
            updated[CONTRACT_MULTIPLIER_METADATA_KEY],
            serde_json::json!(decimal("10"))
        );
        // The partial spec is left intact for display.
        assert_eq!(updated["option"]["right"], serde_json::json!("CALL"));

        let resolved = Asset {
            metadata: Some(updated),
            ..asset
        };
        assert_eq!(resolved.contract_multiplier(), decimal("10"));
    }

    #[test]
    fn option_spec_completed_by_the_multiplier_write_goes_nested() {
        // Only `multiplier` is missing, so writing it produces a spec the
        // resolver can parse — the nested key is the right home.
        let asset = Asset {
            instrument_type: Some(InstrumentType::Option),
            metadata: Some(serde_json::json!({
                "option": {
                    "underlyingAssetId": "AAPL",
                    "expiration": "2026-12-18",
                    "right": "CALL",
                    "strike": "150"
                }
            })),
            ..Default::default()
        };

        let updated = contract_multiplier_metadata_update(&asset, None, decimal("50"))
            .expect("changed multiplier");

        assert!(updated.get(CONTRACT_MULTIPLIER_METADATA_KEY).is_none());
        let resolved = Asset {
            metadata: Some(updated),
            ..asset
        };
        assert_eq!(resolved.contract_multiplier(), decimal("50"));
    }

    #[test]
    fn option_without_any_spec_keeps_multiplier_at_top_level() {
        let asset = Asset {
            instrument_type: Some(InstrumentType::Option),
            metadata: None,
            ..Default::default()
        };

        let updated = contract_multiplier_metadata_update(&asset, None, decimal("10"))
            .expect("changed multiplier");

        assert_eq!(
            updated[CONTRACT_MULTIPLIER_METADATA_KEY],
            serde_json::json!(decimal("10"))
        );
    }

    #[test]
    fn holdings_contract_multiplier_prefers_exact_value_with_safe_defaults() {
        assert_eq!(
            positive_contract_multiplier(Some(50.0), Decimal::ONE),
            decimal("50")
        );
        assert_eq!(
            positive_contract_multiplier(Some(0.0), Decimal::ONE),
            Decimal::ONE
        );

        let adjusted = HoldingsOptionSymbol {
            multiplier: Some(50.0),
            ..Default::default()
        };
        let legacy_mini = HoldingsOptionSymbol {
            is_mini_option: Some(true),
            ..Default::default()
        };
        let standard = HoldingsOptionSymbol::default();

        assert_eq!(option_contract_multiplier(&adjusted), decimal("50"));
        assert_eq!(option_contract_multiplier(&legacy_mini), decimal("10"));
        assert_eq!(option_contract_multiplier(&standard), decimal("100"));
    }

    #[test]
    fn holdings_contract_deserializes_exact_multipliers() {
        let position: HoldingsPosition = serde_json::from_value(serde_json::json!({
            "contract_multiplier": 50
        }))
        .expect("regular holding");
        let option: HoldingsOptionPosition = serde_json::from_value(serde_json::json!({
            "symbol": {
                "option_symbol": {
                    "ticker": "AAPL  261218C00100000",
                    "multiplier": 25,
                    "is_mini_option": false
                }
            }
        }))
        .expect("option holding");

        assert_eq!(position.contract_multiplier, Some(50.0));
        assert_eq!(
            option
                .resolved_option_symbol()
                .and_then(|value| value.multiplier),
            Some(25.0)
        );
    }

    #[test]
    fn non_occ_option_uses_structured_metadata_and_exact_multiplier() {
        let option = HoldingsOptionSymbol {
            ticker: Some("BROKER-ADJUSTED-OPTION".to_string()),
            option_type: Some("CALL".to_string()),
            strike_price: Some(100.0),
            expiration_date: Some("2026-12-18".to_string()),
            multiplier: Some(50.0),
            underlying_symbol: Some(HoldingsUnderlyingSymbol {
                symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let metadata = holdings_option_metadata(&option, "BROKER-ADJUSTED-OPTION", decimal("50"));
        let spec: OptionSpec =
            serde_json::from_value(metadata["option"].clone()).expect("valid option spec");

        assert_eq!(spec.underlying_asset_id, "AAPL");
        assert_eq!(spec.multiplier, decimal("50"));
        assert_eq!(spec.occ_symbol, None);
    }

    fn position(
        account_id: &str,
        asset_id: &str,
        quantity: &str,
        average_cost: &str,
        total_cost_basis: &str,
        currency: &str,
    ) -> Position {
        let now = Utc::now();
        Position {
            id: format!("{}_{}", account_id, asset_id),
            account_id: account_id.to_string(),
            asset_id: asset_id.to_string(),
            quantity: decimal(quantity),
            average_cost: decimal(average_cost),
            total_cost_basis: decimal(total_cost_basis),
            currency: currency.to_string(),
            inception_date: now,
            lots: VecDeque::new(),
            created_at: now,
            last_updated: now,
            is_alternative: false,
            contract_multiplier: Decimal::ONE,
            cost_basis_account: None,
            cost_basis_base: None,
        }
    }

    fn snapshot_with_positions(positions: Vec<Position>) -> AccountStateSnapshot {
        AccountStateSnapshot {
            positions: positions
                .into_iter()
                .map(|p| (p.asset_id.clone(), p))
                .collect::<HashMap<_, _>>(),
            ..Default::default()
        }
    }

    fn snapshot_with_metadata(
        snapshot_date: &str,
        source: SnapshotSource,
        positions: Vec<Position>,
    ) -> AccountStateSnapshot {
        AccountStateSnapshot {
            snapshot_date: NaiveDate::parse_from_str(snapshot_date, "%Y-%m-%d")
                .expect("valid snapshot date"),
            source,
            positions: positions
                .into_iter()
                .map(|p| (p.asset_id.clone(), p))
                .collect::<HashMap<_, _>>(),
            ..Default::default()
        }
    }

    fn positions_map(positions: Vec<Position>) -> HashMap<String, Position> {
        positions
            .into_iter()
            .map(|p| (p.asset_id.clone(), p))
            .collect::<HashMap<_, _>>()
    }

    #[test]
    fn broker_credit_cards_default_to_transaction_tracking() {
        assert_eq!(
            default_tracking_mode_for_broker_account_type(account_types::CREDIT_CARD),
            TrackingMode::Transactions
        );
        assert_eq!(
            default_tracking_mode_for_broker_account_type(account_types::SECURITIES),
            TrackingMode::Holdings
        );
    }

    #[test]
    fn compute_holdings_diff_detects_added_updated_removed_and_unchanged() {
        let latest = snapshot_with_positions(vec![
            position("acc-1", "a", "10", "100", "1000", "USD"), // unchanged
            position("acc-1", "b", "5", "50", "250", "USD"),    // updated
            position("acc-1", "c", "2", "20", "40", "USD"),     // removed
        ]);

        let current = positions_map(vec![
            position("acc-1", "a", "10", "100", "1000", "USD"),
            position("acc-1", "b", "5", "55", "275", "USD"),
            position("acc-1", "d", "1", "10", "10", "USD"),
        ]);

        let diff = BrokerSyncService::compute_holdings_diff(Some(&latest), &current);
        assert_eq!(diff.total_positions, 3);
        assert_eq!(diff.added_positions, 1);
        assert_eq!(diff.updated_positions, 1);
        assert_eq!(diff.removed_positions, 1);
        assert_eq!(diff.unchanged_positions, 1);
    }

    #[test]
    fn compute_holdings_diff_ignores_tiny_decimal_drift_for_crypto() {
        let latest = snapshot_with_positions(vec![position(
            "acc-1",
            "btc",
            "0.123456789123",
            "42123.123456789123",
            "5199.999999999999",
            "USD",
        )]);

        // Drift only beyond 12 decimal places should still be unchanged.
        let current = positions_map(vec![position(
            "acc-1",
            "btc",
            "0.1234567891234",
            "42123.1234567891234",
            "5199.9999999999994",
            "USD",
        )]);

        let diff = BrokerSyncService::compute_holdings_diff(Some(&latest), &current);
        assert_eq!(diff.added_positions, 0);
        assert_eq!(diff.updated_positions, 0);
        assert_eq!(diff.removed_positions, 0);
        assert_eq!(diff.unchanged_positions, 1);
    }

    #[test]
    fn compute_holdings_diff_detects_cost_basis_change_with_same_quantity() {
        let latest = snapshot_with_positions(vec![position(
            "acc-1",
            "eth",
            "1.000000000001",
            "2000.000000000001",
            "2000.000000000003",
            "USD",
        )]);

        let current = positions_map(vec![position(
            "acc-1",
            "eth",
            "1.000000000001",
            "2000.010000000001",
            "2000.010000000003",
            "USD",
        )]);

        let diff = BrokerSyncService::compute_holdings_diff(Some(&latest), &current);
        assert_eq!(diff.added_positions, 0);
        assert_eq!(diff.updated_positions, 1);
        assert_eq!(diff.removed_positions, 0);
        assert_eq!(diff.unchanged_positions, 0);
    }

    #[test]
    fn should_preserve_manual_snapshot_for_same_day_only() {
        let manual_today = snapshot_with_metadata(
            "2026-03-29",
            SnapshotSource::ManualEntry,
            vec![position("acc-1", "aapl", "10", "100", "1000", "USD")],
        );
        let broker_today = snapshot_with_metadata(
            "2026-03-29",
            SnapshotSource::BrokerImported,
            vec![position("acc-1", "aapl", "10", "100", "1000", "USD")],
        );
        let manual_yesterday = snapshot_with_metadata(
            "2026-03-28",
            SnapshotSource::ManualEntry,
            vec![position("acc-1", "aapl", "10", "100", "1000", "USD")],
        );
        let today = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();

        assert!(BrokerSyncService::should_preserve_manual_snapshot_for_date(
            Some(&manual_today),
            today,
        ));
        assert!(
            !BrokerSyncService::should_preserve_manual_snapshot_for_date(
                Some(&broker_today),
                today,
            )
        );
        assert!(
            !BrokerSyncService::should_preserve_manual_snapshot_for_date(
                Some(&manual_yesterday),
                today,
            )
        );
    }

    #[test]
    fn resolve_position_average_cost_prefers_broker_value() {
        let latest = position("acc-1", "aapl", "10", "100", "1000", "USD");

        let resolved = BrokerSyncService::resolve_position_average_cost(
            Some(decimal("125.50")),
            Some(&latest),
            decimal("10"),
            "USD",
            decimal("50"),
            true,
        );

        assert_eq!(resolved, decimal("125.50"));
    }

    #[test]
    fn resolve_position_average_cost_reuses_latest_when_quantity_is_unchanged() {
        let latest = position("acc-1", "aapl", "10", "100.25", "1002.5", "USD");

        let resolved = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("10.0000000000004"),
            "USD",
            Decimal::ONE,
            true,
        );

        assert_eq!(resolved, decimal("100.25"));
    }

    #[test]
    fn resolve_position_average_cost_does_not_reuse_latest_when_quantity_or_currency_changes() {
        let latest = position("acc-1", "aapl", "10", "100.25", "1002.5", "USD");

        let quantity_changed = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("11"),
            "USD",
            Decimal::ONE,
            true,
        );
        let currency_changed = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("10"),
            "CAD",
            Decimal::ONE,
            true,
        );
        let missing = BrokerSyncService::resolve_position_average_cost(
            None,
            None,
            decimal("10"),
            "USD",
            Decimal::ONE,
            true,
        );

        assert_eq!(quantity_changed, Decimal::ZERO);
        assert_eq!(currency_changed, Decimal::ZERO);
        assert_eq!(missing, Decimal::ZERO);
    }

    #[test]
    fn resolve_position_average_cost_rescales_regular_cost_when_multiplier_changes() {
        let latest = position("acc-1", "future", "2", "12.5", "25", "USD");

        let resolved = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("2"),
            "USD",
            decimal("50"),
            true,
        );

        assert_eq!(resolved, decimal("625"));
    }

    #[test]
    fn resolve_position_average_cost_does_not_rescale_option_contract_cost() {
        let mut latest = position("acc-1", "option", "2", "5000", "10000", "USD");
        latest.contract_multiplier = decimal("100");

        let resolved = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("2"),
            "USD",
            decimal("50"),
            false,
        );

        assert_eq!(resolved, decimal("5000"));
    }

    #[test]
    fn merge_broker_position_sums_quantities_and_weights_average_cost() {
        // Two lots of the same instrument: 30 @ 100 and 10 @ 200.
        let mut existing = position("acc-1", "vti", "30", "100", "3000", "USD");
        let incoming = position("acc-1", "vti", "10", "200", "2000", "USD");

        BrokerSyncService::merge_broker_position(&mut existing, incoming);

        assert_eq!(existing.quantity, decimal("40"));
        assert_eq!(existing.total_cost_basis, decimal("5000"));
        // Quantity-weighted average: 5000 / 40 = 125.
        assert_eq!(existing.average_cost, decimal("125"));
    }

    #[test]
    fn merge_broker_position_matches_fidelity_combined_share_count() {
        // Reproduces the reported Fidelity-via-SnapTrade bug: VTI is returned as two lots
        // (a margin lot and a non-margin lot) that both resolve to the same asset_id.
        // Before the fix the second lot overwrote the first, halving the share count.
        let margin_basis = (decimal("32.005") * decimal("324.2431")).round_dp(12);
        let non_margin_basis = (decimal("18.423") * decimal("362.4893")).round_dp(12);

        let mut margin_lot = position(
            "acc-1",
            "vti",
            "32.005",
            "324.2431",
            &margin_basis.to_string(),
            "USD",
        );
        let non_margin_lot = position(
            "acc-1",
            "vti",
            "18.423",
            "362.4893",
            &non_margin_basis.to_string(),
            "USD",
        );

        BrokerSyncService::merge_broker_position(&mut margin_lot, non_margin_lot);

        // Fidelity's combined total for VTI is 50.428 shares.
        assert_eq!(margin_lot.quantity, decimal("50.428"));

        let combined_basis = (margin_basis + non_margin_basis).round_dp(12);
        assert_eq!(margin_lot.total_cost_basis, combined_basis);
        assert_eq!(
            margin_lot.average_cost,
            (combined_basis / decimal("50.428")).round_dp(12)
        );
    }

    #[test]
    fn merge_broker_position_handles_offsetting_quantities_without_dividing_by_zero() {
        // A net-flat instrument (e.g. a long lot fully offset by a short lot) must not panic.
        let mut existing = position("acc-1", "vti", "10", "100", "1000", "USD");
        let incoming = position("acc-1", "vti", "-10", "100", "-1000", "USD");

        BrokerSyncService::merge_broker_position(&mut existing, incoming);

        assert_eq!(existing.quantity, Decimal::ZERO);
        assert_eq!(existing.total_cost_basis, Decimal::ZERO);
        assert_eq!(existing.average_cost, Decimal::ZERO);
    }

    #[test]
    fn merge_broker_position_is_order_independent() {
        let mut a_then_b = position("acc-1", "vti", "30", "100", "3000", "USD");
        BrokerSyncService::merge_broker_position(
            &mut a_then_b,
            position("acc-1", "vti", "10", "200", "2000", "USD"),
        );

        let mut b_then_a = position("acc-1", "vti", "10", "200", "2000", "USD");
        BrokerSyncService::merge_broker_position(
            &mut b_then_a,
            position("acc-1", "vti", "30", "100", "3000", "USD"),
        );

        assert_eq!(a_then_b.quantity, b_then_a.quantity);
        assert_eq!(a_then_b.total_cost_basis, b_then_a.total_cost_basis);
        assert_eq!(a_then_b.average_cost, b_then_a.average_cost);
    }

    #[test]
    fn combined_quantities_by_asset_sums_split_rows() {
        let row = |spec_key: &str, quantity: &str| super::HoldingsPositionData {
            spec_key: spec_key.to_string(),
            quantity: decimal(quantity),
            quote_price: decimal("100"),
            quote_currency: "USD".to_string(),
            average_cost: None,
            position_currency: "USD".to_string(),
            contract_multiplier: Decimal::ONE,
            rescale_average_cost_with_multiplier: true,
            multiplier_from_broker: true,
        };
        let position_data = vec![
            row("EQUITY:VTI", "32.005"),
            row("EQUITY:VTI", "18.423"),
            row("EQUITY:VXUS", "10"),
        ];
        let mut spec_key_to_asset_id = HashMap::new();
        spec_key_to_asset_id.insert("EQUITY:VTI".to_string(), "asset-vti".to_string());
        spec_key_to_asset_id.insert("EQUITY:VXUS".to_string(), "asset-vxus".to_string());

        let totals =
            BrokerSyncService::combined_quantities_by_asset(&position_data, &spec_key_to_asset_id);

        assert_eq!(totals.get("asset-vti").copied(), Some(decimal("50.428")));
        assert_eq!(totals.get("asset-vxus").copied(), Some(decimal("10")));
    }

    #[test]
    fn resolve_position_average_cost_reuses_prior_cost_for_combined_split_quantity() {
        // Broker omits cost and splits the holding into two rows. Resolving against the COMBINED
        // quantity (50.428) — not a single 32.005 row — matches the prior snapshot and preserves
        // its average cost instead of zeroing it (the regression Codex flagged).
        let latest = position("acc-1", "vti", "50.428", "300", "15128.4", "USD");

        let combined = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("50.428"),
            "USD",
            Decimal::ONE,
            true,
        );
        let single_row = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("32.005"),
            "USD",
            Decimal::ONE,
            true,
        );

        assert_eq!(combined, decimal("300"));
        // The pre-fix per-row path compared 32.005 against 50.428 and lost the known basis.
        assert_eq!(single_row, Decimal::ZERO);
    }
}
