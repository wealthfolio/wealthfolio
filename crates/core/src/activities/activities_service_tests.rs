#[cfg(test)]
mod tests {
    use crate::accounts::{Account, AccountServiceTrait, AccountUpdate, NewAccount};
    use crate::activities::activities_model::*;
    use crate::activities::{ActivityRepositoryTrait, ActivityService, ActivityServiceTrait};
    use crate::assets::{
        Asset, AssetKind, AssetServiceTrait, InstrumentType, ProviderProfile, QuoteMode,
        UpdateAssetProfile,
    };
    use crate::errors::{DatabaseError, Error, Result};
    use crate::events::{DomainEvent, MockDomainEventSink};
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::quotes::service::ProviderInfo;
    use crate::quotes::{
        LatestQuotePair, LatestQuoteSnapshot, Quote, QuoteImport, QuoteServiceTrait,
        QuoteSyncState, ResolvedQuote, SymbolSearchResult, SymbolSyncPlan, SyncMode, SyncResult,
    };
    use async_trait::async_trait;
    use chrono::{DateTime, NaiveDate, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    // --- Mock AccountService ---
    #[derive(Clone)]
    struct MockAccountService {
        accounts: Arc<Mutex<Vec<Account>>>,
    }

    impl MockAccountService {
        fn new() -> Self {
            Self {
                accounts: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn add_account(&self, account: Account) {
            self.accounts.lock().unwrap().push(account);
        }
    }

    #[async_trait]
    impl AccountServiceTrait for MockAccountService {
        async fn create_account(&self, _new_account: NewAccount) -> Result<Account> {
            unimplemented!()
        }

        async fn update_account(&self, _account_update: AccountUpdate) -> Result<Account> {
            unimplemented!()
        }

        async fn delete_account(&self, _account_id: &str) -> Result<()> {
            unimplemented!()
        }

        fn get_account(&self, account_id: &str) -> Result<Account> {
            let accounts = self.accounts.lock().unwrap();
            accounts
                .iter()
                .find(|a| a.id == account_id)
                .cloned()
                .ok_or_else(|| crate::errors::Error::Unexpected("Account not found".to_string()))
        }

        fn list_accounts(
            &self,
            _active_only: Option<bool>,
            _is_archived_filter: Option<bool>,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<Account>> {
            Ok(self.accounts.lock().unwrap().clone())
        }

        fn get_all_accounts(&self) -> Result<Vec<Account>> {
            Ok(self.accounts.lock().unwrap().clone())
        }

        fn get_active_accounts(&self) -> Result<Vec<Account>> {
            Ok(self.accounts.lock().unwrap().clone())
        }

        fn get_accounts_by_ids(&self, _account_ids: &[String]) -> Result<Vec<Account>> {
            unimplemented!()
        }

        fn get_non_archived_accounts(&self) -> Result<Vec<Account>> {
            Ok(self.accounts.lock().unwrap().clone())
        }

        fn get_active_non_archived_accounts(&self) -> Result<Vec<Account>> {
            Ok(self.accounts.lock().unwrap().clone())
        }

        fn get_base_currency(&self) -> Option<String> {
            Some("USD".to_string())
        }
    }

    // --- Mock AssetService ---
    #[derive(Clone)]
    struct MockAssetService {
        assets: Arc<Mutex<Vec<Asset>>>,
        get_asset_by_id_error: Arc<Mutex<Option<String>>>,
    }

    impl MockAssetService {
        fn new() -> Self {
            Self {
                assets: Arc::new(Mutex::new(Vec::new())),
                get_asset_by_id_error: Arc::new(Mutex::new(None)),
            }
        }

        fn add_asset(&self, asset: Asset) {
            self.assets.lock().unwrap().push(asset);
        }

        fn set_get_asset_by_id_error(&self, message: &str) {
            *self.get_asset_by_id_error.lock().unwrap() = Some(message.to_string());
        }
    }

    #[async_trait]
    impl AssetServiceTrait for MockAssetService {
        fn get_assets(&self) -> Result<Vec<Asset>> {
            Ok(self.assets.lock().unwrap().clone())
        }

        fn get_asset_by_id(&self, asset_id: &str) -> Result<Asset> {
            if let Some(message) = self.get_asset_by_id_error.lock().unwrap().clone() {
                return Err(Error::Unexpected(message));
            }
            let assets = self.assets.lock().unwrap();
            assets
                .iter()
                .find(|a| a.id == asset_id)
                .cloned()
                .ok_or_else(|| {
                    Error::Database(DatabaseError::NotFound(format!(
                        "Asset not found: {asset_id}",
                    )))
                })
        }

        async fn delete_asset(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn update_asset_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            // Return a dummy asset
            Ok(Asset::default())
        }

        async fn get_assets_by_asset_ids(&self, _asset_ids: &[String]) -> Result<Vec<Asset>> {
            unimplemented!()
        }

        async fn create_asset(&self, _new_asset: crate::assets::NewAsset) -> Result<Asset> {
            unimplemented!()
        }

        async fn get_or_create_minimal_asset(
            &self,
            asset_id: &str,
            _context_currency: Option<String>,
            _metadata: Option<crate::assets::AssetMetadata>,
            _quote_mode: Option<String>,
        ) -> Result<Asset> {
            self.get_asset_by_id(asset_id)
        }

        async fn enrich_asset_profile(&self, _asset_id: &str) -> Result<Asset> {
            unimplemented!()
        }

        async fn enrich_assets(&self, _asset_ids: Vec<String>) -> Result<(usize, usize, usize)> {
            Ok((0, 0, 0))
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn merge_unknown_asset(
            &self,
            _resolved_asset_id: &str,
            _unknown_asset_id: &str,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<u32> {
            Ok(0)
        }

        async fn ensure_assets(
            &self,
            specs: Vec<crate::assets::AssetSpec>,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<crate::assets::EnsureAssetsResult> {
            let mut result = crate::assets::EnsureAssetsResult::default();
            let assets = self.assets.lock().unwrap();

            // Look up existing assets by spec ID
            for spec in specs {
                if let Some(ref id) = spec.id {
                    if let Some(asset) = assets.iter().find(|a| a.id == *id) {
                        result.assets.insert(id.clone(), asset.clone());
                    }
                }
            }

            Ok(result)
        }
    }

    // --- Mock FxService ---
    #[derive(Clone, Default)]
    struct MockFxService {
        registered_pairs: Arc<Mutex<HashSet<(String, String)>>>,
    }

    impl MockFxService {
        fn new() -> Self {
            Self {
                registered_pairs: Arc::new(Mutex::new(HashSet::new())),
            }
        }

        fn get_registered_pairs(&self) -> HashSet<(String, String)> {
            self.registered_pairs.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl FxServiceTrait for MockFxService {
        fn initialize(&self) -> Result<()> {
            Ok(())
        }

        async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> Result<ExchangeRate> {
            unimplemented!()
        }

        fn get_historical_rates(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _days: i64,
        ) -> Result<Vec<ExchangeRate>> {
            unimplemented!()
        }

        async fn update_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _rate: Decimal,
        ) -> Result<ExchangeRate> {
            unimplemented!()
        }

        fn get_latest_exchange_rate(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<Decimal> {
            Ok(Decimal::ONE)
        }

        fn get_exchange_rate_for_date(
            &self,
            _from_currency: &str,
            _to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            unimplemented!()
        }

        fn convert_currency(
            &self,
            _amount: Decimal,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<Decimal> {
            unimplemented!()
        }

        fn convert_currency_for_date(
            &self,
            _amount: Decimal,
            _from_currency: &str,
            _to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            unimplemented!()
        }

        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            unimplemented!()
        }

        async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn register_currency_pair(
            &self,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<()> {
            let mut pairs = self.registered_pairs.lock().unwrap();
            pairs.insert((from_currency.to_string(), to_currency.to_string()));
            Ok(())
        }

        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn ensure_fx_pairs(&self, pairs: Vec<(String, String)>) -> Result<()> {
            let mut registered = self.registered_pairs.lock().unwrap();
            for (from, to) in pairs {
                registered.insert((from, to));
            }
            Ok(())
        }
    }

    // --- Mock QuoteService ---
    #[derive(Clone, Default)]
    struct MockQuoteService;

    #[async_trait]
    impl QuoteServiceTrait for MockQuoteService {
        fn get_latest_quote(&self, _symbol: &str) -> Result<Quote> {
            unimplemented!()
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> Result<HashMap<String, Quote>> {
            unimplemented!()
        }

        fn get_latest_quotes_snapshot(
            &self,
            asset_ids: &[String],
        ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
            let today = Utc::now().date_naive();
            let quotes = self.get_latest_quotes(asset_ids)?;
            Ok(quotes
                .into_iter()
                .map(|(asset_id, quote)| {
                    let quote_day = quote.timestamp.date_naive();
                    (
                        asset_id,
                        LatestQuoteSnapshot {
                            quote: Some(quote),
                            is_stale: quote_day < today,
                            effective_market_date: today.to_string(),
                            quote_date: Some(quote_day.to_string()),
                            no_quote_reason: None,
                        },
                    )
                })
                .collect())
        }

        fn get_latest_quotes_pair(
            &self,
            _symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            unimplemented!()
        }

        fn get_historical_quotes(&self, _symbol: &str) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
            unimplemented!()
        }

        fn get_quotes_in_range(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        fn get_quotes_in_range_filled(
            &self,
            _symbols: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn get_daily_quotes(
            &self,
            _asset_ids: &HashSet<String>,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<HashMap<NaiveDate, HashMap<String, Quote>>> {
            unimplemented!()
        }

        async fn add_quote(&self, _quote: &Quote) -> Result<Quote> {
            unimplemented!()
        }

        async fn update_quote(&self, quote: Quote) -> Result<Quote> {
            Ok(quote)
        }

        async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn bulk_upsert_quotes(&self, _quotes: Vec<Quote>) -> Result<usize> {
            unimplemented!()
        }

        async fn search_symbol(&self, _query: &str) -> Result<Vec<SymbolSearchResult>> {
            unimplemented!()
        }

        async fn search_symbol_with_currency(
            &self,
            query: &str,
            _account_currency: Option<&str>,
        ) -> Result<Vec<SymbolSearchResult>> {
            if query.eq_ignore_ascii_case("VWRPL") {
                return Ok(vec![SymbolSearchResult {
                    symbol: "VWRPL".to_string(),
                    short_name: "Vanguard FTSE All-World".to_string(),
                    long_name: "Vanguard FTSE All-World UCITS ETF".to_string(),
                    exchange: "LSE".to_string(),
                    exchange_mic: Some("XLON".to_string()),
                    exchange_name: Some("London Stock Exchange".to_string()),
                    quote_type: "EQUITY".to_string(),
                    type_display: "ETF".to_string(),
                    currency: Some("GBP".to_string()),
                    currency_source: Some("provider".to_string()),
                    data_source: Some("YAHOO".to_string()),
                    is_existing: false,
                    existing_asset_id: None,
                    index: String::new(),
                    score: 1.0,
                }]);
            }

            Ok(vec![])
        }

        async fn resolve_symbol_quote(
            &self,
            symbol: &str,
            exchange_mic: Option<&str>,
            _instrument_type: Option<&InstrumentType>,
            _quote_ccy: Option<&str>,
            _preferred_provider: Option<&str>,
        ) -> Result<ResolvedQuote> {
            let is_uk_vwrp = (exchange_mic == Some("XLON") || exchange_mic == Some("CXE"))
                && (symbol.eq_ignore_ascii_case("VWRPL")
                    || symbol.eq_ignore_ascii_case("VWRPL.XC"));
            if is_uk_vwrp {
                return Ok(ResolvedQuote {
                    currency: Some("GBP".to_string()),
                    price: Some(dec!(131.60)),
                    resolved_provider_id: Some("YAHOO".to_string()),
                });
            }

            Ok(ResolvedQuote::default())
        }

        async fn get_asset_profile(&self, _asset: &Asset) -> Result<ProviderProfile> {
            unimplemented!()
        }

        async fn fetch_quotes_from_provider(
            &self,
            _asset_id: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn fetch_quotes_for_symbol(
            &self,
            _symbol: &str,
            _currency: &str,
            _start: NaiveDate,
            _end: NaiveDate,
        ) -> Result<Vec<Quote>> {
            unimplemented!()
        }

        async fn sync(
            &self,
            _mode: SyncMode,
            _asset_ids: Option<Vec<String>>,
        ) -> Result<SyncResult> {
            unimplemented!()
        }

        async fn resync(&self, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
            unimplemented!()
        }

        async fn refresh_sync_state(&self) -> Result<()> {
            unimplemented!()
        }

        fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
            unimplemented!()
        }

        async fn handle_activity_created(
            &self,
            _symbol: &str,
            _activity_date: NaiveDate,
        ) -> Result<()> {
            Ok(())
        }

        async fn handle_activity_deleted(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        async fn delete_sync_state(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_symbols_needing_sync(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(vec![])
        }

        fn get_sync_state(&self, _symbol: &str) -> Result<Option<QuoteSyncState>> {
            Ok(None)
        }

        async fn mark_profile_enriched(&self, _symbol: &str) -> Result<()> {
            Ok(())
        }

        fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(vec![])
        }

        async fn update_position_status_from_holdings(
            &self,
            _current_holdings: &HashMap<String, Decimal>,
        ) -> Result<()> {
            Ok(())
        }

        fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
            Ok(vec![])
        }

        async fn reset_sync_errors(&self, _asset_ids: &[String]) -> Result<()> {
            Ok(())
        }

        async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> Result<()> {
            Ok(())
        }

        async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
            Ok(vec![])
        }

        async fn update_provider_settings(
            &self,
            _provider_id: &str,
            _priority: i32,
            _enabled: bool,
        ) -> Result<()> {
            Ok(())
        }

        async fn check_quotes_import(
            &self,
            _content: &[u8],
            _has_header_row: bool,
        ) -> Result<Vec<QuoteImport>> {
            Ok(vec![])
        }

        async fn import_quotes(
            &self,
            quotes: Vec<QuoteImport>,
            _overwrite: bool,
        ) -> Result<Vec<QuoteImport>> {
            Ok(quotes)
        }
    }

    // --- Mock ActivityRepository ---
    #[derive(Clone, Default)]
    struct MockActivityRepository {
        activities: Arc<Mutex<Vec<Activity>>>,
    }

    impl MockActivityRepository {
        fn new() -> Self {
            Self {
                activities: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn add_activity(&self, activity: Activity) {
            self.activities.lock().unwrap().push(activity);
        }
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepository {
        fn get_activity(&self, activity_id: &str) -> Result<Activity> {
            let activities = self.activities.lock().unwrap();
            activities
                .iter()
                .find(|a| a.id == activity_id)
                .cloned()
                .ok_or_else(|| Error::Unexpected("Activity not found".to_string()))
        }

        fn get_activities(&self) -> Result<Vec<Activity>> {
            Ok(self.activities.lock().unwrap().clone())
        }

        fn get_activities_by_account_id(&self, _account_id: &str) -> Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_activities_by_account_ids(&self, _account_ids: &[String]) -> Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_trading_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_income_activities(&self) -> Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_contribution_activities(
            &self,
            _account_ids: &[String],
            _start_date: chrono::DateTime<chrono::Utc>,
            _end_date: chrono::DateTime<chrono::Utc>,
        ) -> Result<Vec<crate::limits::ContributionActivity>> {
            unimplemented!()
        }

        fn search_activities(
            &self,
            _page: i64,
            _page_size: i64,
            _account_id_filter: Option<Vec<String>>,
            _activity_type_filter: Option<Vec<String>>,
            _asset_id_keyword: Option<String>,
            _sort: Option<Sort>,
            _is_draft_filter: Option<bool>,
            _date_from: Option<chrono::NaiveDate>,
            _date_to: Option<chrono::NaiveDate>,
            _instrument_type_filter: Option<Vec<String>>,
        ) -> Result<ActivitySearchResponse> {
            unimplemented!()
        }

        async fn create_activity(&self, new_activity: NewActivity) -> Result<Activity> {
            use crate::activities::ActivityStatus;
            // Extract asset_id before consuming other fields
            let asset_id = new_activity.get_symbol_id().map(|s| s.to_string());
            let metadata = new_activity
                .metadata
                .as_deref()
                .and_then(|metadata| serde_json::from_str(metadata).ok());
            let activity = Activity {
                id: new_activity.id.unwrap_or_else(|| "test-id".to_string()),
                account_id: new_activity.account_id,
                asset_id,
                activity_type: new_activity.activity_type,
                activity_type_override: None,
                source_type: None,
                subtype: new_activity.subtype,
                status: new_activity.status.unwrap_or(ActivityStatus::Posted),
                activity_date: Utc::now(),
                settlement_date: None,
                quantity: new_activity.quantity,
                unit_price: new_activity.unit_price,
                amount: new_activity.amount,
                fee: new_activity.fee,
                currency: new_activity.currency,
                fx_rate: new_activity.fx_rate,
                notes: new_activity.notes,
                metadata,
                source_system: None,
                source_record_id: None,
                source_group_id: new_activity.source_group_id,
                idempotency_key: new_activity.idempotency_key,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            };
            self.activities.lock().unwrap().push(activity.clone());
            Ok(activity)
        }

        async fn update_activity(&self, activity_update: ActivityUpdate) -> Result<Activity> {
            let mut activities = self.activities.lock().unwrap();
            let existing = activities
                .iter_mut()
                .find(|activity| activity.id == activity_update.id)
                .ok_or_else(|| Error::Unexpected("Activity not found".to_string()))?;
            let asset_id = activity_update.get_symbol_id().map(|s| s.to_string());

            existing.account_id = activity_update.account_id;
            existing.asset_id = asset_id;
            existing.activity_type = activity_update.activity_type;
            existing.subtype = match activity_update.subtype {
                Some(subtype) if subtype.trim().is_empty() => None,
                Some(subtype) => Some(subtype),
                None => existing.subtype.clone(),
            };
            existing.quantity = activity_update.quantity.unwrap_or(existing.quantity);
            existing.unit_price = activity_update.unit_price.unwrap_or(existing.unit_price);
            existing.amount = activity_update.amount.unwrap_or(existing.amount);
            existing.fee = activity_update.fee.unwrap_or(existing.fee);
            existing.currency = activity_update.currency;
            existing.fx_rate = activity_update.fx_rate.unwrap_or(existing.fx_rate);
            existing.notes = activity_update.notes;
            existing.updated_at = Utc::now();

            Ok(existing.clone())
        }

        async fn delete_activity(&self, _activity_id: String) -> Result<Activity> {
            unimplemented!()
        }

        async fn link_transfer_activities(
            &self,
            _activity_a_id: String,
            _activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            unimplemented!()
        }

        async fn unlink_transfer_activities(
            &self,
            activity_a_id: String,
            activity_b_id: String,
        ) -> Result<(Activity, Activity)> {
            let mut activities = self.activities.lock().unwrap();
            let first_index = activities
                .iter()
                .position(|activity| activity.id == activity_a_id)
                .ok_or_else(|| {
                    crate::errors::Error::Unexpected("first activity not found".to_string())
                })?;
            let second_index = activities
                .iter()
                .position(|activity| activity.id == activity_b_id)
                .ok_or_else(|| {
                    crate::errors::Error::Unexpected("second activity not found".to_string())
                })?;

            let first = activities[first_index].clone();
            let second = activities[second_index].clone();
            let (transfer_in_index, transfer_out_index) =
                match (first.activity_type.as_str(), second.activity_type.as_str()) {
                    ("TRANSFER_IN", "TRANSFER_OUT") => (first_index, second_index),
                    ("TRANSFER_OUT", "TRANSFER_IN") => (second_index, first_index),
                    _ => {
                        return Err(crate::errors::Error::Unexpected(
                            "unlink requires transfer pair".to_string(),
                        ));
                    }
                };

            let transfer_in_group = activities[transfer_in_index].source_group_id.clone();
            let transfer_out_group = activities[transfer_out_index].source_group_id.clone();
            if transfer_in_group.is_none() || transfer_in_group != transfer_out_group {
                return Err(crate::errors::Error::Unexpected(
                    "transfer pair is not linked".to_string(),
                ));
            }

            let mut transfer_in = activities[transfer_in_index].clone();
            let mut transfer_out = activities[transfer_out_index].clone();
            transfer_in.source_group_id = None;
            transfer_in.metadata = Some(json!({ "flow": { "is_external": true } }));
            transfer_out.source_group_id = None;
            transfer_out.metadata = Some(json!({ "flow": { "is_external": true } }));
            transfer_in.updated_at = Utc::now();
            transfer_out.updated_at = Utc::now();

            activities[transfer_in_index] = transfer_in.clone();
            activities[transfer_out_index] = transfer_out.clone();

            Ok((transfer_in, transfer_out))
        }

        async fn bulk_mutate_activities(
            &self,
            creates: Vec<NewActivity>,
            updates: Vec<ActivityUpdate>,
            _delete_ids: Vec<String>,
        ) -> Result<ActivityBulkMutationResult> {
            let mut created = Vec::new();
            for new_activity in creates {
                let activity = self.create_activity(new_activity).await?;
                created.push(activity);
            }
            let mut updated = Vec::new();
            for update in updates {
                let activity = self.update_activity(update).await?;
                updated.push(activity);
            }
            Ok(ActivityBulkMutationResult {
                created,
                updated,
                deleted: Vec::new(),
                created_mappings: Vec::new(),
                errors: Vec::new(),
            })
        }

        async fn create_activities(&self, _activities: Vec<NewActivity>) -> Result<usize> {
            let mut stored = self.activities.lock().unwrap();
            let mut count = 0usize;
            for new_activity in _activities {
                let asset_id = new_activity.get_symbol_id().map(|s| s.to_string());
                let metadata = new_activity
                    .metadata
                    .as_deref()
                    .and_then(|metadata| serde_json::from_str(metadata).ok());
                stored.push(Activity {
                    id: new_activity.id.unwrap_or_else(|| "test-id".to_string()),
                    account_id: new_activity.account_id,
                    asset_id,
                    activity_type: new_activity.activity_type,
                    activity_type_override: None,
                    source_type: None,
                    subtype: None,
                    status: new_activity
                        .status
                        .unwrap_or(crate::activities::ActivityStatus::Posted),
                    activity_date: Utc::now(),
                    settlement_date: None,
                    quantity: new_activity.quantity,
                    unit_price: new_activity.unit_price,
                    amount: new_activity.amount,
                    fee: new_activity.fee,
                    currency: new_activity.currency,
                    fx_rate: new_activity.fx_rate,
                    notes: new_activity.notes,
                    metadata,
                    source_system: None,
                    source_record_id: None,
                    source_group_id: new_activity.source_group_id,
                    idempotency_key: new_activity.idempotency_key,
                    import_run_id: None,
                    is_user_modified: false,
                    needs_review: false,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                });
                count += 1;
            }
            Ok(count)
        }

        fn get_first_activity_date(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }

        fn get_import_mapping(
            &self,
            _account_id: &str,
            _context_kind: &str,
        ) -> Result<Option<ImportMapping>> {
            unimplemented!()
        }

        async fn save_import_mapping(&self, _mapping: &ImportMapping) -> Result<()> {
            unimplemented!()
        }

        async fn link_account_template(
            &self,
            _account_id: &str,
            _template_id: &str,
            _context_kind: &str,
        ) -> Result<()> {
            unimplemented!()
        }

        fn list_import_templates(&self) -> Result<Vec<ImportTemplate>> {
            Ok(Vec::new())
        }

        fn get_import_template(&self, _template_id: &str) -> Result<Option<ImportTemplate>> {
            Ok(None)
        }

        async fn save_import_template(&self, _template: &ImportTemplate) -> Result<()> {
            unimplemented!()
        }

        async fn delete_import_template(&self, _template_id: &str) -> Result<()> {
            unimplemented!()
        }

        fn get_broker_sync_profile(
            &self,
            _account_id: &str,
            _source_system: &str,
        ) -> Result<Option<ImportTemplate>> {
            Ok(None)
        }

        async fn save_broker_sync_profile(&self, _template: &ImportTemplate) -> Result<()> {
            Ok(())
        }

        async fn link_broker_sync_profile(
            &self,
            _account_id: &str,
            _template_id: &str,
            _source_system: &str,
        ) -> Result<()> {
            Ok(())
        }

        fn calculate_average_cost(&self, _account_id: &str, _asset_id: &str) -> Result<Decimal> {
            unimplemented!()
        }

        fn get_income_activities_data(&self, _account_id: Option<&str>) -> Result<Vec<IncomeData>> {
            unimplemented!()
        }

        fn get_first_activity_date_overall(&self) -> Result<DateTime<Utc>> {
            unimplemented!()
        }

        fn get_activity_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _asset_ids: &[String],
        ) -> Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            Ok(std::collections::HashMap::new())
        }

        fn check_existing_duplicates(
            &self,
            idempotency_keys: &[String],
        ) -> Result<std::collections::HashMap<String, String>> {
            let stored = self.activities.lock().unwrap();
            let mut map = std::collections::HashMap::new();
            for requested_key in idempotency_keys {
                if let Some(existing) = stored
                    .iter()
                    .find(|a| a.idempotency_key.as_deref() == Some(requested_key.as_str()))
                {
                    map.insert(requested_key.clone(), existing.id.clone());
                }
            }
            Ok(map)
        }

        async fn bulk_upsert(
            &self,
            _activities: Vec<crate::activities::ActivityUpsert>,
        ) -> Result<crate::activities::BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _old_asset_id: &str, _new_asset_id: &str) -> Result<u32> {
            Ok(0)
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _asset_id: &str,
        ) -> Result<(Vec<String>, Vec<String>)> {
            Ok((Vec::new(), Vec::new()))
        }
    }

    // Helper to create a test account
    fn create_test_account(id: &str, currency: &str) -> Account {
        Account {
            id: id.to_string(),
            name: format!("Test Account {}", id),
            account_type: "SECURITIES".to_string(),
            currency: currency.to_string(),
            is_default: false,
            is_active: true,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            platform_id: None,
            group: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: crate::accounts::TrackingMode::NotSet,
        }
    }

    // Helper to create a test asset
    fn create_test_asset(id: &str, currency: &str) -> Asset {
        Asset {
            id: id.to_string(),
            display_code: Some(id.to_string()),
            quote_ccy: currency.to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        }
    }

    /// Create a test asset with proper instrument fields for matching
    fn create_test_asset_with_instrument(
        id: &str,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<InstrumentType>,
        currency: &str,
    ) -> Asset {
        Asset {
            id: id.to_string(),
            display_code: Some(symbol.to_string()),
            instrument_symbol: Some(symbol.to_string()),
            instrument_exchange_mic: exchange_mic.map(|s| s.to_string()),
            instrument_type,
            quote_ccy: currency.to_string(),
            kind: AssetKind::Investment,
            ..Default::default()
        }
    }

    fn create_test_asset_with_instrument_and_isin(
        id: &str,
        symbol: &str,
        exchange_mic: Option<&str>,
        instrument_type: Option<InstrumentType>,
        currency: &str,
        isin: &str,
    ) -> Asset {
        let mut asset =
            create_test_asset_with_instrument(id, symbol, exchange_mic, instrument_type, currency);
        asset.metadata = Some(json!({ "identifiers": { "isin": isin } }));
        asset
    }

    fn create_stored_activity(id: &str, account_id: &str, asset_id: Option<&str>) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: asset_id.map(|s| s.to_string()),
            activity_type: "BUY".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            amount: Some(dec!(100)),
            fee: Some(dec!(0)),
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn create_test_activity_update(
        id: &str,
        account_id: &str,
        asset: Option<AssetResolutionInput>,
        currency: &str,
    ) -> ActivityUpdate {
        ActivityUpdate {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(Some(dec!(1))),
            unit_price: Some(Some(dec!(100))),
            currency: currency.to_string(),
            fee: Some(Some(dec!(0))),
            amount: Some(Some(dec!(100))),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_create_split_rejects_missing_amount_ratio() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let new_activity = NewActivity {
            id: Some("split-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "SPLIT".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: None,
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("positive amount ratio"));
    }

    #[tokio::test]
    async fn test_create_split_accepts_negative_amount_after_normalization() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let new_activity = NewActivity {
            id: Some("split-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "SPLIT".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(-2)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().amount, Some(dec!(2)));
    }

    #[tokio::test]
    async fn test_update_to_split_rejects_missing_amount_ratio() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));
        activity_repository.add_activity(create_stored_activity(
            "activity-1",
            "acc-1",
            Some("AAPL"),
        ));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let mut update = create_test_activity_update(
            "activity-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "SPLIT".to_string();
        update.quantity = None;
        update.unit_price = None;
        update.amount = None;

        let result = activity_service.update_activity(update).await;

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("positive amount ratio"));
    }

    #[tokio::test]
    async fn test_update_existing_split_allows_omitted_amount_ratio() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));
        let mut existing = create_stored_activity("activity-1", "acc-1", Some("AAPL"));
        existing.activity_type = "SPLIT".to_string();
        existing.amount = Some(dec!(2));
        existing.quantity = None;
        existing.unit_price = None;
        activity_repository.add_activity(existing);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let mut update = create_test_activity_update(
            "activity-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "SPLIT".to_string();
        update.quantity = None;
        update.unit_price = None;
        update.amount = None;
        update.notes = Some("Updated note".to_string());

        let result = activity_service.update_activity(update).await;

        assert!(result.is_ok());
        let updated = result.unwrap();
        assert_eq!(updated.amount, Some(dec!(2)));
        assert_eq!(updated.notes.as_deref(), Some("Updated note"));
    }

    /// Test: When creating an activity where the activity currency matches the account currency,
    /// but the asset has a different currency, we should still register the FX pair for the asset currency.
    ///
    /// Scenario:
    /// - Account currency: USD
    /// - Asset currency: EUR (e.g., European stock)
    /// - Activity currency: USD (frontend sends account currency for new assets not in lookup)
    ///
    /// Expected: FX pair USD/EUR should be registered
    #[tokio::test]
    async fn test_registers_fx_pair_for_asset_currency_different_from_account() {
        // Setup
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        // Create account with USD currency
        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Create asset with EUR currency (different from account)
        let asset = create_test_asset("NESN", "EUR");
        asset_service.add_asset(asset);

        // Create the activity service
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service.clone(),
            quote_service,
        );

        // Create activity with USD currency (same as account) but for EUR asset
        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("NESN".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(), // Same as account currency
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        // Execute
        let result = activity_service.create_activity(new_activity).await;

        // Assert
        assert!(result.is_ok());

        // Check that FX pair was registered for asset currency
        let registered_pairs = fx_service.get_registered_pairs();

        // Should have registered EUR/USD (from=EUR asset currency, to=USD account currency)
        // This creates FX:EUR:USD for converting EUR values to account's USD
        assert!(
            registered_pairs.contains(&("EUR".to_string(), "USD".to_string())),
            "Expected FX pair EUR/USD to be registered for asset currency. Registered pairs: {:?}",
            registered_pairs
        );
    }

    /// Test: When activity currency differs from account currency, register that FX pair
    #[tokio::test]
    async fn test_registers_fx_pair_for_activity_currency_different_from_account() {
        // Setup
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        // Create account with USD currency
        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Create asset with EUR currency
        let asset = create_test_asset("NESN", "EUR");
        asset_service.add_asset(asset);

        // Create the activity service
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service.clone(),
            quote_service,
        );

        // Create activity with EUR currency (different from account USD)
        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("NESN".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(100)),
            currency: "EUR".to_string(), // Different from account currency
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        // Execute
        let result = activity_service.create_activity(new_activity).await;

        // Assert
        assert!(result.is_ok());

        // Check that FX pair was registered
        let registered_pairs = fx_service.get_registered_pairs();

        // Should have registered EUR/USD (from=EUR activity currency, to=USD account currency)
        // This creates FX:EUR:USD for converting EUR values to account's USD
        assert!(
            registered_pairs.contains(&("EUR".to_string(), "USD".to_string())),
            "Expected FX pair EUR/USD to be registered. Registered pairs: {:?}",
            registered_pairs
        );
    }

    #[tokio::test]
    async fn test_duplicate_manual_create_returns_clear_error() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let duplicate_activity = NewActivity {
            id: None,
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2026-02-27T21:32:00Z".to_string(),
            quantity: Some(dec!(25)),
            unit_price: Some(dec!(51.90)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: None,
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        activity_service
            .create_activity(duplicate_activity.clone())
            .await
            .expect("first create should succeed");
        let err = activity_service
            .create_activity(duplicate_activity)
            .await
            .expect_err("second identical create should be rejected as duplicate");

        assert!(
            err.to_string().contains("Duplicate activity detected"),
            "error should clearly explain duplicate detection: {}",
            err
        );
    }

    #[tokio::test]
    async fn test_source_record_id_changes_idempotency_for_provider_create() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let provider_activity_one = NewActivity {
            id: None,
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2026-02-27T21:32:00Z".to_string(),
            quantity: Some(dec!(25)),
            unit_price: Some(dec!(51.90)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: None,
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: Some("SNAPTRADE".to_string()),
            source_record_id: Some("provider-1".to_string()),
            source_group_id: None,
            idempotency_key: None,
        };

        let mut provider_activity_two = provider_activity_one.clone();
        provider_activity_two.source_record_id = Some("provider-2".to_string());

        activity_service
            .create_activity(provider_activity_one)
            .await
            .expect("first provider create should succeed");
        activity_service
            .create_activity(provider_activity_two)
            .await
            .expect("second provider create with different source record id should succeed");
    }

    #[tokio::test]
    async fn test_bulk_create_assigns_idempotency_key() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let request = ActivityBulkMutationRequest {
            creates: vec![NewActivity {
                id: Some("temp-1".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("AAPL".to_string()),
                    ..Default::default()
                }),
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2026-02-27T21:32:00Z".to_string(),
                quantity: Some(dec!(25)),
                unit_price: Some(dec!(51.90)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: None,
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            }],
            updates: vec![],
            delete_ids: vec![],
        };

        let result = activity_service
            .bulk_mutate_activities(request)
            .await
            .expect("bulk create should succeed");

        assert_eq!(result.created.len(), 1);
        let key = result.created[0]
            .idempotency_key
            .as_deref()
            .expect("bulk create should assign idempotency key");
        assert_eq!(key.len(), 64, "key should be a sha256 hex string");
    }

    #[tokio::test]
    async fn test_bulk_update_preserves_existing_asset_backed_subtype_when_omitted() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "ETH",
            "ETH",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));

        let mut existing = create_stored_activity("staking-1", "acc-1", Some("ETH"));
        existing.activity_type = "INTEREST".to_string();
        existing.subtype = Some("STAKING_REWARD".to_string());
        existing.quantity = Some(dec!(1));
        existing.unit_price = Some(dec!(100));
        existing.amount = Some(dec!(100));
        activity_repository.add_activity(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let mut update = create_test_activity_update(
            "staking-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("ETH".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "INTEREST".to_string();
        update.subtype = None;
        update.quantity = None;
        update.unit_price = None;
        update.amount = None;

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![update],
                delete_ids: vec![],
            })
            .await
            .expect("bulk update should succeed");

        assert!(result.errors.is_empty());
        assert_eq!(result.updated.len(), 1);
        assert_eq!(result.updated[0].subtype.as_deref(), Some("STAKING_REWARD"));
        assert_eq!(result.updated[0].quantity, Some(dec!(1)));
        assert_eq!(result.updated[0].unit_price, Some(dec!(100)));
    }

    #[tokio::test]
    async fn test_bulk_update_clears_existing_subtype_when_explicitly_cleared() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "ETH",
            "ETH",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));

        let mut existing = create_stored_activity("staking-1", "acc-1", Some("ETH"));
        existing.activity_type = "INTEREST".to_string();
        existing.subtype = Some("STAKING_REWARD".to_string());
        existing.quantity = Some(dec!(1));
        existing.unit_price = Some(dec!(100));
        existing.amount = Some(dec!(100));
        activity_repository.add_activity(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let mut update = create_test_activity_update(
            "staking-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("ETH".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "DIVIDEND".to_string();
        update.subtype = Some(String::new());
        update.quantity = None;
        update.unit_price = None;
        update.amount = Some(Some(dec!(100)));

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![update],
                delete_ids: vec![],
            })
            .await
            .expect("bulk update should succeed");

        assert!(result.errors.is_empty());
        assert_eq!(result.updated.len(), 1);
        assert_eq!(result.updated[0].activity_type, "DIVIDEND");
        assert_eq!(result.updated[0].subtype, None);
    }

    #[tokio::test]
    async fn test_bulk_update_preserves_provider_subtype_label_when_omitted() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "AAPL_OPT",
            "AAPL251219C00200000",
            None,
            Some(InstrumentType::Option),
            "USD",
        ));

        let mut existing = create_stored_activity("option-1", "acc-1", Some("AAPL_OPT"));
        existing.activity_type = "BUY".to_string();
        existing.subtype = Some("BUY_TO_OPEN".to_string());
        activity_repository.add_activity(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let mut update = create_test_activity_update(
            "option-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("AAPL_OPT".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "BUY".to_string();
        update.subtype = None;
        update.quantity = None;
        update.unit_price = None;
        update.amount = None;

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![update],
                delete_ids: vec![],
            })
            .await
            .expect("bulk update should succeed");

        assert!(result.errors.is_empty());
        assert_eq!(result.updated.len(), 1);
        assert_eq!(result.updated[0].subtype.as_deref(), Some("BUY_TO_OPEN"));
    }

