use super::currency_converter::CurrencyConverter;
use super::fx_errors::FxError;
use super::fx_model::{ExchangeRate, NewExchangeRate};
use super::fx_traits::{FxRepositoryTrait, FxServiceTrait};
use crate::errors::Result;
use crate::events::{DomainEvent, DomainEventSink, NoOpDomainEventSink};
use crate::fx::currency::{denormalization_multiplier, normalize_currency_code};
use crate::quotes::constants::{DATA_SOURCE_MANUAL, DATA_SOURCE_YAHOO};
use async_trait::async_trait;
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use std::collections::HashSet;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct FxService {
    repository: Arc<dyn FxRepositoryTrait>,
    converter: Arc<RwLock<Option<CurrencyConverter>>>,
    event_sink: Arc<dyn DomainEventSink>,
}

impl FxService {
    pub const DEFAULT_DATA_SOURCE: &'static str = DATA_SOURCE_MANUAL;

    pub fn new(repository: Arc<dyn FxRepositoryTrait>) -> Self {
        Self {
            repository,
            converter: Arc::new(RwLock::new(None)),
            event_sink: Arc::new(NoOpDomainEventSink),
        }
    }

    /// Sets the domain event sink for this service.
    pub fn with_event_sink(mut self, event_sink: Arc<dyn DomainEventSink>) -> Self {
        self.event_sink = event_sink;
        self
    }

    /// Initialize the currency converter with all exchange rates, filling missing days
    fn initialize_converter(&self) -> Result<()> {
        let all_historical_rates = self.repository.get_historical_exchange_rates()?;

        if all_historical_rates.is_empty() {
            log::warn!("No exchange rates available, converter not initialized");
            let mut converter_lock = self
                .converter
                .write()
                .map_err(|e| FxError::CacheError(e.to_string()))?;
            *converter_lock = None;
            return Ok(());
        }

        match CurrencyConverter::new(all_historical_rates) {
            Ok(converter) => {
                let mut converter_lock = self
                    .converter
                    .write()
                    .map_err(|e| FxError::CacheError(e.to_string()))?;
                *converter_lock = Some(converter);
                Ok(())
            }
            Err(e) => {
                log::error!("Failed to initialize currency converter: {}", e);
                let mut converter_lock = self
                    .converter
                    .write()
                    .map_err(|e| FxError::CacheError(e.to_string()))?;
                *converter_lock = None;
                Err(e.into())
            }
        }
    }

    fn load_latest_exchange_rate(&self, from: &str, to: &str) -> Result<ExchangeRate> {
        match self.repository.get_latest_exchange_rate(from, to)? {
            Some(rate) => Ok(rate),
            None => {
                // Try inverse rate via instrument_key
                let inverse_key = ExchangeRate::make_instrument_key(to, from);
                match self
                    .repository
                    .get_latest_exchange_rate_by_symbol(&inverse_key)?
                {
                    Some(inverse_rate) => {
                        let direct_rate = ExchangeRate {
                            id: inverse_rate.id,
                            from_currency: from.to_string(),
                            to_currency: to.to_string(),
                            rate: Decimal::ONE / inverse_rate.rate,
                            source: inverse_rate.source,
                            timestamp: inverse_rate.timestamp,
                        };

                        Ok(direct_rate)
                    }
                    None => Err(FxError::RateNotFound(format!(
                        "Exchange rate not found for {}/{}",
                        from, to
                    ))
                    .into()),
                }
            }
        }
    }

    fn normalize_currency_pair<'a>(
        from_currency: &'a str,
        to_currency: &'a str,
    ) -> (&'a str, &'a str, Decimal, Decimal) {
        let normalized_from = normalize_currency_code(from_currency);
        let normalized_to = normalize_currency_code(to_currency);

        let source_multiplier = if normalized_from == from_currency {
            Decimal::ONE
        } else {
            Decimal::ONE / denormalization_multiplier(from_currency)
        };

        let target_multiplier = denormalization_multiplier(to_currency);

        (
            normalized_from,
            normalized_to,
            source_multiplier,
            target_multiplier,
        )
    }

    fn get_latest_rate_between_normalized(&self, from: &str, to: &str) -> Result<Decimal> {
        if from == to {
            return Ok(Decimal::ONE);
        }

        if let Ok(converter_lock) = self.converter.read() {
            if let Some(converter) = &*converter_lock {
                let today = Utc::now().naive_utc().date();
                if let Ok(rate) = converter.get_rate_nearest(from, to, today) {
                    return Ok(rate);
                }
            }
        }

        let rate = self.load_latest_exchange_rate(from, to)?;
        Ok(rate.rate)
    }

    fn get_rate_for_date_between_normalized(
        &self,
        from: &str,
        to: &str,
        date: NaiveDate,
    ) -> Result<Decimal> {
        if from == to {
            return Ok(Decimal::ONE);
        }

        if let Ok(converter_lock) = self.converter.read() {
            if let Some(converter) = &*converter_lock {
                if let Ok(rate) = converter.get_rate_nearest(from, to, date) {
                    return Ok(rate);
                }
            }
        }

        let latest_rate = self.load_latest_exchange_rate(from, to)?;
        let fallback_date = latest_rate.timestamp.date_naive();

        log::warn!(
            "No exchange rate found for {}/{} on {}. Using fallback rate from {}",
            from,
            to,
            date,
            fallback_date
        );

        Ok(latest_rate.rate)
    }
}

