//! Unit tests for net worth service.

use super::*;
use crate::accounts::{account_types, Account, AccountRepositoryTrait, AccountUpdate, NewAccount};
use crate::assets::{
    Asset, AssetKind, AssetRepositoryTrait, NewAsset, ProviderProfile, QuoteMode,
    UpdateAssetProfile,
};
use crate::errors::Result;
use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
use crate::portfolio::snapshot::{
    AccountStateSnapshot, Position, SnapshotRepositoryTrait, SnapshotSource,
};
use crate::portfolio::valuation::{
    DailyAccountValuation, NegativeBalanceInfo, ValuationRepositoryTrait,
};
use crate::quotes::{
    LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote, QuoteImport, QuoteServiceTrait,
    QuoteSyncState, SymbolSearchResult, SymbolSyncPlan, SyncResult,
};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};

// ============================================================================
// Mock Implementations
// ============================================================================

struct MockAccountRepository {
    accounts: Vec<Account>,
}

impl MockAccountRepository {
    fn new(accounts: Vec<Account>) -> Self {
        Self { accounts }
    }
}

#[async_trait]
impl AccountRepositoryTrait for MockAccountRepository {
    async fn create(&self, _new_account: NewAccount) -> Result<Account> {
        unimplemented!()
    }

    async fn update(&self, _account_update: AccountUpdate) -> Result<Account> {
        unimplemented!()
    }

    async fn delete(&self, _account_id: &str) -> Result<usize> {
        unimplemented!()
    }

    fn get_by_id(&self, account_id: &str) -> Result<Account> {
        self.accounts
            .iter()
            .find(|a| a.id == account_id)
            .cloned()
            .ok_or_else(|| {
                crate::errors::Error::Repository(format!("Account {} not found", account_id))
            })
    }

    fn list(
        &self,
        is_active_filter: Option<bool>,
        is_archived_filter: Option<bool>,
        _account_ids: Option<&[String]>,
    ) -> Result<Vec<Account>> {
        let accounts: Vec<Account> = self
            .accounts
            .iter()
            .filter(|a| is_active_filter.is_none_or(|active| a.is_active == active))
            .filter(|a| is_archived_filter.is_none_or(|archived| a.is_archived == archived))
            .cloned()
            .collect();
        Ok(accounts)
    }
}

struct MockAssetRepository {
    assets: Vec<Asset>,
}

impl MockAssetRepository {
    fn new(assets: Vec<Asset>) -> Self {
        Self { assets }
    }
}

#[async_trait]
impl AssetRepositoryTrait for MockAssetRepository {
    async fn create(&self, _new_asset: NewAsset) -> Result<Asset> {
        unimplemented!()
    }

    async fn create_batch(&self, _new_assets: Vec<NewAsset>) -> Result<Vec<Asset>> {
        unimplemented!()
    }

    async fn update_profile(&self, _asset_id: &str, _payload: UpdateAssetProfile) -> Result<Asset> {
        unimplemented!()
    }

    async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
        unimplemented!()
    }

    fn find_by_instrument_key(&self, _instrument_key: &str) -> Result<Option<Asset>> {
        Ok(None)
    }

    fn get_by_id(&self, asset_id: &str) -> Result<Asset> {
        self.assets
            .iter()
            .find(|a| a.id == asset_id)
            .cloned()
            .ok_or_else(|| {
                crate::errors::Error::Repository(format!("Asset {} not found", asset_id))
            })
    }

    fn list(&self) -> Result<Vec<Asset>> {
        Ok(self.assets.clone())
    }

    fn list_by_asset_ids(&self, asset_ids: &[String]) -> Result<Vec<Asset>> {
        Ok(self
            .assets
            .iter()
            .filter(|a| asset_ids.contains(&a.id))
            .cloned()
            .collect())
    }

    async fn delete(&self, _asset_id: &str) -> Result<()> {
        unimplemented!()
    }

    fn search_by_symbol(&self, _query: &str) -> Result<Vec<Asset>> {
        Ok(Vec::new())
    }

    async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
        Ok(())
    }

    async fn deactivate(&self, _asset_id: &str) -> Result<()> {
        Ok(())
    }

    async fn reactivate(&self, _asset_id: &str) -> Result<()> {
        Ok(())
    }

    async fn copy_user_metadata(&self, _source_id: &str, _target_id: &str) -> Result<()> {
        Ok(())
    }

    async fn deactivate_orphaned_investments(&self) -> Result<Vec<String>> {
        Ok(vec![])
    }
}

struct MockSnapshotRepository {
    snapshots: HashMap<String, AccountStateSnapshot>,
}

impl MockSnapshotRepository {
    fn new(snapshots: Vec<AccountStateSnapshot>) -> Self {
        let map = snapshots
            .into_iter()
            .map(|s| (s.account_id.clone(), s))
            .collect();
        Self { snapshots: map }
    }
}

#[async_trait]
impl SnapshotRepositoryTrait for MockSnapshotRepository {
    async fn save_snapshots(&self, _snapshots: &[AccountStateSnapshot]) -> Result<()> {
        unimplemented!()
    }

    fn get_snapshots_by_account(
        &self,
        _account_id: &str,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        unimplemented!()
    }

    fn get_latest_snapshot_before_date(
        &self,
        account_id: &str,
        _date: NaiveDate,
    ) -> Result<Option<AccountStateSnapshot>> {
        Ok(self.snapshots.get(account_id).cloned())
    }

    fn get_latest_snapshots_before_date(
        &self,
        account_ids: &[String],
        _date: NaiveDate,
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        let result = account_ids
            .iter()
            .filter_map(|id| self.snapshots.get(id).map(|s| (id.clone(), s.clone())))
            .collect();
        Ok(result)
    }

    fn get_all_latest_snapshots(
        &self,
        account_ids: &[String],
    ) -> Result<HashMap<String, AccountStateSnapshot>> {
        let result = account_ids
            .iter()
            .filter_map(|id| self.snapshots.get(id).map(|s| (id.clone(), s.clone())))
            .collect();
        Ok(result)
    }

    async fn delete_snapshots_by_account_ids(&self, _account_ids: &[String]) -> Result<usize> {
        unimplemented!()
    }

    async fn delete_snapshots_for_account_and_dates(
        &self,
        _account_id: &str,
        _dates_to_delete: &[NaiveDate],
    ) -> Result<()> {
        unimplemented!()
    }

    async fn delete_snapshots_for_account_in_range(
        &self,
        _account_id: &str,
        _start_date: NaiveDate,
        _end_date: NaiveDate,
    ) -> Result<()> {
        unimplemented!()
    }

    async fn overwrite_snapshots_for_account_in_range(
        &self,
        _account_id: &str,
        _start_date: NaiveDate,
        _end_date: NaiveDate,
        _snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        unimplemented!()
    }

    async fn overwrite_multiple_account_snapshot_ranges(
        &self,
        _new_snapshots: &[AccountStateSnapshot],
    ) -> Result<()> {
        unimplemented!()
    }

    fn get_all_non_archived_account_snapshots(
        &self,
        _start_date: Option<NaiveDate>,
        _end_date: Option<NaiveDate>,
    ) -> Result<Vec<AccountStateSnapshot>> {
        unimplemented!()
    }

    fn get_earliest_snapshot_date(&self, _account_id: &str) -> Result<Option<NaiveDate>> {
        unimplemented!()
    }

    async fn overwrite_all_snapshots_for_account(
        &self,
        _account_id: &str,
        _snapshots_to_save: &[AccountStateSnapshot],
    ) -> Result<()> {
        unimplemented!()
    }

    async fn update_snapshots_source(&self, _account_id: &str, _new_source: &str) -> Result<usize> {
        unimplemented!()
    }

    async fn save_or_update_snapshot(&self, _snapshot: &AccountStateSnapshot) -> Result<()> {
        unimplemented!()
    }

    fn get_non_calculated_snapshot_count(&self, _account_id: &str) -> Result<usize> {
        Ok(0)
    }

    fn get_earliest_non_calculated_snapshot(
        &self,
        _account_id: &str,
    ) -> Result<Option<AccountStateSnapshot>> {
        Ok(None)
    }

    fn get_snapshot_positions(&self, _snapshot_id: &str) -> Result<HashMap<String, Position>> {
        Ok(HashMap::new())
    }

    fn get_snapshot_positions_batch(
        &self,
        _snapshot_ids: &[String],
    ) -> Result<HashMap<String, HashMap<String, Position>>> {
        Ok(HashMap::new())
    }
}

struct MockMarketDataRepository {
    quotes: Vec<Quote>,
}

impl MockMarketDataRepository {
    fn new(quotes: Vec<Quote>) -> Self {
        Self { quotes }
    }
}

