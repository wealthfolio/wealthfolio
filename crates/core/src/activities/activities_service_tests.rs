#[cfg(test)]
mod tests {
    use crate::accounts::{Account, AccountServiceTrait, AccountUpdate, NewAccount};
    use crate::activities::activities_model::*;
    use crate::activities::{
        ActivityRepositoryTrait, ActivityService, ActivityServiceTrait, ImportRun,
        ImportRunRepositoryTrait, ImportRunStatus,
    };
    use crate::assets::{
        normalize_quote_ccy_code, parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix,
        resolve_import_quote_ccy_precedence, Asset, AssetKind,
        AssetResolutionInput as ImportAssetResolutionInput, AssetResolutionOutput,
        AssetServiceTrait, InstrumentType, NewAsset, ProviderProfile, QuoteCcyResolutionSource,
        QuoteMode, UpdateAssetProfile,
    };
    use crate::errors::{DatabaseError, Error, Result};
    use crate::events::{DomainEvent, MockDomainEventSink};
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::portfolio::economic_events::BasisStatus;
    use crate::portfolio::performance::{PerformanceService, PerformanceServiceTrait};
    use crate::portfolio::snapshot::{
        AccountStateSnapshot, SnapshotRecalcMode, SnapshotServiceTrait,
    };
    use crate::portfolio::valuation::{
        DailyAccountValuation, ExternalFlowSource, NegativeBalanceInfo, ValuationRepositoryTrait,
        ValuationService, ValuationServiceTrait, ValuationStatus,
    };
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
    use std::sync::{Arc, Mutex, RwLock};

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
        resolve_import_asset_input_batches: Arc<Mutex<Vec<Vec<ImportAssetResolutionInput>>>>,
    }

    impl MockAssetService {
        fn new() -> Self {
            Self {
                assets: Arc::new(Mutex::new(Vec::new())),
                get_asset_by_id_error: Arc::new(Mutex::new(None)),
                resolve_import_asset_input_batches: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn add_asset(&self, asset: Asset) {
            self.assets.lock().unwrap().push(asset);
        }

        fn set_get_asset_by_id_error(&self, message: &str) {
            *self.get_asset_by_id_error.lock().unwrap() = Some(message.to_string());
        }

        fn resolve_import_asset_call_count(&self) -> usize {
            self.resolve_import_asset_input_batches
                .lock()
                .unwrap()
                .len()
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

        async fn resolve_import_asset_inputs(
            &self,
            inputs: Vec<ImportAssetResolutionInput>,
        ) -> Result<Vec<AssetResolutionOutput>> {
            self.resolve_import_asset_input_batches
                .lock()
                .unwrap()
                .push(inputs.clone());
            let assets = self.assets.lock().unwrap().clone();

            Ok(inputs
                .into_iter()
                .map(|input| {
                    let source_symbol = input.source_symbol.trim().to_string();
                    let (base_symbol, suffix_mic) =
                        parse_symbol_with_exchange_suffix(&source_symbol);
                    let mut exchange_mic = input
                        .exchange_mic
                        .clone()
                        .or_else(|| suffix_mic.map(str::to_string));
                    let provider_resolution = if source_symbol.eq_ignore_ascii_case("BRK.B") {
                        Some((
                            "BRK.B".to_string(),
                            "XNYS".to_string(),
                            "USD".to_string(),
                            "Berkshire Hathaway Inc.".to_string(),
                            "BRK-B".to_string(),
                        ))
                    } else if source_symbol.eq_ignore_ascii_case("VOD.L") {
                        Some((
                            "VOD".to_string(),
                            "XLON".to_string(),
                            "GBp".to_string(),
                            "Vodafone Group Public Limited Company".to_string(),
                            "VOD.L".to_string(),
                        ))
                    } else {
                        None
                    };
                    if exchange_mic.is_none() {
                        exchange_mic = provider_resolution
                            .as_ref()
                            .map(|(_, mic, _, _, _)| mic.clone());
                    }

                    let mut instrument_type = input.instrument_type.clone().or_else(|| {
                        if parse_crypto_pair_symbol(base_symbol).is_some()
                            || matches!(base_symbol.to_uppercase().as_str(), "BTC" | "ETH")
                        {
                            Some(InstrumentType::Crypto)
                        } else if crate::utils::occ_symbol::looks_like_occ_symbol(base_symbol) {
                            Some(InstrumentType::Option)
                        } else {
                            Some(InstrumentType::Equity)
                        }
                    });
                    if matches!(
                        instrument_type.as_ref(),
                        Some(InstrumentType::Crypto | InstrumentType::Fx)
                    ) {
                        exchange_mic = None;
                    }

                    let mut canonical_symbol = match instrument_type.as_ref() {
                        Some(InstrumentType::Crypto) => parse_crypto_pair_symbol(base_symbol)
                            .map(|(base, _)| base)
                            .unwrap_or_else(|| base_symbol.to_string()),
                        Some(InstrumentType::Option) => {
                            crate::utils::occ_symbol::normalize_option_symbol(base_symbol)
                                .unwrap_or_else(|| base_symbol.to_string())
                        }
                        _ => provider_resolution
                            .as_ref()
                            .map(|(symbol, _, _, _, _)| symbol.clone())
                            .unwrap_or_else(|| base_symbol.to_string()),
                    };

                    let pair_quote = if instrument_type.as_ref() == Some(&InstrumentType::Crypto) {
                        parse_crypto_pair_symbol(base_symbol).map(|(_, quote)| quote)
                    } else {
                        None
                    };

                    let existing_asset = input
                        .asset_id
                        .as_deref()
                        .and_then(|id| assets.iter().find(|asset| asset.id == id))
                        .or_else(|| {
                            input.isin.as_deref().and_then(|isin| {
                                let normalized = isin.trim().to_uppercase();
                                assets.iter().find(|asset| {
                                    asset
                                        .metadata
                                        .as_ref()
                                        .and_then(|metadata| metadata.get("identifiers"))
                                        .and_then(|ids| ids.get("isin"))
                                        .and_then(|value| value.as_str())
                                        .is_some_and(|asset_isin| {
                                            asset_isin.eq_ignore_ascii_case(&normalized)
                                        })
                                })
                            })
                        })
                        .or_else(|| {
                            assets.iter().find(|asset| {
                                asset.instrument_symbol.as_deref().is_some_and(|symbol| {
                                    symbol.eq_ignore_ascii_case(&canonical_symbol)
                                }) && instrument_type.as_ref().is_none_or(|itype| {
                                    asset.instrument_type.as_ref() == Some(itype)
                                }) && match instrument_type.as_ref() {
                                    Some(InstrumentType::Crypto | InstrumentType::Fx) => input
                                        .quote_ccy
                                        .as_deref()
                                        .or(pair_quote.as_deref())
                                        .is_none_or(|quote| {
                                            asset.quote_ccy.eq_ignore_ascii_case(quote)
                                        }),
                                    _ => match (
                                        exchange_mic.as_deref(),
                                        asset.instrument_exchange_mic.as_deref(),
                                    ) {
                                        (Some(expected), Some(actual)) => {
                                            actual.eq_ignore_ascii_case(expected)
                                        }
                                        (Some(_), _) => false,
                                        (None, _) => true,
                                    },
                                }
                            })
                        });

                    if let Some(asset) = existing_asset {
                        if let Some(symbol) = asset
                            .instrument_symbol
                            .as_deref()
                            .map(str::trim)
                            .filter(|symbol| !symbol.is_empty())
                        {
                            canonical_symbol = symbol.to_string();
                        }
                        if exchange_mic.is_none() {
                            exchange_mic = asset.instrument_exchange_mic.clone();
                        }
                        if instrument_type.is_none() {
                            instrument_type = asset.instrument_type.clone();
                        }
                    }

                    let explicit_quote_ccy = normalize_quote_ccy_code(input.quote_ccy.as_deref());
                    let existing_quote_ccy = existing_asset.map(|asset| asset.quote_ccy.clone());
                    let provider_quote_ccy = provider_resolution
                        .as_ref()
                        .map(|(_, _, quote, _, _)| quote.clone());
                    let mic_quote_ccy = exchange_mic
                        .as_deref()
                        .and_then(wealthfolio_market_data::mic_to_currency)
                        .map(str::to_string);
                    let activity_quote_ccy = input
                        .activity_currency
                        .clone()
                        .filter(|currency| !currency.trim().is_empty());
                    let (quote_ccy, quote_ccy_source) = resolve_import_quote_ccy_precedence(
                        explicit_quote_ccy.as_deref().or(pair_quote.as_deref()),
                        existing_quote_ccy.as_deref(),
                        activity_quote_ccy.as_deref(),
                        provider_quote_ccy.as_deref(),
                        mic_quote_ccy.as_deref(),
                        Some(input.account_currency.as_str()),
                    )
                    .unwrap_or_else(|| {
                        (
                            input.account_currency.clone(),
                            QuoteCcyResolutionSource::TerminalFallback,
                        )
                    });
                    let kind = match instrument_type.as_ref() {
                        Some(InstrumentType::Fx) => AssetKind::Fx,
                        _ => AssetKind::Investment,
                    };
                    let quote_mode = input.quote_mode.unwrap_or(QuoteMode::Market);
                    let existing_asset_id = existing_asset.map(|asset| asset.id.clone());
                    let name = existing_asset
                        .and_then(|asset| asset.name.clone())
                        .or_else(|| {
                            provider_resolution
                                .as_ref()
                                .map(|(_, _, _, name, _)| name.clone())
                        })
                        .or_else(|| Some(canonical_symbol.clone()));
                    let review_symbol = if instrument_type.as_ref() == Some(&InstrumentType::Equity)
                    {
                        exchange_mic
                            .as_deref()
                            .and_then(|mic| match mic.to_uppercase().as_str() {
                                "XETR" => Some(".DE"),
                                "XTSE" => Some(".TO"),
                                "XLON" => Some(".L"),
                                "CXE" => Some(".XC"),
                                _ => None,
                            })
                            .filter(|suffix| !suffix.is_empty())
                            .map(|suffix| format!("{canonical_symbol}{suffix}"))
                            .or_else(|| Some(canonical_symbol.clone()))
                    } else {
                        Some(canonical_symbol.clone())
                    };
                    let draft = existing_asset_id.is_none().then(|| NewAsset {
                        id: None,
                        kind: kind.clone(),
                        name: name.clone(),
                        display_code: Some(canonical_symbol.clone()),
                        is_active: true,
                        quote_mode,
                        quote_ccy: quote_ccy.clone(),
                        instrument_type: instrument_type.clone(),
                        instrument_symbol: Some(canonical_symbol.clone()),
                        instrument_exchange_mic: exchange_mic.clone(),
                        provider_config: None,
                        provider_id: provider_resolution.as_ref().map(|_| "YAHOO".to_string()),
                        provider_symbol: provider_resolution
                            .as_ref()
                            .map(|(_, _, _, _, symbol)| symbol.clone()),
                        notes: None,
                        metadata: None,
                    });

                    AssetResolutionOutput {
                        key: input.key,
                        source_symbol,
                        canonical_symbol: Some(canonical_symbol),
                        exchange_mic,
                        quote_ccy: Some(quote_ccy),
                        quote_ccy_source: Some(quote_ccy_source),
                        instrument_type,
                        kind: Some(kind),
                        provider_id: provider_resolution.as_ref().map(|_| "YAHOO".to_string()),
                        provider_symbol: provider_resolution
                            .as_ref()
                            .map(|(_, _, _, _, symbol)| symbol.clone()),
                        provider_config: None,
                        review_symbol,
                        existing_asset_id,
                        name,
                        draft,
                    }
                })
                .collect())
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
            Ok(Decimal::ONE)
        }

        fn convert_currency(
            &self,
            amount: Decimal,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<Decimal> {
            Ok(amount)
        }

        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            _from_currency: &str,
            _to_currency: &str,
            _date: NaiveDate,
        ) -> Result<Decimal> {
            Ok(amount)
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
                    ..Default::default()
                }]);
            }

            if query.eq_ignore_ascii_case("MSF.DE") {
                return Ok(vec![SymbolSearchResult {
                    symbol: "MSF".to_string(),
                    short_name: "Microsoft Corporation".to_string(),
                    long_name: "Microsoft Corporation".to_string(),
                    exchange: "NMS".to_string(),
                    exchange_mic: Some("XNAS".to_string()),
                    exchange_name: Some("NASDAQ".to_string()),
                    quote_type: "EQUITY".to_string(),
                    type_display: "Equity".to_string(),
                    currency: Some("USD".to_string()),
                    currency_source: Some("provider".to_string()),
                    data_source: Some("YAHOO".to_string()),
                    is_existing: false,
                    existing_asset_id: None,
                    index: String::new(),
                    score: 1.0,
                    ..Default::default()
                }]);
            }

            if query.eq_ignore_ascii_case("BRK.B") {
                return Ok(vec![SymbolSearchResult {
                    symbol: "BRK.B".to_string(),
                    short_name: "Berkshire Hathaway Inc.".to_string(),
                    long_name: "Berkshire Hathaway Inc.".to_string(),
                    exchange: "NYQ".to_string(),
                    exchange_mic: Some("XNYS".to_string()),
                    exchange_name: Some("NYSE".to_string()),
                    quote_type: "EQUITY".to_string(),
                    type_display: "Equity".to_string(),
                    currency: Some("USD".to_string()),
                    currency_source: Some("provider".to_string()),
                    data_source: Some("YAHOO".to_string()),
                    is_existing: false,
                    existing_asset_id: None,
                    index: String::new(),
                    score: 1.0,
                    ..Default::default()
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

    #[derive(Clone, Default)]
    struct RecordingQuoteService {
        updated_quotes: Arc<Mutex<Vec<Quote>>>,
    }

    impl RecordingQuoteService {
        fn updated_quotes(&self) -> Vec<Quote> {
            self.updated_quotes.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl QuoteServiceTrait for RecordingQuoteService {
        fn get_latest_quote(&self, _symbol: &str) -> Result<Quote> {
            unimplemented!()
        }

        fn get_latest_quotes(&self, _symbols: &[String]) -> Result<HashMap<String, Quote>> {
            unimplemented!()
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
            _asset_ids: &[String],
        ) -> Result<HashMap<String, LatestQuoteSnapshot>> {
            Ok(HashMap::new())
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
            self.updated_quotes.lock().unwrap().push(quote.clone());
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
            _query: &str,
            _account_currency: Option<&str>,
        ) -> Result<Vec<SymbolSearchResult>> {
            unimplemented!()
        }

        async fn resolve_symbol_quote(
            &self,
            _symbol: &str,
            _exchange_mic: Option<&str>,
            _instrument_type: Option<&InstrumentType>,
            _quote_ccy: Option<&str>,
            _preferred_provider: Option<&str>,
        ) -> Result<ResolvedQuote> {
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

    #[derive(Clone, Default)]
    struct MockImportRunRepository {
        runs: Arc<Mutex<Vec<ImportRun>>>,
    }

    #[async_trait]
    impl ImportRunRepositoryTrait for MockImportRunRepository {
        async fn create(&self, import_run: ImportRun) -> Result<ImportRun> {
            self.runs.lock().unwrap().push(import_run.clone());
            Ok(import_run)
        }

        async fn update(&self, import_run: ImportRun) -> Result<ImportRun> {
            let mut runs = self.runs.lock().unwrap();
            if let Some(existing) = runs.iter_mut().find(|run| run.id == import_run.id) {
                *existing = import_run.clone();
            } else {
                runs.push(import_run.clone());
            }
            Ok(import_run)
        }

        fn get_by_id(&self, id: &str) -> Result<Option<ImportRun>> {
            Ok(self
                .runs
                .lock()
                .unwrap()
                .iter()
                .find(|run| run.id == id)
                .cloned())
        }

        fn get_recent_for_account(&self, account_id: &str, limit: i64) -> Result<Vec<ImportRun>> {
            Ok(self
                .runs
                .lock()
                .unwrap()
                .iter()
                .filter(|run| run.account_id == account_id)
                .take(limit.max(0) as usize)
                .cloned()
                .collect())
        }
    }

    fn parse_test_activity_datetime(activity_date: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(activity_date)
            .map(|dt| dt.with_timezone(&Utc))
            .or_else(|_| {
                NaiveDate::parse_from_str(activity_date, "%Y-%m-%d")
                    .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc())
            })
            .unwrap_or_else(|_| Utc::now())
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

        fn find_transfer_counterpart(
            &self,
            group_id: &str,
            exclude_id: &str,
        ) -> Result<Option<Activity>> {
            let activities = self.activities.lock().unwrap();
            Ok(activities
                .iter()
                .find(|a| a.source_group_id.as_deref() == Some(group_id) && a.id != exclude_id)
                .cloned())
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
            _activity_id_filter: Option<Vec<String>>,
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
            let activity_date = parse_test_activity_datetime(&new_activity.activity_date);
            let generated_id = new_activity.id.unwrap_or_else(|| {
                format!("test-id-{}", self.activities.lock().unwrap().len() + 1)
            });
            let activity = Activity {
                id: generated_id,
                account_id: new_activity.account_id,
                asset_id,
                activity_type: new_activity.activity_type,
                activity_type_override: None,
                source_type: None,
                subtype: new_activity.subtype,
                status: new_activity.status.unwrap_or(ActivityStatus::Posted),
                activity_date,
                settlement_date: None,
                quantity: new_activity.quantity,
                unit_price: new_activity.unit_price,
                amount: new_activity.amount,
                fee: new_activity.fee,
                tax: new_activity.tax,
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
            existing.activity_date = parse_test_activity_datetime(&activity_update.activity_date);
            existing.subtype = match activity_update.subtype {
                Some(subtype) if subtype.trim().is_empty() => None,
                Some(subtype) => Some(subtype),
                None => existing.subtype.clone(),
            };
            existing.activity_date = parse_test_activity_datetime(&activity_update.activity_date);
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

        async fn delete_activity(&self, activity_id: String) -> Result<Activity> {
            let mut activities = self.activities.lock().unwrap();
            let index = activities
                .iter()
                .position(|activity| activity.id == activity_id)
                .ok_or_else(|| Error::Unexpected("Activity not found".to_string()))?;
            Ok(activities.remove(index))
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
            delete_ids: Vec<String>,
        ) -> Result<ActivityBulkMutationResult> {
            let mut deleted = Vec::new();
            for delete_id in delete_ids {
                deleted.push(self.delete_activity(delete_id).await?);
            }

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
                deleted,
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
                let activity_date = parse_test_activity_datetime(&new_activity.activity_date);
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
                    activity_date,
                    settlement_date: None,
                    quantity: new_activity.quantity,
                    unit_price: new_activity.unit_price,
                    amount: new_activity.amount,
                    fee: new_activity.fee,
                    tax: new_activity.tax,
                    currency: new_activity.currency,
                    fx_rate: new_activity.fx_rate,
                    notes: new_activity.notes,
                    metadata,
                    source_system: None,
                    source_record_id: None,
                    source_group_id: new_activity.source_group_id,
                    idempotency_key: new_activity.idempotency_key,
                    import_run_id: new_activity.import_run_id,
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

        fn get_income_activities_data(
            &self,
            _account_ids: Option<&[String]>,
        ) -> Result<Vec<IncomeData>> {
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

    #[derive(Clone)]
    struct MockValuationRepository {
        valuations: Arc<Mutex<Vec<DailyAccountValuation>>>,
    }

    impl MockValuationRepository {
        fn new(valuations: Vec<DailyAccountValuation>) -> Self {
            Self {
                valuations: Arc::new(Mutex::new(valuations)),
            }
        }

        fn in_range(
            valuation: &DailyAccountValuation,
            start_date: Option<NaiveDate>,
            end_date: Option<NaiveDate>,
        ) -> bool {
            start_date
                .map(|start| valuation.valuation_date >= start)
                .unwrap_or(true)
                && end_date
                    .map(|end| valuation.valuation_date <= end)
                    .unwrap_or(true)
        }

        fn sort_valuations(valuations: &mut [DailyAccountValuation]) {
            valuations.sort_by(|left, right| {
                left.account_id
                    .cmp(&right.account_id)
                    .then(left.valuation_date.cmp(&right.valuation_date))
            });
        }
    }

    #[async_trait]
    impl ValuationRepositoryTrait for MockValuationRepository {
        async fn save_valuations(
            &self,
            _valuation_records: &[DailyAccountValuation],
        ) -> Result<()> {
            unimplemented!()
        }

        async fn replace_valuations_for_account(
            &self,
            _account_id: &str,
            _since_date: Option<NaiveDate>,
            _valuation_records: &[DailyAccountValuation],
        ) -> Result<()> {
            unimplemented!()
        }

        fn get_historical_valuations(
            &self,
            account_id: &str,
            start_date: Option<NaiveDate>,
            end_date: Option<NaiveDate>,
        ) -> Result<Vec<DailyAccountValuation>> {
            let mut rows: Vec<_> = self
                .valuations
                .lock()
                .unwrap()
                .iter()
                .filter(|valuation| valuation.account_id == account_id)
                .filter(|valuation| Self::in_range(valuation, start_date, end_date))
                .cloned()
                .collect();
            Self::sort_valuations(&mut rows);
            Ok(rows)
        }

        fn get_historical_valuations_for_accounts(
            &self,
            account_ids: &[String],
            start_date: Option<NaiveDate>,
            end_date: Option<NaiveDate>,
        ) -> Result<Vec<DailyAccountValuation>> {
            let account_ids: HashSet<&str> = account_ids.iter().map(String::as_str).collect();
            let mut rows: Vec<_> = self
                .valuations
                .lock()
                .unwrap()
                .iter()
                .filter(|valuation| account_ids.contains(valuation.account_id.as_str()))
                .filter(|valuation| Self::in_range(valuation, start_date, end_date))
                .cloned()
                .collect();
            Self::sort_valuations(&mut rows);
            Ok(rows)
        }

        fn load_latest_valuation_date(&self, _account_id: &str) -> Result<Option<NaiveDate>> {
            unimplemented!()
        }

        async fn delete_valuations_for_account(
            &self,
            _account_id: &str,
            _since_date: Option<NaiveDate>,
        ) -> Result<()> {
            unimplemented!()
        }

        fn get_latest_valuations(
            &self,
            _account_ids: &[String],
        ) -> Result<Vec<DailyAccountValuation>> {
            unimplemented!()
        }

        fn get_valuations_on_date(
            &self,
            _account_ids: &[String],
            _date: NaiveDate,
        ) -> Result<Vec<DailyAccountValuation>> {
            unimplemented!()
        }

        fn get_accounts_with_negative_balance(
            &self,
            _account_ids: &[String],
        ) -> Result<Vec<NegativeBalanceInfo>> {
            Ok(Vec::new())
        }
    }

    #[derive(Clone)]
    struct MockSnapshotService;

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
            Ok(Vec::new())
        }

        fn get_latest_holdings_snapshot(
            &self,
            _account_id: &str,
        ) -> Result<Option<AccountStateSnapshot>> {
            unimplemented!()
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

    fn create_daily_valuation(
        account_id: &str,
        date: &str,
        cash_balance: Decimal,
        investment_market_value: Decimal,
        total_value: Decimal,
        net_contribution: Decimal,
    ) -> DailyAccountValuation {
        DailyAccountValuation {
            id: format!("{}-{}", account_id, date),
            account_id: account_id.to_string(),
            valuation_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            account_currency: "USD".to_string(),
            base_currency: "USD".to_string(),
            fx_rate_to_base: Decimal::ONE,
            cash_balance,
            investment_market_value,
            total_value,
            cost_basis: net_contribution,
            book_basis: net_contribution,
            net_contribution,
            cash_balance_base: cash_balance,
            investment_market_value_base: investment_market_value,
            total_value_base: total_value,
            cost_basis_base: net_contribution,
            book_basis_base: net_contribution,
            net_contribution_base: net_contribution,
            external_inflow_base: Decimal::ZERO,
            external_outflow_base: Decimal::ZERO,
            external_flow_source: ExternalFlowSource::Unknown,
            performance_eligible_value_base: total_value,
            value_status: ValuationStatus::Complete,
            basis_status: if investment_market_value.is_zero() {
                BasisStatus::NotApplicable
            } else {
                BasisStatus::Complete
            },
            calculated_at: DateTime::<Utc>::from_timestamp(0, 0).unwrap(),
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
            tax: None,
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

    struct TransferActivitySeed<'a> {
        id: &'a str,
        account_id: &'a str,
        activity_type: &'a str,
        date: &'a str,
        amount: Option<Decimal>,
        currency: &'a str,
        asset_id: Option<&'a str>,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
    }

    fn create_transfer_activity(seed: TransferActivitySeed<'_>) -> Activity {
        Activity {
            id: seed.id.to_string(),
            account_id: seed.account_id.to_string(),
            asset_id: seed.asset_id.map(str::to_string),
            activity_type: seed.activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: parse_test_activity_datetime(seed.date),
            settlement_date: None,
            quantity: seed.quantity,
            unit_price: seed.unit_price,
            amount: seed.amount,
            fee: Some(dec!(0)),
            tax: None,
            currency: seed.currency.to_string(),
            fx_rate: None,
            notes: None,
            metadata: Some(json!({ "flow": { "is_external": true } })),
            source_system: Some("MANUAL".to_string()),
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

    fn create_cash_transfer_activity(
        id: &str,
        account_id: &str,
        activity_type: &str,
        date: &str,
        amount: Decimal,
        currency: &str,
    ) -> Activity {
        create_transfer_activity(TransferActivitySeed {
            id,
            account_id,
            activity_type,
            date,
            amount: Some(amount),
            currency,
            asset_id: None,
            quantity: None,
            unit_price: None,
        })
    }

    fn create_security_transfer_activity(
        id: &str,
        account_id: &str,
        activity_type: &str,
        date: &str,
        asset_id: &str,
        quantity: Decimal,
        unit_price: Decimal,
    ) -> Activity {
        create_transfer_activity(TransferActivitySeed {
            id,
            account_id,
            activity_type,
            date,
            amount: None,
            currency: "USD",
            asset_id: Some(asset_id),
            quantity: Some(quantity),
            unit_price: Some(unit_price),
        })
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
            tax: None,
            amount: Some(Some(dec!(100))),
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_create_security_transfer_does_not_create_manual_quote_from_cost_basis() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        let mut asset = create_test_asset_with_instrument(
            "asset-aapl",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        );
        asset.quote_mode = QuoteMode::Manual;
        asset_service.add_asset(asset);

        let quote_service = Arc::new(RecordingQuoteService::default());
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service.clone(),
        );

        let created = activity_service
            .create_activity(NewActivity {
                id: Some("transfer-1".to_string()),
                account_id: "acc-1".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("asset-aapl".to_string()),
                    ..Default::default()
                }),
                activity_type: "TRANSFER_IN".to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: Some(dec!(10)),
                unit_price: Some(dec!(8)),
                currency: "USD".to_string(),
                fee: Some(dec!(0)),
                tax: None,
                amount: Some(dec!(999)),
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
                import_run_id: None,
            })
            .await
            .expect("security transfer should be created");

        assert_eq!(created.amount, None);
        assert!(
            quote_service.updated_quotes().is_empty(),
            "transfer unit_price is book basis and must not be written as a quote"
        );
    }

    #[tokio::test]
    async fn test_update_price_bearing_activity_clears_stale_amount_when_account_changes() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-usd", "USD"));
        account_service.add_account(create_test_account("acc-cad", "CAD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "asset-aapl",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        ));

        let mut existing = create_stored_activity("activity-1", "acc-usd", Some("asset-aapl"));
        existing.amount = Some(dec!(100));
        existing.quantity = Some(dec!(1));
        existing.unit_price = Some(dec!(100));
        existing.currency = "USD".to_string();
        activity_repository
            .activities
            .lock()
            .unwrap()
            .push(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let updated = activity_service
            .update_activity(ActivityUpdate {
                id: "activity-1".to_string(),
                account_id: "acc-cad".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("asset-aapl".to_string()),
                    ..Default::default()
                }),
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: Some(Some(dec!(2))),
                unit_price: Some(Some(dec!(70))),
                currency: "CAD".to_string(),
                fee: Some(Some(dec!(0))),
                tax: None,
                amount: None,
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
            })
            .await
            .expect("update should succeed");

        assert_eq!(updated.account_id, "acc-cad");
        assert_eq!(updated.amount, None);
        assert_eq!(updated.quantity, Some(dec!(2)));
        assert_eq!(updated.unit_price, Some(dec!(70)));
    }

    #[tokio::test]
    async fn test_update_bond_price_bearing_activity_preserves_authoritative_amount() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-usd", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "asset-bond",
            "US912828ZT58",
            None,
            Some(InstrumentType::Bond),
            "USD",
        ));

        let mut existing = create_stored_activity("activity-1", "acc-usd", Some("asset-bond"));
        existing.amount = Some(dec!(990));
        existing.quantity = Some(dec!(1000));
        existing.unit_price = Some(dec!(99));
        activity_repository
            .activities
            .lock()
            .unwrap()
            .push(existing);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let updated = activity_service
            .update_activity(ActivityUpdate {
                id: "activity-1".to_string(),
                account_id: "acc-usd".to_string(),
                asset: Some(AssetResolutionInput {
                    id: Some("asset-bond".to_string()),
                    ..Default::default()
                }),
                activity_type: "BUY".to_string(),
                subtype: None,
                activity_date: "2024-01-15".to_string(),
                quantity: Some(Some(dec!(1000))),
                unit_price: Some(Some(dec!(98))),
                currency: "USD".to_string(),
                fee: Some(Some(dec!(0))),
                tax: None,
                amount: None,
                status: None,
                notes: None,
                fx_rate: None,
                metadata: None,
            })
            .await
            .expect("update should succeed");

        assert_eq!(updated.amount, Some(dec!(990)));
        assert_eq!(updated.quantity, Some(dec!(1000)));
        assert_eq!(updated.unit_price, Some(dec!(98)));
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
            tax: None,
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
            import_run_id: None,
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
        let event_sink = Arc::new(MockDomainEventSink::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        )
        .with_event_sink(event_sink.clone());

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
            tax: None,
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
            import_run_id: None,
        };

        let result = activity_service.create_activity(new_activity).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().amount, Some(dec!(2)));
        assert!(event_sink.events().iter().any(|event| matches!(
            event,
            DomainEvent::AssetSplitActivitiesChanged { asset_ids, .. }
                if asset_ids == &["AAPL".to_string()]
        )));
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

    #[tokio::test]
    async fn credit_card_accounts_reject_investment_activity_types() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut account = create_test_account("card-1", "USD");
        account.account_type = "CREDIT_CARD".to_string();
        account_service.add_account(account);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let new_activity = NewActivity {
            id: Some("activity-1".to_string()),
            account_id: "card-1".to_string(),
            asset: None,
            activity_type: "BUY".to_string(),
            subtype: None,
            activity_date: "2024-01-15".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
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
            import_run_id: None,
        };

        let err = activity_service
            .create_activity(new_activity)
            .await
            .expect_err("credit cards should reject investment activity types");

        assert!(err
            .to_string()
            .contains("BUY activities are not supported for credit card accounts"));
    }

    #[tokio::test]
    async fn credit_card_accounts_reject_investment_activity_updates() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut account = create_test_account("card-1", "USD");
        account.account_type = "CREDIT_CARD".to_string();
        account_service.add_account(account);
        asset_service.add_asset(create_test_asset("AAPL", "USD"));
        activity_repository.add_activity(create_stored_activity(
            "activity-1",
            "card-1",
            Some("AAPL"),
        ));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let update = create_test_activity_update(
            "activity-1",
            "card-1",
            Some(AssetResolutionInput {
                id: Some("AAPL".to_string()),
                ..Default::default()
            }),
            "USD",
        );

        let err = activity_service
            .update_activity(update)
            .await
            .expect_err("credit cards should reject investment activity updates");

        assert!(err
            .to_string()
            .contains("BUY activities are not supported for credit card accounts"));
    }

    #[tokio::test]
    async fn sync_prepare_marks_unsupported_credit_card_activity_as_review_draft() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut account = create_test_account("card-1", "USD");
        account.account_type = "CREDIT_CARD".to_string();
        account_service.add_account(account.clone());
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

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
                    id: Some("card-buy".to_string()),
                    account_id: "card-1".to_string(),
                    asset: Some(AssetResolutionInput {
                        id: Some("AAPL".to_string()),
                        ..Default::default()
                    }),
                    activity_type: "BUY".to_string(),
                    subtype: None,
                    activity_date: "2024-01-15".to_string(),
                    quantity: Some(dec!(1)),
                    unit_price: Some(dec!(100)),
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    tax: None,
                    amount: Some(dec!(100)),
                    status: Some(ActivityStatus::Posted),
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: Some(false),
                    source_system: Some("SNAPTRADE".to_string()),
                    source_record_id: Some("card-buy".to_string()),
                    source_group_id: None,
                    idempotency_key: None,
                    import_run_id: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should preserve unsupported card rows for review");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        let prepared = &result.prepared[0].activity;
        assert_eq!(prepared.needs_review, Some(true));
        assert_eq!(prepared.status, Some(ActivityStatus::Draft));
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
    async fn test_create_rejects_same_trade_with_different_tax() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset("AAPL", "USD"));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let taxable_activity = NewActivity {
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
            tax: Some(dec!(1)),
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
            import_run_id: None,
        };

        activity_service
            .create_activity(taxable_activity.clone())
            .await
            .expect("first create should succeed");

        let mut different_tax_activity = taxable_activity;
        different_tax_activity.tax = Some(dec!(2));
        let err = activity_service
            .create_activity(different_tax_activity)
            .await
            .expect_err("same trade with different tax should still be a duplicate");

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1);
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
            tax: None,
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
            import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
            })
            .await
            .expect("negative provider-style signs should normalize before validation");

        assert_eq!(activity.quantity, Some(dec!(0.25)));
        assert_eq!(activity.unit_price, Some(dec!(4000)));
        assert_eq!(activity.amount, Some(dec!(1000)));
    }

    #[tokio::test]
    async fn test_sync_prepare_canonicalizes_provider_position_subtype_label() {
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
                    tax: None,
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
                    import_run_id: None,
                }],
                &account,
            )
            .await
            .expect("sync preparation should canonicalize provider position subtype labels");

        assert!(result.errors.is_empty());
        assert_eq!(result.prepared.len(), 1);
        assert_eq!(
            result.prepared[0].activity.subtype.as_deref(),
            Some("POSITION_OPEN")
        );
    }

    #[tokio::test]
    async fn test_import_prepare_normalizes_minor_currency_tax() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "GBP");
        account_service.add_account(account.clone());
        asset_service.add_asset(create_test_asset("SEC:AZN:XLON", "GBp"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .prepare_activities_for_import(
                vec![NewActivity {
                    id: Some("gbp-tax-import".to_string()),
                    account_id: "acc-1".to_string(),
                    asset: Some(AssetResolutionInput {
                        id: Some("SEC:AZN:XLON".to_string()),
                        ..Default::default()
                    }),
                    activity_type: "BUY".to_string(),
                    subtype: None,
                    activity_date: "2024-01-15".to_string(),
                    quantity: Some(dec!(10)),
                    unit_price: Some(dec!(14082)),
                    currency: "GBp".to_string(),
                    fee: Some(dec!(999)),
                    tax: Some(dec!(150)),
                    amount: Some(dec!(140820)),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                    needs_review: None,
                    source_system: None,
                    source_record_id: None,
                    source_group_id: None,
                    idempotency_key: None,
                    import_run_id: None,
                }],
                &account,
            )
            .await
            .expect("import preparation should normalize minor currency values");

        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.prepared.len(), 1);

        let prepared = &result.prepared[0].activity;
        assert_eq!(prepared.currency, "GBP");
        assert_eq!(prepared.unit_price, Some(dec!(140.82)));
        assert_eq!(prepared.amount, Some(dec!(1408.20)));
        assert_eq!(prepared.fee, Some(dec!(9.99)));
        assert_eq!(prepared.tax, Some(dec!(1.50)));
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
                    tax: None,
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
                    import_run_id: None,
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
        assert_eq!(prepared.status, Some(ActivityStatus::Draft));
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
                    tax: None,
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
                    import_run_id: None,
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
        assert_eq!(prepared.activity.status, Some(ActivityStatus::Draft));
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
                    tax: None,
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
                    import_run_id: None,
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
                    tax: None,
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
                    import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
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
                tax: None,
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
                import_run_id: None,
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
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
    async fn test_check_import_uses_existing_asset_currency_when_import_currency_is_missing() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "kweb-uuid",
            "KWEB",
            Some("ARCX"),
            Some(InstrumentType::Equity),
            "USD",
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
            date: "2026-06-30".to_string(),
            symbol: "KWEB".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(28.50)),
            currency: String::new(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(285)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("ARCX".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let checked = &result[0];
        assert_eq!(checked.asset_id.as_deref(), Some("kweb-uuid"));
        assert_eq!(checked.currency, "USD");
        assert_eq!(checked.quote_ccy.as_deref(), Some("USD"));
    }

    #[tokio::test]
    async fn test_check_import_preserves_explicit_import_currency_for_existing_asset() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "CAD");
        account_service.add_account(account);

        let asset = create_test_asset_with_instrument(
            "kweb-uuid",
            "KWEB",
            Some("ARCX"),
            Some(InstrumentType::Equity),
            "USD",
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
            date: "2026-06-30".to_string(),
            symbol: "KWEB".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(28.50)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(285)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("ARCX".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let checked = &result[0];
        assert_eq!(checked.asset_id.as_deref(), Some("kweb-uuid"));
        assert_eq!(checked.currency, "CAD");
        assert_eq!(checked.quote_ccy.as_deref(), Some("USD"));
    }

    #[tokio::test]
    async fn test_check_import_uses_activity_currency_before_provider_quote_for_new_asset() {
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
            date: "2026-06-30".to_string(),
            symbol: "VOD.L".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(28.50)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(285)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let checked = &result[0];
        assert_eq!(checked.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(checked.currency, "USD");
        assert_eq!(checked.quote_ccy.as_deref(), Some("USD"));
        assert_eq!(
            checked
                .warnings
                .as_ref()
                .and_then(|warnings| warnings.get("_quote_ccy_fallback")),
            None
        );
    }

    #[tokio::test]
    async fn test_check_import_keeps_provider_quote_unit_when_activity_currency_is_major() {
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

        let import = ActivityImport {
            id: None,
            date: "2026-06-30".to_string(),
            symbol: "VOD.L".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(28.50)),
            currency: "GBP".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(285)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let checked = &result[0];
        assert_eq!(checked.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(checked.currency, "GBP");
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(
            checked
                .warnings
                .as_ref()
                .and_then(|warnings| warnings.get("_quote_ccy_fallback")),
            None
        );
    }

    #[tokio::test]
    async fn test_check_import_does_not_default_missing_currency_before_asset_resolution() {
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
            asset_service.clone(),
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2026-06-30".to_string(),
            symbol: "VOD.L".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(28.50)),
            currency: String::new(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(285)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let batches = asset_service
            .resolve_import_asset_input_batches
            .lock()
            .unwrap();
        assert_eq!(batches[0][0].activity_currency, None);

        let checked = &result[0];
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBp"));
        assert_eq!(checked.currency, "USD");
    }

    #[tokio::test]
    async fn test_check_import_does_not_resolve_reviewed_assets_again() {
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
            asset_service.clone(),
            fx_service,
            quote_service,
        );

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "ZFL".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("BMO Long Federal Bond Index ETF".to_string()),
            exchange_mic: Some("XTSE".to_string()),
            quote_ccy: Some("CAD".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: Some("YAHOO".to_string()),
            provider_symbol: Some("ZFL.TO".to_string()),
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: true,
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
        assert!(checked.is_valid);
        assert_eq!(checked.symbol.as_str(), "ZFL");
        assert_eq!(
            checked.symbol_name.as_deref(),
            Some("BMO Long Federal Bond Index ETF")
        );
        assert_eq!(checked.exchange_mic.as_deref(), Some("XTSE"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("CAD"));
        assert_eq!(checked.instrument_type.as_deref(), Some("EQUITY"));
        assert_eq!(
            asset_service.resolve_import_asset_call_count(),
            0,
            "reviewed assets should not go back through import asset resolution"
        );
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
                tax: None,
                amount: Some(dec!(100)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: None,
                exchange_mic: None,
                quote_ccy: None,
                instrument_type: None,
                quote_mode: None,
                provider_id: None,
                provider_symbol: None,
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
                tax: None,
                amount: Some(dec!(100)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: None,
                exchange_mic: None,
                quote_ccy: None,
                instrument_type: None,
                quote_mode: None,
                provider_id: None,
                provider_symbol: None,
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
    async fn test_check_import_keeps_same_symbol_rows_distinct_by_explicit_mic() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        asset_service.add_asset(create_test_asset_with_instrument(
            "shop-nyse",
            "SHOP",
            Some("XNYS"),
            Some(InstrumentType::Equity),
            "USD",
        ));
        asset_service.add_asset(create_test_asset_with_instrument(
            "shop-tsx",
            "SHOP",
            Some("XTSE"),
            Some(InstrumentType::Equity),
            "CAD",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let nyse = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "SHOP".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XNYS".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
        let mut tsx = nyse.clone();
        tsx.exchange_mic = Some("XTSE".to_string());
        tsx.line_number = Some(2);

        let result = activity_service
            .check_activities_import(vec![nyse, tsx])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].asset_id.as_deref(), Some("shop-nyse"));
        assert_eq!(result[0].exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(result[1].asset_id.as_deref(), Some("shop-tsx"));
        assert_eq!(result[1].exchange_mic.as_deref(), Some("XTSE"));
    }

    #[tokio::test]
    async fn test_check_import_keeps_same_symbol_rows_distinct_by_provider_refs() {
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
            asset_service.clone(),
            fx_service,
            quote_service,
        );

        let first = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "XAU".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(1)),
            unit_price: Some(dec!(100)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: Some("METAL_PRICE_API".to_string()),
            provider_symbol: Some("XAU-1KG".to_string()),
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
        let mut second = first.clone();
        second.provider_symbol = Some("XAU-OZ".to_string());
        second.line_number = Some(2);

        let result = activity_service
            .check_activities_import(vec![first, second])
            .await
            .expect("import check should succeed");

        assert_eq!(result.len(), 2);

        let batches = asset_service
            .resolve_import_asset_input_batches
            .lock()
            .unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 2);
        assert_ne!(
            batches[0][0].key, batches[0][1].key,
            "provider refs must be part of the import asset resolution cache key"
        );
        assert_eq!(batches[0][0].provider_symbol.as_deref(), Some("XAU-1KG"));
        assert_eq!(batches[0][1].provider_symbol.as_deref(), Some("XAU-OZ"));
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
                    provider_id: None,
                    provider_symbol: None,
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
                    provider_id: None,
                    provider_symbol: None,
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
    async fn test_preview_import_assets_returns_backend_review_symbol_for_suffix_mic() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "EUR");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            quote_service,
        );

        let preview = activity_service
            .preview_import_assets(vec![ImportAssetCandidate {
                key: "msf-xetr".to_string(),
                account_id: "acc-1".to_string(),
                symbol: "MSF.DE".to_string(),
                currency: Some("EUR".to_string()),
                instrument_type: None,
                quote_ccy: None,
                quote_mode: None,
                exchange_mic: None,
                isin: None,
                provider_id: None,
                provider_symbol: None,
            }])
            .await
            .expect("preview should succeed");

        assert_eq!(preview.len(), 1);
        assert_eq!(
            preview[0].status,
            ImportAssetPreviewStatus::AutoResolvedNewAsset
        );
        assert_eq!(preview[0].review_symbol.as_deref(), Some("MSF.DE"));

        let draft = preview[0].draft.as_ref().expect("draft should be returned");
        assert_eq!(draft.display_code.as_deref(), Some("MSF"));
        assert_eq!(draft.instrument_symbol.as_deref(), Some("MSF"));
        assert_eq!(draft.instrument_exchange_mic.as_deref(), Some("XETR"));
    }

    #[tokio::test]
    async fn test_preview_import_assets_preserves_provider_refs() {
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
            asset_service.clone(),
            fx_service,
            quote_service,
        );

        activity_service
            .preview_import_assets(vec![ImportAssetCandidate {
                key: "custom-provider".to_string(),
                account_id: "acc-1".to_string(),
                symbol: "XAU".to_string(),
                currency: Some("USD".to_string()),
                instrument_type: Some("EQUITY".to_string()),
                quote_ccy: Some("USD".to_string()),
                quote_mode: Some("MARKET".to_string()),
                exchange_mic: None,
                isin: None,
                provider_id: Some("METAL_PRICE_API".to_string()),
                provider_symbol: Some("XAU-1KG".to_string()),
            }])
            .await
            .expect("preview should succeed");

        let batches = asset_service
            .resolve_import_asset_input_batches
            .lock()
            .unwrap();
        let input = &batches[0][0];
        assert_eq!(input.provider_id.as_deref(), Some("METAL_PRICE_API"));
        assert_eq!(input.provider_symbol.as_deref(), Some("XAU-1KG"));
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
            currency: String::new(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
    async fn test_check_import_prefers_symbol_suffix_over_provider_search_exchange() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let account = create_test_account("acc-1", "EUR");
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
            symbol: "MSF.DE".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(120)),
            currency: "EUR".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
        assert_eq!(checked.symbol, "MSF");
        assert_eq!(checked.exchange_mic.as_deref(), Some("XETR"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("EUR"));
    }

    #[tokio::test]
    async fn test_check_import_uses_asset_resolution_quote_ccy() {
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

        let import = ActivityImport {
            id: None,
            date: "2024-01-15".to_string(),
            symbol: "VOD.L".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(10)),
            unit_price: Some(dec!(70)),
            currency: "GBp".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(700)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

        let checked = &result[0];
        assert_eq!(checked.symbol, "VOD");
        assert_eq!(checked.exchange_mic.as_deref(), Some("XLON"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("GBp"));
        assert!(
            checked
                .warnings
                .as_ref()
                .and_then(|w| w.get("_quote_ccy_fallback"))
                .is_none(),
            "resolved provider quote currency should not be reported as a MIC fallback"
        );
    }

    #[tokio::test]
    async fn test_check_import_preserves_share_class_dot_with_provider_result() {
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
            symbol: "BRK.B".to_string(),
            activity_type: "BUY".to_string(),
            quantity: Some(dec!(3)),
            unit_price: Some(dec!(440)),
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(1320)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
        assert_eq!(checked.symbol, "BRK.B");
        assert_eq!(
            checked.symbol_name.as_deref(),
            Some("Berkshire Hathaway Inc.")
        );
        assert_eq!(checked.exchange_mic.as_deref(), Some("XNYS"));
        assert_eq!(checked.quote_ccy.as_deref(), Some("USD"));
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
            tax: None,
            amount: Some(dec!(1200)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
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
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
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
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(65000)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: Some("XTSE".to_string()),
            quote_ccy: None,
            instrument_type: Some("CRYPTO".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(1000)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Ethereum".to_string()),
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Apple".to_string()),
            exchange_mic: Some("XNAS".to_string()),
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("AAPL Dec 2025 200 Call".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            .expect("import should canonicalize provider position subtype labels");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 1);
        assert_eq!(
            result.activities[0].subtype.as_deref(),
            Some("POSITION_OPEN")
        );
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
            tax: None,
            amount: Some(dec!(42)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(42)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
    async fn test_imported_transactions_feed_scoped_valuation_and_performance_flows() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-1", "USD"));
        asset_service.add_asset(create_test_asset_with_instrument(
            "asset-aapl",
            "AAPL",
            Some("XNAS"),
            Some(InstrumentType::Equity),
            "USD",
        ));

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service.clone(),
            fx_service.clone(),
            quote_service.clone(),
        );

        let checked = activity_service
            .check_activities_import(vec![
                ActivityImport {
                    id: None,
                    date: "2026-05-02".to_string(),
                    symbol: String::new(),
                    activity_type: "DEPOSIT".to_string(),
                    quantity: None,
                    unit_price: None,
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    tax: None,
                    amount: Some(dec!(1000)),
                    comment: Some("Funding".to_string()),
                    account_id: Some("acc-1".to_string()),
                    account_name: None,
                    symbol_name: None,
                    exchange_mic: None,
                    quote_ccy: None,
                    instrument_type: None,
                    quote_mode: None,
                    provider_id: None,
                    provider_symbol: None,
                    errors: None,
                    warnings: None,
                    duplicate_of_id: None,
                    duplicate_of_line_number: None,
                    is_draft: false,
                    is_valid: false,
                    line_number: Some(1),
                    fx_rate: None,
                    subtype: None,
                    asset_id: None,
                    isin: None,
                    force_import: false,
                    is_external: None,
                },
                ActivityImport {
                    id: None,
                    date: "2026-05-03".to_string(),
                    symbol: "AAPL".to_string(),
                    activity_type: "BUY".to_string(),
                    quantity: Some(dec!(10)),
                    unit_price: Some(dec!(100)),
                    currency: "USD".to_string(),
                    fee: Some(dec!(0)),
                    tax: None,
                    amount: Some(dec!(1000)),
                    comment: Some("Buy AAPL".to_string()),
                    account_id: Some("acc-1".to_string()),
                    account_name: None,
                    symbol_name: None,
                    exchange_mic: None,
                    quote_ccy: None,
                    instrument_type: None,
                    quote_mode: None,
                    provider_id: None,
                    provider_symbol: None,
                    errors: None,
                    warnings: None,
                    duplicate_of_id: None,
                    duplicate_of_line_number: None,
                    is_draft: false,
                    is_valid: false,
                    line_number: Some(2),
                    fx_rate: None,
                    subtype: None,
                    asset_id: None,
                    isin: None,
                    force_import: false,
                    is_external: None,
                },
            ])
            .await
            .expect("import check should resolve activities");

        assert_eq!(asset_service.resolve_import_asset_call_count(), 1);
        assert!(checked.iter().all(|activity| activity.is_valid));
        let checked_buy = checked
            .iter()
            .find(|activity| activity.activity_type == "BUY")
            .expect("checked buy row should exist");
        assert_eq!(checked_buy.asset_id.as_deref(), Some("asset-aapl"));
        assert_eq!(checked_buy.quote_ccy.as_deref(), Some("USD"));

        let import_result = activity_service
            .import_activities(checked)
            .await
            .expect("resolved import should persist");
        assert!(import_result.summary.success);
        assert_eq!(import_result.summary.imported, 2);

        let stored = activity_repository
            .get_activities()
            .expect("imported activities should be stored");
        assert_eq!(stored.len(), 2);
        let imported_buy = stored
            .iter()
            .find(|activity| activity.activity_type == "BUY")
            .expect("stored buy row should exist");
        assert_eq!(imported_buy.asset_id.as_deref(), Some("asset-aapl"));

        let valuation_repository = Arc::new(MockValuationRepository::new(vec![
            create_daily_valuation(
                "acc-1",
                "2026-05-01",
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
                Decimal::ZERO,
            ),
            create_daily_valuation(
                "acc-1",
                "2026-05-02",
                dec!(1000),
                Decimal::ZERO,
                dec!(1000),
                dec!(1000),
            ),
            create_daily_valuation(
                "acc-1",
                "2026-05-03",
                Decimal::ZERO,
                dec!(1100),
                dec!(1100),
                dec!(1000),
            ),
        ]));
        let timezone = Arc::new(RwLock::new("UTC".to_string()));
        let valuation_service = Arc::new(
            ValuationService::new(
                Arc::new(RwLock::new("USD".to_string())),
                valuation_repository,
                Arc::new(MockSnapshotService),
                quote_service.clone(),
                fx_service,
            )
            .with_activity_repository(activity_repository, timezone),
        );

        let account_ids = vec!["acc-1".to_string()];
        let start_date = NaiveDate::parse_from_str("2026-05-01", "%Y-%m-%d").unwrap();
        let end_date = NaiveDate::parse_from_str("2026-05-03", "%Y-%m-%d").unwrap();
        let scoped_valuations = valuation_service
            .get_historical_valuations_for_accounts(
                "scope:acc-1",
                &account_ids,
                "USD",
                Some(start_date),
                Some(end_date),
            )
            .expect("scoped valuation should aggregate imported flows");

        assert_eq!(scoped_valuations.len(), 3);
        assert_eq!(scoped_valuations[1].external_inflow_base, dec!(1000));
        assert_eq!(scoped_valuations[1].external_outflow_base, Decimal::ZERO);
        assert_eq!(scoped_valuations[2].external_inflow_base, Decimal::ZERO);
        assert_eq!(scoped_valuations[2].external_outflow_base, Decimal::ZERO);

        let performance_service = PerformanceService::new(valuation_service, quote_service);
        let account_tracking_modes = HashMap::new();
        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:acc-1",
                &account_ids,
                "USD",
                &account_tracking_modes,
                &HashMap::new(),
                Some(start_date),
                Some(end_date),
            )
            .await
            .expect("performance should use imported activity flows");

        assert_eq!(performance.returns.twr, Some(dec!(0.1)));
        assert_eq!(performance.attribution.unrealized_pnl_change, dec!(100));
        assert_eq!(performance.series.last().unwrap().value, dec!(0.1));
    }

    #[tokio::test]
    async fn test_scoped_cross_currency_transfer_delta_is_fx_attribution() {
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut transfer_out = create_stored_activity("transfer-out", "acc-usd", None);
        transfer_out.activity_type = "TRANSFER_OUT".to_string();
        transfer_out.activity_date = parse_test_activity_datetime("2026-05-02");
        transfer_out.amount = Some(dec!(100));
        transfer_out.currency = "USD".to_string();
        transfer_out.source_group_id = Some("transfer-group".to_string());

        let mut transfer_in = create_stored_activity("transfer-in", "acc-eur", None);
        transfer_in.activity_type = "TRANSFER_IN".to_string();
        transfer_in.activity_date = parse_test_activity_datetime("2026-05-02");
        transfer_in.amount = Some(dec!(98));
        transfer_in.currency = "EUR".to_string();
        transfer_in.source_group_id = Some("transfer-group".to_string());

        activity_repository.add_activity(transfer_out);
        activity_repository.add_activity(transfer_in);

        let mut usd_start = create_daily_valuation(
            "acc-usd",
            "2026-05-01",
            dec!(100),
            Decimal::ZERO,
            dec!(100),
            dec!(100),
        );
        let mut usd_end = create_daily_valuation(
            "acc-usd",
            "2026-05-02",
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
        );
        usd_end.external_outflow_base = dec!(100);
        usd_end.external_flow_source = ExternalFlowSource::ActivityDerived;

        let mut eur_start = create_daily_valuation(
            "acc-eur",
            "2026-05-01",
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
            Decimal::ZERO,
        );
        let mut eur_end = create_daily_valuation(
            "acc-eur",
            "2026-05-02",
            dec!(98),
            Decimal::ZERO,
            dec!(98),
            dec!(98),
        );
        eur_end.account_currency = "EUR".to_string();
        eur_end.base_currency = "USD".to_string();
        eur_end.external_inflow_base = dec!(98);
        eur_end.external_flow_source = ExternalFlowSource::ActivityDerived;

        usd_start.external_flow_source = ExternalFlowSource::ActivityDerived;
        for valuation in [&mut usd_start, &mut usd_end, &mut eur_start, &mut eur_end] {
            valuation.cost_basis = Decimal::ZERO;
            valuation.cost_basis_base = Decimal::ZERO;
        }
        let valuation_repository = Arc::new(MockValuationRepository::new(vec![
            usd_start, usd_end, eur_start, eur_end,
        ]));
        let quote_service = Arc::new(MockQuoteService);
        let timezone = Arc::new(RwLock::new("UTC".to_string()));
        let valuation_service = Arc::new(
            ValuationService::new(
                Arc::new(RwLock::new("USD".to_string())),
                valuation_repository,
                Arc::new(MockSnapshotService),
                quote_service.clone(),
                fx_service.clone(),
            )
            .with_activity_repository(activity_repository.clone(), timezone),
        );

        let account_ids = vec!["acc-usd".to_string(), "acc-eur".to_string()];
        let start_date = NaiveDate::parse_from_str("2026-05-01", "%Y-%m-%d").unwrap();
        let end_date = NaiveDate::parse_from_str("2026-05-02", "%Y-%m-%d").unwrap();
        let scoped_valuations = valuation_service
            .get_historical_valuations_for_accounts(
                "scope:transfer",
                &account_ids,
                "USD",
                Some(start_date),
                Some(end_date),
            )
            .expect("scoped valuation should remove internal transfer flows");

        assert_eq!(scoped_valuations[1].external_inflow_base, Decimal::ZERO);
        assert_eq!(scoped_valuations[1].external_outflow_base, Decimal::ZERO);

        let performance_service = PerformanceService::new(valuation_service, quote_service)
            .with_activity_repository(activity_repository, fx_service);
        let performance = performance_service
            .calculate_performance_history_for_accounts(
                "scope:transfer",
                &account_ids,
                "USD",
                &HashMap::new(),
                &HashMap::new(),
                Some(start_date),
                Some(end_date),
            )
            .await
            .expect("performance should attribute transfer FX delta");

        assert_eq!(performance.attribution.contributions, Decimal::ZERO);
        assert_eq!(performance.attribution.distributions, Decimal::ZERO);
        assert_eq!(performance.attribution.fx_effect, dec!(-2));
        assert_eq!(performance.attribution.residual, Decimal::ZERO);
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: None,
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MANUAL".to_string()),
            provider_id: None,
            provider_symbol: None,
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
    async fn test_import_prepare_date_errors_are_keyed_under_activity_date_field() {
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
            tax: None,
            amount: Some(dec!(132)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World UCITS ETF".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
        assert!(errors.contains_key("activityDate"));
        assert!(!errors.contains_key("symbol"));
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
            tax: None,
            amount: Some(dec!(500)),
            comment: Some("Cash top up".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
    async fn test_import_stamps_inserted_activities_with_import_run_id() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());
        let import_run_repository = Arc::new(MockImportRunRepository::default());

        let account = create_test_account("acc-1", "USD");
        account_service.add_account(account);

        let quote_service = Arc::new(MockQuoteService);
        let activity_service = ActivityService::with_import_run_repository(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
            import_run_repository.clone(),
        );

        let activity = ActivityImport {
            id: None,
            date: "2026-01-07".to_string(),
            symbol: String::new(),
            activity_type: "DEPOSIT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            .import_activities(vec![activity])
            .await
            .expect("cash import should succeed");

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].import_run_id.as_deref(),
            Some(result.import_run_id.as_str())
        );

        let import_run = import_run_repository
            .get_by_id(&result.import_run_id)
            .expect("import run lookup should succeed")
            .expect("import run should be stored");
        assert_eq!(import_run.status, ImportRunStatus::Applied);
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
            tax: None,
            amount: Some(dec!(500)),
            comment: Some("Internal transfer out".to_string()),
            account_id: Some("acc-2".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: Some("Internal transfer in".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
    async fn test_import_does_not_auto_link_same_account_same_currency_transfer_pairs() {
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
    async fn test_import_auto_links_same_account_cash_fx_transfer_pairs() {
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

        let transfer_in = ActivityImport {
            id: None,
            date: "2026-01-07".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_IN".to_string(),
            quantity: None,
            unit_price: None,
            currency: "CAD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(32.93)),
            comment: Some("FxExchange".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(1),
            fx_rate: None,
            subtype: Some("FXEXCHANGE".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(false),
        };

        let transfer_out = ActivityImport {
            id: None,
            date: "2026-01-07".to_string(),
            symbol: String::new(),
            activity_type: "TRANSFER_OUT".to_string(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(dec!(24.33)),
            comment: Some("FxExchange".to_string()),
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: Some(2),
            fx_rate: None,
            subtype: Some("FXEXCHANGE".to_string()),
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(false),
        };

        let result = activity_service
            .import_activities(vec![transfer_in, transfer_out])
            .await
            .expect("same-account FX import should succeed");

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

        assert!(transfer_out_stored.source_group_id.is_some());
        assert_eq!(
            transfer_out_stored.source_group_id,
            transfer_in_stored.source_group_id
        );
        assert!(transfer_in_stored.fx_rate.is_none());
        assert!(transfer_out_stored.fx_rate.is_none());

        for activity in [transfer_in_stored, transfer_out_stored] {
            let metadata = activity
                .metadata
                .as_ref()
                .expect("linked FX transfer should have metadata");
            assert_eq!(
                metadata
                    .get("flow")
                    .and_then(|flow| flow.get("is_external"))
                    .and_then(|value| value.as_bool()),
                Some(false)
            );
            let fx = metadata.get("fx").expect("FX metadata should be present");
            assert_eq!(
                fx.get("sourceCurrency").and_then(|v| v.as_str()),
                Some("USD")
            );
            assert_eq!(
                fx.get("destinationCurrency").and_then(|v| v.as_str()),
                Some("CAD")
            );
            assert_eq!(
                fx.get("sourceAmount").and_then(|v| v.as_str()),
                Some("24.33")
            );
            assert_eq!(
                fx.get("destinationAmount").and_then(|v| v.as_str()),
                Some("32.93")
            );
            assert_eq!(
                fx.get("rateSource").and_then(|v| v.as_str()),
                Some("implied_from_import")
            );
            assert!(fx.get("impliedRate").and_then(|v| v.as_str()).is_some());
        }
    }

    #[tokio::test]
    async fn test_import_does_not_auto_link_same_account_cash_fx_without_fx_provenance() {
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

        let cash_transfer = |activity_type: &str, currency: &str, amount: Decimal| ActivityImport {
            id: None,
            date: "2026-01-07".to_string(),
            symbol: String::new(),
            activity_type: activity_type.to_string(),
            quantity: None,
            unit_price: None,
            currency: currency.to_string(),
            fee: Some(dec!(0)),
            tax: None,
            amount: Some(amount),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
            errors: None,
            warnings: None,
            duplicate_of_id: None,
            duplicate_of_line_number: None,
            is_draft: false,
            is_valid: true,
            line_number: None,
            fx_rate: None,
            subtype: None,
            asset_id: None,
            isin: None,
            force_import: false,
            is_external: Some(false),
        };

        let result = activity_service
            .import_activities(vec![
                cash_transfer("TRANSFER_IN", "CAD", dec!(32.93)),
                cash_transfer("TRANSFER_OUT", "USD", dec!(24.33)),
            ])
            .await
            .expect("same-account cash transfer import should succeed");

        assert!(result.summary.success);
        assert_eq!(result.summary.imported, 2);

        let stored = activity_repository
            .get_activities()
            .expect("stored activities should be readable");
        assert_eq!(stored.len(), 2);
        for activity in stored {
            assert!(
                activity.source_group_id.is_none(),
                "same-account different-currency cash transfers without FX provenance should not be auto-linked"
            );
            assert!(
                activity.metadata.is_none(),
                "unlinked internal rows should not gain generated FX metadata"
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
            None,
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
                tax: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: None,
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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

    #[test]
    fn find_transfer_match_candidates_returns_cash_matches_only() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        activity_repository.add_activity(create_cash_transfer_activity(
            "source-out",
            "acc-a",
            "TRANSFER_OUT",
            "2024-01-15T00:00:00Z",
            dec!(100),
            "USD",
        ));
        activity_repository.add_activity(create_cash_transfer_activity(
            "cash-match",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-17T00:00:00Z",
            dec!(100),
            "USD",
        ));
        activity_repository.add_activity(create_cash_transfer_activity(
            "wrong-amount",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-17T00:00:00Z",
            dec!(101),
            "USD",
        ));
        activity_repository.add_activity(create_cash_transfer_activity(
            "same-account",
            "acc-a",
            "TRANSFER_IN",
            "2024-01-17T00:00:00Z",
            dec!(100),
            "USD",
        ));
        activity_repository.add_activity(create_cash_transfer_activity(
            "same-account-fx",
            "acc-a",
            "TRANSFER_IN",
            "2024-01-17T00:00:00Z",
            dec!(135),
            "CAD",
        ));
        let mut linked = create_cash_transfer_activity(
            "already-linked",
            "acc-c",
            "TRANSFER_IN",
            "2024-01-17T00:00:00Z",
            dec!(100),
            "USD",
        );
        linked.source_group_id = Some("group-1".to_string());
        activity_repository.add_activity(linked);
        let mut linked_counterpart = create_cash_transfer_activity(
            "already-linked-out",
            "acc-d",
            "TRANSFER_OUT",
            "2024-01-17T00:00:00Z",
            dec!(100),
            "USD",
        );
        linked_counterpart.source_group_id = Some("group-1".to_string());
        activity_repository.add_activity(linked_counterpart);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let candidates = activity_service
            .find_transfer_match_candidates(TransferMatchCandidateRequest {
                activity_id: "source-out".to_string(),
                window_days: Some(7),
                limit: Some(25),
            })
            .expect("candidate search should succeed");

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.activity.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cash-match", "same-account-fx"]
        );
        let cash_match = candidates
            .iter()
            .find(|candidate| candidate.activity.id == "cash-match")
            .expect("cross-account cash candidate");
        assert_eq!(cash_match.match_kind, "cash");
        assert!(cash_match
            .warnings
            .iter()
            .any(|warning| warning.contains("Dates differ")));

        let fx_match = candidates
            .iter()
            .find(|candidate| candidate.activity.id == "same-account-fx")
            .expect("same-account FX candidate");
        assert_eq!(fx_match.match_kind, "cash_fx_conversion");
        assert!(fx_match
            .reasons
            .iter()
            .any(|reason| reason == "Cash FX conversion"));
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.activity.id == "same-account"));
    }

    #[test]
    fn find_transfer_match_candidates_allows_orphan_source_group() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut source = create_cash_transfer_activity(
            "source-out",
            "acc-a",
            "TRANSFER_OUT",
            "2024-01-15T00:00:00Z",
            dec!(100),
            "USD",
        );
        source.source_group_id = Some("orphan-group".to_string());
        activity_repository.add_activity(source);
        activity_repository.add_activity(create_cash_transfer_activity(
            "cash-match",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-15T00:00:00Z",
            dec!(100),
            "USD",
        ));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let candidates = activity_service
            .find_transfer_match_candidates(TransferMatchCandidateRequest {
                activity_id: "source-out".to_string(),
                window_days: Some(7),
                limit: Some(25),
            })
            .expect("candidate search should succeed");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].activity.id, "cash-match");
    }

    #[test]
    fn find_transfer_match_candidates_matches_security_by_asset_and_quantity() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        activity_repository.add_activity(create_security_transfer_activity(
            "security-out",
            "acc-a",
            "TRANSFER_OUT",
            "2024-01-15T00:00:00Z",
            "SEC:AAPL:XNAS",
            dec!(10),
            dec!(150),
        ));
        activity_repository.add_activity(create_security_transfer_activity(
            "security-match",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-15T00:00:00Z",
            "SEC:AAPL:XNAS",
            dec!(10),
            dec!(153),
        ));
        activity_repository.add_activity(create_security_transfer_activity(
            "same-account-security",
            "acc-a",
            "TRANSFER_IN",
            "2024-01-15T00:00:00Z",
            "SEC:AAPL:XNAS",
            dec!(10),
            dec!(150),
        ));
        activity_repository.add_activity(create_security_transfer_activity(
            "wrong-quantity",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-15T00:00:00Z",
            "SEC:AAPL:XNAS",
            dec!(9),
            dec!(150),
        ));
        activity_repository.add_activity(create_security_transfer_activity(
            "wrong-asset",
            "acc-b",
            "TRANSFER_IN",
            "2024-01-15T00:00:00Z",
            "SEC:MSFT:XNAS",
            dec!(10),
            dec!(150),
        ));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let candidates = activity_service
            .find_transfer_match_candidates(TransferMatchCandidateRequest {
                activity_id: "security-out".to_string(),
                window_days: Some(7),
                limit: Some(25),
            })
            .expect("candidate search should succeed");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].activity.id, "security-match");
        assert_eq!(candidates[0].match_kind, "security");
        assert!(candidates[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("Prices differ")));
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
                tax: None,
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
                tax: None,
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
    async fn save_internal_transfer_pair_creates_cross_currency_legs() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-twd", "TWD"));
        account_service.add_account(create_test_account("acc-usd", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .save_internal_transfer_pair(InternalTransferPairRequest {
                transfer_out_id: None,
                transfer_in_id: None,
                source_group_id: None,
                from_account_id: "acc-twd".to_string(),
                to_account_id: "acc-usd".to_string(),
                activity_date: "2026-06-03T20:20:00Z".to_string(),
                source_amount: Some(dec!(1000)),
                destination_amount: Some(dec!(31.20)),
                source_currency: "TWD".to_string(),
                destination_currency: "USD".to_string(),
                fx_rate: Some(dec!(0.0312)),
                notes: Some("Move cash".to_string()),
                transfer_mode: Some("cash".to_string()),
            })
            .await
            .expect("pair create should succeed");

        assert_eq!(result.transfer_out.account_id, "acc-twd");
        assert_eq!(result.transfer_out.currency, "TWD");
        assert_eq!(result.transfer_out.amount, Some(dec!(1000)));
        assert_eq!(result.transfer_in.account_id, "acc-usd");
        assert_eq!(result.transfer_in.currency, "USD");
        assert_eq!(result.transfer_in.amount, Some(dec!(31.20)));
        assert_eq!(result.transfer_in.fx_rate, Some(dec!(0.0312)));
        assert_eq!(
            result.transfer_out.source_group_id,
            result.transfer_in.source_group_id
        );
        assert_eq!(
            result
                .transfer_out
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("flow"))
                .and_then(|flow| flow.get("is_external"))
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[tokio::test]
    async fn save_internal_transfer_pair_same_currency_uses_source_amount() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-from", "USD"));
        account_service.add_account(create_test_account("acc-to", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .save_internal_transfer_pair(InternalTransferPairRequest {
                transfer_out_id: None,
                transfer_in_id: None,
                source_group_id: None,
                from_account_id: "acc-from".to_string(),
                to_account_id: "acc-to".to_string(),
                activity_date: "2026-06-03T20:20:00Z".to_string(),
                source_amount: Some(dec!(100)),
                destination_amount: Some(dec!(90)),
                source_currency: "USD".to_string(),
                destination_currency: "USD".to_string(),
                fx_rate: Some(dec!(0.9)),
                notes: None,
                transfer_mode: Some("cash".to_string()),
            })
            .await
            .expect("pair create should succeed");

        assert_eq!(result.transfer_out.amount, Some(dec!(100)));
        assert_eq!(result.transfer_in.amount, Some(dec!(100)));
        assert_eq!(result.transfer_in.fx_rate, None);
    }

    #[tokio::test]
    async fn save_internal_transfer_pair_update_preserves_leg_currencies() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-twd", "TWD"));
        account_service.add_account(create_test_account("acc-usd", "USD"));

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let created = activity_service
            .save_internal_transfer_pair(InternalTransferPairRequest {
                transfer_out_id: None,
                transfer_in_id: None,
                source_group_id: None,
                from_account_id: "acc-twd".to_string(),
                to_account_id: "acc-usd".to_string(),
                activity_date: "2026-06-03T20:20:00Z".to_string(),
                source_amount: Some(dec!(1000)),
                destination_amount: Some(dec!(31.20)),
                source_currency: "TWD".to_string(),
                destination_currency: "USD".to_string(),
                fx_rate: Some(dec!(0.0312)),
                notes: None,
                transfer_mode: Some("cash".to_string()),
            })
            .await
            .expect("pair create should succeed");

        let updated = activity_service
            .save_internal_transfer_pair(InternalTransferPairRequest {
                transfer_out_id: Some(created.transfer_out.id.clone()),
                transfer_in_id: Some(created.transfer_in.id.clone()),
                source_group_id: None,
                from_account_id: "acc-twd".to_string(),
                to_account_id: "acc-usd".to_string(),
                activity_date: "2026-06-04T20:20:00Z".to_string(),
                source_amount: Some(dec!(2000)),
                destination_amount: Some(dec!(62.40)),
                source_currency: "TWD".to_string(),
                destination_currency: "USD".to_string(),
                fx_rate: Some(dec!(0.0312)),
                notes: Some("Updated".to_string()),
                transfer_mode: Some("cash".to_string()),
            })
            .await
            .expect("pair update should succeed");

        assert_eq!(updated.transfer_out.currency, "TWD");
        assert_eq!(updated.transfer_out.amount, Some(dec!(2000)));
        assert_eq!(updated.transfer_in.currency, "USD");
        assert_eq!(updated.transfer_in.amount, Some(dec!(62.40)));
    }

    #[tokio::test]
    async fn delete_internal_transfer_pair_deletes_both_legs_and_emits_both_accounts() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());
        let event_sink = Arc::new(MockDomainEventSink::new());

        let mut transfer_out = create_stored_activity("transfer-out", "acc-out", None);
        transfer_out.activity_type = "TRANSFER_OUT".to_string();
        transfer_out.source_group_id = Some("transfer-group".to_string());
        transfer_out.metadata = Some(json!({ "flow": { "is_external": false } }));
        transfer_out.currency = "USD".to_string();
        let mut transfer_in = create_stored_activity("transfer-in", "acc-in", None);
        transfer_in.activity_type = "TRANSFER_IN".to_string();
        transfer_in.source_group_id = Some("transfer-group".to_string());
        transfer_in.metadata = Some(json!({ "flow": { "is_external": false } }));
        transfer_in.currency = "CAD".to_string();
        activity_repository.add_activity(transfer_out);
        activity_repository.add_activity(transfer_in);

        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        )
        .with_event_sink(event_sink.clone());

        let deleted = activity_service
            .delete_activity("transfer-out".to_string())
            .await
            .expect("delete should cascade");

        assert_eq!(deleted.id, "transfer-out");
        assert!(activity_repository.get_activities().unwrap().is_empty());
        let events = event_sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            DomainEvent::ActivitiesChanged {
                account_ids,
                currencies,
                ..
            } => {
                let mut account_ids = account_ids.clone();
                account_ids.sort();
                assert_eq!(account_ids, vec!["acc-in", "acc-out"]);
                let mut currencies = currencies.clone();
                currencies.sort();
                assert_eq!(currencies, vec!["CAD", "USD"]);
            }
            event => panic!("expected ActivitiesChanged event, got {event:?}"),
        }
    }

    #[tokio::test]
    async fn delete_group_with_extra_non_transfer_row_does_not_cascade() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut transfer_out = create_stored_activity("transfer-out", "acc-out", None);
        transfer_out.activity_type = "TRANSFER_OUT".to_string();
        transfer_out.source_group_id = Some("provider-group".to_string());
        transfer_out.metadata = Some(json!({ "flow": { "is_external": false } }));
        let mut transfer_in = create_stored_activity("transfer-in", "acc-in", None);
        transfer_in.activity_type = "TRANSFER_IN".to_string();
        transfer_in.source_group_id = Some("provider-group".to_string());
        transfer_in.metadata = Some(json!({ "flow": { "is_external": false } }));
        let mut dividend = create_stored_activity("dividend", "acc-in", None);
        dividend.activity_type = "DIVIDEND".to_string();
        dividend.source_group_id = Some("provider-group".to_string());
        activity_repository.add_activity(transfer_out);
        activity_repository.add_activity(transfer_in);
        activity_repository.add_activity(dividend);

        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        activity_service
            .delete_activity("transfer-out".to_string())
            .await
            .expect("single delete should succeed");

        let remaining: HashSet<String> = activity_repository
            .get_activities()
            .unwrap()
            .into_iter()
            .map(|activity| activity.id)
            .collect();
        assert_eq!(
            remaining,
            HashSet::from(["transfer-in".to_string(), "dividend".to_string()])
        );
    }

    #[tokio::test]
    async fn bulk_delete_expands_valid_transfer_pair() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        let mut transfer_out = create_stored_activity("transfer-out", "acc-out", None);
        transfer_out.activity_type = "TRANSFER_OUT".to_string();
        transfer_out.source_group_id = Some("transfer-group".to_string());
        transfer_out.metadata = Some(json!({ "flow": { "is_external": false } }));
        let mut transfer_in = create_stored_activity("transfer-in", "acc-in", None);
        transfer_in.activity_type = "TRANSFER_IN".to_string();
        transfer_in.source_group_id = Some("transfer-group".to_string());
        transfer_in.metadata = Some(json!({ "flow": { "is_external": false } }));
        activity_repository.add_activity(transfer_out);
        activity_repository.add_activity(transfer_in);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![],
                delete_ids: vec!["transfer-in".to_string()],
            })
            .await
            .expect("bulk delete should succeed");

        let mut deleted_ids: Vec<String> = result
            .deleted
            .into_iter()
            .map(|activity| activity.id)
            .collect();
        deleted_ids.sort();
        assert_eq!(deleted_ids, vec!["transfer-in", "transfer-out"]);
    }

    #[tokio::test]
    async fn bulk_cross_currency_pair_amount_update_without_fx_returns_error() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());

        account_service.add_account(create_test_account("acc-usd", "USD"));
        account_service.add_account(create_test_account("acc-eur", "EUR"));

        let mut transfer_out = create_stored_activity("transfer-out", "acc-usd", None);
        transfer_out.activity_type = "TRANSFER_OUT".to_string();
        transfer_out.source_group_id = Some("transfer-group".to_string());
        transfer_out.metadata = Some(json!({ "flow": { "is_external": false } }));
        transfer_out.currency = "USD".to_string();
        transfer_out.amount = Some(dec!(100));
        let mut transfer_in = create_stored_activity("transfer-in", "acc-eur", None);
        transfer_in.activity_type = "TRANSFER_IN".to_string();
        transfer_in.source_group_id = Some("transfer-group".to_string());
        transfer_in.metadata = Some(json!({ "flow": { "is_external": false } }));
        transfer_in.currency = "EUR".to_string();
        transfer_in.amount = Some(dec!(98));
        transfer_in.fx_rate = None;
        activity_repository.add_activity(transfer_out);
        activity_repository.add_activity(transfer_in);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        );
        let mut update = create_test_activity_update("transfer-out", "acc-usd", None, "USD");
        update.activity_type = "TRANSFER_OUT".to_string();
        update.amount = Some(Some(dec!(110)));

        let result = activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![update],
                delete_ids: vec![],
            })
            .await
            .expect("bulk mutation should return structured errors");

        assert!(result.updated.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0]
            .message
            .contains("Cross-currency transfer amount updates require a valid FX rate"));
    }

    #[tokio::test]
    async fn bulk_update_event_uses_old_activity_date_when_moved_later() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());
        let event_sink = Arc::new(MockDomainEventSink::new());

        account_service.add_account(create_test_account("acc-usd", "USD"));

        let old_date = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let new_date = DateTime::parse_from_rfc3339("2026-02-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut activity = create_stored_activity("cash-activity", "acc-usd", None);
        activity.activity_type = "DEPOSIT".to_string();
        activity.activity_date = old_date;
        activity.quantity = None;
        activity.unit_price = None;
        activity.amount = Some(dec!(100));
        activity_repository.add_activity(activity);

        let activity_service = ActivityService::new(
            activity_repository,
            account_service,
            asset_service,
            fx_service,
            Arc::new(MockQuoteService),
        )
        .with_event_sink(event_sink.clone());

        activity_service
            .bulk_mutate_activities(ActivityBulkMutationRequest {
                creates: vec![],
                updates: vec![ActivityUpdate {
                    id: "cash-activity".to_string(),
                    account_id: "acc-usd".to_string(),
                    asset: None,
                    activity_type: "DEPOSIT".to_string(),
                    subtype: None,
                    activity_date: new_date.to_rfc3339(),
                    quantity: Some(None),
                    unit_price: Some(None),
                    currency: "USD".to_string(),
                    fee: Some(Some(dec!(0))),
                    tax: None,
                    amount: Some(Some(dec!(125))),
                    status: None,
                    notes: None,
                    fx_rate: None,
                    metadata: None,
                }],
                delete_ids: vec![],
            })
            .await
            .expect("bulk update should succeed");

        let events = event_sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            DomainEvent::ActivitiesChanged {
                earliest_activity_at_utc,
                ..
            } => assert_eq!(*earliest_activity_at_utc, Some(old_date)),
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
            None,
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
                tax: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            None,
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
                tax: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(100)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("Vanguard FTSE All-World".to_string()),
            exchange_mic: Some("XLON".to_string()),
            quote_ccy: Some("GBP".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(140820)), // 140820 pence total
            status: None,
            notes: None,
            fx_rate: None,
            metadata: None,
            needs_review: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
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
            import_run_id: None,
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
            tax: None,
            amount: Some(dec!(995)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("BOND".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(995)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("US Treasury Note 2.5% 2025".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("BOND".to_string()),
            quote_mode: Some("MANUAL".to_string()),
            provider_id: None,
            provider_symbol: None,
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
                tax: None,
                amount: Some(dec!(995)),
                comment: None,
                account_id: Some("acc-1".to_string()),
                account_name: None,
                symbol_name: Some("US Treasury Note".to_string()),
                exchange_mic: None,
                quote_ccy: Some("USD".to_string()),
                instrument_type: Some(alias.to_string()),
                quote_mode: Some("MANUAL".to_string()),
                provider_id: None,
                provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(500)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: Some("BOND".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(550)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(1670)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: Some("SPY Jun 19 2026 580 Put".to_string()),
            exchange_mic: None,
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("OPTION".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
            amount: Some(dec!(800)),
            comment: None,
            account_id: Some("acc-1".to_string()),
            account_name: None,
            symbol_name: None,
            exchange_mic: None,
            quote_ccy: None,
            instrument_type: Some("OPTION".to_string()),
            quote_mode: None,
            provider_id: None,
            provider_symbol: None,
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
            tax: None,
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
            import_run_id: None,
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

    // ── Transfer pair sync ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_update_activity_propagates_to_transfer_counterpart() {
        let account_service = Arc::new(MockAccountService::new());
        let asset_service = Arc::new(MockAssetService::new());
        let fx_service = Arc::new(MockFxService::new());
        let activity_repository = Arc::new(MockActivityRepository::new());
        let event_sink = Arc::new(MockDomainEventSink::new());
        let quote_service = Arc::new(MockQuoteService);
        account_service.add_account(create_test_account("acc-out", "USD"));

        let activity_service = ActivityService::new(
            activity_repository.clone(),
            account_service,
            asset_service,
            fx_service,
            quote_service,
        )
        .with_event_sink(event_sink.clone());

        let date_original = DateTime::parse_from_rfc3339("2024-01-15T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let date_updated = DateTime::parse_from_rfc3339("2024-02-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        activity_repository.activities.lock().unwrap().extend([
            Activity {
                id: "transfer-out".to_string(),
                account_id: "acc-out".to_string(),
                asset_id: None,
                activity_type: "TRANSFER_OUT".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date_original,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(500)),
                fee: Some(dec!(0)),
                tax: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: None,
                source_system: None,
                source_record_id: None,
                source_group_id: Some("grp-1".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: date_original,
                updated_at: date_original,
            },
            Activity {
                id: "transfer-in".to_string(),
                account_id: "acc-in".to_string(),
                asset_id: None,
                activity_type: "TRANSFER_IN".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date_original,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(500)),
                fee: Some(dec!(0)),
                tax: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: None,
                source_system: None,
                source_record_id: None,
                source_group_id: Some("grp-1".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: date_original,
                updated_at: date_original,
            },
        ]);

        let update = crate::activities::ActivityUpdate {
            id: "transfer-out".to_string(),
            account_id: "acc-out".to_string(),
            asset: None,
            activity_type: "TRANSFER_OUT".to_string(),
            subtype: None,
            activity_date: date_updated.to_rfc3339(),
            quantity: None,
            unit_price: None,
            currency: "USD".to_string(),
            fee: None,
            tax: None,
            amount: Some(Some(dec!(750))),
            status: Some(ActivityStatus::Posted),
            notes: Some("moved funds".to_string()),
            fx_rate: None,
            metadata: None,
        };

        activity_service
            .update_activity(update)
            .await
            .expect("update should succeed");

        let stored = activity_repository.activities.lock().unwrap().clone();

        let counterpart = stored
            .iter()
            .find(|a| a.id == "transfer-in")
            .expect("transfer-in should still exist");

        assert_eq!(counterpart.amount, Some(dec!(750)), "amount propagated");
        assert_eq!(counterpart.activity_date, date_updated, "date propagated");
        assert_eq!(
            counterpart.notes,
            Some("moved funds".to_string()),
            "notes propagated"
        );
        assert_eq!(counterpart.account_id, "acc-in", "account_id not changed");
        assert_eq!(
            counterpart.activity_type, "TRANSFER_IN",
            "activity_type not changed"
        );
    }

    #[tokio::test]
    async fn test_delete_activity_cascades_transfer_pair() {
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

        let date = DateTime::parse_from_rfc3339("2024-01-15T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        activity_repository.activities.lock().unwrap().extend([
            Activity {
                id: "transfer-out".to_string(),
                account_id: "acc-out".to_string(),
                asset_id: None,
                activity_type: "TRANSFER_OUT".to_string(),
                activity_type_override: None,
                source_type: None,
                subtype: None,
                status: ActivityStatus::Posted,
                activity_date: date,
                settlement_date: None,
                quantity: None,
                unit_price: None,
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                tax: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: Some(json!({ "flow": { "is_external": false } })),
                source_system: None,
                source_record_id: None,
                source_group_id: Some("grp-cascade".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: date,
                updated_at: date,
            },
            Activity {
                id: "transfer-in".to_string(),
                account_id: "acc-in".to_string(),
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
                amount: Some(dec!(100)),
                fee: Some(dec!(0)),
                tax: None,
                currency: "USD".to_string(),
                fx_rate: None,
                notes: None,
                metadata: Some(json!({ "flow": { "is_external": false } })),
                source_system: None,
                source_record_id: None,
                source_group_id: Some("grp-cascade".to_string()),
                idempotency_key: None,
                import_run_id: None,
                is_user_modified: false,
                needs_review: false,
                created_at: date,
                updated_at: date,
            },
        ]);

        activity_service
            .delete_activity("transfer-out".to_string())
            .await
            .expect("delete should succeed");

        let stored = activity_repository.activities.lock().unwrap().clone();
        assert!(
            stored
                .iter()
                .all(|a| a.source_group_id.as_deref() != Some("grp-cascade")),
            "both transfer legs should be deleted"
        );
        assert_eq!(stored.len(), 0, "no activities should remain");

        // Both accounts must appear in the emitted event
        let events = event_sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            DomainEvent::ActivitiesChanged { account_ids, .. } => {
                let mut ids = account_ids.clone();
                ids.sort();
                assert_eq!(ids, vec!["acc-in", "acc-out"]);
            }
            event => panic!("expected ActivitiesChanged, got {event:?}"),
        }
    }
}