#[async_trait]
impl FxServiceTrait for FxService {
    fn initialize(&self) -> Result<()> {
        self.initialize_converter()?;
        Ok(())
    }

    async fn add_exchange_rate(&self, new_rate: NewExchangeRate) -> Result<ExchangeRate> {
        // Create/get the FX asset — returns the asset UUID
        let asset_id = self
            .repository
            .create_fx_asset(
                &new_rate.from_currency,
                &new_rate.to_currency,
                new_rate.source.as_str(),
            )
            .await?;

        let rate = ExchangeRate {
            id: asset_id,
            from_currency: new_rate.from_currency,
            to_currency: new_rate.to_currency,
            rate: new_rate.rate,
            source: new_rate.source,
            timestamp: Utc::now(),
        };

        // Only MANUAL rates carry a user-supplied value worth persisting. For
        // provider-backed sources the rate is fetched by the market-data sync;
        // persisting the request's placeholder here would write a fake quote
        // (e.g. "1") stamped on a non-trading day that the sync can never
        // overwrite, since providers only return quotes for trading days (#1143).
        if rate.source == DATA_SOURCE_MANUAL {
            self.repository.save_exchange_rate(rate).await
        } else {
            Ok(rate)
        }
    }

    fn get_historical_rates(&self, from: &str, to: &str, days: i64) -> Result<Vec<ExchangeRate>> {
        let normalized_from = normalize_currency_code(from);
        let normalized_to = normalize_currency_code(to);

        let instrument_key = ExchangeRate::make_instrument_key(normalized_from, normalized_to);
        let end = Utc::now();
        let start = end - chrono::Duration::days(days);

        match self.repository.get_historical_quotes(
            &instrument_key,
            start.naive_utc(),
            end.naive_utc(),
        ) {
            Ok(quotes) => Ok(quotes
                .into_iter()
                .map(|q| ExchangeRate {
                    id: q.asset_id.clone(),
                    from_currency: normalized_from.to_string(),
                    to_currency: normalized_to.to_string(),
                    rate: q.close,
                    source: q.data_source.clone(),
                    timestamp: q.timestamp,
                })
                .collect()),
            Err(e) => {
                Err(FxError::FetchError(format!("Failed to fetch historical rates: {}", e)).into())
            }
        }
    }

    async fn update_exchange_rate(
        &self,
        from: &str,
        to: &str,
        rate: Decimal,
    ) -> Result<ExchangeRate> {
        let new_rate = NewExchangeRate {
            from_currency: from.to_string(),
            to_currency: to.to_string(),
            rate,
            source: DATA_SOURCE_MANUAL.to_string(),
        };
        self.add_exchange_rate(new_rate).await
    }

    fn get_latest_exchange_rate(&self, from_currency: &str, to_currency: &str) -> Result<Decimal> {
        let (normalized_from, normalized_to, source_multiplier, target_multiplier) =
            Self::normalize_currency_pair(from_currency, to_currency);

        if normalized_from == normalized_to {
            return Ok(source_multiplier * target_multiplier);
        }

        let base_rate =
            match self.get_latest_rate_between_normalized(normalized_from, normalized_to) {
                Ok(rate) => rate,
                Err(e) => {
                    log::error!(
                        "Exchange rate not available for {}/{}",
                        normalized_from,
                        normalized_to
                    );
                    return Err(e);
                }
            };

        Ok(source_multiplier * base_rate * target_multiplier)
    }