    #[tokio::test]
    async fn test_bulk_update_rejects_asset_backed_subtype_without_quantity() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "ETH",
            "ETH",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));

        let mut existing = create_stored_activity("interest-1", "acc-1", Some("ETH"));
        existing.activity_type = "INTEREST".to_string();
        existing.subtype = None;
        existing.quantity = None;
        existing.unit_price = None;
        existing.amount = Some(dec!(25));
        activity_repository.add_activity(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let mut update = create_test_activity_update(
            "interest-1",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("ETH".to_string()),
                ..Default::default()
            }),
            "USD",
        );
        update.activity_type = "INTEREST".to_string();
        update.subtype = Some("STAKING_REWARD".to_string());
        update.quantity = None;
        update.unit_price = Some(Some(dec!(100)));
        update.amount = Some(Some(dec!(100)));

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![update],
                delete_ids: vec![],
            })
            .await
            .expect("bulk mutation should return structured errors");

        assert_eq!(result.updated.len(), 0);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].action, "update");
        assert!(
            result.errors[0]
                .message
                .contains("Asset-backed income activities require a positive quantity"),
            "unexpected error: {}",
            result.errors[0].message
        );
    }

    /// Test: When activity currency, asset currency, and account currency are all the same,
    /// no FX pair should be registered
    #[tokio::test]
    async fn test_no_fx_pair_registered_when_all_currencies_match() {
        // Setup
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        // Create account with USD currency
        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Create asset with USD currency (same as account)
        let asset = create_test_asset("AAPL", "USD");
        asset_service.add_asset(asset);

        // Create the activity service
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service.clone(),
            quote_service,
        );

        // Create activity with USD currency (same as account and asset)
        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        // Execute
        let result = activity_service.create_activity(new_activity).await;

        // Assert
        assert!(result.is_ok());

        // Check that no FX pair was registered
        let registered_pairs = fx_service.get_registered_pairs();

        assert!(
            registered_pairs.is_empty(),
            "Expected no FX pairs to be registered. Registered pairs: {:?}",
            registered_pairs
        );
    }

    // ==========================================================================
    // resolve_asset_id() and infer_asset_kind() Tests (via create_activity)
    // ==========================================================================

    /// Test: When symbol + exchange_mic are provided, finds existing asset by instrument fields
    #[tokio::test]
    async fn test_resolve_asset_id_with_symbol_and_exchange() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "aapl-uuid",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("AAPL".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("aapl-uuid".to_string()),
            "Should find existing asset by instrument fields"
        );
    }

    /// Test: When symbol is provided without exchange, generates SEC:SYMBOL:UNKNOWN
    #[tokio::test]
    async fn test_resolve_asset_id_symbol_without_exchange() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "tsla-uuid",
            "TSLA",
            None,
            Some(InstrumentType::Equity),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("TSLA".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(5)),
            unit_price: Some(dec!(200)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("tsla-uuid".to_string()),
            "Should find existing asset by instrument symbol"
        );
    }

    #[tokio::test]
    async fn test_create_rejects_new_equity_without_requested_quote_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-missing-quote".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("NFLX".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                quote_mode: Some("MARKET".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(500)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_err());
        let error = result.err().unwrap().to_string();
        assert!(
            error.contains("Quote currency is required"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn test_create_rejects_staking_reward_without_symbol_or_asset_id() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "CAD"));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("staking-reward-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: None,
            activity_type: "INTEREST".to_string(),
            subtype: Some("STAKING_REWARD".to_string()),
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(0.25)),
            unit_price: Some(dec!(4000)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_err());
        let error = result.err().unwrap().to_string();
        assert!(
            error.contains("Asset-backed activities need either asset_id or symbol"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn test_create_canonicalizes_case_insensitive_subtype() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "ETH",
            "ETH",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let activity = activity_service
            .create_activity(NewActivity {
                id: Some("staking-reward-lowercase".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("ETH".to_string()),
                    ..Default::default()
                }),
                activity_type: "INTEREST".to_string(),
                subtype: Some("staking_reward".to_string()),
                activity_date: "2024-01-15".to_string(),
                quantity: Some(dec!(0.25)),
                unit_price: Some(dec!(4000)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(1000)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            })
            .await
            .expect("lowercase subtype should save");

        assert_eq!(activity.subtype.as_deref(), Some("STAKING_REWARD"));
    }

    #[tokio::test]
    async fn test_create_asset_backed_income_normalizes_negative_values_before_validation() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "ETH",
            "ETH",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let activity = activity_service
            .create_activity(NewActivity {
                id: Some("staking-reward-negative".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("ETH".to_string()),
                    ..Default::default()
                }),
                activity_type: "INTEREST".to_string(),
                subtype: Some("STAKING_REWARD".to_string()),
                activity_date: "2024-01-15".to_string(),
                quantity: Some(dec!(-0.25)),
                unit_price: Some(dec!(-4000)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(-1000)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            })
            .await
            .expect("negative provider-style signs should normalize before validation");

        assert_eq!(activity.quantity, Some(dec!(0.25)));
        assert_eq!(activity.unit_price, Some(dec!(4000)));
        assert_eq!(activity.amount, Some(dec!(1000)));
    }

    #[tokio::test]
    async fn test_sync_prepare_allows_provider_subtype_label() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account.clone());
        asset_service.add_asset(create_test_asset("AAPL_OPT", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_sync(
                vec![NewActivity {
                    id: Some("option-buy".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: Some(AssetResolutionInput {
                        id: Some("AAPL_OPT".to_string()),
                        ..Default::default()
                    }),
                    activity_type: "BUY".to_string(),
                    subtype: Some("BUY_TO_OPEN".to_string()),
                    activity_date: "2024-01-15".to_string(),
                    quantity: Some(dec!(1)),
                    unit_price: Some(dec!(100)),
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    amount: Some(dec!(100)),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("option-buy".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should not reject provider subtype labels");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        assert_eq!(
            result.prepared[0].activity.subtype.as_deref(),
            Some("BUY_TO_OPEN")
        );
    }

    #[tokio::test]
    async fn test_sync_prepare_keeps_incomplete_valid_asset_backed_subtype_for_review() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account.clone());

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_sync(
                vec![NewActivity {
                    id: Some("staking-cash-only".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: None,
                    activity_type: "INTEREST".to_string(),
                    subtype: Some("STAKING_REWARD".to_string()),
                    activity_date: "2024-01-15".to_string(),
                    quantity: None,
                    unit_price: None,
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    amount: Some(dec!(25)),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("staking-cash-only".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should keep broker rows for review");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        let prepared = &result.prepared[0].activity;
        assert_eq!(prepared.activity_type, "INTEREST");
        assert_eq!(prepared.subtype, None);
        assert_eq!(prepared.amount, Some(dec!(25)));
        assert_eq!(prepared.quantity, None);
        assert_eq!(prepared.needs_review, Some(true));
    }

    #[tokio::test]
    async fn test_sync_prepare_keeps_unresolved_asset_backed_income_for_review() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account.clone());

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_sync(
                vec![NewActivity {
                    id: Some("staking-invalid-symbol".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: Some(AssetResolutionInput {
                        symbol: Some("$FOO".to_string()),
                        ..Default::default()
                    }),
                    activity_type: "INTEREST".to_string(),
                    subtype: Some("STAKING_REWARD".to_string()),
                    activity_date: "2024-01-15".to_string(),
                    quantity: Some(dec!(2)),
                    unit_price: Some(dec!(12.50)),
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    amount: None,
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("staking-invalid-symbol".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should not drop unresolved broker rows");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        let prepared = &result.prepared[0];
        assert_eq!(prepared.resolved_asset_id, None);
        assert_eq!(prepared.activity.subtype, None);
        assert_eq!(prepared.activity.amount, Some(dec!(25.00)));
        assert_eq!(prepared.activity.needs_review, Some(true));
    }

    #[tokio::test]
    async fn test_sync_prepare_keeps_mismatched_asset_backed_subtype_as_metadata() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account.clone());

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_sync(
                vec![NewActivity {
                    id: Some("interest-drip-label".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: None,
                    activity_type: "INTEREST".to_string(),
                    subtype: Some("DRIP".to_string()),
                    activity_date: "2024-01-15".to_string(),
                    quantity: None,
                    unit_price: None,
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    amount: Some(dec!(25)),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("interest-drip-label".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should keep mismatched subtype as inert metadata");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        assert_eq!(result.prepared[0].activity.subtype.as_deref(), Some("DRIP"));
        assert_eq!(result.prepared[0].activity.needs_review, None);
        assert_eq!(result.prepared[0].activity.status, None);
    }

    #[tokio::test]
    async fn test_sync_prepare_keeps_known_mismatched_subtype_as_metadata() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account.clone());

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_sync(
                vec![NewActivity {
                    id: Some("credit-staking-label".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: None,
                    activity_type: "CREDIT".to_string(),
                    subtype: Some("STAKING_REWARD".to_string()),
                    activity_date: "2024-01-15".to_string(),
                    quantity: None,
                    unit_price: None,
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    amount: Some(dec!(25)),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("credit-staking-label".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should keep mismatched subtype as inert metadata");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        assert_eq!(
            result.prepared[0].activity.subtype.as_deref(),
            Some("STAKING_REWARD")
        );
        assert_eq!(result.prepared[0].activity.needs_review, None);
        assert_eq!(result.prepared[0].activity.status, None);
    }

    #[tokio::test]
    async fn test_bulk_create_rejects_new_equity_without_requested_quote_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let request = ActivityBulkMutationRequest {
            creates: vec![NewActivity {
                id: Some("temp-1".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    symbol: Some("NVDA".to_string()),
                    exchange_mic: Some("XNAS".to_string()),
                    instrument_type: Some("EQUITY".to_string()),
                    quote_mode: Some("MARKET".to_string()),
                    ..Default::default()
                }),
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(100)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(100)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            }],
            updates: vec![],
            delete_ids: vec![],
        };

        let result = activity_service
            .bulk_mutate_activities(request)
            .await
            .unwrap();
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].action, "create");
        assert!(
            result.errors[0]
                .message
                .contains("Quote currency is required"),
            "unexpected error: {}",
            result.errors[0].message
        );
    }

    /// Test: For NEW activities, symbol takes priority over asset_id to ensure canonical ID generation
    /// This is intentional - for new activities we always want canonical IDs
    #[tokio::test]
    async fn test_resolve_asset_id_backward_compatibility() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "aapl-uuid-2",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("IGNORED".to_string()), // Should be ignored when symbol is provided
                symbol: Some("AAPL".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("aapl-uuid-2".to_string()),
            "Symbol + exchange_mic should find existing asset, ignoring provided asset_id"
        );
    }

    #[tokio::test]
    async fn test_update_stale_asset_id_with_changed_mic_rebinds_to_matching_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "CAD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "SEC:FBTC:NEOE",
            "FBTC",
            Some("NEOE"),
            Some(InstrumentType::Equity),
            "CAD",
        ));
        asset_service.add_asset(create_test_asset_with_instrument(
            "SEC:FBTC:XTSE",
            "FBTC",
            Some("XTSE"),
            Some(InstrumentType::Equity),
            "CAD",
        ));
        activity_repository.add_activity(create_stored_activity(
            "activity-fbtc",
            "acc-1",
            Some("SEC:FBTC:NEOE"),
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let update = create_test_activity_update(
            "activity-fbtc",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("SEC:FBTC:NEOE".to_string()),
                symbol: Some("FBTC".to_string()),
                exchange_mic: Some("XTSE".to_string()),
                quote_ccy: Some("CAD".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                ..Default::default()
            }),
            "CAD",
        );

        let updated = activity_service
            .update_activity(update)
            .await
            .expect("update should rebind to matching MIC asset");

        assert_eq!(updated.asset_id.as_deref(), Some("SEC:FBTC:XTSE"));
    }

    #[tokio::test]
    async fn test_update_stale_crypto_quote_ccy_rebinds_to_matching_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "CRYPTO:BTC:USD",
            "BTC",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        ));
        asset_service.add_asset(create_test_asset_with_instrument(
            "CRYPTO:BTC:EUR",
            "BTC",
            None,
            Some(InstrumentType::Crypto),
            "EUR",
        ));
        activity_repository.add_activity(create_stored_activity(
            "activity-btc",
            "acc-1",
            Some("CRYPTO:BTC:USD"),
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let update = create_test_activity_update(
            "activity-btc",
            "acc-1",
            Some(AssetResolutionInput {
                id: Some("CRYPTO:BTC:USD".to_string()),
                symbol: Some("BTC".to_string()),
                quote_ccy: Some("EUR".to_string()),
                instrument_type: Some("CRYPTO".to_string()),
                ..Default::default()
            }),
            "EUR",
        );

        let updated = activity_service
            .update_activity(update)
            .await
            .expect("update should rebind to matching crypto quote currency asset");

        assert_eq!(updated.asset_id.as_deref(), Some("CRYPTO:BTC:EUR"));
    }

    #[tokio::test]
    async fn test_create_id_only_missing_asset_errors() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-missing-asset".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("missing-asset".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let error = activity_service
            .create_activity(new_activity)
            .await
            .expect_err("id-only missing asset should fail")
            .to_string();

        assert!(
            error.contains("Asset not found"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn test_create_matching_id_and_identity_keeps_id_without_duplicate_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "SEC:AAPL:XNAS",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service.clone(),
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-aapl".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:AAPL:XNAS".to_string()),
                symbol: Some("AAPL".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                quote_ccy: Some("USD".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let created = activity_service
            .create_activity(new_activity)
            .await
            .expect("matching id + identity should create activity");

        assert_eq!(created.asset_id.as_deref(), Some("SEC:AAPL:XNAS"));
        assert_eq!(asset_service.get_assets().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_create_id_lookup_transient_error_is_not_swallowed() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.set_get_asset_by_id_error(
            "Asset not found lookup failed: database temporarily unavailable",
        );

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-transient".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:AAPL:XNAS".to_string()),
                symbol: Some("AAPL".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                quote_ccy: Some("USD".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let error = activity_service
            .create_activity(new_activity)
            .await
            .expect_err("transient get_asset_by_id error should fail")
            .to_string();

        assert!(
            error.contains("database temporarily unavailable"),
            "unexpected error: {error}"
        );
    }

    /// Test: Cash activity (DEPOSIT) generates CASH:{currency} asset ID
    #[tokio::test]
    async fn test_resolve_asset_id_cash_deposit_no_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: None,
            activity_type: "DEPOSIT".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id, None,
            "DEPOSIT should have no asset_id (cash activities have no asset in v2)"
        );
    }

    /// Test: Cash activity (WITHDRAWAL) has no asset_id
    #[tokio::test]
    async fn test_resolve_asset_id_cash_withdrawal_no_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: None,
            activity_type: "WITHDRAWAL".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id, None,
            "WITHDRAWAL should have no asset_id (cash activities have no asset in v2)"
        );
    }

    /// Test: Non-cash activity (BUY) without symbol or asset_id fails
    #[tokio::test]
    async fn test_resolve_asset_id_buy_without_symbol_fails() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: None, // No asset info
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(150)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1500)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(
            result.is_err(),
            "BUY without symbol or asset_id should fail"
        );
    }

    /// Test: Crypto symbol (BTC) without exchange infers CRYPTO kind
    #[tokio::test]
    async fn test_infer_asset_kind_common_crypto_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Add crypto asset with instrument fields
        let asset = create_test_asset_with_instrument(
            "btc-uuid",
            "BTC",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("BTC".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(50000)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(50000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("btc-uuid".to_string()),
            "BTC should match existing crypto asset"
        );
    }

    /// Test: Crypto pattern (BTC-USD) infers CRYPTO kind
    #[tokio::test]
    async fn test_infer_asset_kind_crypto_pattern() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Add crypto asset with normalized symbol (BTC-USD -> BTC)
        let asset = create_test_asset_with_instrument(
            "btc-uuid-2",
            "BTC",
            None,
            Some(InstrumentType::Crypto),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("BTC-USD".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(50000)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(50000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);

        let created = result.unwrap();
        // In v2, asset_id is a UUID. The BTC-USD symbol should be normalized to BTC
        // and matched against the existing crypto asset.
        assert!(
            created.asset_id.is_some(),
            "BTC-USD pattern should resolve to an asset"
        );
    }

    /// Test: Explicit kind input overrides inference
    #[tokio::test]
    async fn test_infer_asset_kind_explicit_input() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // BTC would normally be inferred as crypto, but we're forcing security with exchange_mic
        let asset = create_test_asset_with_instrument(
            "btc-equity-uuid",
            "BTC",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("BTC".to_string()),
                exchange_mic: Some("XNAS".to_string()),
                kind: Some("SECURITY".to_string()), // Explicit input
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(100)),
            unit_price: Some(dec!(50)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(5000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("btc-equity-uuid".to_string()),
            "Explicit SECURITY input with exchange should find existing equity asset"
        );
    }

    /// Test: Exchange MIC presence forces Security kind
    #[tokio::test]
    async fn test_infer_asset_kind_exchange_mic_forces_security() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "eth-equity-uuid",
            "ETH",
            Some("XTSE"),
            Some(InstrumentType::Equity),
            "CAD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // ETH would be inferred as crypto, but exchange_mic forces security
        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("ETH".to_string()),
                exchange_mic: Some("XTSE".to_string()), // Has exchange = security
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(100)),
            unit_price: Some(dec!(30)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(3000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("eth-equity-uuid".to_string()),
            "Exchange MIC should match existing equity asset"
        );
    }

    /// Test: All cash activity types generate CASH:{currency} asset_id
    #[tokio::test]
    async fn test_all_cash_activity_types_no_asset() {
        let cash_types = [
            "DEPOSIT",
            "WITHDRAWAL",
            "INTEREST",
            "TAX",
            "FEE",
            "TRANSFER_IN",
            "TRANSFER_OUT",
        ];

        for activity_type in cash_types {
            let account_service = Arc::new(MockAccountService::new());
            let asset_service = Arc::new(MockAssetService::new());
            let fx_service = Arc::new(MockFxService::new());
            let activity_repository = Arc::new(MockActivityRepository::new());

            let account = create_test_account("acc-1", "USD");
            account_service.add_account(account);

            let quote_service = Arc::new(MockQuoteService);
            let activity_service = ActivityService::new(
                activity_repository.clone(),
                account_service,
                asset_service,
                fx_service,
                quote_service,
            );

            let new_activity = NewActivity {
                id: Some(format!("activity-{}", activity_type)),
                account_id: "acc-1".to_string(),
                asset: None,
                activity_type: activity_type.to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: None,
                unit_price: None,
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(100)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            };

            let result = activity_service.create_activity(new_activity).await;
            assert!(
                result.is_ok(),
                "{} should succeed without asset_id",
                activity_type
            );

            let created = result.unwrap();
            assert_eq!(
                created.asset_id, None,
                "{} should have no asset_id (cash activities have no asset in v2)",
                activity_type
            );
        }
    }

    /// Test: Bulk mutation also registers FX pairs correctly
    #[tokio::test]
    async fn test_bulk_mutate_registers_fx_pair_for_asset_currency() {
        // Setup
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        // Create account with USD currency
        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Create asset with CHF currency
        let asset = create_test_asset("NESN", "CHF");
        asset_service.add_asset(asset);

        // Create the activity service
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service.clone(),
            quote_service,
        );

        // Create bulk mutation request
        let request = ActivityBulkMutationRequest {
            creates: vec![NewActivity {
                id: Some("activity-1".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("NESN".to_string()),
                    ..Default::default()
                }),
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: Some(dec!(10)),
                unit_price: Some(dec!(100)),
                currency: "USD".to_string(), // Same as account, different from asset
                fee: Some(dec!(0)),
                amount: Some(dec!(1000)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
            }],
            updates: vec![],
            delete_ids: vec![],
        };

        // Execute
        let result = activity_service.bulk_mutate_activities(request).await;

        // Assert
        assert!(result.is_ok());

        // Check that FX pair was registered for asset currency
        let registered_pairs = fx_service.get_registered_pairs();

        // Should have registered CHF/USD (from=CHF asset currency, to=USD account currency)
        // This creates FX:CHF:USD for converting CHF values to account's USD
        assert!(
            registered_pairs.contains(&("CHF".to_string(), "USD".to_string())),
            "Expected FX pair CHF/USD to be registered. Registered pairs: {:?}",
            registered_pairs
        );
    }

    #[tokio::test]
    async fn test_check_import_sets_quote_ccy_and_instrument_type_from_existing_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "azn-uuid",
            "AZN",
            Some("XLON"),
            Some(InstrumentType::Equity),
            "GBp",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AZN".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(checked.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(checked.instrument_type.as_deref(), Some("EQUITY"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBp"));
    }

    #[tokio::test]
    async fn test_check_import_keeps_same_symbol_rows_distinct_by_isin() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        asset_service.add_asset(create_test_asset_with_instrument_and_isin(
            "shop-nyse",
            "SHOP",
            Some("XNYS"),
            Some(InstrumentType::Equity),
            "USD",
            "CA82509L1076",
        ));
        asset_service.add_asset(create_test_asset_with_instrument_and_isin(
            "shop-nasdaq",
            "SHOP",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
            "CA82509L1077",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let imports = vec![
            ActivityImport {
                id: None,
                date: "2024-01-15".to_string(),
                symbol: "SHOP".to_string(),
                activity_type: "BUY".to_string(),
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(100)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(100)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: None,
                exchange_mic: None,
                quote_ccy: None,
                instrument_type: None,
                quote_mode: None,
                errors: None,
                warnings: None,
                duplicate_of_id: None,
                duplicate_of_line_number: None,
                is_draft: false,
                is_valid: true,
                line_number: Some(1),
                fx_rate: None,
                subtype: None,
                asset_id: None,
                isin: Some("ca82509l1076".to_string()),
                force_import: false,
                is_external: None,
            },
            ActivityImport {
                id: None,
                date: "2024-01-15".to_string(),
                symbol: "SHOP".to_string(),
                activity_type: "BUY".to_string(),
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(100)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(100)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: None,
                exchange_mic: None,
                quote_ccy: None,
                instrument_type: None,
                quote_mode: None,
                errors: None,
                warnings: None,
                duplicate_of_id: None,
                duplicate_of_line_number: None,
                is_draft: false,
                is_valid: true,
                line_number: Some(2),
                fx_rate: None,
                subtype: None,
                asset_id: None,
                isin: Some("CA82509L1077".to_string()),
                force_import: false,
                is_external: None,
            },
        ];

        let result = activity_service
            .check_activities_import(imports)
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].asset_id.as_deref(), Some("shop-nyse"));
        assert_eq!(result[0].exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(result[1].asset_id.as_deref(), Some("shop-nasdaq"));
        assert_eq!(result[1].exchange_mic.as_deref(), Some("XNAS"));
    }

    #[tokio::test]
    async fn test_preview_import_assets_keeps_same_symbol_candidates_distinct_by_isin() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        asset_service.add_asset(create_test_asset_with_instrument_and_isin(
            "shop-nyse",
            "SHOP",
            Some("XNYS"),
            Some(InstrumentType::Equity),
            "USD",
            "CA82509L1076",
        ));
        asset_service.add_asset(create_test_asset_with_instrument_and_isin(
            "shop-nasdaq",
            "SHOP",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
            "CA82509L1077",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let preview = activity_service
            .preview_import_assets(vec![
                ImportAssetCandidate {
                    key: "shop-1".to_string(),
                    account_id: "acc-1".to_string(),
                    symbol: "SHOP".to_string(),
                    currency: Some("USD".to_string()),
                    instrument_type: None,
                    quote_ccy: None,
                    quote_mode: None,
                    exchange_mic: None,
                    isin: Some("ca82509l1076".to_string()),
                },
                ImportAssetCandidate {
                    key: "shop-2".to_string(),
                    account_id: "acc-1".to_string(),
                    symbol: "SHOP".to_string(),
                    currency: Some("USD".to_string()),
                    instrument_type: None,
                    quote_ccy: None,
                    quote_mode: None,
                    exchange_mic: None,
                    isin: Some("CA82509L1077".to_string()),
                },
            ])
            .await
            .expect("preview should succeed");

        assert_eq!(preview.len(), 2);
        assert_eq!(preview[0].status, ImportAssetPreviewStatus::ExistingAsset);
        assert_eq!(preview[0].asset_id.as_deref(), Some("shop-nyse"));
        assert_eq!(preview[1].status, ImportAssetPreviewStatus::ExistingAsset);
        assert_eq!(preview[1].asset_id.as_deref(), Some("shop-nasdaq"));
    }

    #[tokio::test]
    async fn test_check_import_uses_mic_currency_as_quote_ccy_fallback() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AZN".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(checked.instrument_type.as_deref(), Some("EQUITY"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBp"));
        assert!(
            checked
                .warnings
                .as_ref()
                .and_then(|w| w.get("_quote_ccy_fallback"))
                .is_some(),
            "Expected MIC fallback warning when quote_ccy is inferred from exchange"
        );
    }

    #[tokio::test]
    async fn test_check_import_preserves_explicit_requested_quote_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AZN".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(checked.instrument_type.as_deref(), Some("EQUITY"));
        assert_eq!(checked.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBP"));
    }

    #[tokio::test]
    async fn test_check_import_unknown_suffix_resolves_mic_and_prefers_provider_quote_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // ".XC" suffix resolves to Cboe UK MIC and provider quote currency.
        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRPL.XC".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(checked.exchange_mic.as_deref(), Some("CXE"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBP"));
        assert!(
            checked
                .warnings
                .as_ref()
                .and_then(|w| w.get("_quote_ccy_fallback"))
                .is_none(),
            "Provider quote currency should win over MIC fallback for VWRPL.XC"
        );
    }

    #[tokio::test]
    async fn test_check_import_allows_manual_quote_mode_without_mic() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "CUSTOM".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Custom Security".to_string()),
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            quote_mode: Some("MANUAL".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert!(checked.is_valid);
        assert!(checked.errors.is_none());
        assert_eq!(checked.exchange_mic, None);
        assert_eq!(checked.quote_mode.as_deref(), Some("MANUAL"));
    }

    #[tokio::test]
    async fn test_check_import_uses_existing_manual_asset_quote_mode() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Create an existing manual asset with EQUITY type
        let mut manual_asset = create_test_asset_with_instrument(
            "asset-custom",
            "CUSTOM",
            None,
            Some(InstrumentType::Equity),
            "USD",
        );
        manual_asset.quote_mode = QuoteMode::Manual;
        manual_asset.name = Some("Custom Security".to_string());
        manual_asset.instrument_key = Some("EQUITY:CUSTOM".to_string());
        asset_service.add_asset(manual_asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // Import activity for earlier created manual asset without `quote_mode` set
        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "CUSTOM".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            quote_mode: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];

        assert!(checked.is_valid);
        assert!(checked.errors.is_none() || checked.errors.as_ref().unwrap().is_empty());

        assert_eq!(checked.quote_mode.as_deref(), Some("MANUAL"));
        assert_eq!(checked.symbol_name.as_deref(), Some("Custom Security"));
        assert_eq!(checked.symbol, "CUSTOM");
        assert_eq!(checked.exchange_mic, None);
    }

    #[tokio::test]
    async fn test_check_import_crypto_input_clears_mic_and_uses_pair_quote_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "BTC-USD".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(65000)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(65000)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XTSE".to_string()),
            quote_ccy: None,
            instrument_type: Some("CRYPTO".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(checked.symbol, "BTC");
        assert_eq!(checked.instrument_type.as_deref(), Some("CRYPTO"));
        assert_eq!(checked.exchange_mic, None);
        assert_eq!(checked.quote_ccy.as_deref(), Some("USD"));
    }

    #[tokio::test]
    async fn test_import_rejects_unresolved_symbol_required_rows_without_rechecking() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let unresolved = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRPL.XC".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![unresolved])
            .await
            .expect("import should complete with validation feedback");

        assert!(!result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.skipped, 1);
        assert_eq!(result.activities.len(), 1);
        assert!(!result.activities[0].is_valid);
        let errors = result.activities[0]
            .errors
            .as_ref()
            .expect("expected import errors");
        assert!(errors.contains_key("quoteCcy"));
        assert!(errors.contains_key("instrumentType"));
        assert!(!errors.contains_key("exchangeMic"));
    }

    #[tokio::test]
    async fn test_import_rejects_drip_without_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let drip = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: String::new(),
            activity_type: "DIVIDEND".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("DRIP".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![drip])
            .await
            .expect("import should complete with validation feedback");

        assert!(!result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.skipped, 1);
        let errors = result.activities[0]
            .errors
            .as_ref()
            .expect("expected import errors");
        assert!(errors.contains_key("symbol"));
    }

    #[tokio::test]
    async fn test_import_rejects_dividend_in_kind_without_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let dividend_in_kind = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: String::new(),
            activity_type: "DIVIDEND".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("DIVIDEND_IN_KIND".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![dividend_in_kind])
            .await
            .expect("import should complete with validation feedback");

        assert!(!result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.skipped, 1);
        let errors = result.activities[0]
            .errors
            .as_ref()
            .expect("expected import errors");
        assert!(errors.contains_key("symbol"));
    }

    #[tokio::test]
    async fn test_import_rejects_staking_reward_without_resolution_metadata() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let staking_reward = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "ETH".to_string(),
            activity_type: "INTEREST".to_string(),
            quantity: Some(dec!(0.25)),
            unit_price: Some(dec!(4000)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(1000)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Ethereum".to_string()),
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("STAKING_REWARD".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![staking_reward])
            .await
            .expect("import should complete with validation feedback");

        assert!(!result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.skipped, 1);
        let errors = result.activities[0]
            .errors
            .as_ref()
            .expect("expected import errors");
        assert!(errors.contains_key("quoteCcy"));
        assert!(errors.contains_key("instrumentType"));
    }

    #[tokio::test]
    async fn test_import_keeps_mismatched_known_subtype_as_metadata() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let mismatched_subtype = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AAPL".to_string(),
            activity_type: "DIVIDEND".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Apple".to_string()),
            exchange_mic: Some("XNAS".to_string()),
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("STAKING_REWARD".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![mismatched_subtype])
            .await
            .expect("import should keep subtype labels as metadata");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(
            result.activities[0].subtype.as_deref(),
            Some("STAKING_REWARD")
        );
    }

    #[tokio::test]
    async fn test_import_allows_unknown_provider_subtype_label() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let option_buy = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "AAPL251219C00200000".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(5)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("AAPL Dec 2025 200 Call".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("BUY_TO_OPEN".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![option_buy])
            .await
            .expect("import should accept provider subtype labels");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.activities[0].subtype.as_deref(), Some("BUY_TO_OPEN"));
    }

    #[tokio::test]
    async fn test_check_import_accepts_cash_dividend_without_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let cash_dividend = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: String::new(),
            activity_type: "DIVIDEND".to_string(),
            quantity: None,
            unit_price: None,
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(42)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![cash_dividend])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        assert!(result[0].is_valid);
        assert!(result[0]
            .errors
            .as_ref()
            .is_none_or(|errors| errors.is_empty()));
        assert_eq!(result[0].symbol, "");
        assert_eq!(result[0].asset_id, None);
    }

    #[tokio::test]
    async fn test_import_accepts_cash_dividend_without_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let cash_dividend = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: String::new(),
            activity_type: "DIVIDEND".to_string(),
            quantity: None,
            unit_price: None,
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(42)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![cash_dividend])
            .await
            .expect("cash dividend import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.skipped, 0);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].activity_type, "DIVIDEND");
        assert_eq!(stored[0].asset_id, None);
    }

    #[tokio::test]
    async fn test_import_accepts_resolved_symbol_rows_without_rechecking() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);
        asset_service.add_asset(create_test_asset_with_instrument(
            "vwrpl-uuid",
            "VWRPL",
            Some("XLON"),
            Some(InstrumentType::Equity),
            "GBP",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let resolved = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRPL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![resolved])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.skipped, 0);
        assert_eq!(result.activities.len(), 1);
        assert!(result.activities[0].is_valid);
    }

    #[tokio::test]
    async fn test_import_accepts_manual_equity_without_exchange_mic() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);
        asset_service.add_asset(create_test_asset_with_instrument(
            "vwrpl-uuid",
            "VWRPL",
            Some("XLON"),
            Some(InstrumentType::Equity),
            "GBP",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let manual_row = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRPL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MANUAL".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![manual_row])
            .await
            .expect("manual quote import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.skipped, 0);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1);
        assert!(
            stored[0].asset_id.is_none(),
            "import apply should not live-resolve missing MIC during persistence"
        );
    }

    #[tokio::test]
    async fn test_import_prepare_errors_are_keyed_under_symbol_field() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let invalid_date_row = ActivityImport {
            id: None,
            date: "invalid-date".to_string(),
            symbol: "VWRPL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(132)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![invalid_date_row])
            .await
            .expect("import should return validation feedback");

        assert!(!result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.skipped, 1);

        let errors = result.activities[0]
            .errors
            .as_ref()
            .expect("expected prepare errors");
        assert!(errors.contains_key("symbol"));
        assert!(!errors.contains_key("VWRPL"));
    }

    #[tokio::test]
    async fn test_import_keeps_cash_rows_without_symbol_resolution() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let cash_row = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: String::new(),
            activity_type: "DEPOSIT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: Some("Cash top up".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![cash_row])
            .await
            .expect("cash import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.skipped, 0);
        assert_eq!(result.activities[0].symbol, "");
        assert!(result.activities[0].exchange_mic.is_none());
        assert!(result.activities[0].quote_ccy.is_none());
        assert!(result.activities[0].instrument_type.is_none());
    }

    #[tokio::test]
    async fn test_import_links_transfer_pairs_using_offset_local_date_and_clears_external_metadata()
    {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);
        let destination_account = create_test_account("acc-2", "USD");
        account_service.add_account(destination_account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let transfer_out = ActivityImport {
            id: None,
            date: "2025-12-31".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_OUT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: Some("Internal transfer out".to_string()),
            account_id: Some("acc-2".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let transfer_in = ActivityImport {
            id: None,
            date: "2025-12-31T23:30:00-05:00".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: Some("Internal transfer in".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(2),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let result = activity_service
            .import_activities(vec![transfer_out, transfer_in])
            .await
            .expect("transfer import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 2);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 2);

        let transfer_out_stored = stored
            .iter()
            .find(|activity| activity.activity_type == "TRANSFER_OUT")
            .expect("TRANSFER_OUT should exist");
        let transfer_in_stored = stored
            .iter()
            .find(|activity| activity.activity_type == "TRANSFER_IN")
            .expect("TRANSFER_IN should exist");

        assert!(
            transfer_out_stored.source_group_id.is_some(),
            "transfer out should be linked"
        );
        assert_eq!(
            transfer_out_stored.source_group_id, transfer_in_stored.source_group_id,
            "paired transfers should share the same source_group_id"
        );
        assert_eq!(
            transfer_out_stored
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("flow"))
                .and_then(|flow| flow.get("is_external"))
                .and_then(|value| value.as_bool()),
            Some(false),
            "auto-linked transfer out should be marked internal"
        );
        assert_eq!(
            transfer_in_stored
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("flow"))
                .and_then(|flow| flow.get("is_external"))
                .and_then(|value| value.as_bool()),
            Some(false),
            "auto-linked transfer in should be marked internal"
        );
    }

    #[tokio::test]
    async fn test_import_does_not_auto_link_transfer_pairs_with_same_account() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let transfer_out = ActivityImport {
            id: None,
            date: "2025-12-31".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_OUT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let transfer_in = ActivityImport {
            id: None,
            date: "2025-12-31".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(2),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let result = activity_service
            .import_activities(vec![transfer_out, transfer_in])
            .await
            .expect("transfer import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 2);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 2);

        for activity in stored {
            assert!(
                activity.source_group_id.is_none(),
                "same-account transfer leg should not be auto-linked"
            );
            assert_eq!(
                activity
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get("flow"))
                    .and_then(|flow| flow.get("is_external"))
                    .and_then(|value| value.as_bool()),
                Some(true),
                "unlinked same-account leg should keep its external flag"
            );
        }
    }

    #[tokio::test]
    async fn test_import_does_not_auto_link_transfer_when_matching_leg_is_duplicate() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let date = DateTime::parse_from_rfc3339("2025-12-31T00:00:00Z")
            .expect("valid date")
            .with_timezone(&Utc);
        let existing_transfer_in_key = crate::activities::compute_idempotency_key(
            "acc-1",
            "TRANSFER_IN",
            &date,
            None,
            None,
            None,
            Some(dec!(500)),
            "USD",
            None,
            None,
        );
        activity_repository
            .activities
            .lock()
            .unwrap()
            .push(Activity {
                id: "existing-transfer-in".to_string(),
                account_id: "acc-1".to_string(),
                asset_id: None,
                activity_type: "TRANSFER_IN".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(500)),
                fee: Some(dec!(0)),
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: Some(json!({ "flow": { "is_external": true } })),
                source_system: Some("CSV".to_string()),
                source_record_id: None,
                source_group_id: None,
                idempotency_key: Some(existing_transfer_in_key),
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            });

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let transfer_out = ActivityImport {
            id: None,
            date: "2025-12-31".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_OUT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let transfer_in_duplicate = ActivityImport {
            id: None,
            date: "2025-12-31".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(2),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(true),
        };

        let result = activity_service
            .import_activities(vec![transfer_out, transfer_in_duplicate])
            .await
            .expect("transfer import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.duplicates, 1);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        let imported_transfer_out = stored
            .iter()
            .find(|activity| activity.activity_type == "TRANSFER_OUT")
            .expect("TRANSFER_OUT should be inserted");

        assert!(
            imported_transfer_out.source_group_id.is_none(),
            "single inserted leg should not get an orphan source_group_id"
        );
        assert_eq!(
            imported_transfer_out
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("flow"))
                .and_then(|flow| flow.get("is_external"))
                .and_then(|value| value.as_bool()),
            Some(true),
            "unpaired inserted leg should keep its external flag"
        );
    }

    #[tokio::test]
    async fn unlink_transfer_activities_emits_activities_changed_event() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());
        let event_sink = Arc::new(MockDomainEventSink::new());
        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        )
        .with_event_sink(event_sink.clone());

        let earlier = DateTime::parse_from_rfc3339("2024-01-15T00:00:00Z")
            .expect("valid date")
            .with_timezone(&Utc);
        let later = DateTime::parse_from_rfc3339("2024-01-16T00:00:00Z")
            .expect("valid date")
            .with_timezone(&Utc);
        activity_repository.activities.lock().unwrap().extend([
            Activity {
                id: "transfer-in".to_string(),
                account_id: "acc-in".to_string(),
                asset_id: Some("asset-in".to_string()),
                activity_type: "TRANSFER_IN".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: later,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                currency: "CAD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: Some(json!({ "flow": { "is_external": false } })),
                source_system: Some("MANUAL".to_string()),
                source_record_id: None,
                source_group_id: Some("transfer-group".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: earlier,
                updated_at: earlier,
            },
            Activity {
                id: "transfer-out".to_string(),
                account_id: "acc-out".to_string(),
                asset_id: Some("asset-out".to_string()),
                activity_type: "TRANSFER_OUT".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: earlier,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: Some(json!({ "flow": { "is_external": false } })),
                source_system: Some("MANUAL".to_string()),
                source_record_id: None,
                source_group_id: Some("transfer-group".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: earlier,
                updated_at: earlier,
            },
        ]);

        activity_service
            .unlink_transfer_activities("transfer-in".to_string(), "transfer-out".to_string())
            .await
            .expect("unlink should succeed");

        let stored = activity_repository
            .get_activities()
            .expect("stored activities");
        assert!(stored
            .iter()
            .all(|activity| activity.source_group_id.is_none()));
        assert!(stored.iter().all(|activity| {
            activity
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("flow"))
                .and_then(|flow| flow.get("is_external"))
                .and_then(|value| value.as_bool())
                == Some(true)
        }));

        let events = event_sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            DomainEvent::ActivitiesChanged {
                account_ids,
                asset_ids,
                currencies,
                earliest_activity_at_utc,
            } => {
                let mut account_ids = account_ids.clone();
                account_ids.sort();
                assert_eq!(account_ids, vec!["acc-in", "acc-out"]);

                let mut asset_ids = asset_ids.clone();
                asset_ids.sort();
                assert_eq!(asset_ids, vec!["asset-in", "asset-out"]);

                let mut currencies = currencies.clone();
                currencies.sort();
                assert_eq!(currencies, vec!["CAD", "USD"]);
                assert_eq!(*earliest_activity_at_utc, Some(earlier));
            }
            event => panic!("expected ActivitiesChanged event, got {event:?}"),
        }
    }

    #[tokio::test]
    async fn test_import_skips_existing_hard_duplicates_before_insert() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let date = DateTime::parse_from_rfc3339("2024-01-15T00:00:00Z")
            .expect("valid date")
            .with_timezone(&Utc);
        let existing_key = crate::activities::compute_idempotency_key(
            "acc-1",
            "BUY",
            &date,
            Some("VWRL@XLON"),
            Some(dec!(1)),
            Some(dec!(100)),
            Some(dec!(100)),
            "GBP",
            None,
            None,
        );
        activity_repository
            .activities
            .lock()
            .unwrap()
            .push(Activity {
                id: "existing-dup".to_string(),
                account_id: "acc-1".to_string(),
                asset_id: None,
                activity_type: "BUY".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date,
                settlement_date: None,
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(100)),
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                currency: "GBP".to_string(),
                fx_rate: None,
                notes: None,
                metadata: None,
                source_system: Some("CSV".to_string()),
                source_record_id: None,
                source_group_id: None,
                idempotency_key: Some(existing_key),
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            });

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let duplicate = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![duplicate])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 0);
        assert_eq!(result.summary.duplicates, 1);
        assert_eq!(result.summary.skipped, 1);
        assert_eq!(
            result.activities[0].duplicate_of_id.as_deref(),
            Some("existing-dup")
        );

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1, "duplicate row should not be inserted");
    }

    #[tokio::test]
    async fn test_import_skips_within_batch_duplicates_before_insert() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![
                import.clone(),
                ActivityImport {
                    line_number: Some(2),
                    ..import
                },
            ])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.duplicates, 1);
        assert_eq!(result.summary.skipped, 1);
        assert_eq!(result.activities[1].duplicate_of_line_number, Some(1));

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(
            stored.len(),
            1,
            "within-batch duplicate should not be inserted"
        );
    }

    // ==========================================================================
    // force_import Tests
    // ==========================================================================

    /// Test: force_import=true bypasses DB duplicate detection and inserts the row.
    /// The idempotency key is nulled out so the DB unique constraint is not violated.
    #[tokio::test]
    async fn test_import_force_import_bypasses_existing_duplicate() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let date = DateTime::parse_from_rfc3339("2024-01-15T00:00:00Z")
            .expect("valid date")
            .with_timezone(&Utc);
        let existing_key = crate::activities::compute_idempotency_key(
            "acc-1",
            "BUY",
            &date,
            Some("VWRL@XLON"),
            Some(dec!(1)),
            Some(dec!(100)),
            Some(dec!(100)),
            "GBP",
            None,
            None,
        );
        activity_repository
            .activities
            .lock()
            .unwrap()
            .push(Activity {
                id: "existing-dup".to_string(),
                account_id: "acc-1".to_string(),
                asset_id: None,
                activity_type: "BUY".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date,
                settlement_date: None,
                quantity: Some(dec!(1)),
                unit_price: Some(dec!(100)),
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                currency: "GBP".to_string(),
                fx_rate: None,
                notes: None,
                metadata: None,
                source_system: Some("CSV".to_string()),
                source_record_id: None,
                source_group_id: None,
                idempotency_key: Some(existing_key),
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            });

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let forced = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: true,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![forced])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(
            result.summary.imported, 1,
            "force_import row should be inserted"
        );
        assert_eq!(
            result.summary.duplicates, 0,
            "force_import row should not count as duplicate"
        );

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(
            stored.len(),
            2,
            "both existing and force-imported rows should exist"
        );

        // The force-imported row should have a NULL idempotency key
        let new_row = stored
            .iter()
            .find(|a| a.id != "existing-dup")
            .expect("new row");
        assert!(
            new_row.idempotency_key.is_none(),
            "force-imported row should have NULL idempotency key"
        );
    }

    /// Test: force_import=true bypasses within-batch duplicate detection.
    /// Both identical rows are inserted, each with a NULL idempotency key.
    #[tokio::test]
    async fn test_import_force_import_bypasses_within_batch_duplicate() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let base = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        // First row: normal import. Second row: identical but force_import=true.
        let result = activity_service
            .import_activities(vec![
                base.clone(),
                ActivityImport {
                    line_number: Some(2),
                    force_import: true,
                    is_external: None,
                    ..base
                },
            ])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 2, "both rows should be inserted");
        assert_eq!(
            result.summary.duplicates, 0,
            "force_import row should not count as duplicate"
        );

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 2, "both rows should exist in the store");

        // The force-imported row should have NULL key, the first row should have a key
        let keys: Vec<Option<&str>> = stored
            .iter()
            .map(|a| a.idempotency_key.as_deref())
            .collect();
        assert!(
            keys.iter().any(|k| k.is_some()),
            "first row should have an idempotency key"
        );
        assert!(
            keys.iter().any(|k| k.is_none()),
            "force-imported row should have NULL idempotency key"
        );
    }

    /// Test: force_import=true on a non-duplicate row is a no-op — the idempotency
    /// key is preserved so future imports can still deduplicate against it.
    #[tokio::test]
    async fn test_import_force_import_noop_on_non_duplicate() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VWRL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: true, // flag set but no duplicate exists
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![import])
            .await
            .expect("import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(result.summary.duplicates, 0);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1);
        assert!(
            stored[0].idempotency_key.is_some(),
            "non-duplicate row should keep its idempotency key even with force_import=true"
        );
    }

    // ==========================================================================
    // Currency Normalization Tests (GBp -> GBP, etc.)
    // ==========================================================================

    /// Test: Activity with GBp currency is normalized to GBP with amount conversion
    /// When user explicitly selects GBp (pence), the backend should:
    /// 1. Convert currency GBp -> GBP
    /// 2. Multiply unit_price by 0.01 (14082 pence -> 140.82 GBP)
    /// 3. Multiply amount by 0.01
    /// 4. Multiply fee by 0.01
    #[tokio::test]
    async fn test_gbp_pence_normalization_on_create() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        // Create GBP account
        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        // LSE stock with GBp currency
        let asset = create_test_asset("SEC:AZN:XLON", "GBp");
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // User submits activity in GBp (pence) - 14082 pence per share
        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:AZN:XLON".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(14082)), // 14082 pence
            currency: "GBp".to_string(),   // Pence currency
            fee: Some(dec!(999)),          // 999 pence fee
            amount: Some(dec!(140820)),    // 140820 pence total
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok(), "Activity creation should succeed");

        let created = result.unwrap();

        // Currency should be normalized to GBP
        assert_eq!(
            created.currency, "GBP",
            "Currency should be normalized from GBp to GBP"
        );

        // Unit price should be converted: 14082 pence * 0.01 = 140.82 GBP
        assert_eq!(
            created.unit_price,
            Some(dec!(140.82)),
            "Unit price should be converted from pence to pounds"
        );

        // Fee should be converted: 999 pence * 0.01 = 9.99 GBP
        assert_eq!(
            created.fee,
            Some(dec!(9.99)),
            "Fee should be converted from pence to pounds"
        );

        // Amount should be converted: 140820 pence * 0.01 = 1408.20 GBP
        assert_eq!(
            created.amount,
            Some(dec!(1408.20)),
            "Amount should be converted from pence to pounds"
        );

        // Quantity should NOT be converted (shares, not currency)
        assert_eq!(
            created.quantity,
            Some(dec!(10)),
            "Quantity should remain unchanged"
        );
    }

    /// Test: Activity with GBX currency (alternative pence code) is also normalized
    #[tokio::test]
    async fn test_gbx_normalization_on_create() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let asset = create_test_asset("SEC:VOD:XLON", "GBX");
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:VOD:XLON".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(100)),
            unit_price: Some(dec!(7500)), // 7500 pence
            currency: "GBX".to_string(),  // Alternative pence code
            fee: Some(dec!(0)),
            amount: Some(dec!(750000)), // 750000 pence
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(created.currency, "GBP", "GBX should normalize to GBP");
        assert_eq!(created.unit_price, Some(dec!(75)), "7500 pence = 75 pounds");
        assert_eq!(
            created.amount,
            Some(dec!(7500)),
            "750000 pence = 7500 pounds"
        );
    }

    /// Test: Activity with ZAc (South African cents) is normalized to ZAR
    #[tokio::test]
    async fn test_zac_normalization_on_create() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "ZAR");
        account_service.add_account(account);

        let asset = create_test_asset("SEC:NPN:XJSE", "ZAc");
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:NPN:XJSE".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(50)),
            unit_price: Some(dec!(200000)), // 200000 cents = 2000 ZAR
            currency: "ZAc".to_string(),
            fee: Some(dec!(1000)), // 1000 cents = 10 ZAR
            amount: Some(dec!(10000000)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(created.currency, "ZAR", "ZAc should normalize to ZAR");
        assert_eq!(
            created.unit_price,
            Some(dec!(2000)),
            "200000 cents = 2000 ZAR"
        );
        assert_eq!(created.fee, Some(dec!(10)), "1000 cents = 10 ZAR");
    }

    /// Test: Activity with regular GBP currency is NOT modified
    #[tokio::test]
    async fn test_regular_gbp_not_modified() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account);

        let asset = create_test_asset("SEC:LLOY:XLON", "GBP");
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                id: Some("SEC:LLOY:XLON".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1000)),
            unit_price: Some(dec!(0.45)), // Already in GBP
            currency: "GBP".to_string(),  // Major currency
            fee: Some(dec!(5)),
            amount: Some(dec!(450)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok());

        let created = result.unwrap();
        assert_eq!(created.currency, "GBP", "GBP should remain GBP");
        assert_eq!(
            created.unit_price,
            Some(dec!(0.45)),
            "Unit price should not change for GBP"
        );
        assert_eq!(
            created.amount,
            Some(dec!(450)),
            "Amount should not change for GBP"
        );
        assert_eq!(created.fee, Some(dec!(5)), "Fee should not change for GBP");
    }

    // --- Bond instrument type tests ---

    #[tokio::test]
    async fn test_check_import_recognizes_bond_instrument_type() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-06-01".to_string(),
            symbol: "US912828ZT58".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(99.5)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(995)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("BOND".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(
            checked.instrument_type.as_deref(),
            Some("BOND"),
            "BOND instrument type should be preserved through check"
        );
    }

    #[tokio::test]
    async fn test_import_apply_accepts_bond_instrument_type() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let resolved = ActivityImport {
            id: None,
            date: "2024-06-01".to_string(),
            symbol: "US912828ZT58".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(99.5)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(995)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("US Treasury Note 2.5% 2025".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("BOND".to_string()),
            quote_mode: Some("MANUAL".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![resolved])
            .await
            .expect("import should succeed for bond");

        assert!(
            result.summary.success,
            "bond import should succeed, got errors: {:?}",
            result.activities.first().and_then(|a| a.errors.as_ref())
        );
        assert_eq!(result.summary.imported, 1);
    }

    #[tokio::test]
    async fn test_import_apply_recognizes_bond_aliases() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        for alias in &["FIXEDINCOME", "FIXED_INCOME", "DEBT"] {
            let resolved = ActivityImport {
                id: None,
                date: "2024-06-01".to_string(),
                symbol: "US912828ZT58".to_string(),
                activity_type: "BUY".to_string(),
                quantity: Some(dec!(10)),
                unit_price: Some(dec!(99.5)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                amount: Some(dec!(995)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: Some("US Treasury Note".to_string()),
                exchange_mic: None,
                quote_ccy: Some("USD".to_string()),
                instrument_type: Some(alias.to_string()),
                quote_mode: Some("MANUAL".to_string()),
                errors: None,
                warnings: None,
                duplicate_of_id: None,
                duplicate_of_line_number: None,
                is_draft: false,
                is_valid: true,
                line_number: Some(1),
                fx_rate: None,
                subtype: None,
                asset_id: None,
                isin: None,
                force_import: false,
                is_external: None,
            };

            let result = activity_service
                .import_activities(vec![resolved])
                .await
                .unwrap_or_else(|_| panic!("import should succeed for alias '{}'", alias));

            assert!(
                result.summary.success,
                "bond alias '{}' should be accepted, got errors: {:?}",
                alias,
                result.activities.first().and_then(|a| a.errors.as_ref())
            );
        }
    }

    #[tokio::test]
    async fn test_check_import_bond_with_existing_asset_enriches_name_and_ccy() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Existing bond asset in the system
        let mut bond_asset = create_test_asset_with_instrument(
            "bond-uuid",
            "US912828ZT58",
            None,
            Some(InstrumentType::Bond),
            "USD",
        );
        bond_asset.name = Some("US Treasury Note 2.5% 2025".to_string());
        asset_service.add_asset(bond_asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // Import with explicit BOND instrument_type; name/ccy should be enriched from asset
        let import = ActivityImport {
            id: None,
            date: "2024-06-01".to_string(),
            symbol: "US912828ZT58".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(5)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: Some("BOND".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(
            checked.instrument_type.as_deref(),
            Some("BOND"),
            "BOND instrument type should be preserved"
        );
        assert_eq!(
            checked.symbol_name.as_deref(),
            Some("US Treasury Note 2.5% 2025"),
            "symbol_name should be enriched from existing bond asset"
        );
        assert_eq!(
            checked.quote_ccy.as_deref(),
            Some("USD"),
            "quote_ccy should be enriched from existing bond asset"
        );
    }

    // --- Option instrument type tests ---

    #[tokio::test]
    async fn test_check_import_recognizes_option_instrument_type() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // AAPL Sep 18, 2026 $200 Call (OCC format)
        let import = ActivityImport {
            id: None,
            date: "2026-03-01".to_string(),
            symbol: "AAPL260918C00200000".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(5.50)),
            currency: "USD".to_string(),
            fee: Some(dec!(0.65)),
            amount: Some(dec!(550)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(
            checked.instrument_type.as_deref(),
            Some("OPTION"),
            "OPTION instrument type should be preserved through check"
        );
    }

    #[tokio::test]
    async fn test_import_apply_accepts_option_instrument_type() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // SPY June 19, 2026 $580 Put (OCC format)
        let resolved = ActivityImport {
            id: None,
            date: "2026-03-01".to_string(),
            symbol: "SPY260619P00580000".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(2)),
            unit_price: Some(dec!(8.35)),
            currency: "USD".to_string(),
            fee: Some(dec!(1.30)),
            amount: Some(dec!(1670)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("SPY Jun 19 2026 580 Put".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: Some("MARKET".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .import_activities(vec![resolved])
            .await
            .expect("import should succeed for option");

        assert!(
            result.summary.success,
            "option import should succeed, got errors: {:?}",
            result.activities.first().and_then(|a| a.errors.as_ref())
        );
        assert_eq!(result.summary.imported, 1);
    }

    #[tokio::test]
    async fn test_check_import_existing_option_asset_enriches_name() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Existing option asset
        let mut option_asset = create_test_asset_with_instrument(
            "opt-uuid",
            "AAPL260918C00200000",
            None,
            Some(InstrumentType::Option),
            "USD",
        );
        option_asset.name = Some("AAPL Sep 18 2026 200 Call".to_string());
        asset_service.add_asset(option_asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2026-04-01".to_string(),
            symbol: "AAPL260918C00200000".to_string(),
            activity_type: "SELL".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(8.00)),
            currency: "USD".to_string(),
            fee: Some(dec!(0.65)),
            amount: Some(dec!(800)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: Some("OPTION".to_string()),
            quote_mode: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: None,
        };

        let result = activity_service
            .check_activities_import(vec![import])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 1);
        let checked = &result[0];
        assert_eq!(
            checked.instrument_type.as_deref(),
            Some("OPTION"),
            "OPTION instrument type should be preserved"
        );
        assert_eq!(
            checked.symbol_name.as_deref(),
            Some("AAPL Sep 18 2026 200 Call"),
            "symbol_name should be enriched from existing option asset"
        );
    }

    /// Test: OCC symbol pattern (e.g. AAPL240119C00150000) infers OPTION kind
    /// and matches against an existing option asset.
    #[tokio::test]
    async fn test_infer_asset_kind_occ_symbol() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        // Add an option asset matching the OCC symbol
        let asset = create_test_asset_with_instrument(
            "aapl-opt-uuid",
            "AAPL240119C00150000",
            None,
            Some(InstrumentType::Option),
            "USD",
        );
        asset_service.add_asset(asset);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        // OCC symbol with no explicit kind input — should be inferred as OPTION
        let new_activity = NewActivity {
            id: Some("activity-occ-1".to_string()),
            account_id: "acc-1".to_string(),
            asset: Some(AssetResolutionInput {
                symbol: Some("AAPL240119C00150000".to_string()),
                ..Default::default()
            }),
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(2)),
            unit_price: Some(dec!(5)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            amount: Some(dec!(10)),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
        };

        let result = activity_service.create_activity(new_activity).await;
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);

        let created = result.unwrap();
        assert_eq!(
            created.asset_id,
            Some("aapl-opt-uuid".to_string()),
            "OCC symbol should match existing option asset"
        );
    }
}