#[async_trait]
impl QuoteServiceTrait for MockMarketDataRepository {
    // =========================================================================
    // Quote CRUD Operations
    // =========================================================================

    fn get_latest_quote(&self, symbol: &str) -> Result<Quote> {
        self.quotes
            .iter()
            .filter(|q| q.asset_id == symbol)
            .max_by_key(|q| q.timestamp)
            .cloned()
            .ok_or_else(|| {
                crate::errors::Error::Repository(format!("Quote not found for {}", symbol))
            })
    }

    fn get_latest_quotes(&self, symbols: &[String]) -> Result<HashMap<String, Quote>> {
        let mut result = HashMap::new();
        for symbol in symbols {
            if let Some(quote) = self
                .quotes
                .iter()
                .filter(|q| &q.asset_id == symbol)
                .max_by_key(|q| q.timestamp)
            {
                result.insert(symbol.clone(), quote.clone());
            }
        }
        Ok(result)
    }

    fn get_latest_quotes_as_of(
        &self,
        _symbols: &[String],
        _as_of: chrono::NaiveDate,
    ) -> Result<HashMap<String, Quote>> {
        Ok(HashMap::new())
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

    fn get_historical_quotes(&self, symbol: &str) -> Result<Vec<Quote>> {
        Ok(self
            .quotes
            .iter()
            .filter(|q| q.asset_id == symbol)
            .cloned()
            .collect())
    }

    fn get_all_historical_quotes(&self) -> Result<HashMap<String, Vec<(NaiveDate, Quote)>>> {
        let mut result: HashMap<String, Vec<(NaiveDate, Quote)>> = HashMap::new();
        for quote in &self.quotes {
            let date = quote.timestamp.date_naive();
            result
                .entry(quote.asset_id.clone())
                .or_default()
                .push((date, quote.clone()));
        }
        Ok(result)
    }

    fn get_quotes_in_range(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        Ok(self
            .quotes
            .iter()
            .filter(|q| {
                let date = q.timestamp.date_naive();
                symbols.contains(&q.asset_id) && date >= start && date <= end
            })
            .cloned()
            .collect())
    }

    fn get_quotes_in_range_filled(
        &self,
        symbols: &HashSet<String>,
        start: NaiveDate,
        end: NaiveDate,
    ) -> Result<Vec<Quote>> {
        // For testing, just return the raw quotes in range
        // The actual implementation would fill gaps
        self.get_quotes_in_range(symbols, start, end)
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

    async fn update_quote(&self, _quote: Quote) -> Result<Quote> {
        unimplemented!()
    }

    async fn delete_quote(&self, _quote_id: &str) -> Result<()> {
        unimplemented!()
    }

    async fn bulk_upsert_quotes(&self, _quotes: Vec<Quote>) -> Result<usize> {
        unimplemented!()
    }

    // =========================================================================
    // Provider Operations
    // =========================================================================

    async fn search_symbol(&self, _query: &str) -> Result<Vec<SymbolSearchResult>> {
        unimplemented!()
    }

    async fn search_symbol_with_currency(
        &self,
        _query: &str,
        _account_currency: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>> {
        unimplemented!()
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

    // =========================================================================
    // Sync Operations
    // =========================================================================

    async fn sync(
        &self,
        _mode: crate::quotes::SyncMode,
        _asset_ids: Option<Vec<String>>,
    ) -> Result<SyncResult> {
        unimplemented!()
    }

    async fn resync(&self, _asset_ids: Option<Vec<String>>) -> Result<SyncResult> {
        unimplemented!()
    }

    async fn refresh_sync_state(&self) -> Result<()> {
        Ok(())
    }

    fn get_sync_plan(&self) -> Result<Vec<SymbolSyncPlan>> {
        Ok(Vec::new())
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
        Ok(Vec::new())
    }

    fn get_sync_state(&self, _symbol: &str) -> Result<Option<QuoteSyncState>> {
        Ok(None)
    }

    async fn mark_profile_enriched(&self, _symbol: &str) -> Result<()> {
        Ok(())
    }

    fn get_assets_needing_profile_enrichment(&self) -> Result<Vec<QuoteSyncState>> {
        Ok(Vec::new())
    }

    async fn update_position_status_from_holdings(
        &self,
        _current_holdings: &std::collections::HashMap<String, rust_decimal::Decimal>,
    ) -> Result<()> {
        Ok(())
    }

    fn get_sync_states_with_errors(&self) -> Result<Vec<QuoteSyncState>> {
        Ok(Vec::new())
    }

    async fn reset_sync_errors(&self, _asset_ids: &[String]) -> Result<()> {
        Ok(())
    }

    async fn reset_sync_state_for_profile_change(&self, _asset_id: &str) -> Result<()> {
        Ok(())
    }

    // =========================================================================
    // Provider Settings
    // =========================================================================

    async fn get_providers_info(&self) -> Result<Vec<ProviderInfo>> {
        unimplemented!()
    }

    async fn update_provider_settings(
        &self,
        _provider_id: &str,
        _priority: i32,
        _enabled: bool,
    ) -> Result<()> {
        unimplemented!()
    }

    // =========================================================================
    // Quote Import
    // =========================================================================

    async fn check_quotes_import(
        &self,
        _content: &[u8],
        _has_header_row: bool,
    ) -> Result<Vec<QuoteImport>> {
        unimplemented!()
    }

    async fn import_quotes(
        &self,
        _quotes: Vec<QuoteImport>,
        _overwrite: bool,
    ) -> Result<Vec<QuoteImport>> {
        unimplemented!()
    }
}

struct MockFxService {
    #[allow(dead_code)]
    base_currency: String,
}

impl MockFxService {
    fn new(base_currency: &str) -> Self {
        Self {
            base_currency: base_currency.to_string(),
        }
    }
}

#[async_trait]
impl FxServiceTrait for MockFxService {
    fn initialize(&self) -> Result<()> {
        Ok(())
    }

    fn get_historical_rates(
        &self,
        _from_currency: &str,
        _to_currency: &str,
        _days: i64,
    ) -> Result<Vec<ExchangeRate>> {
        Ok(vec![])
    }

    fn get_latest_exchange_rate(
        &self,
        _from_currency: &str,
        _to_currency: &str,
    ) -> Result<Decimal> {
        Ok(dec!(1.0))
    }

    fn get_exchange_rate_for_date(
        &self,
        _from_currency: &str,
        _to_currency: &str,
        _date: NaiveDate,
    ) -> Result<Decimal> {
        Ok(dec!(1.0))
    }

    fn convert_currency(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
    ) -> Result<Decimal> {
        if from_currency == to_currency {
            return Ok(amount);
        }
        // For testing, use 1:1 conversion
        Ok(amount)
    }

    fn convert_currency_for_date(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
        _date: NaiveDate,
    ) -> Result<Decimal> {
        if from_currency == to_currency {
            return Ok(amount);
        }
        // For testing, use 1:1 conversion
        Ok(amount)
    }

    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        Ok(vec![])
    }

    async fn add_exchange_rate(&self, _new_rate: NewExchangeRate) -> Result<ExchangeRate> {
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

    async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
        unimplemented!()
    }

    async fn register_currency_pair(&self, _from_currency: &str, _to_currency: &str) -> Result<()> {
        Ok(())
    }

    async fn register_currency_pair_manual(
        &self,
        _from_currency: &str,
        _to_currency: &str,
    ) -> Result<()> {
        Ok(())
    }

    async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> Result<()> {
        Ok(())
    }
}

struct MockValuationRepository {
    valuations: Vec<DailyAccountValuation>,
}

impl MockValuationRepository {
    fn new(valuations: Vec<DailyAccountValuation>) -> Self {
        Self { valuations }
    }
}

#[async_trait]
impl ValuationRepositoryTrait for MockValuationRepository {
    async fn save_valuations(&self, _valuation_records: &[DailyAccountValuation]) -> Result<()> {
        Ok(())
    }

    async fn replace_valuations_for_account(
        &self,
        _account_id: &str,
        _since_date: Option<NaiveDate>,
        _valuation_records: &[DailyAccountValuation],
    ) -> Result<()> {
        Ok(())
    }

    fn get_historical_valuations(
        &self,
        account_id: &str,
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        let filtered: Vec<_> = self
            .valuations
            .iter()
            .filter(|v| v.account_id == account_id)
            .filter(|v| start_date.map(|sd| v.valuation_date >= sd).unwrap_or(true))
            .filter(|v| end_date.map(|ed| v.valuation_date <= ed).unwrap_or(true))
            .cloned()
            .collect();
        Ok(filtered)
    }

    fn get_historical_valuations_for_accounts(
        &self,
        account_ids: &[String],
        start_date: Option<NaiveDate>,
        end_date: Option<NaiveDate>,
    ) -> Result<Vec<DailyAccountValuation>> {
        let filtered: Vec<_> = self
            .valuations
            .iter()
            .filter(|v| account_ids.contains(&v.account_id))
            .filter(|v| start_date.map(|sd| v.valuation_date >= sd).unwrap_or(true))
            .filter(|v| end_date.map(|ed| v.valuation_date <= ed).unwrap_or(true))
            .cloned()
            .collect();
        Ok(filtered)
    }

    fn load_latest_valuation_date(&self, account_id: &str) -> Result<Option<NaiveDate>> {
        let latest = self
            .valuations
            .iter()
            .filter(|v| v.account_id == account_id)
            .max_by_key(|v| v.valuation_date)
            .map(|v| v.valuation_date);
        Ok(latest)
    }

    async fn delete_valuations_for_account(
        &self,
        _account_id: &str,
        _since_date: Option<NaiveDate>,
    ) -> Result<()> {
        Ok(())
    }

    fn get_latest_valuations(&self, account_ids: &[String]) -> Result<Vec<DailyAccountValuation>> {
        let mut result = vec![];
        for account_id in account_ids {
            if let Some(val) = self
                .valuations
                .iter()
                .filter(|v| &v.account_id == account_id)
                .max_by_key(|v| v.valuation_date)
            {
                result.push(val.clone());
            }
        }
        Ok(result)
    }

    fn get_valuations_on_date(
        &self,
        account_ids: &[String],
        date: NaiveDate,
    ) -> Result<Vec<DailyAccountValuation>> {
        let filtered: Vec<_> = self
            .valuations
            .iter()
            .filter(|v| account_ids.contains(&v.account_id) && v.valuation_date == date)
            .cloned()
            .collect();
        Ok(filtered)
    }

    fn get_accounts_with_negative_balance(
        &self,
        _account_ids: &[String],
    ) -> Result<Vec<NegativeBalanceInfo>> {
        Ok(Vec::new())
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

fn create_test_account(id: &str, account_type: &str, currency: &str) -> Account {
    let now = Utc::now().naive_utc();
    Account {
        id: id.to_string(),
        name: format!("Test Account {}", id),
        account_type: account_type.to_string(),
        group: None,
        currency: currency.to_string(),
        is_default: false,
        is_active: true,
        created_at: now,
        updated_at: now,
        platform_id: None,
        account_number: None,
        meta: None,
        provider: None,
        provider_account_id: None,
        is_archived: false,
        tracking_mode: crate::accounts::TrackingMode::NotSet,
    }
}

fn create_test_asset(id: &str, kind: AssetKind, currency: &str) -> Asset {
    let now = Utc::now().naive_utc();
    Asset {
        id: id.to_string(),
        name: Some(format!("Asset {}", id)),
        display_code: Some(id.to_string()),
        notes: None,
        created_at: now,
        updated_at: now,
        quote_ccy: currency.to_string(),
        kind,
        instrument_type: None,
        instrument_symbol: None,
        instrument_exchange_mic: None,
        instrument_key: None,
        exchange_name: None,
        quote_mode: QuoteMode::Market,
        provider_config: None,
        is_active: true,
        metadata: None,
    }
}

fn create_test_position(
    account_id: &str,
    asset_id: &str,
    quantity: Decimal,
    cost_basis: Decimal,
    currency: &str,
) -> Position {
    Position {
        id: format!("POS-{}-{}", asset_id, account_id),
        account_id: account_id.to_string(),
        asset_id: asset_id.to_string(),
        quantity,
        average_cost: if quantity > Decimal::ZERO {
            cost_basis / quantity
        } else {
            Decimal::ZERO
        },
        total_cost_basis: cost_basis,
        currency: currency.to_string(),
        inception_date: Utc::now(),
        lots: VecDeque::new(),
        created_at: Utc::now(),
        last_updated: Utc::now(),
        is_alternative: false,
        contract_multiplier: Decimal::ONE,
    }
}

fn create_test_snapshot(
    account_id: &str,
    positions: Vec<Position>,
    cash: HashMap<String, Decimal>,
) -> AccountStateSnapshot {
    let mut positions_map = HashMap::new();
    for pos in positions {
        positions_map.insert(pos.asset_id.clone(), pos);
    }

    AccountStateSnapshot {
        id: format!("{}_2024-01-15", account_id),
        account_id: account_id.to_string(),
        snapshot_date: NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        currency: "USD".to_string(),
        positions: positions_map,
        cash_balances: cash,
        cost_basis: Decimal::ZERO,
        net_contribution: Decimal::ZERO,
        net_contribution_base: Decimal::ZERO,
        cash_total_account_currency: Decimal::ZERO,
        cash_total_base_currency: Decimal::ZERO,
        calculated_at: Utc::now().naive_utc(),
        source: SnapshotSource::Calculated,
    }
}

fn create_test_quote(symbol: &str, price: Decimal, date: NaiveDate, currency: &str) -> Quote {
    Quote {
        id: format!("{}-{}", symbol, date),
        asset_id: symbol.to_string(),
        timestamp: DateTime::from_naive_utc_and_offset(date.and_hms_opt(16, 0, 0).unwrap(), Utc),
        open: price,
        high: price,
        low: price,
        close: price,
        adjclose: price,
        volume: dec!(0),
        currency: currency.to_string(),
        data_source: "MANUAL".to_string(),
        created_at: Utc::now(),
        notes: None,
    }
}

fn create_net_worth_service(
    accounts: Vec<Account>,
    assets: Vec<Asset>,
    snapshots: Vec<AccountStateSnapshot>,
    quotes: Vec<Quote>,
) -> NetWorthService {
    create_net_worth_service_with_valuations(accounts, assets, snapshots, quotes, vec![])
}

fn create_net_worth_service_with_valuations(
    accounts: Vec<Account>,
    assets: Vec<Asset>,
    snapshots: Vec<AccountStateSnapshot>,
    quotes: Vec<Quote>,
    valuations: Vec<DailyAccountValuation>,
) -> NetWorthService {
    let base_currency = Arc::new(RwLock::new("USD".to_string()));
    let effective_accounts = if accounts.is_empty() && !valuations.is_empty() {
        valuations
            .iter()
            .map(|valuation| valuation.account_id.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|account_id| create_test_account(&account_id, account_types::SECURITIES, "USD"))
            .collect()
    } else {
        accounts
    };
    let account_repo = Arc::new(MockAccountRepository::new(effective_accounts));
    let asset_repo = Arc::new(MockAssetRepository::new(assets));
    let snapshot_repo = Arc::new(MockSnapshotRepository::new(snapshots));
    let market_data_repo = Arc::new(MockMarketDataRepository::new(quotes));
    let valuation_repo = Arc::new(MockValuationRepository::new(valuations));
    let fx_service = Arc::new(MockFxService::new("USD"));

    NetWorthService::new(
        base_currency,
        account_repo,
        asset_repo,
        snapshot_repo,
        market_data_repo,
        valuation_repo,
        fx_service,
    )
}

fn create_total_valuation(
    date: NaiveDate,
    total_value: Decimal,
    net_contribution: Decimal,
) -> DailyAccountValuation {
    DailyAccountValuation {
        id: format!("account-1_{}", date),
        account_id: "account-1".to_string(),
        valuation_date: date,
        account_currency: "USD".to_string(),
        base_currency: "USD".to_string(),
        fx_rate_to_base: dec!(1),
        cash_balance: Decimal::ZERO,
        investment_market_value: total_value,
        total_value,
        cost_basis: net_contribution,
        net_contribution,
        cash_balance_base: Decimal::ZERO,
        investment_market_value_base: total_value,
        total_value_base: total_value,
        cost_basis_base: net_contribution,
        net_contribution_base: net_contribution,
        external_inflow_base: Decimal::ZERO,
        external_outflow_base: Decimal::ZERO,
        performance_eligible_value_base: total_value,
        calculated_at: Utc::now(),
    }
}

fn create_account_valuation(
    account_id: &str,
    date: NaiveDate,
    total_value: Decimal,
) -> DailyAccountValuation {
    DailyAccountValuation {
        id: format!("{}_{}", account_id, date),
        account_id: account_id.to_string(),
        valuation_date: date,
        account_currency: "USD".to_string(),
        base_currency: "USD".to_string(),
        fx_rate_to_base: dec!(1),
        cash_balance: total_value,
        investment_market_value: Decimal::ZERO,
        total_value,
        cost_basis: Decimal::ZERO,
        net_contribution: Decimal::ZERO,
        cash_balance_base: total_value,
        investment_market_value_base: Decimal::ZERO,
        total_value_base: total_value,
        cost_basis_base: Decimal::ZERO,
        net_contribution_base: Decimal::ZERO,
        external_inflow_base: Decimal::ZERO,
        external_outflow_base: Decimal::ZERO,
        performance_eligible_value_base: total_value,
        calculated_at: Utc::now(),
    }
}

// Helper to get category value from breakdown
fn get_category_value(response: &NetWorthResponse, category: &str) -> Decimal {
    response
        .assets
        .breakdown
        .iter()
        .find(|b| b.category == category)
        .map(|b| b.value)
        .unwrap_or(Decimal::ZERO)
}

// ============================================================================
// Tests
// ============================================================================

#[tokio::test]
async fn test_empty_accounts_returns_zero_net_worth() {
    let service = create_net_worth_service(vec![], vec![], vec![], vec![]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.net_worth, Decimal::ZERO);
    assert_eq!(result.assets.total, Decimal::ZERO);
    assert_eq!(result.liabilities.total, Decimal::ZERO);
    assert_eq!(result.currency, "USD");
}

#[tokio::test]
async fn test_single_investment_account() {
    let account = create_test_account("acc1", "SECURITIES", "USD");
    let asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let position = create_test_position("acc1", "AAPL", dec!(100), dec!(15000), "USD");
    let snapshot = create_test_snapshot("acc1", vec![position], HashMap::new());
    let quote = create_test_quote(
        "AAPL",
        dec!(185),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // 100 shares * $185 = $18,500
    assert_eq!(result.net_worth, dec!(18500));
    assert_eq!(result.assets.total, dec!(18500));
    assert_eq!(result.liabilities.total, Decimal::ZERO);
    assert_eq!(get_category_value(&result, "investments"), dec!(18500));
}

#[tokio::test]
async fn test_net_worth_with_liability() {
    // Investment account
    let inv_account = create_test_account("inv1", "SECURITIES", "USD");
    let asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let position = create_test_position("inv1", "AAPL", dec!(100), dec!(15000), "USD");
    let inv_snapshot = create_test_snapshot("inv1", vec![position], HashMap::new());
    let quote = create_test_quote(
        "AAPL",
        dec!(200),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    // Liability account
    let liab_account = create_test_account("liab1", "LIABILITY", "USD");
    let liab_asset = create_test_asset("LIAB-12345", AssetKind::Liability, "USD");
    let liab_position = create_test_position("liab1", "LIAB-12345", dec!(1), dec!(50000), "USD");
    let liab_snapshot = create_test_snapshot("liab1", vec![liab_position], HashMap::new());
    let liab_quote = create_test_quote(
        "LIAB-12345",
        dec!(50000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(
        vec![inv_account, liab_account],
        vec![asset, liab_asset],
        vec![inv_snapshot, liab_snapshot],
        vec![quote, liab_quote],
    );

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Assets: 100 * $200 = $20,000
    // Liabilities: $50,000
    // Net Worth: $20,000 - $50,000 = -$30,000
    assert_eq!(result.assets.total, dec!(20000));
    assert_eq!(result.liabilities.total, dec!(50000));
    assert_eq!(result.net_worth, dec!(-30000));
    assert_eq!(get_category_value(&result, "investments"), dec!(20000));
}

#[tokio::test]
async fn test_property_breakdown() {
    let account = create_test_account("prop1", "PROPERTY", "USD");
    let asset = create_test_asset("PROP-abc123", AssetKind::Property, "USD");
    let position = create_test_position("prop1", "PROP-abc123", dec!(1), dec!(400000), "USD");
    let snapshot = create_test_snapshot("prop1", vec![position], HashMap::new());
    let quote = create_test_quote(
        "PROP-abc123",
        dec!(450000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.net_worth, dec!(450000));
    assert_eq!(get_category_value(&result, "properties"), dec!(450000));
    assert_eq!(get_category_value(&result, "investments"), Decimal::ZERO);
}

#[tokio::test]
async fn test_cash_included_in_investments() {
    let account = create_test_account("acc1", "SECURITIES", "USD");
    let mut cash = HashMap::new();
    cash.insert("USD".to_string(), dec!(10000));
    let snapshot = create_test_snapshot("acc1", vec![], cash);

    let service = create_net_worth_service(vec![account], vec![], vec![snapshot], vec![]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.net_worth, dec!(10000));
    // Cash is in the cash category
    assert_eq!(get_category_value(&result, "cash"), dec!(10000));
}

#[tokio::test]
async fn test_credit_card_negative_balance_is_liability() {
    let account = create_test_account("card1", "CREDIT_CARD", "USD");
    let mut cash = HashMap::new();
    cash.insert("USD".to_string(), dec!(-1250));
    let snapshot = create_test_snapshot("card1", vec![], cash);

    let service = create_net_worth_service(vec![account], vec![], vec![snapshot], vec![]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.assets.total, Decimal::ZERO);
    assert_eq!(result.liabilities.total, dec!(1250));
    assert_eq!(result.net_worth, dec!(-1250));
    assert_eq!(result.stale_assets.len(), 0);
}

#[tokio::test]
async fn test_credit_card_positive_balance_is_cash() {
    let account = create_test_account("card1", "CREDIT_CARD", "USD");
    let mut cash = HashMap::new();
    cash.insert("USD".to_string(), dec!(25));
    let snapshot = create_test_snapshot("card1", vec![], cash);

    let service = create_net_worth_service(vec![account], vec![], vec![snapshot], vec![]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.assets.total, dec!(25));
    assert_eq!(result.liabilities.total, Decimal::ZERO);
    assert_eq!(result.net_worth, dec!(25));
    assert_eq!(get_category_value(&result, "cash"), dec!(25));
}

#[tokio::test]
async fn test_credit_card_multi_currency_nets_before_liability_split() {
    let account = create_test_account("card1", "CREDIT_CARD", "USD");
    let mut cash = HashMap::new();
    cash.insert("USD".to_string(), dec!(-500));
    cash.insert("EUR".to_string(), dec!(200));
    let snapshot = create_test_snapshot("card1", vec![], cash);
    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();

    let service = create_net_worth_service_with_valuations(
        vec![account],
        vec![],
        vec![snapshot],
        vec![],
        vec![create_account_valuation("card1", date, dec!(-300))],
    );

    let result = service.get_net_worth(date).await.unwrap();
    assert_eq!(result.assets.total, Decimal::ZERO);
    assert_eq!(result.liabilities.total, dec!(300));
    assert_eq!(result.net_worth, dec!(-300));
    assert_eq!(get_category_value(&result, "cash"), Decimal::ZERO);

    let history = service.get_net_worth_history(date, date).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].total_assets, Decimal::ZERO);
    assert_eq!(history[0].total_liabilities, dec!(300));
    assert_eq!(history[0].net_worth, dec!(-300));
}

#[tokio::test]
async fn test_staleness_detection() {
    let account = create_test_account("acc1", "SECURITIES", "USD");
    let asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let position = create_test_position("acc1", "AAPL", dec!(100), dec!(15000), "USD");
    let snapshot = create_test_snapshot("acc1", vec![position], HashMap::new());

    // Quote from 100 days ago
    let old_date = NaiveDate::from_ymd_opt(2023, 10, 7).unwrap();
    let quote = create_test_quote("AAPL", dec!(150), old_date, "USD");

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Should detect stale asset (>90 days)
    assert_eq!(result.stale_assets.len(), 1);
    assert_eq!(result.stale_assets[0].asset_id, "AAPL");
    assert!(result.stale_assets[0].days_stale > 90);
    assert_eq!(result.oldest_valuation_date, Some(old_date));
}

#[tokio::test]
async fn test_multiple_asset_categories() {
    // Securities account
    let sec_account = create_test_account("sec1", "SECURITIES", "USD");
    let sec_asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let sec_position = create_test_position("sec1", "AAPL", dec!(50), dec!(7500), "USD");
    let sec_snapshot = create_test_snapshot("sec1", vec![sec_position], HashMap::new());
    let sec_quote = create_test_quote(
        "AAPL",
        dec!(200),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    // Property account
    let prop_account = create_test_account("prop1", "PROPERTY", "USD");
    let prop_asset = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let prop_position = create_test_position("prop1", "PROP-house", dec!(1), dec!(300000), "USD");
    let prop_snapshot = create_test_snapshot("prop1", vec![prop_position], HashMap::new());
    let prop_quote = create_test_quote(
        "PROP-house",
        dec!(350000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    // Vehicle account
    let veh_account = create_test_account("veh1", "VEHICLE", "USD");
    let veh_asset = create_test_asset("VEH-car", AssetKind::Vehicle, "USD");
    let veh_position = create_test_position("veh1", "VEH-car", dec!(1), dec!(35000), "USD");
    let veh_snapshot = create_test_snapshot("veh1", vec![veh_position], HashMap::new());
    let veh_quote = create_test_quote(
        "VEH-car",
        dec!(30000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    // Liability account
    let liab_account = create_test_account("liab1", "LIABILITY", "USD");
    let liab_asset = create_test_asset("LIAB-mortgage", AssetKind::Liability, "USD");
    let liab_position =
        create_test_position("liab1", "LIAB-mortgage", dec!(1), dec!(200000), "USD");
    let liab_snapshot = create_test_snapshot("liab1", vec![liab_position], HashMap::new());
    let liab_quote = create_test_quote(
        "LIAB-mortgage",
        dec!(200000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(
        vec![sec_account, prop_account, veh_account, liab_account],
        vec![sec_asset, prop_asset, veh_asset, liab_asset],
        vec![sec_snapshot, prop_snapshot, veh_snapshot, liab_snapshot],
        vec![sec_quote, prop_quote, veh_quote, liab_quote],
    );

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Investments: 50 * $200 = $10,000
    // Properties: $350,000
    // Vehicles: $30,000
    // Liabilities: $200,000
    // Total Assets: $10,000 + $350,000 + $30,000 = $390,000
    // Net Worth: $390,000 - $200,000 = $190,000

    assert_eq!(get_category_value(&result, "investments"), dec!(10000));
    assert_eq!(get_category_value(&result, "properties"), dec!(350000));
    assert_eq!(get_category_value(&result, "vehicles"), dec!(30000));
    assert_eq!(result.assets.total, dec!(390000));
    assert_eq!(result.liabilities.total, dec!(200000));
    assert_eq!(result.net_worth, dec!(190000));
}

#[tokio::test]
async fn test_precious_metals_category() {
    let account = create_test_account("prec1", "PRECIOUS", "USD");
    let asset = create_test_asset("PREC-gold", AssetKind::PreciousMetal, "USD");
    // 10 oz of gold
    let position = create_test_position("prec1", "PREC-gold", dec!(10), dec!(18000), "USD");
    let snapshot = create_test_snapshot("prec1", vec![position], HashMap::new());
    // Gold at $2000/oz
    let quote = create_test_quote(
        "PREC-gold",
        dec!(2000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // 10 oz * $2000 = $20,000
    assert_eq!(result.net_worth, dec!(20000));
    assert_eq!(get_category_value(&result, "preciousMetals"), dec!(20000));
}

#[tokio::test]
async fn test_collectibles_category() {
    let account = create_test_account("coll1", "COLLECTIBLE", "USD");
    let asset = create_test_asset("COLL-art", AssetKind::Collectible, "USD");
    let position = create_test_position("coll1", "COLL-art", dec!(1), dec!(50000), "USD");
    let snapshot = create_test_snapshot("coll1", vec![position], HashMap::new());
    let quote = create_test_quote(
        "COLL-art",
        dec!(75000),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    assert_eq!(result.net_worth, dec!(75000));
    assert_eq!(get_category_value(&result, "collectibles"), dec!(75000));
}

#[tokio::test]
async fn test_no_quote_falls_back_to_cost_basis() {
    let account = create_test_account("acc1", "SECURITIES", "USD");
    let asset = create_test_asset("NEWSTOCK", AssetKind::Investment, "USD");
    // Position with $10,000 cost basis, 100 shares -> implied price $100/share
    let position = create_test_position("acc1", "NEWSTOCK", dec!(100), dec!(10000), "USD");
    let snapshot = create_test_snapshot("acc1", vec![position], HashMap::new());
    // No quotes available

    let service = create_net_worth_service(
        vec![account],
        vec![asset],
        vec![snapshot],
        vec![], // Empty quotes
    );

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Should use cost basis: 100 * ($10,000/100) = $10,000
    assert_eq!(result.net_worth, dec!(10000));
}

// ============================================================================
// Net Worth History Tests
// ============================================================================

#[test]
fn test_history_basic_portfolio_with_alt_assets() {
    // Setup: Portfolio + Property + Liability over 5 days
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
    let d3 = NaiveDate::from_ymd_opt(2024, 1, 3).unwrap();
    let d4 = NaiveDate::from_ymd_opt(2024, 1, 4).unwrap();
    let d5 = NaiveDate::from_ymd_opt(2024, 1, 5).unwrap();

    // Portfolio valuations
    let valuations = vec![
        create_total_valuation(d1, dec!(100000), dec!(95000)), // $5K gain
        create_total_valuation(d2, dec!(101000), dec!(95000)), // $6K gain
        create_total_valuation(d3, dec!(102000), dec!(96000)), // $6K gain (deposited $1K)
        create_total_valuation(d4, dec!(103000), dec!(96000)), // $7K gain
        create_total_valuation(d5, dec!(104000), dec!(96000)), // $8K gain
    ];

    // Property asset
    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let property_quotes = vec![
        create_test_quote("PROP-house", dec!(500000), d1, "USD"),
        create_test_quote("PROP-house", dec!(505000), d5, "USD"), // Appreciated
    ];

    // Liability asset
    let liability = create_test_asset("LIAB-mortgage", AssetKind::Liability, "USD");
    let liability_quotes = vec![
        create_test_quote("LIAB-mortgage", dec!(300000), d1, "USD"),
        create_test_quote("LIAB-mortgage", dec!(298000), d5, "USD"), // Paid down
    ];

    let all_quotes = [property_quotes, liability_quotes].concat();

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property, liability],
        vec![],
        all_quotes,
        valuations,
    );

    let history = service.get_net_worth_history(d1, d5).unwrap();

    assert_eq!(history.len(), 5, "Should have 5 data points");

    // Day 1: Portfolio 100K + Property 500K - Liability 300K = 300K
    assert_eq!(history[0].date, d1);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].alternative_assets_value, dec!(500000));
    assert_eq!(history[0].total_liabilities, dec!(300000));
    assert_eq!(history[0].net_worth, dec!(300000));
    assert_eq!(history[0].net_contribution, dec!(95000));

    // Day 5: Portfolio 104K + Property 505K - Liability 298K = 311K
    let last = &history[4];
    assert_eq!(last.date, d5);
    assert_eq!(last.portfolio_value, dec!(104000));
    assert_eq!(last.alternative_assets_value, dec!(505000));
    assert_eq!(last.total_liabilities, dec!(298000));
    assert_eq!(last.net_worth, dec!(311000));
    assert_eq!(last.net_contribution, dec!(96000));

    // Verify gain calculation would work correctly:
    // Portfolio gain = (104000 - 96000) - (100000 - 95000) = 8000 - 5000 = 3000
    // Alt asset gain = 505000 - 500000 = 5000
    // Liability reduction = 300000 - 298000 = 2000
    // Total gain = 3000 + 5000 + 2000 = 10000
    let first = &history[0];
    let portfolio_gain = (last.portfolio_value - last.net_contribution)
        - (first.portfolio_value - first.net_contribution);
    let alt_asset_gain = last.alternative_assets_value - first.alternative_assets_value;
    let liability_reduction = first.total_liabilities - last.total_liabilities;
    let total_gain = portfolio_gain + alt_asset_gain + liability_reduction;
    assert_eq!(total_gain, dec!(10000));
}

#[test]
fn test_history_portfolio_only_no_alt_assets() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
    let d3 = NaiveDate::from_ymd_opt(2024, 1, 3).unwrap();

    let valuations = vec![
        create_total_valuation(d1, dec!(50000), dec!(48000)),
        create_total_valuation(d2, dec!(51000), dec!(48000)),
        create_total_valuation(d3, dec!(52000), dec!(48000)),
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![], // No alternative assets
        vec![],
        vec![], // No quotes
        valuations,
    );

    let history = service.get_net_worth_history(d1, d3).unwrap();

    assert_eq!(history.len(), 3);
    assert_eq!(history[0].portfolio_value, dec!(50000));
    assert_eq!(history[0].alternative_assets_value, Decimal::ZERO);
    assert_eq!(history[0].total_liabilities, Decimal::ZERO);
    assert_eq!(history[0].net_worth, dec!(50000));

    assert_eq!(history[2].net_worth, dec!(52000));
}

#[test]
fn test_history_credit_card_balance_is_split_to_liabilities() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();

    let valuations = vec![
        create_total_valuation(d1, dec!(100000), dec!(100000)),
        create_account_valuation("card1", d1, dec!(-1250)),
    ];
    let portfolio_account = create_test_account("account-1", "SECURITIES", "USD");
    let card = create_test_account("card1", "CREDIT_CARD", "USD");

    let service = create_net_worth_service_with_valuations(
        vec![portfolio_account, card],
        vec![],
        vec![],
        vec![],
        valuations,
    );

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].total_assets, dec!(100000));
    assert_eq!(history[0].total_liabilities, dec!(1250));
    assert_eq!(history[0].net_worth, dec!(98750));
}

#[test]
fn test_history_credit_card_balance_before_first_portfolio_date_is_seeded() {
    let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let card_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let first_portfolio_date = NaiveDate::from_ymd_opt(2024, 2, 1).unwrap();

    let valuations = vec![
        create_total_valuation(first_portfolio_date, dec!(100000), dec!(100000)),
        create_account_valuation("card1", card_date, dec!(-500)),
    ];
    let portfolio_account = create_test_account("account-1", "SECURITIES", "USD");
    let card = create_test_account("card1", "CREDIT_CARD", "USD");

    let service = create_net_worth_service_with_valuations(
        vec![portfolio_account, card],
        vec![],
        vec![],
        vec![],
        valuations,
    );

    let history = service
        .get_net_worth_history(start, first_portfolio_date)
        .unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].date, first_portfolio_date);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].total_liabilities, dec!(500));
    assert_eq!(history[0].net_worth, dec!(99500));
}

#[test]
fn test_history_credit_card_without_total_stays_liability_only() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();

    let account = create_test_account("card1", "CREDIT_CARD", "USD");
    let valuations = vec![create_account_valuation("card1", d1, dec!(-500))];

    let service =
        create_net_worth_service_with_valuations(vec![account], vec![], vec![], vec![], valuations);

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].total_assets, Decimal::ZERO);
    assert_eq!(history[0].total_liabilities, dec!(500));
    assert_eq!(history[0].net_worth, dec!(-500));
}

#[test]
fn test_history_credit_card_positive_balance_without_total_is_cash_asset() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();

    let account = create_test_account("card1", "CREDIT_CARD", "USD");
    let valuations = vec![create_account_valuation("card1", d1, dec!(25))];

    let service =
        create_net_worth_service_with_valuations(vec![account], vec![], vec![], vec![], valuations);

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].total_assets, dec!(25));
    assert_eq!(history[0].total_liabilities, Decimal::ZERO);
    assert_eq!(history[0].net_worth, dec!(25));
}