    fn get_exchange_rate_for_date(
        &self,
        from_currency: &str,
        to_currency: &str,
        date: NaiveDate,
    ) -> Result<Decimal> {
        if from_currency.len() != 3 || !from_currency.chars().all(|c| c.is_alphabetic()) {
            return Err(FxError::InvalidCurrencyCode(format!(
                "Invalid currency code: {}",
                from_currency
            ))
            .into());
        }

        if to_currency.len() != 3 || !to_currency.chars().all(|c| c.is_alphabetic()) {
            return Err(FxError::InvalidCurrencyCode(format!(
                "Invalid currency code: {}",
                to_currency
            ))
            .into());
        }

        let (normalized_from, normalized_to, source_multiplier, target_multiplier) =
            Self::normalize_currency_pair(from_currency, to_currency);

        if normalized_from == normalized_to {
            return Ok(source_multiplier * target_multiplier);
        }

        let base_rate =
            self.get_rate_for_date_between_normalized(normalized_from, normalized_to, date)?;

        Ok(source_multiplier * base_rate * target_multiplier)
    }

    fn convert_currency(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
    ) -> Result<Decimal> {
        if from_currency.eq(to_currency) {
            return Ok(amount);
        }

        let rate = self.get_latest_exchange_rate(from_currency, to_currency)?;
        Ok(amount * rate)
    }

