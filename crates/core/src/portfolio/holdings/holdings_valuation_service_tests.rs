// Test cases for HoldingsValuationService will go here.
#[cfg(test)]
mod tests {
    use crate::assets::{Asset, ProviderProfile};
    use crate::errors::{Error, Result};
    use crate::fx::{ExchangeRate, FxServiceTrait, NewExchangeRate};
    use crate::portfolio::holdings::holdings_model::{
        Holding, HoldingType, Instrument, MonetaryValue,
    };
    use crate::portfolio::holdings::holdings_valuation_service::{
        HoldingsValuationService, HoldingsValuationServiceTrait,
    };
    use crate::quotes::MarketDataError;
    use crate::quotes::{
        LatestQuotePair, LatestQuoteSnapshot, ProviderInfo, Quote, QuoteImport, QuoteServiceTrait,
        QuoteSyncState, SymbolSearchResult, SymbolSyncPlan, SyncResult,
    };
    use crate::utils::time_utils::valuation_date_today;
    use async_trait::async_trait;
    use chrono::{NaiveDate, Utc};
    use rust_decimal::Decimal;
    use rust_decimal_macros::dec;
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};

    // --- Mock FxService ---
    #[derive(Clone, Default)]
    struct MockFxService {
        rates: Arc<Mutex<HashMap<(String, String), Decimal>>>,
        should_fail: Arc<Mutex<HashMap<(String, String), bool>>>,
        latest_rate_calls: Arc<Mutex<HashMap<(String, String), usize>>>,
    }

    impl MockFxService {
        fn add_rate(&self, from: &str, to: &str, rate: Decimal) {
            let mut rates = self.rates.lock().unwrap();
            rates.insert((from.to_string(), to.to_string()), rate);
            if rate != Decimal::ZERO {
                rates.insert((to.to_string(), from.to_string()), dec!(1) / rate);
            }
        }

        fn set_fail(&self, from: &str, to: &str, fail: bool) {
            let mut should_fail = self.should_fail.lock().unwrap();
            should_fail.insert((from.to_string(), to.to_string()), fail);
        }

        fn latest_rate_call_count(&self, from: &str, to: &str) -> usize {
            *self
                .latest_rate_calls
                .lock()
                .unwrap()
                .get(&(from.to_string(), to.to_string()))
                .unwrap_or(&0)
        }
    }

    #[async_trait]
    impl FxServiceTrait for MockFxService {
        fn initialize(&self) -> Result<()> {
            Ok(())
        } // Not used
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
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            unimplemented!()
        }
        async fn register_currency_pair_manual(
            &self,
            _from_currency: &str,
            _to_currency: &str,
        ) -> Result<()> {
            unimplemented!()
        }

        async fn ensure_fx_pairs(&self, _pairs: Vec<(String, String)>) -> Result<()> {
            Ok(())
        }

        fn get_latest_exchange_rate(
            &self,
            from_currency: &str,
            to_currency: &str,
        ) -> Result<Decimal> {
            let cache_key = (from_currency.to_string(), to_currency.to_string());
            self.latest_rate_calls
                .lock()
                .unwrap()
                .entry(cache_key.clone())
                .and_modify(|count| *count += 1)
                .or_insert(1);

            if from_currency == to_currency {
                return Ok(Decimal::ONE);
            }
            let should_fail = self.should_fail.lock().unwrap();
            if *should_fail.get(&cache_key).unwrap_or(&false) {
                return Err(Error::Unexpected("Intentional FX failure".to_string()));
            }

            let rates = self.rates.lock().unwrap();
            match rates.get(&cache_key) {
                Some(rate) => Ok(*rate),
                None => Err(Error::Fx(crate::fx::FxError::RateNotFound(format!(
                    "Mock rate not found for {}->{}",
                    from_currency, to_currency
                )))),
            }
        }
    }

    // --- Mock MarketDataService (implements QuoteServiceTrait) ---
    #[derive(Clone, Default)]
    struct MockMarketDataService {
        quotes: Arc<Mutex<HashMap<String, LatestQuotePair>>>,
        should_fail: Arc<Mutex<bool>>,
    }

    impl MockMarketDataService {
        fn add_quote_pair(&self, symbol: &str, latest: Quote, previous: Option<Quote>) {
            let mut quotes = self.quotes.lock().unwrap();
            quotes.insert(symbol.to_string(), LatestQuotePair { latest, previous });
        }
    }

    #[async_trait]
    impl QuoteServiceTrait for MockMarketDataService {
        // =========================================================================
        // Quote CRUD Operations
        // =========================================================================

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
            symbols: &[String],
        ) -> Result<HashMap<String, LatestQuotePair>> {
            if *self.should_fail.lock().unwrap() {
                return Err(Error::MarketData(MarketDataError::ProviderError(
                    "Intentional market data failure".to_string(),
                )));
            }
            let quotes_db = self.quotes.lock().unwrap();
            let mut result = HashMap::new();
            for symbol in symbols {
                if let Some(pair) = quotes_db.get(symbol) {
                    result.insert(symbol.clone(), pair.clone());
                }
            }
            Ok(result)
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

    // --- Helper Functions ---
    fn create_quote(
        date_str: &str, // "YYYY-MM-DD"
        close: Decimal,
        currency: &str,
    ) -> Quote {
        let date = NaiveDate::from_str(date_str).unwrap();
        let naive_timestamp = date.and_hms_opt(0, 0, 0).unwrap();
        let utc_timestamp = chrono::TimeZone::from_utc_datetime(&Utc, &naive_timestamp);
        Quote {
            id: format!("{}_{}", currency, date_str),
            asset_id: "".to_string(),
            timestamp: utc_timestamp,
            close,
            open: close,
            high: close,
            low: close,
            adjclose: close,
            volume: dec!(1000),
            currency: currency.to_string(),
            data_source: "YAHOO".to_string(),
            created_at: Utc::now(),
            notes: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn create_holding(
        id: &str,
        holding_type: HoldingType,
        symbol_or_cash_code: &str,
        quantity: Decimal,
        local_currency: &str,
        base_currency: &str,
        cost_basis_local: Option<Decimal>, // None if missing
        name: Option<&str>,
    ) -> Holding {
        let instrument = if holding_type == HoldingType::Security {
            Some(Instrument {
                id: symbol_or_cash_code.to_string(), // Use symbol as ID to match mock quote keys
                symbol: symbol_or_cash_code.to_string(),
                name: Some(name.unwrap_or(symbol_or_cash_code).to_string()),
                currency: local_currency.to_string(),
                notes: None,
                pricing_mode: "MARKET".to_string(),
                preferred_provider: None,
                exchange_mic: None,
                classifications: None,
            })
        } else {
            None
        };

        Holding {
            id: id.to_string(),
            account_id: "acc_1".to_string(),
            holding_type,
            quantity,
            local_currency: local_currency.to_string(),
            base_currency: base_currency.to_string(),
            cost_basis: cost_basis_local.map(|cb_local| MonetaryValue {
                local: cb_local,
                base: dec!(0.0),
            }), // Base will be calculated
            instrument,
            asset_kind: None,
            open_date: None,
            lots: None,
            contract_multiplier: Decimal::ONE,
            weight: dec!(0.0),
            as_of_date: NaiveDate::from_ymd_opt(1970, 1, 1).unwrap(), // Placeholder
            market_value: MonetaryValue::zero(),                      // To be calculated
            price: None,                                              // To be calculated
            purchase_price: None,
            fx_rate: None,             // To be calculated
            unrealized_gain: None,     // To be calculated
            unrealized_gain_pct: None, // To be calculated
            day_change: None,          // To be calculated
            day_change_pct: None,      // To be calculated
            prev_close_value: None,    // To be calculated
            realized_gain: None,       // To be calculated
            realized_gain_pct: None,   // To be calculated
            total_gain: None,          // To be calculated
            total_gain_pct: None,      // To be calculated
            income: None,
            total_return: None,
            total_return_pct: None,
            return_basis: None,
            source_account_ids: vec![],
            metadata: None,
        }
    }

    fn assert_monetary_value_approx(
        value: Option<&MonetaryValue>,
        expected_local: Decimal,
        expected_base: Decimal,
        tolerance: Decimal,
        message: &str,
    ) {
        match value {
            Some(mv) => {
                assert!(
                    (mv.local - expected_local).abs() < tolerance,
                    "{}: Local value mismatch. Expected {}, Got {}",
                    message,
                    expected_local,
                    mv.local
                );
                assert!(
                    (mv.base - expected_base).abs() < tolerance,
                    "{}: Base value mismatch. Expected {}, Got {}",
                    message,
                    expected_base,
                    mv.base
                );
            }
            None => panic!("{}: MonetaryValue was None", message),
        }
    }

    fn assert_decimal_approx(
        value: Option<Decimal>,
        expected: Decimal,
        tolerance: Decimal,
        message: &str,
    ) {
        match value {
            Some(d) => {
                assert!(
                    (d - expected).abs() < tolerance,
                    "{}: Decimal value mismatch. Expected {}, Got {}",
                    message,
                    expected,
                    d
                );
            }
            None => panic!("{}: Decimal value was None", message),
        }
    }

    // --- Test Setup ---
    fn setup_test_env() -> (
        Arc<MockFxService>,
        Arc<MockMarketDataService>,
        HoldingsValuationService,
    ) {
        let fx_service = Arc::new(MockFxService::default());
        let market_data_service = Arc::new(MockMarketDataService::default());
        let valuation_service =
            HoldingsValuationService::new(fx_service.clone(), market_data_service.clone());

        // Common FX Rates
        fx_service.add_rate("USD", "CAD", dec!(1.3));
        fx_service.add_rate("EUR", "CAD", dec!(1.45));
        fx_service.add_rate("USD", "EUR", dec!(0.9)); // Implies EUR/USD = 1/0.9 = 1.111...

        (fx_service, market_data_service, valuation_service)
    }

    // --- Test Cases ---
    const TOLERANCE: Decimal = dec!(0.0001);

    #[tokio::test]
    async fn test_security_valuation_base_currency() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        let latest_quote = create_quote("2024-01-10", dec!(150.0), "CAD");
        let prev_quote = create_quote("2024-01-09", dec!(145.0), "CAD");
        market_data_service.add_quote_pair("XYZ.TO", latest_quote, Some(prev_quote));

        let mut holdings = vec![create_holding(
            "h1",
            HoldingType::Security,
            "XYZ.TO",
            dec!(10),
            "CAD",
            "CAD",
            Some(dec!(1400.0)),
            Some("XYZ Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // Expected values
        let expected_price = dec!(150.0);
        let expected_mv_local = dec!(1500.0); // 10 * 150
        let expected_mv_base = dec!(1500.0); // 1.0 FX rate
        let expected_cost_base = dec!(1400.0);
        let expected_unrealized_local = dec!(100.0); // 1500 - 1400
        let expected_unrealized_base = dec!(100.0);
        let expected_unrealized_pct = dec!(0.0714); // 100 / 1400
        let expected_prev_value_local = dec!(1450.0); // 10 * 145
        let expected_prev_value_base = dec!(1450.0);
        let expected_day_change_local = dec!(50.0); // 1500 - 1450
        let expected_day_change_base = dec!(50.0);
        let expected_day_change_pct = dec!(0.0345); // 50 / 1450

        assert_eq!(
            holding.as_of_date,
            NaiveDate::from_str("2024-01-10").unwrap()
        );
        assert_decimal_approx(holding.price, expected_price, TOLERANCE, "Price");
        assert_decimal_approx(holding.fx_rate, dec!(1.0), TOLERANCE, "FX Rate");
        assert_monetary_value_approx(
            Some(&holding.market_value),
            expected_mv_local,
            expected_mv_base,
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            dec!(1400.0),
            expected_cost_base,
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            expected_unrealized_local,
            expected_unrealized_base,
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            expected_unrealized_pct,
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            expected_prev_value_local,
            expected_prev_value_base,
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            expected_day_change_local,
            expected_day_change_base,
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            expected_day_change_pct,
            TOLERANCE,
            "Day Change Pct",
        );
        assert!(holding.realized_gain.is_none()); // Not calculated here
        assert_monetary_value_approx(
            holding.total_gain.as_ref(),
            expected_unrealized_local,
            expected_unrealized_base,
            TOLERANCE,
            "Total Gain",
        );
        assert_decimal_approx(
            holding.total_gain_pct,
            expected_unrealized_pct,
            TOLERANCE,
            "Total Gain Pct",
        );
    }

    #[tokio::test]
    async fn security_short_valuation_uses_absolute_basis_for_percentages() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        let latest_quote = create_quote("2024-01-10", dec!(90.0), "USD");
        let prev_quote = create_quote("2024-01-09", dec!(100.0), "USD");
        market_data_service.add_quote_pair("AAPL", latest_quote, Some(prev_quote));

        let mut holdings = vec![create_holding(
            "h-short",
            HoldingType::Security,
            "AAPL",
            dec!(-10),
            "USD",
            "USD",
            Some(dec!(-1000)),
            Some("Apple Inc."),
        )];

        valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await
            .unwrap();
        let holding = &holdings[0];

        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(-900),
            dec!(-900),
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            dec!(-1000),
            dec!(-1000),
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(100),
            dec!(100),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            dec!(0.1),
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            dec!(-1000),
            dec!(-1000),
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            dec!(100),
            dec!(100),
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            dec!(0.1),
            TOLERANCE,
            "Day Change Pct",
        );
        assert_monetary_value_approx(
            holding.total_gain.as_ref(),
            dec!(100),
            dec!(100),
            TOLERANCE,
            "Total Gain",
        );
        assert_decimal_approx(
            holding.total_gain_pct,
            dec!(0.1),
            TOLERANCE,
            "Total Gain Pct",
        );
    }

    #[tokio::test]
    async fn expired_short_option_reports_positive_full_gain_percentage() {
        let (_fx_service, _market_data_service, valuation_service) = setup_test_env();

        let mut holding = create_holding(
            "h-expired-short-option",
            HoldingType::Security,
            "AAPL260116C00200000",
            dec!(-1),
            "USD",
            "USD",
            Some(dec!(-200)),
            Some("AAPL expired call"),
        );
        holding.metadata = Some(serde_json::json!({
            "option": {
                "expiration": "2000-01-01"
            }
        }));
        let mut holdings = vec![holding];

        valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await
            .unwrap();
        let holding = &holdings[0];

        assert_eq!(holding.market_value, MonetaryValue::zero());
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(200),
            dec!(200),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            dec!(1),
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.total_gain.as_ref(),
            dec!(200),
            dec!(200),
            TOLERANCE,
            "Total Gain",
        );
        assert_decimal_approx(holding.total_gain_pct, dec!(1), TOLERANCE, "Total Gain Pct");
    }

    #[tokio::test]
    async fn security_valuation_with_zero_basis_returns_no_gain_percent() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        let latest_quote = create_quote("2024-01-10", dec!(100.0), "CAD");
        market_data_service.add_quote_pair("ZERO", latest_quote, None);

        let mut holdings = vec![create_holding(
            "h-zero",
            HoldingType::Security,
            "ZERO",
            dec!(10),
            "CAD",
            "CAD",
            Some(Decimal::ZERO),
            Some("Zero Basis Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());

        let holding = &holdings[0];
        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(1000),
            dec!(1000),
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(1000),
            dec!(1000),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert!(holding.unrealized_gain_pct.is_none());
        assert!(holding.total_gain_pct.is_none());
    }

    #[tokio::test]
    async fn test_security_valuation_with_fx() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        let usd_cad_rate = fx_service.get_latest_exchange_rate("USD", "CAD").unwrap(); // 1.3

        let latest_quote = create_quote("2024-01-10", dec!(100.0), "USD");
        let prev_quote = create_quote("2024-01-09", dec!(95.0), "USD");
        market_data_service.add_quote_pair("AAPL", latest_quote, Some(prev_quote));

        let mut holdings = vec![
            create_holding(
                "h2",
                HoldingType::Security,
                "AAPL",
                dec!(20),
                "USD",
                "CAD",
                Some(dec!(1800.0)),
                Some("Apple Inc."),
            ), // Cost basis is 1800 USD
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // Expected values
        let expected_price = dec!(100.0); // USD
        let expected_mv_local = dec!(2000.0); // 20 * 100 USD
        let expected_mv_base = expected_mv_local * usd_cad_rate; // 2000 * 1.3 = 2600 CAD
        let expected_cost_local = dec!(1800.0); // USD
        let expected_cost_base = expected_cost_local * usd_cad_rate; // 1800 * 1.3 = 2340 CAD
        let expected_unrealized_local = dec!(200.0); // 2000 - 1800 USD
        let expected_unrealized_base = expected_mv_base - expected_cost_base; // 2600 - 2340 = 260 CAD
        let expected_unrealized_pct = expected_unrealized_base / expected_cost_base; // 260 / 2340 = 0.1111
        let expected_prev_value_local = dec!(1900.0); // 20 * 95 USD
        let expected_prev_value_base = expected_prev_value_local * usd_cad_rate; // 1900 * 1.3 = 2470 CAD
        let expected_day_change_local = dec!(100.0); // 2000 - 1900 USD
        let expected_day_change_base = expected_day_change_local * usd_cad_rate; // 100 * 1.3 = 130 CAD
        let expected_day_change_pct = expected_day_change_base / expected_prev_value_base; // 130 / 2470 = 0.0526

        assert_eq!(
            holding.as_of_date,
            NaiveDate::from_str("2024-01-10").unwrap()
        );
        assert_decimal_approx(holding.price, expected_price, TOLERANCE, "Price");
        assert_decimal_approx(holding.fx_rate, usd_cad_rate, TOLERANCE, "FX Rate");
        assert_monetary_value_approx(
            Some(&holding.market_value),
            expected_mv_local,
            expected_mv_base,
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            expected_cost_local,
            expected_cost_base,
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            expected_unrealized_local,
            expected_unrealized_base,
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            expected_unrealized_pct,
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            expected_prev_value_local,
            expected_prev_value_base,
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            expected_day_change_local,
            expected_day_change_base,
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            expected_day_change_pct,
            TOLERANCE,
            "Day Change Pct",
        );
    }

    #[tokio::test]
    async fn security_valuation_with_fx_equal_cost_and_price_has_zero_gain_percent() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        let latest_quote = create_quote("2024-01-10", dec!(50.0), "USD");
        market_data_service.add_quote_pair("FXFLAT", latest_quote, None);

        let mut holdings = vec![create_holding(
            "h-fx-flat",
            HoldingType::Security,
            "FXFLAT",
            dec!(100),
            "CAD",
            "CAD",
            Some(dec!(6500.0)),
            Some("FX Flat Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());

        let holding = &holdings[0];
        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(6500.0),
            dec!(6500.0),
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            Decimal::ZERO,
            Decimal::ZERO,
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_eq!(holding.unrealized_gain_pct, Some(Decimal::ZERO));
        assert_eq!(holding.total_gain_pct, Some(Decimal::ZERO));
    }

    #[tokio::test]
    async fn issue_1277_transfer_in_fx_effect_does_not_change_holding_return_pct() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        fx_service.add_rate("USD", "MXN", dec!(17.46));

        market_data_service.add_quote_pair(
            "TRANSFERRED",
            create_quote("2024-01-10", dec!(91.63), "USD"),
            None,
        );

        let mut holdings = vec![create_holding(
            "h-transfer-in",
            HoldingType::Security,
            "TRANSFERRED",
            dec!(1),
            "USD",
            "MXN",
            Some(dec!(91.50)),
            Some("Transferred security"),
        )];
        // A TRANSFER_IN lot keeps the base cost recorded at the historical FX rate.
        holdings[0].cost_basis.as_mut().unwrap().base = dec!(726.61);

        valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await
            .unwrap();

        let holding = &holdings[0];
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(0.13),
            dec!(873.2498),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_eq!(holding.unrealized_gain_pct, Some(dec!(0.0014)));
        assert_eq!(holding.total_gain_pct, Some(dec!(0.0014)));
    }

    #[tokio::test]
    async fn issue_408_preserves_historical_base_cost_basis() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        fx_service.add_rate("USD", "EUR", dec!(0.8));

        let latest_quote = create_quote("2024-01-10", dec!(110.0), "USD");
        let prev_quote = create_quote("2024-01-09", dec!(100.0), "USD");
        market_data_service.add_quote_pair("AAPL", latest_quote, Some(prev_quote));

        let mut holdings = vec![create_holding(
            "h_408",
            HoldingType::Security,
            "AAPL",
            dec!(10),
            "USD",
            "EUR",
            Some(dec!(1000.0)),
            Some("Apple Inc."),
        )];
        holdings[0].cost_basis.as_mut().unwrap().base = dec!(1000.0);

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(1100.0),
            dec!(880.0),
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            dec!(1000.0),
            dec!(1000.0),
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(100.0),
            dec!(-120.0),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            dec!(0.1000),
            TOLERANCE,
            "Unrealized Gain Pct",
        );
    }

    #[tokio::test]
    async fn missing_historical_base_cost_basis_falls_back_to_current_fx() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        fx_service.add_rate("USD", "EUR", dec!(0.8));

        market_data_service.add_quote_pair(
            "AAPL",
            create_quote("2024-01-10", dec!(110.0), "USD"),
            None,
        );

        let mut holdings = vec![create_holding(
            "h_current_fx_fallback",
            HoldingType::Security,
            "AAPL",
            dec!(10),
            "USD",
            "EUR",
            Some(dec!(1000.0)),
            Some("Apple Inc."),
        )];

        valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await
            .unwrap();

        let holding = &holdings[0];
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            dec!(1000.0),
            dec!(800.0),
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(100.0),
            dec!(80.0),
            TOLERANCE,
            "Unrealized Gain",
        );
    }

    #[tokio::test]
    async fn latest_fx_rates_are_cached_per_valuation_request() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();

        market_data_service.add_quote_pair(
            "AAPL",
            create_quote("2024-01-10", dec!(100.0), "USD"),
            None,
        );
        market_data_service.add_quote_pair(
            "MSFT",
            create_quote("2024-01-10", dec!(200.0), "USD"),
            None,
        );

        let mut holdings = vec![
            create_holding(
                "h_cache_1",
                HoldingType::Security,
                "AAPL",
                dec!(1),
                "USD",
                "CAD",
                Some(dec!(90.0)),
                Some("Apple Inc."),
            ),
            create_holding(
                "h_cache_2",
                HoldingType::Security,
                "MSFT",
                dec!(1),
                "USD",
                "CAD",
                Some(dec!(180.0)),
                Some("Microsoft"),
            ),
        ];

        valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await
            .unwrap();

        assert_eq!(fx_service.latest_rate_call_count("USD", "CAD"), 1);
        assert_eq!(fx_service.latest_rate_call_count("USD", "USD"), 1);
    }

    #[tokio::test]
    async fn test_security_valuation_minor_quote_currency_normalizes_price_to_local_currency() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        // Yahoo-style LSE quote values in pence (GBp)
        let latest_quote = create_quote("2024-01-10", dec!(14906.0), "GBp");
        let prev_quote = create_quote("2024-01-09", dec!(14818.0), "GBp");
        market_data_service.add_quote_pair("AZN.L", latest_quote, Some(prev_quote));

        let mut holdings = vec![create_holding(
            "h_minor",
            HoldingType::Security,
            "AZN.L",
            dec!(17),
            "GBP",
            "GBP",
            Some(dec!(2393.94)),
            Some("AstraZeneca"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // 14906 GBp -> 149.06 GBP, then local (GBP) price/value should remain in GBP
        assert_decimal_approx(holding.price, dec!(149.06), TOLERANCE, "Price (GBP)");
        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(2534.02), // 149.06 * 17
            dec!(2534.02),
            TOLERANCE,
            "Market Value (GBP)",
        );
    }

    #[tokio::test]
    async fn test_security_valuation_quote_currency_differs_from_local() {
        // Holding is in CAD, Base is CAD, Quote is in USD
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        let usd_cad_rate = fx_service.get_latest_exchange_rate("USD", "CAD").unwrap(); // 1.3

        // Quote is in USD, even though we might track the holding in CAD locally (e.g., ADR)
        let latest_quote = create_quote("2024-01-10", dec!(50.0), "USD");
        let prev_quote = create_quote("2024-01-09", dec!(48.0), "USD");
        market_data_service.add_quote_pair("BNS", latest_quote, Some(prev_quote)); // BNS usually CAD, but simulating USD quote source

        let mut holdings = vec![
            create_holding(
                "h3",
                HoldingType::Security,
                "BNS",
                dec!(100),
                "CAD",
                "CAD",
                Some(dec!(6000.0)),
                Some("Bank of Nova Scotia"),
            ), // Holding/Cost basis in CAD
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok(), "Valuation failed: {:?}", result.err());
        let holding = &holdings[0];

        // Expected values
        let expected_price = dec!(65.0); // Converted to local currency (CAD)
        let expected_mv_quote_curr = dec!(5000.0); // 100 * 50 USD
        let expected_mv_local = expected_mv_quote_curr * usd_cad_rate; // 5000 * 1.3 = 6500 CAD
        let expected_mv_base = expected_mv_local; // Base is CAD, so same as local = 6500 CAD
        let expected_cost_local = dec!(6000.0); // CAD
        let expected_cost_base = expected_cost_local; // Base is CAD, cost basis fx rate is 1.0 = 6000 CAD
        let expected_unrealized_local = dec!(500.0); // 6500 - 6000 CAD
        let expected_unrealized_base = dec!(500.0); // 6500 - 6000 CAD
        let expected_unrealized_pct = expected_unrealized_base / expected_cost_base; // 500 / 6000 = 0.0833
        let expected_prev_value_quote_curr = dec!(4800.0); // 100 * 48 USD
        let expected_prev_value_local = expected_prev_value_quote_curr * usd_cad_rate; // 4800 * 1.3 = 6240 CAD
        let expected_prev_value_base = expected_prev_value_local; // 6240 CAD
        let expected_day_change_local = expected_mv_local - expected_prev_value_local; // 6500 - 6240 = 260 CAD
        let expected_day_change_base = expected_day_change_local; // 260 CAD
        let expected_day_change_pct = expected_day_change_base / expected_prev_value_base; // 260 / 6240 = 0.0417

        assert_eq!(holding.local_currency, "CAD");
        assert_eq!(holding.base_currency, "CAD");
        assert_eq!(holding.instrument.as_ref().unwrap().currency, "CAD"); // Instrument currency matches holding local
        assert_eq!(
            market_data_service
                .quotes
                .lock()
                .unwrap()
                .get("BNS")
                .unwrap()
                .latest
                .currency,
            "USD"
        ); // Quote currency is USD

        assert_eq!(
            holding.as_of_date,
            NaiveDate::from_str("2024-01-10").unwrap()
        );
        assert_decimal_approx(
            holding.price,
            expected_price,
            TOLERANCE,
            "Price (Local Currency)",
        );
        assert_decimal_approx(
            holding.fx_rate,
            dec!(1.0),
            TOLERANCE,
            "FX Rate (Local to Base)",
        ); // Holding is CAD, Base is CAD
        assert_monetary_value_approx(
            Some(&holding.market_value),
            expected_mv_local,
            expected_mv_base,
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            expected_cost_local,
            expected_cost_base,
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            expected_unrealized_local,
            expected_unrealized_base,
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            expected_unrealized_pct,
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            expected_prev_value_local,
            expected_prev_value_base,
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            expected_day_change_local,
            expected_day_change_base,
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            expected_day_change_pct,
            TOLERANCE,
            "Day Change Pct",
        );
    }

    #[tokio::test]
    async fn test_cash_valuation_base_currency() {
        let (_fx_service, _market_data_service, valuation_service) = setup_test_env();

        let mut holdings = vec![create_holding(
            "h_cash_cad",
            HoldingType::Cash,
            "CASH:CAD",
            dec!(1000.0),
            "CAD",
            "CAD",
            Some(dec!(1000.0)),
            None,
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        let expected_value = dec!(1000.0);

        assert_eq!(holding.as_of_date, valuation_date_today());
        assert_decimal_approx(holding.price, dec!(1.0), TOLERANCE, "Price");
        assert_decimal_approx(holding.fx_rate, dec!(1.0), TOLERANCE, "FX Rate");
        assert_monetary_value_approx(
            Some(&holding.market_value),
            expected_value,
            expected_value,
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            expected_value,
            expected_value,
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            dec!(0.0),
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            expected_value,
            expected_value,
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            dec!(0.0),
            TOLERANCE,
            "Day Change Pct",
        );
        assert_monetary_value_approx(
            holding.realized_gain.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Realized Gain",
        );
        assert_decimal_approx(
            holding.realized_gain_pct,
            dec!(0.0),
            TOLERANCE,
            "Realized Gain Pct",
        );
        assert_monetary_value_approx(
            holding.total_gain.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Total Gain",
        );
        assert_decimal_approx(
            holding.total_gain_pct,
            dec!(0.0),
            TOLERANCE,
            "Total Gain Pct",
        );
    }

    #[tokio::test]
    async fn test_cash_valuation_with_fx() {
        let (fx_service, _market_data_service, valuation_service) = setup_test_env();
        let usd_cad_rate = fx_service.get_latest_exchange_rate("USD", "CAD").unwrap(); // 1.3

        let mut holdings = vec![create_holding(
            "h_cash_usd",
            HoldingType::Cash,
            "CASH:USD",
            dec!(500.0),
            "USD",
            "CAD",
            Some(dec!(500.0)),
            None,
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        let expected_local_value = dec!(500.0);
        let expected_base_value = expected_local_value * usd_cad_rate; // 500 * 1.3 = 650 CAD

        assert_eq!(holding.as_of_date, valuation_date_today());
        assert_decimal_approx(holding.price, dec!(1.0), TOLERANCE, "Price");
        assert_decimal_approx(holding.fx_rate, usd_cad_rate, TOLERANCE, "FX Rate");
        assert_monetary_value_approx(
            Some(&holding.market_value),
            expected_local_value,
            expected_base_value,
            TOLERANCE,
            "Market Value",
        );
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            expected_local_value,
            expected_base_value,
            TOLERANCE,
            "Cost Basis",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Unrealized Gain",
        );
        assert_decimal_approx(
            holding.unrealized_gain_pct,
            dec!(0.0),
            TOLERANCE,
            "Unrealized Gain Pct",
        );
        // Note: prev_close is initialized to current value for cash if missing
        assert_monetary_value_approx(
            holding.prev_close_value.as_ref(),
            expected_local_value,
            expected_base_value,
            TOLERANCE,
            "Prev Close Value",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Day Change",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            dec!(0.0),
            TOLERANCE,
            "Day Change Pct",
        );
    }

    #[tokio::test]
    async fn test_multiple_holdings_mixed_currencies() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        let usd_cad_rate = fx_service.get_latest_exchange_rate("USD", "CAD").unwrap(); // 1.3
        let eur_cad_rate = fx_service.get_latest_exchange_rate("EUR", "CAD").unwrap(); // 1.45

        // Setup market data
        market_data_service.add_quote_pair(
            "XYZ.TO",
            create_quote("2024-01-10", dec!(150.0), "CAD"),
            Some(create_quote("2024-01-09", dec!(145.0), "CAD")),
        );
        market_data_service.add_quote_pair(
            "AAPL",
            create_quote("2024-01-10", dec!(100.0), "USD"),
            Some(create_quote("2024-01-09", dec!(95.0), "USD")),
        );
        market_data_service.add_quote_pair(
            "ADS.DE",
            create_quote("2024-01-10", dec!(200.0), "EUR"),
            Some(create_quote("2024-01-09", dec!(198.0), "EUR")),
        );

        let mut holdings = vec![
            create_holding(
                "h1",
                HoldingType::Security,
                "XYZ.TO",
                dec!(10),
                "CAD",
                "CAD",
                Some(dec!(1400.0)),
                Some("XYZ Corp"),
            ), // CAD Security
            create_holding(
                "h2",
                HoldingType::Security,
                "AAPL",
                dec!(20),
                "USD",
                "CAD",
                Some(dec!(1800.0)),
                Some("Apple Inc."),
            ), // USD Security, CAD Base
            create_holding(
                "h3",
                HoldingType::Security,
                "ADS.DE",
                dec!(5),
                "EUR",
                "CAD",
                Some(dec!(950.0)),
                Some("Adidas AG"),
            ), // EUR Security, CAD Base
            create_holding(
                "h_cash_cad",
                HoldingType::Cash,
                "CASH:CAD",
                dec!(1000.0),
                "CAD",
                "CAD",
                Some(dec!(1000.0)),
                None,
            ), // CAD Cash
            create_holding(
                "h_cash_usd",
                HoldingType::Cash,
                "CASH:USD",
                dec!(500.0),
                "USD",
                "CAD",
                Some(dec!(500.0)),
                None,
            ), // USD Cash, CAD Base
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());

        // --- Assertions for XYZ.TO (CAD) ---
        let h1 = holdings.iter().find(|h| h.id == "h1").unwrap();
        assert_decimal_approx(h1.fx_rate, dec!(1.0), TOLERANCE, "h1 FX Rate");
        assert_monetary_value_approx(
            Some(&h1.market_value),
            dec!(1500.0),
            dec!(1500.0),
            TOLERANCE,
            "h1 Market Value",
        );
        assert_monetary_value_approx(
            h1.cost_basis.as_ref(),
            dec!(1400.0),
            dec!(1400.0),
            TOLERANCE,
            "h1 Cost Basis",
        );
        assert_monetary_value_approx(
            h1.day_change.as_ref(),
            dec!(50.0),
            dec!(50.0),
            TOLERANCE,
            "h1 Day Change",
        );

        // --- Assertions for AAPL (USD -> CAD) ---
        let h2 = holdings.iter().find(|h| h.id == "h2").unwrap();
        assert_decimal_approx(h2.fx_rate, usd_cad_rate, TOLERANCE, "h2 FX Rate");
        assert_monetary_value_approx(
            Some(&h2.market_value),
            dec!(2000.0),
            dec!(2600.0),
            TOLERANCE,
            "h2 Market Value",
        );
        assert_monetary_value_approx(
            h2.cost_basis.as_ref(),
            dec!(1800.0),
            dec!(2340.0),
            TOLERANCE,
            "h2 Cost Basis",
        );
        assert_monetary_value_approx(
            h2.day_change.as_ref(),
            dec!(100.0),
            dec!(130.0),
            TOLERANCE,
            "h2 Day Change",
        );

        // --- Assertions for ADS.DE (EUR -> CAD) ---
        let h3 = holdings.iter().find(|h| h.id == "h3").unwrap();
        assert_decimal_approx(h3.fx_rate, eur_cad_rate, TOLERANCE, "h3 FX Rate"); // 1.45
        let expected_h3_mv_local = dec!(1000.0); // 5 * 200 EUR
        let expected_h3_mv_base = expected_h3_mv_local * eur_cad_rate; // 1000 * 1.45 = 1450 CAD
        let expected_h3_cost_local = dec!(950.0); // EUR
        let expected_h3_cost_base = expected_h3_cost_local * eur_cad_rate; // 950 * 1.45 = 1377.5 CAD
        let expected_h3_prev_local = dec!(990.0); // 5 * 198 EUR
        let expected_h3_day_change_local = expected_h3_mv_local - expected_h3_prev_local; // 1000 - 990 = 10 EUR
        let expected_h3_day_change_base = expected_h3_day_change_local * eur_cad_rate; // 10 * 1.45 = 14.5 CAD
        assert_monetary_value_approx(
            Some(&h3.market_value),
            expected_h3_mv_local,
            expected_h3_mv_base,
            TOLERANCE,
            "h3 Market Value",
        );
        assert_monetary_value_approx(
            h3.cost_basis.as_ref(),
            expected_h3_cost_local,
            expected_h3_cost_base,
            TOLERANCE,
            "h3 Cost Basis",
        );
        assert_monetary_value_approx(
            h3.day_change.as_ref(),
            expected_h3_day_change_local,
            expected_h3_day_change_base,
            TOLERANCE,
            "h3 Day Change",
        );

        // --- Assertions for Cash CAD ---
        let h_cash_cad = holdings.iter().find(|h| h.id == "h_cash_cad").unwrap();
        assert_decimal_approx(h_cash_cad.fx_rate, dec!(1.0), TOLERANCE, "Cash CAD FX Rate");
        assert_monetary_value_approx(
            Some(&h_cash_cad.market_value),
            dec!(1000.0),
            dec!(1000.0),
            TOLERANCE,
            "Cash CAD Market Value",
        );

        // --- Assertions for Cash USD -> CAD ---
        let h_cash_usd = holdings.iter().find(|h| h.id == "h_cash_usd").unwrap();
        assert_decimal_approx(
            h_cash_usd.fx_rate,
            usd_cad_rate,
            TOLERANCE,
            "Cash USD FX Rate",
        );
        assert_monetary_value_approx(
            Some(&h_cash_usd.market_value),
            dec!(500.0),
            dec!(650.0),
            TOLERANCE,
            "Cash USD Market Value",
        );
    }

    #[tokio::test]
    async fn test_missing_market_data() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        // NO market data added for "MISSING"
        market_data_service.add_quote_pair(
            "XYZ.TO",
            create_quote("2024-01-10", dec!(150.0), "CAD"),
            Some(create_quote("2024-01-09", dec!(145.0), "CAD")),
        );

        let mut holdings = vec![
            create_holding(
                "h1",
                HoldingType::Security,
                "XYZ.TO",
                dec!(10),
                "CAD",
                "CAD",
                Some(dec!(1400.0)),
                Some("XYZ Corp"),
            ), // Has data
            create_holding(
                "h_missing",
                HoldingType::Security,
                "MISSING",
                dec!(100),
                "USD",
                "CAD",
                Some(dec!(5000.0)),
                Some("Missing Co"),
            ), // Missing data
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());

        // Check the holding with data is still processed
        let h1 = holdings.iter().find(|h| h.id == "h1").unwrap();
        assert_monetary_value_approx(
            Some(&h1.market_value),
            dec!(1500.0),
            dec!(1500.0),
            TOLERANCE,
            "h1 Market Value (Missing Test)",
        );
        assert_monetary_value_approx(
            h1.day_change.as_ref(),
            dec!(50.0),
            dec!(50.0),
            TOLERANCE,
            "h1 Day Change (Missing Test)",
        );

        // Check the holding with missing data has zero/None values
        let h_missing = holdings.iter().find(|h| h.id == "h_missing").unwrap();
        assert_eq!(
            h_missing.market_value,
            MonetaryValue::zero(),
            "Missing holding market value should be zero"
        );
        assert!(
            h_missing.price.is_none(),
            "Missing holding price should be None"
        );
        assert!(
            h_missing.unrealized_gain.is_none(),
            "Missing holding unrealized gain should be None"
        );
        assert!(
            h_missing.unrealized_gain_pct.is_none(),
            "Missing holding unrealized gain pct should be None"
        );
        assert!(
            h_missing.day_change.is_none(),
            "Missing holding day change should be None"
        );
        assert!(
            h_missing.day_change_pct.is_none(),
            "Missing holding day change pct should be None"
        );
        assert!(
            h_missing.prev_close_value.is_none(),
            "Missing holding prev close should be None"
        );
        // Cost basis should still be calculated based on FX rate
        let usd_cad_rate = _fx_service.get_latest_exchange_rate("USD", "CAD").unwrap();
        assert_monetary_value_approx(
            h_missing.cost_basis.as_ref(),
            dec!(5000.0),
            dec!(5000.0) * usd_cad_rate,
            TOLERANCE,
            "Missing holding cost basis",
        );
        assert_decimal_approx(
            h_missing.fx_rate,
            usd_cad_rate,
            TOLERANCE,
            "Missing holding FX rate",
        );
    }

    #[tokio::test]
    async fn test_missing_previous_day_quote() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        // Add only latest quote, no previous quote
        market_data_service.add_quote_pair(
            "XYZ.TO",
            create_quote("2024-01-10", dec!(150.0), "CAD"),
            None,
        );

        let mut holdings = vec![create_holding(
            "h1",
            HoldingType::Security,
            "XYZ.TO",
            dec!(10),
            "CAD",
            "CAD",
            Some(dec!(1400.0)),
            Some("XYZ Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // Market value and unrealized gain should be calculated
        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(1500.0),
            dec!(1500.0),
            TOLERANCE,
            "Market Value (No Prev Quote)",
        );
        assert_monetary_value_approx(
            holding.unrealized_gain.as_ref(),
            dec!(100.0),
            dec!(100.0),
            TOLERANCE,
            "Unrealized Gain (No Prev Quote)",
        );

        // Day change related fields should be None
        assert!(
            holding.day_change.is_none(),
            "Day change should be None when prev quote missing"
        );
        assert!(
            holding.day_change_pct.is_none(),
            "Day change pct should be None when prev quote missing"
        );
        assert!(
            holding.prev_close_value.is_none(),
            "Prev close value should be None when prev quote missing"
        );
    }

    #[tokio::test]
    async fn test_fx_service_error_fallback() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();

        // Set USD->CAD rate lookup to fail
        fx_service.set_fail("USD", "CAD", true);

        market_data_service.add_quote_pair(
            "AAPL",
            create_quote("2024-01-10", dec!(100.0), "USD"),
            Some(create_quote("2024-01-09", dec!(95.0), "USD")),
        );

        let mut holdings = vec![
            create_holding(
                "h_usd",
                HoldingType::Security,
                "AAPL",
                dec!(20),
                "USD",
                "CAD",
                Some(dec!(1800.0)),
                None,
            ), // USD Security, CAD Base
            create_holding(
                "h_cash_usd",
                HoldingType::Cash,
                "CASH:USD",
                dec!(500.0),
                "USD",
                "CAD",
                Some(dec!(500.0)),
                None,
            ), // USD Cash, CAD Base
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());

        // Security - FX rate fallback to 1.0
        let h_sec = holdings.iter().find(|h| h.id == "h_usd").unwrap();
        assert_decimal_approx(
            h_sec.fx_rate,
            dec!(1.0),
            TOLERANCE,
            "Security FX Rate Fallback",
        );
        assert_monetary_value_approx(
            Some(&h_sec.market_value),
            dec!(2000.0),
            dec!(2000.0),
            TOLERANCE,
            "Security Market Value Fallback",
        ); // Base uses fallback rate
        assert_monetary_value_approx(
            h_sec.cost_basis.as_ref(),
            dec!(1800.0),
            dec!(1800.0),
            TOLERANCE,
            "Security Cost Basis Fallback",
        ); // Base uses fallback rate
        assert_monetary_value_approx(
            h_sec.unrealized_gain.as_ref(),
            dec!(200.0),
            dec!(200.0),
            TOLERANCE,
            "Security Unrealized Gain Fallback",
        );
        assert_monetary_value_approx(
            h_sec.prev_close_value.as_ref(),
            dec!(1900.0),
            dec!(1900.0),
            TOLERANCE,
            "Security Prev Close Fallback",
        );
        assert_monetary_value_approx(
            h_sec.day_change.as_ref(),
            dec!(100.0),
            dec!(100.0),
            TOLERANCE,
            "Security Day Change Fallback",
        );

        // Cash - FX rate fallback to 1.0
        let h_cash = holdings.iter().find(|h| h.id == "h_cash_usd").unwrap();
        assert_decimal_approx(
            h_cash.fx_rate,
            dec!(1.0),
            TOLERANCE,
            "Cash FX Rate Fallback",
        );
        assert_monetary_value_approx(
            Some(&h_cash.market_value),
            dec!(500.0),
            dec!(500.0),
            TOLERANCE,
            "Cash Market Value Fallback",
        );
        assert_monetary_value_approx(
            h_cash.cost_basis.as_ref(),
            dec!(500.0),
            dec!(500.0),
            TOLERANCE,
            "Cash Cost Basis Fallback",
        );
    }

    #[tokio::test]
    async fn test_market_data_service_error() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        // Set market data service to fail
        {
            let mut fail_flag = market_data_service.should_fail.lock().unwrap();
            *fail_flag = true;
        }

        let mut holdings = vec![create_holding(
            "h1",
            HoldingType::Security,
            "XYZ.TO",
            dec!(10),
            "CAD",
            "CAD",
            Some(dec!(1400.0)),
            Some("XYZ Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        // The service itself doesn't return the error, it logs warnings and continues
        // Let's check if the values are default/zeroed as expected when quotes aren't found due to the error
        assert!(
            result.is_err(),
            "Expected an error when market data service fails"
        ); // Expect Err result

        /* // Original checks removed as the function should return Err, not modify holdings.
        let holding = &holdings[0];
        assert_eq!(holding.market_value, MonetaryValue::zero(), "Market value should be zero on MD error");
        assert!(holding.price.is_none(), "Price should be None on MD error");
        // ... existing code ...
        assert!(holding.day_change.is_none(), "Day change should be None on MD error");
        // Cost basis base should still be calculated using FX
        assert_monetary_value_approx(holding.cost_basis.as_ref(), dec!(1400.0), dec!(1400.0), TOLERANCE, "Cost Basis on MD error");
        assert_decimal_approx(holding.fx_rate, dec!(1.0), TOLERANCE, "FX Rate on MD error");
        */
    }

    #[tokio::test]
    async fn test_zero_quantity_security() {
        let (_fx_service, market_data_service, valuation_service) = setup_test_env();

        market_data_service.add_quote_pair(
            "XYZ.TO",
            create_quote("2024-01-10", dec!(150.0), "CAD"),
            Some(create_quote("2024-01-09", dec!(145.0), "CAD")),
        );

        let mut holdings = vec![create_holding(
            "h_zero",
            HoldingType::Security,
            "XYZ.TO",
            dec!(0.0),
            "CAD",
            "CAD",
            Some(dec!(0.0)),
            Some("Zero Corp"),
        )];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        assert_eq!(holding.market_value, MonetaryValue::zero(), "Zero Qty MV");
        assert!(holding.price.is_none(), "Zero Qty Price");
        assert!(holding.unrealized_gain.is_none(), "Zero Qty Unrealized");
        assert!(
            holding.unrealized_gain_pct.is_none(),
            "Zero Qty Unrealized Pct"
        );
        assert!(holding.day_change.is_none(), "Zero Qty Day Change");
        assert!(holding.day_change_pct.is_none(), "Zero Qty Day Change Pct");
        assert!(holding.prev_close_value.is_none(), "Zero Qty Prev Close");
        assert_monetary_value_approx(
            holding.cost_basis.as_ref(),
            dec!(0.0),
            dec!(0.0),
            TOLERANCE,
            "Zero Qty Cost Basis",
        );
        assert_decimal_approx(holding.fx_rate, dec!(1.0), TOLERANCE, "Zero Qty FX Rate");
    }

    #[tokio::test]
    async fn test_missing_cost_basis_security() {
        let (fx_service, market_data_service, valuation_service) = setup_test_env();
        let usd_cad_rate = fx_service.get_latest_exchange_rate("USD", "CAD").unwrap();

        market_data_service.add_quote_pair(
            "AAPL",
            create_quote("2024-01-10", dec!(100.0), "USD"),
            Some(create_quote("2024-01-09", dec!(95.0), "USD")),
        );

        let mut holdings = vec![
            create_holding(
                "h_no_cost",
                HoldingType::Security,
                "AAPL",
                dec!(20),
                "USD",
                "CAD",
                None,
                Some("Apple Inc."),
            ), // No cost basis provided
        ];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // Market value, price, day change etc should be calculated
        assert_decimal_approx(holding.price, dec!(100.0), TOLERANCE, "Price (No Cost)");
        assert_decimal_approx(
            holding.fx_rate,
            usd_cad_rate,
            TOLERANCE,
            "FX Rate (No Cost)",
        );
        assert_monetary_value_approx(
            Some(&holding.market_value),
            dec!(2000.0),
            dec!(2600.0),
            TOLERANCE,
            "Market Value (No Cost)",
        );
        assert_monetary_value_approx(
            holding.day_change.as_ref(),
            dec!(100.0),
            dec!(130.0),
            TOLERANCE,
            "Day Change (No Cost)",
        );
        assert_decimal_approx(
            holding.day_change_pct,
            dec!(0.0526),
            TOLERANCE,
            "Day Change Pct (No Cost)",
        );

        // Cost basis and related fields should be None
        assert!(holding.cost_basis.is_none(), "Cost Basis should be None");
        assert!(
            holding.unrealized_gain.is_none(),
            "Unrealized Gain should be None"
        );
        assert!(
            holding.unrealized_gain_pct.is_none(),
            "Unrealized Gain Pct should be None"
        );
        assert!(holding.total_gain.is_none(), "Total Gain should be None");
        assert!(
            holding.total_gain_pct.is_none(),
            "Total Gain Pct should be None"
        );
    }

    #[tokio::test]
    async fn test_missing_instrument_security() {
        let (_fx_service, _market_data_service, valuation_service) = setup_test_env();

        let mut holding_no_instrument = create_holding(
            "h_no_inst",
            HoldingType::Security,
            "XYZ",
            dec!(10),
            "CAD",
            "CAD",
            Some(dec!(100.0)),
            Some("XYZ"),
        );
        holding_no_instrument.instrument = None; // Manually remove instrument

        let mut holdings = vec![holding_no_instrument];

        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        let holding = &holdings[0];

        // All valuation fields should remain default/None as instrument is required for lookup
        assert_eq!(
            holding.market_value,
            MonetaryValue::zero(),
            "MV No Instrument"
        );
        assert!(holding.price.is_none(), "Price No Instrument");
        assert!(holding.fx_rate.is_none(), "FX Rate No Instrument");
        // Cost basis remains as it was initially set, but base is not calculated
        assert_eq!(holding.cost_basis.as_ref().unwrap().local, dec!(100.0));
        assert_eq!(holding.cost_basis.as_ref().unwrap().base, dec!(0.0));
        assert!(
            holding.unrealized_gain.is_none(),
            "Unrealized No Instrument"
        );
        assert!(holding.day_change.is_none(), "Day Change No Instrument");
    }

    #[tokio::test]
    async fn test_empty_holdings_list() {
        let (_fx_service, _market_data_service, valuation_service) = setup_test_env();
        let mut holdings: Vec<Holding> = vec![];
        let result = valuation_service
            .calculate_holdings_live_valuation(&mut holdings)
            .await;
        assert!(result.is_ok());
        assert!(holdings.is_empty()); // Should remain empty
    }
}