#[test]
fn test_history_credit_card_liability_carries_forward_between_dates() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
    let d3 = NaiveDate::from_ymd_opt(2024, 1, 3).unwrap();

    // Portfolio holds steady at $100K. Card balance changes on d1 and d2, then
    // has no valuation on d3 (the balance should carry forward from d2).
    let valuations = vec![
        create_total_valuation(d1, dec!(100000), dec!(100000)),
        create_total_valuation(d2, dec!(100000), dec!(100000)),
        create_total_valuation(d3, dec!(100000), dec!(100000)),
        create_account_valuation("card1", d1, dec!(-500)),
        create_account_valuation("card1", d2, dec!(-1200)),
    ];
    let portfolio_account = create_test_account("account-1", "SECURITIES", "USD");
    let card = create_test_account("card1", "CREDIT_CARD", "USD");

    let service = create_net_worth_service_with_valuations(
        vec![portfolio_account, card],
        vec![],
        vec![],
        vec![],
        valuations,
    );

    let history = service.get_net_worth_history(d1, d3).unwrap();

    assert_eq!(history.len(), 3);

    assert_eq!(history[0].date, d1);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].total_liabilities, dec!(500));
    assert_eq!(history[0].net_worth, dec!(99500));

    assert_eq!(history[1].date, d2);
    assert_eq!(history[1].total_liabilities, dec!(1200));
    assert_eq!(history[1].net_worth, dec!(98800));

    // d3 has no new card valuation: liability carries forward from d2.
    assert_eq!(history[2].date, d3);
    assert_eq!(history[2].portfolio_value, dec!(100000));
    assert_eq!(history[2].total_liabilities, dec!(1200));
    assert_eq!(history[2].net_worth, dec!(98800));
}