    fn convert_currency_for_date(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
        date: NaiveDate,
    ) -> Result<Decimal> {
        if from_currency.eq(to_currency) {
            return Ok(amount);
        }

        let rate = self.get_exchange_rate_for_date(from_currency, to_currency, date)?;
        Ok(amount * rate)
    }

    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
        self.repository.get_latest_exchange_rates()
    }

    async fn delete_exchange_rate(&self, rate_id: &str) -> Result<()> {
        self.repository.delete_exchange_rate(rate_id).await?;

        // Reinitialize the converter with updated rates
        self.initialize_converter()?;

        Ok(())
    }

    async fn register_currency_pair(&self, from: &str, to: &str) -> Result<()> {
        if from == to || from.is_empty() || to.is_empty() {
            return Ok(());
        }

        let normalized_from = normalize_currency_code(from);
        let normalized_to = normalize_currency_code(to);

        if normalized_from.is_empty() || normalized_to.is_empty() {
            return Ok(());
        }

        // Minor/major aliases (e.g., GBp -> GBP) may normalize to the same code.
        // Never create synthetic same-currency FX assets.
        if normalized_from == normalized_to {
            return Ok(());
        }

        let existing_rate = self
            .load_latest_exchange_rate(normalized_from, normalized_to)
            .ok();

        if existing_rate.is_none() {
            let asset_id = self
                .repository
                .create_fx_asset(normalized_from, normalized_to, DATA_SOURCE_YAHOO)
                .await?;

            self.event_sink
                .emit(DomainEvent::assets_created(vec![asset_id]));
        }

        Ok(())
    }

    async fn register_currency_pair_manual(&self, from: &str, to: &str) -> Result<()> {
        if from == to || from.is_empty() || to.is_empty() {
            return Ok(());
        }

        let normalized_from = normalize_currency_code(from);
        let normalized_to = normalize_currency_code(to);

        if normalized_from.is_empty() || normalized_to.is_empty() {
            return Ok(());
        }

        // Minor/major aliases (e.g., GBp -> GBP) may normalize to the same code.
        // Never create synthetic same-currency FX assets.
        if normalized_from == normalized_to {
            return Ok(());
        }

        let existing_rate = self
            .load_latest_exchange_rate(normalized_from, normalized_to)
            .ok();

        if existing_rate.is_none() {
            let asset_id = self
                .repository
                .create_fx_asset(normalized_from, normalized_to, DATA_SOURCE_MANUAL)
                .await?;

            self.event_sink
                .emit(DomainEvent::assets_created(vec![asset_id]));
        }

        Ok(())
    }

    async fn ensure_fx_pairs(&self, pairs: Vec<(String, String)>) -> Result<()> {
        let unique_pairs: HashSet<(String, String)> = pairs.into_iter().collect();

        for (from, to) in unique_pairs {
            if from != to {
                self.register_currency_pair(&from, &to).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quotes::Quote;
    use chrono::NaiveDateTime;
    use rust_decimal::Decimal;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockFxRepository {
        created_pairs: Mutex<Vec<(String, String, String)>>,
        saved_rates: Mutex<Vec<ExchangeRate>>,
    }

    #[async_trait]
    impl FxRepositoryTrait for MockFxRepository {
        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            Ok(vec![])
        }

        fn get_historical_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            Ok(vec![])
        }

        fn get_latest_exchange_rate(&self, _from: &str, _to: &str) -> Result<Option<ExchangeRate>> {
            Ok(None)
        }

        fn get_latest_exchange_rate_by_symbol(
            &self,
            _symbol: &str,
        ) -> Result<Option<ExchangeRate>> {
            Ok(None)
        }

        fn get_historical_quotes(
            &self,
            _symbol: &str,
            _start_date: NaiveDateTime,
            _end_date: NaiveDateTime,
        ) -> Result<Vec<Quote>> {
            Ok(vec![])
        }

        async fn add_quote(
            &self,
            _symbol: String,
            _date: String,
            _rate: Decimal,
            _source: String,
        ) -> Result<Quote> {
            unimplemented!()
        }

        async fn save_exchange_rate(&self, rate: ExchangeRate) -> Result<ExchangeRate> {
            self.saved_rates.lock().unwrap().push(rate.clone());
            Ok(rate)
        }

        async fn update_exchange_rate(&self, rate: &ExchangeRate) -> Result<ExchangeRate> {
            Ok(rate.clone())
        }

        async fn delete_exchange_rate(&self, _rate_id: &str) -> Result<()> {
            Ok(())
        }

        async fn create_fx_asset(
            &self,
            from_currency: &str,
            to_currency: &str,
            source: &str,
        ) -> Result<String> {
            self.created_pairs.lock().unwrap().push((
                from_currency.to_string(),
                to_currency.to_string(),
                source.to_string(),
            ));
            Ok(format!("FX:{}{}", from_currency, to_currency))
        }
    }

    #[tokio::test]
    async fn register_currency_pair_skips_minor_major_same_currency_after_normalization() {
        let repo = Arc::new(MockFxRepository::default());
        let service = FxService::new(repo.clone());

        service.register_currency_pair("GBp", "GBP").await.unwrap();

        assert!(
            repo.created_pairs.lock().unwrap().is_empty(),
            "GBp/GBP should not create an FX asset after normalization"
        );
    }

    #[tokio::test]
    async fn register_currency_pair_manual_skips_minor_major_same_currency_after_normalization() {
        let repo = Arc::new(MockFxRepository::default());
        let service = FxService::new(repo.clone());

        service
            .register_currency_pair_manual("GBp", "GBP")
            .await
            .unwrap();

        assert!(
            repo.created_pairs.lock().unwrap().is_empty(),
            "GBp/GBP should not create a manual FX asset after normalization"
        );
    }

    #[tokio::test]
    async fn register_currency_pair_creates_asset_for_distinct_currencies() {
        let repo = Arc::new(MockFxRepository::default());
        let service = FxService::new(repo.clone());

        service.register_currency_pair("USD", "CAD").await.unwrap();

        let created = repo.created_pairs.lock().unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].0, "USD");
        assert_eq!(created[0].1, "CAD");
    }

    #[tokio::test]
    async fn add_exchange_rate_manual_persists_quote() {
        let repo = Arc::new(MockFxRepository::default());
        let service = FxService::new(repo.clone());

        service
            .add_exchange_rate(NewExchangeRate {
                from_currency: "EUR".to_string(),
                to_currency: "USD".to_string(),
                rate: Decimal::new(11, 1), // 1.1
                source: DATA_SOURCE_MANUAL.to_string(),
            })
            .await
            .unwrap();

        let saved = repo.saved_rates.lock().unwrap();
        assert_eq!(saved.len(), 1, "manual rate should be persisted as a quote");
        assert_eq!(saved[0].rate, Decimal::new(11, 1));
    }

    #[tokio::test]
    async fn add_exchange_rate_provider_does_not_persist_placeholder_quote() {
        let repo = Arc::new(MockFxRepository::default());
        let service = FxService::new(repo.clone());

        // Provider-backed add with the frontend placeholder rate. The real rate
        // is fetched by the market-data sync, so no quote should be stored (#1143).
        service
            .add_exchange_rate(NewExchangeRate {
                from_currency: "EUR".to_string(),
                to_currency: "USD".to_string(),
                rate: Decimal::ONE,
                source: DATA_SOURCE_YAHOO.to_string(),
            })
            .await
            .unwrap();

        assert!(
            repo.saved_rates.lock().unwrap().is_empty(),
            "provider-backed add must not persist a placeholder quote"
        );
        assert_eq!(
            repo.created_pairs.lock().unwrap().len(),
            1,
            "provider-backed add should still register the FX asset for syncing"
        );
    }
}
