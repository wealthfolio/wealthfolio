//! Service for synchronizing broker data to the local database.

use async_trait::async_trait;
use log::{debug, info, warn};
use std::sync::Arc;

use super::mapping;
use super::models::{
    AccountUniversalActivity, BrokerAccount, BrokerConnection, HoldingsBalance, HoldingsDiff,
    HoldingsOptionPosition, HoldingsPosition, NewAccountInfo, SyncAccountsResponse,
    SyncConnectionsResponse,
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
    build_option_metadata, parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix,
    AssetServiceTrait, AssetSpec, InstrumentType,
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
use wealthfolio_core::utils::time_utils::valuation_date_today;

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

#[derive(Debug, Clone)]
struct HoldingsPositionData {
    spec_key: String,
    quantity: Decimal,
    quote_price: Decimal,
    quote_currency: String,
    average_cost: Option<Decimal>,
    position_currency: String,
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
        let tomorrow = valuation_date_today() + chrono::Days::new(1);
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

        let today = valuation_date_today();
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
        // Keyed by (symbol, currency) → index into asset_specs
        let mut spec_key_to_idx: HashMap<String, usize> = HashMap::new();
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

            let normalized_symbol = Self::normalize_holdings_symbol(
                raw_symbol.as_deref(),
                api_symbol.as_deref(),
                is_crypto_asset,
            );
            let (symbol, mut exchange_mic) = match normalized_symbol {
                Some(pair) => pair,
                None if is_crypto_asset => {
                    debug!("Skipping crypto position without symbol");
                    continue;
                }
                None => {
                    debug!("Skipping position without symbol");
                    continue;
                }
            };

            // Fallback: use exchange MIC from broker API data when suffix parsing didn't yield one
            if exchange_mic.is_none() && !is_crypto_asset {
                exchange_mic = symbol_info.and_then(|s| s.exchange.as_ref()).and_then(|e| {
                    e.mic_code
                        .clone()
                        .filter(|c| !c.trim().is_empty())
                        .or_else(|| e.code.clone().filter(|c| !c.trim().is_empty()))
                });
            }

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

            let asset_name = symbol_info.and_then(|s| s.name.clone().or(s.description.clone()));

            let spec = AssetSpec {
                name: asset_name,
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
            let avg_cost = pos
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

            let multiplier = if option_symbol.is_mini_option.unwrap_or(false) {
                Decimal::from(10)
            } else {
                Decimal::from(100)
            };
            let metadata = build_option_metadata(&normalized_ticker, multiplier);

            let asset_name = option_symbol
                .underlying_symbol
                .as_ref()
                .and_then(|u| u.description.clone());

            let spec = AssetSpec {
                name: asset_name,
                metadata,
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

            // Determine contract multiplier from the asset spec metadata
            let contract_multiplier = spec_key_to_idx
                .get(&position.spec_key)
                .and_then(|idx| asset_specs.get(*idx))
                .and_then(|spec| spec.option_multiplier())
                .unwrap_or(Decimal::ONE);

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
                contract_multiplier,
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
    ) -> Decimal {
        if let Some(avg_cost) = broker_average_cost {
            return avg_cost.round_dp(HOLDINGS_DECIMAL_PRECISION);
        }

        if let Some(previous) = latest_position {
            let same_quantity = previous.quantity.round_dp(HOLDINGS_DECIMAL_PRECISION)
                == quantity.round_dp(HOLDINGS_DECIMAL_PRECISION);
            if same_quantity && previous.currency == currency {
                return previous.average_cost.round_dp(HOLDINGS_DECIMAL_PRECISION);
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
    }

    fn normalize_holdings_symbol(
        raw_symbol: Option<&str>,
        api_symbol: Option<&str>,
        is_crypto: bool,
    ) -> Option<(String, Option<String>)> {
        let raw_symbol = raw_symbol.map(str::trim).filter(|s| !s.is_empty());
        let api_symbol = api_symbol.map(str::trim).filter(|s| !s.is_empty());

        if is_crypto {
            let symbol = raw_symbol.map(str::to_string).or_else(|| {
                api_symbol.map(|sym| {
                    parse_crypto_pair_symbol(sym)
                        .map(|(base, _)| base)
                        .unwrap_or_else(|| sym.to_string())
                })
            })?;
            return Some((symbol, None));
        }

        let raw_parsed = raw_symbol.map(|sym| {
            let (base, mic) = parse_symbol_with_exchange_suffix(sym);
            (base.to_string(), mic.map(|m| m.to_string()))
        });
        let api_parsed = api_symbol.map(|sym| {
            let (base, mic) = parse_symbol_with_exchange_suffix(sym);
            (base.to_string(), mic.map(|m| m.to_string()))
        });

        let symbol = raw_parsed
            .as_ref()
            .map(|(base, _)| base.clone())
            .or_else(|| api_parsed.as_ref().map(|(base, _)| base.clone()))?;
        let exchange_mic = raw_parsed
            .as_ref()
            .and_then(|(_, mic)| mic.clone())
            .or_else(|| api_parsed.as_ref().and_then(|(_, mic)| mic.clone()));

        Some((symbol, exchange_mic))
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
        default_tracking_mode_for_broker_account_type, normalize_holdings_money, BrokerSyncService,
    };
    use wealthfolio_core::accounts::{account_types, TrackingMode};
    use wealthfolio_core::assets::{AssetSpec, InstrumentType};

    fn decimal(value: &str) -> Decimal {
        Decimal::from_str(value).expect("valid decimal")
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
        };

        assert_eq!(position.quote_price, decimal("85"));
        assert_eq!(position.quote_currency, "GBp");
        assert_eq!(position.average_cost, Some(decimal("0.825")));
        assert_eq!(position.position_currency, "GBP");
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
    fn normalize_holdings_symbol_uses_api_suffix_when_raw_has_no_suffix() {
        let normalized =
            BrokerSyncService::normalize_holdings_symbol(Some("SHOP"), Some("SHOP.TO"), false)
                .unwrap();

        assert_eq!(normalized.0, "SHOP");
        assert_eq!(normalized.1.as_deref(), Some("XTSE"));
    }

    #[test]
    fn normalize_holdings_symbol_parses_suffix_from_raw_symbol() {
        let normalized =
            BrokerSyncService::normalize_holdings_symbol(Some("VOD.L"), Some("VOD"), false)
                .unwrap();

        assert_eq!(normalized.0, "VOD");
        assert_eq!(normalized.1.as_deref(), Some("XLON"));
    }

    #[test]
    fn normalize_holdings_symbol_normalizes_crypto_pairs() {
        let normalized =
            BrokerSyncService::normalize_holdings_symbol(None, Some("BTC-USD"), true).unwrap();

        assert_eq!(normalized.0, "BTC");
        assert_eq!(normalized.1, None);
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
        );
        let currency_changed = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("10"),
            "CAD",
        );
        let missing =
            BrokerSyncService::resolve_position_average_cost(None, None, decimal("10"), "USD");

        assert_eq!(quantity_changed, Decimal::ZERO);
        assert_eq!(currency_changed, Decimal::ZERO);
        assert_eq!(missing, Decimal::ZERO);
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
        );
        let single_row = BrokerSyncService::resolve_position_average_cost(
            None,
            Some(&latest),
            decimal("32.005"),
            "USD",
        );

        assert_eq!(combined, decimal("300"));
        // The pre-fix per-row path compared 32.005 against 50.428 and lost the known basis.
        assert_eq!(single_row, Decimal::ZERO);
    }
}