#[test]
fn test_history_mixed_securities_cash_and_credit_card() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();

    // Securities ($100K) + cash ($5K) both count toward portfolio_value; the
    // credit card ($1,250 owed) is the only account treated as a liability.
    let valuations = vec![
        create_total_valuation(d1, dec!(100000), dec!(100000)),
        create_account_valuation("cash-1", d1, dec!(5000)),
        create_account_valuation("card1", d1, dec!(-1250)),
    ];
    let securities = create_test_account("account-1", "SECURITIES", "USD");
    let cash = create_test_account("cash-1", "CASH", "USD");
    let card = create_test_account("card1", "CREDIT_CARD", "USD");

    let service = create_net_worth_service_with_valuations(
        vec![securities, cash, card],
        vec![],
        vec![],
        vec![],
        valuations,
    );

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].portfolio_value, dec!(105000));
    assert_eq!(history[0].total_assets, dec!(105000));
    assert_eq!(history[0].total_liabilities, dec!(1250));
    assert_eq!(history[0].net_worth, dec!(103750));
}

#[test]
fn test_history_alt_asset_quote_after_range_start_before_first_portfolio_date_seeds_first_point() {
    let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let quote_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let first_portfolio_date = NaiveDate::from_ymd_opt(2024, 2, 1).unwrap();

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let valuations = vec![create_total_valuation(
        first_portfolio_date,
        dec!(100000),
        dec!(100000),
    )];
    let quotes = vec![create_test_quote(
        "PROP-house",
        dec!(450000),
        quote_date,
        "USD",
    )];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property],
        vec![],
        quotes,
        valuations,
    );

    let history = service
        .get_net_worth_history(start, first_portfolio_date)
        .unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].date, first_portfolio_date);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].alternative_assets_value, dec!(450000));
    assert_eq!(history[0].net_worth, dec!(550000));
}

#[test]
fn test_history_includes_closed_non_archived_accounts() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let closed_account =
        create_test_account_with_archive_state("closed-1", "SECURITIES", "USD", false, false);
    let mut valuation = create_total_valuation(d1, dec!(50000), dec!(48000));
    valuation.id = "closed-1_2024-01-01".to_string();
    valuation.account_id = "closed-1".to_string();

    let service = create_net_worth_service_with_valuations(
        vec![closed_account],
        vec![],
        vec![],
        vec![],
        vec![valuation],
    );

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].portfolio_value, dec!(50000));
    assert_eq!(history[0].net_worth, dec!(50000));
}

#[test]
fn test_history_alt_assets_only_no_portfolio() {
    // Edge case: user only has alternative assets, no portfolio
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let quotes = vec![
        create_test_quote("PROP-house", dec!(400000), d1, "USD"),
        create_test_quote("PROP-house", dec!(410000), d2, "USD"),
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property],
        vec![],
        quotes,
        vec![], // No portfolio valuations
    );

    let history = service.get_net_worth_history(d1, d2).unwrap();

    assert_eq!(history.len(), 2);
    assert_eq!(history[0].portfolio_value, Decimal::ZERO);
    assert_eq!(history[0].alternative_assets_value, dec!(400000));
    assert_eq!(history[0].net_worth, dec!(400000));
    assert_eq!(history[0].net_contribution, Decimal::ZERO);

    assert_eq!(history[1].alternative_assets_value, dec!(410000));
    assert_eq!(history[1].net_worth, dec!(410000));
}

#[test]
fn test_history_forward_fill_alt_assets() {
    // Alt asset has quote on day 1 and day 5 only
    // Days 2-4 should forward-fill from day 1
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
    let d3 = NaiveDate::from_ymd_opt(2024, 1, 3).unwrap();
    let d4 = NaiveDate::from_ymd_opt(2024, 1, 4).unwrap();
    let d5 = NaiveDate::from_ymd_opt(2024, 1, 5).unwrap();

    // Portfolio has data every day
    let valuations = vec![
        create_total_valuation(d1, dec!(10000), dec!(10000)),
        create_total_valuation(d2, dec!(10100), dec!(10000)),
        create_total_valuation(d3, dec!(10200), dec!(10000)),
        create_total_valuation(d4, dec!(10300), dec!(10000)),
        create_total_valuation(d5, dec!(10400), dec!(10000)),
    ];

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    // Only quotes on d1 and d5
    let quotes = vec![
        create_test_quote("PROP-house", dec!(200000), d1, "USD"),
        create_test_quote("PROP-house", dec!(210000), d5, "USD"),
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property],
        vec![],
        quotes,
        valuations,
    );

    let history = service.get_net_worth_history(d1, d5).unwrap();

    assert_eq!(history.len(), 5);

    // Days 2-4 should have forward-filled property value of 200000
    assert_eq!(history[1].alternative_assets_value, dec!(200000));
    assert_eq!(history[2].alternative_assets_value, dec!(200000));
    assert_eq!(history[3].alternative_assets_value, dec!(200000));

    // Day 5 should have updated property value
    assert_eq!(history[4].alternative_assets_value, dec!(210000));
}

#[test]
fn test_history_starts_from_first_portfolio_date() {
    // Alt assets have data before portfolio starts
    // History should only start from first portfolio date
    let d_before = NaiveDate::from_ymd_opt(2023, 12, 1).unwrap();
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();

    // Portfolio only starts on d1
    let valuations = vec![
        create_total_valuation(d1, dec!(50000), dec!(50000)),
        create_total_valuation(d2, dec!(51000), dec!(50000)),
    ];

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    // Property has quote before portfolio started
    let quotes = vec![
        create_test_quote("PROP-house", dec!(300000), d_before, "USD"),
        create_test_quote("PROP-house", dec!(310000), d2, "USD"),
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property],
        vec![],
        quotes,
        valuations,
    );

    // Query includes d_before, but history should start from d1
    let history = service.get_net_worth_history(d_before, d2).unwrap();

    // Should only have 2 points (d1 and d2), not 3
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].date, d1);

    // d1 should use forward-filled property value from d_before
    assert_eq!(history[0].portfolio_value, dec!(50000));
    assert_eq!(history[0].alternative_assets_value, dec!(300000));
    assert_eq!(history[0].net_worth, dec!(350000));
}

#[test]
fn test_history_empty_range() {
    // Query range before any data exists
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 5).unwrap();
    let d_after = NaiveDate::from_ymd_opt(2024, 2, 1).unwrap();

    let valuations = vec![create_total_valuation(d_after, dec!(50000), dec!(50000))];

    let service =
        create_net_worth_service_with_valuations(vec![], vec![], vec![], vec![], valuations);

    // Query before any data
    let history = service.get_net_worth_history(d1, d2).unwrap();

    assert!(history.is_empty(), "Should return empty history");
}

#[test]
fn test_history_single_day() {
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();

    let valuations = vec![create_total_valuation(d1, dec!(100000), dec!(90000))];

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let quotes = vec![create_test_quote("PROP-house", dec!(500000), d1, "USD")];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property],
        vec![],
        quotes,
        valuations,
    );

    let history = service.get_net_worth_history(d1, d1).unwrap();

    assert_eq!(history.len(), 1);
    assert_eq!(history[0].date, d1);
    assert_eq!(history[0].portfolio_value, dec!(100000));
    assert_eq!(history[0].alternative_assets_value, dec!(500000));
    assert_eq!(history[0].net_worth, dec!(600000));
    assert_eq!(history[0].net_contribution, dec!(90000));
}

#[test]
fn test_history_liability_reduction_is_positive_gain() {
    // Test that paying down debt shows as positive contribution to net worth
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 31).unwrap();

    let valuations = vec![
        create_total_valuation(d1, dec!(50000), dec!(50000)), // No portfolio gain
        create_total_valuation(d2, dec!(50000), dec!(50000)),
    ];

    let liability = create_test_asset("LIAB-mortgage", AssetKind::Liability, "USD");
    let quotes = vec![
        create_test_quote("LIAB-mortgage", dec!(200000), d1, "USD"),
        create_test_quote("LIAB-mortgage", dec!(195000), d2, "USD"), // Paid $5K
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![liability],
        vec![],
        quotes,
        valuations,
    );

    let history = service.get_net_worth_history(d1, d2).unwrap();

    assert_eq!(history.len(), 2);

    // Day 1: Net worth = 50K - 200K = -150K
    assert_eq!(history[0].net_worth, dec!(-150000));

    // Day 31: Net worth = 50K - 195K = -145K
    assert_eq!(history[1].net_worth, dec!(-145000));

    // Gain from liability reduction
    let liability_reduction = history[0].total_liabilities - history[1].total_liabilities;
    assert_eq!(liability_reduction, dec!(5000));
}

#[test]
fn test_history_contribution_adjusted_gain() {
    // Verify that deposits don't count as gain
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();

    // Day 1: 100K portfolio, 95K contributed (5K gain)
    // Day 15: 150K portfolio, 140K contributed (10K gain)
    // User deposited 45K, market gained 5K
    let valuations = vec![
        create_total_valuation(d1, dec!(100000), dec!(95000)),
        create_total_valuation(d2, dec!(150000), dec!(140000)),
    ];

    let service =
        create_net_worth_service_with_valuations(vec![], vec![], vec![], vec![], valuations);

    let history = service.get_net_worth_history(d1, d2).unwrap();

    assert_eq!(history.len(), 2);

    let first = &history[0];
    let last = &history[1];

    // Net worth increased by 50K
    let net_worth_change = last.net_worth - first.net_worth;
    assert_eq!(net_worth_change, dec!(50000));

    // But contribution-adjusted gain is only 5K
    let portfolio_gain = (last.portfolio_value - last.net_contribution)
        - (first.portfolio_value - first.net_contribution);
    assert_eq!(portfolio_gain, dec!(5000));
}

#[test]
fn test_history_multiple_alt_assets() {
    // Multiple alternative assets, each with different update schedules
    let d1 = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
    let d2 = NaiveDate::from_ymd_opt(2024, 1, 2).unwrap();
    let d3 = NaiveDate::from_ymd_opt(2024, 1, 3).unwrap();

    let valuations = vec![
        create_total_valuation(d1, dec!(10000), dec!(10000)),
        create_total_valuation(d2, dec!(10000), dec!(10000)),
        create_total_valuation(d3, dec!(10000), dec!(10000)),
    ];

    let property = create_test_asset("PROP-house", AssetKind::Property, "USD");
    let gold = create_test_asset("PREC-gold", AssetKind::PreciousMetal, "USD");
    let mortgage = create_test_asset("LIAB-mortgage", AssetKind::Liability, "USD");

    let quotes = vec![
        // Property: updates d1 and d3
        create_test_quote("PROP-house", dec!(500000), d1, "USD"),
        create_test_quote("PROP-house", dec!(510000), d3, "USD"),
        // Gold: updates d1 and d2
        create_test_quote("PREC-gold", dec!(5000), d1, "USD"),
        create_test_quote("PREC-gold", dec!(5500), d2, "USD"),
        // Mortgage: only d1
        create_test_quote("LIAB-mortgage", dec!(200000), d1, "USD"),
    ];

    let service = create_net_worth_service_with_valuations(
        vec![],
        vec![property, gold, mortgage],
        vec![],
        quotes,
        valuations,
    );

    let history = service.get_net_worth_history(d1, d3).unwrap();

    assert_eq!(history.len(), 3);

    // Day 1: 10K + 500K + 5K - 200K = 315K
    assert_eq!(history[0].portfolio_value, dec!(10000));
    assert_eq!(history[0].alternative_assets_value, dec!(505000)); // 500K + 5K
    assert_eq!(history[0].total_liabilities, dec!(200000));
    assert_eq!(history[0].net_worth, dec!(315000));

    // Day 2: 10K + 500K + 5.5K - 200K = 315.5K (gold updated, property forward-filled)
    assert_eq!(history[1].alternative_assets_value, dec!(505500)); // 500K + 5.5K
    assert_eq!(history[1].net_worth, dec!(315500));

    // Day 3: 10K + 510K + 5.5K - 200K = 325.5K (property updated, gold forward-filled)
    assert_eq!(history[2].alternative_assets_value, dec!(515500)); // 510K + 5.5K
    assert_eq!(history[2].net_worth, dec!(325500));
}

// ============================================================================
// Archive Behavior Tests
// ============================================================================

fn create_test_account_with_archive_state(
    id: &str,
    account_type: &str,
    currency: &str,
    is_active: bool,
    is_archived: bool,
) -> Account {
    let now = Utc::now().naive_utc();
    Account {
        id: id.to_string(),
        name: format!("Test Account {}", id),
        account_type: account_type.to_string(),
        group: None,
        currency: currency.to_string(),
        is_default: false,
        is_active,
        created_at: now,
        updated_at: now,
        platform_id: None,
        account_number: None,
        meta: None,
        provider: None,
        provider_account_id: None,
        is_archived,
        tracking_mode: crate::accounts::TrackingMode::NotSet,
    }
}

#[tokio::test]
async fn test_closed_account_in_net_worth_when_not_archived() {
    // Account is closed (is_active=false) but NOT archived (is_archived=false)
    // Should be included in net worth calculations
    let account =
        create_test_account_with_archive_state("closed_acc", "SECURITIES", "USD", false, false);
    let asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let position = create_test_position("closed_acc", "AAPL", dec!(100), dec!(15000), "USD");
    let snapshot = create_test_snapshot("closed_acc", vec![position], HashMap::new());
    let quote = create_test_quote(
        "AAPL",
        dec!(200),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Closed but non-archived account should be included
    // 100 shares * $200 = $20,000
    assert_eq!(result.net_worth, dec!(20000));
    assert_eq!(result.assets.total, dec!(20000));
}

#[tokio::test]
async fn test_archived_account_excluded_from_net_worth() {
    // Account is archived (is_archived=true)
    // Should be excluded from net worth calculations
    let account =
        create_test_account_with_archive_state("archived_acc", "SECURITIES", "USD", true, true);
    let asset = create_test_asset("AAPL", AssetKind::Investment, "USD");
    let position = create_test_position("archived_acc", "AAPL", dec!(100), dec!(15000), "USD");
    let snapshot = create_test_snapshot("archived_acc", vec![position], HashMap::new());
    let quote = create_test_quote(
        "AAPL",
        dec!(200),
        NaiveDate::from_ymd_opt(2024, 1, 15).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(vec![account], vec![asset], vec![snapshot], vec![quote]);

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let result = service.get_net_worth(date).await.unwrap();

    // Archived account should be excluded - net worth should be zero
    assert_eq!(result.net_worth, Decimal::ZERO);
    assert_eq!(result.assets.total, Decimal::ZERO);
}

#[tokio::test]
async fn test_net_worth_with_mixed_account_states() {
    // Setup:
    //   - Account A: is_active=true, is_archived=false (active) - $10,000
    //   - Account B: is_active=false, is_archived=false (closed but not archived) - $5,000
    //   - Account C: is_active=true, is_archived=true (active but archived) - $15,000
    //   - Account D: is_active=false, is_archived=true (closed and archived) - $20,000
    // Expected: Only A ($10K) and B ($5K) contribute = $15K total

    let acc_a = create_test_account_with_archive_state("acc_a", "SECURITIES", "USD", true, false);
    let acc_b = create_test_account_with_archive_state("acc_b", "SECURITIES", "USD", false, false);
    let acc_c = create_test_account_with_archive_state("acc_c", "SECURITIES", "USD", true, true);
    let acc_d = create_test_account_with_archive_state("acc_d", "SECURITIES", "USD", false, true);

    let asset_a = create_test_asset("ASSET_A", AssetKind::Investment, "USD");
    let asset_b = create_test_asset("ASSET_B", AssetKind::Investment, "USD");
    let asset_c = create_test_asset("ASSET_C", AssetKind::Investment, "USD");
    let asset_d = create_test_asset("ASSET_D", AssetKind::Investment, "USD");

    let pos_a = create_test_position("acc_a", "ASSET_A", dec!(100), dec!(10000), "USD");
    let pos_b = create_test_position("acc_b", "ASSET_B", dec!(50), dec!(5000), "USD");
    let pos_c = create_test_position("acc_c", "ASSET_C", dec!(150), dec!(15000), "USD");
    let pos_d = create_test_position("acc_d", "ASSET_D", dec!(200), dec!(20000), "USD");

    let snap_a = create_test_snapshot("acc_a", vec![pos_a], HashMap::new());
    let snap_b = create_test_snapshot("acc_b", vec![pos_b], HashMap::new());
    let snap_c = create_test_snapshot("acc_c", vec![pos_c], HashMap::new());
    let snap_d = create_test_snapshot("acc_d", vec![pos_d], HashMap::new());

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let quote_a = create_test_quote("ASSET_A", dec!(100), date, "USD"); // $100 * 100 = $10K
    let quote_b = create_test_quote("ASSET_B", dec!(100), date, "USD"); // $100 * 50 = $5K
    let quote_c = create_test_quote("ASSET_C", dec!(100), date, "USD"); // $100 * 150 = $15K (excluded)
    let quote_d = create_test_quote("ASSET_D", dec!(100), date, "USD"); // $100 * 200 = $20K (excluded)

    let service = create_net_worth_service(
        vec![acc_a, acc_b, acc_c, acc_d],
        vec![asset_a, asset_b, asset_c, asset_d],
        vec![snap_a, snap_b, snap_c, snap_d],
        vec![quote_a, quote_b, quote_c, quote_d],
    );

    let result = service.get_net_worth(date).await.unwrap();

    // Only non-archived accounts (A and B) should be included
    // A: $10K + B: $5K = $15K total
    assert_eq!(result.net_worth, dec!(15000));
    assert_eq!(result.assets.total, dec!(15000));
}

#[tokio::test]
async fn test_all_accounts_archived_returns_zero_net_worth() {
    // All accounts are archived - net worth should be zero
    let acc1 = create_test_account_with_archive_state("archived1", "SECURITIES", "USD", true, true);
    let acc2 =
        create_test_account_with_archive_state("archived2", "SECURITIES", "USD", false, true);

    let asset1 = create_test_asset("ASSET_1", AssetKind::Investment, "USD");
    let asset2 = create_test_asset("ASSET_2", AssetKind::Investment, "USD");

    let pos1 = create_test_position("archived1", "ASSET_1", dec!(100), dec!(10000), "USD");
    let pos2 = create_test_position("archived2", "ASSET_2", dec!(200), dec!(20000), "USD");

    let snap1 = create_test_snapshot("archived1", vec![pos1], HashMap::new());
    let snap2 = create_test_snapshot("archived2", vec![pos2], HashMap::new());

    let date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();
    let quote1 = create_test_quote("ASSET_1", dec!(150), date, "USD");
    let quote2 = create_test_quote("ASSET_2", dec!(150), date, "USD");

    let service = create_net_worth_service(
        vec![acc1, acc2],
        vec![asset1, asset2],
        vec![snap1, snap2],
        vec![quote1, quote2],
    );

    let result = service.get_net_worth(date).await.unwrap();

    // All accounts are archived - should return zero
    assert_eq!(result.net_worth, Decimal::ZERO);
    assert_eq!(result.assets.total, Decimal::ZERO);
}

#[tokio::test]
async fn test_newly_created_account_has_default_archive_values_net_worth() {
    // Verify default values for newly created accounts
    let account = Account::default();
    assert!(
        !account.is_archived,
        "New accounts should not be archived by default"
    );

    let account = create_test_account("new_acc", "SECURITIES", "USD");
    assert!(
        !account.is_archived,
        "Test helper should create non-archived accounts"
    );
    assert!(
        account.is_active,
        "Test helper should create active accounts"
    );
}

// ============================================================================
// Regression Tests
// ============================================================================

/// Regression: a liability that has a future-dated $0 quote (e.g. a mortgage planned
/// payoff date) must NOT appear as fully paid-off when computing net worth today.
/// The `get_latest_quote_as_of` logic filters quotes to those on or before the
/// requested date, so the future $0 row should be ignored and the most-recent
/// past balance ($180,000) should be used instead.
#[tokio::test]
async fn test_liability_with_future_zero_quote_is_included_at_past_balance() {
    let valuation_date = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap();

    // A mortgage LIABILITY account and asset
    let liab_account = create_test_account("liab-mortgage", "LIABILITY", "USD");
    let liab_asset = create_test_asset("LIAB-mortgage-reg", AssetKind::Liability, "USD");

    // The position records the outstanding balance as quantity=1, cost-basis=180_000
    let liab_position = create_test_position(
        "liab-mortgage",
        "LIAB-mortgage-reg",
        dec!(1),
        dec!(180000),
        "USD",
    );
    let liab_snapshot = create_test_snapshot("liab-mortgage", vec![liab_position], HashMap::new());

    // Two quotes for the same liability:
    //   • 2024-01-10: current outstanding balance = $180,000
    //   • 2041-01-01: planned payoff date recorded as $0 (future-dated)
    let past_quote = create_test_quote(
        "LIAB-mortgage-reg",
        dec!(180000),
        NaiveDate::from_ymd_opt(2024, 1, 10).unwrap(),
        "USD",
    );
    let future_zero_quote = create_test_quote(
        "LIAB-mortgage-reg",
        dec!(0),
        NaiveDate::from_ymd_opt(2041, 1, 1).unwrap(),
        "USD",
    );

    let service = create_net_worth_service(
        vec![liab_account],
        vec![liab_asset],
        vec![liab_snapshot],
        vec![past_quote, future_zero_quote],
    );

    let result = service.get_net_worth(valuation_date).await.unwrap();

    // The future $0 quote must be excluded; the liability must appear at $180,000.
    assert_eq!(
        result.liabilities.total,
        dec!(180000),
        "liability with a future-dated $0 quote should be valued at the most-recent past quote"
    );
    // Net worth = assets (0) - liabilities (180_000) = -180_000
    assert_eq!(result.net_worth, dec!(-180000));
}
