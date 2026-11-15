use super::currency::normalize_currency_code;
use super::fx_model::{
    ExchangeRate, ExchangeRateDateQuery, ExchangeRateDateResult, NewExchangeRate,
};
use crate::errors::Result;
use crate::quotes::Quote;
use async_trait::async_trait;
use chrono::{NaiveDate, NaiveDateTime};
use rust_decimal::Decimal;

/// Trait defining the contract for FX repository operations.
#[async_trait]
pub trait FxRepositoryTrait: Send + Sync {
    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>>;
    fn get_historical_exchange_rates(&self) -> Result<Vec<ExchangeRate>>;
    fn get_latest_exchange_rate(&self, from: &str, to: &str) -> Result<Option<ExchangeRate>>;
    fn get_latest_exchange_rate_by_symbol(&self, symbol: &str) -> Result<Option<ExchangeRate>>;
    fn get_historical_quotes(
        &self,
        symbol: &str,
        start_date: NaiveDateTime,
        end_date: NaiveDateTime,
    ) -> Result<Vec<Quote>>;
    async fn add_quote(
        &self,
        symbol: String,
        date: String,
        rate: Decimal,
        source: String,
    ) -> Result<Quote>;
    async fn save_exchange_rate(&self, rate: ExchangeRate) -> Result<ExchangeRate>;
    async fn update_exchange_rate(&self, rate: &ExchangeRate) -> Result<ExchangeRate>;
    async fn delete_exchange_rate(&self, rate_id: &str) -> Result<()>;
    async fn create_fx_asset(
        &self,
        from_currency: &str,
        to_currency: &str,
        source: &str,
    ) -> Result<String>;
}

/// Trait defining the contract for FX service operations.
#[async_trait]
pub trait FxServiceTrait: Send + Sync {
    fn initialize(&self) -> Result<()>;

    fn get_historical_rates(
        &self,
        from_currency: &str,
        to_currency: &str,
        days: i64,
    ) -> Result<Vec<ExchangeRate>>;
    fn get_latest_exchange_rate(&self, from_currency: &str, to_currency: &str) -> Result<Decimal>;
    fn get_exchange_rate_for_date(
        &self,
        from_currency: &str,
        to_currency: &str,
        date: NaiveDate,
    ) -> Result<Decimal>;
    /// Resolves a historical rate for each requested (currency pair, date).
    /// Never fails the whole batch for one bad pair — each result carries
    /// either a rate or an error.
    fn get_exchange_rates_for_dates(
        &self,
        pairs: Vec<ExchangeRateDateQuery>,
    ) -> Vec<ExchangeRateDateResult> {
        pairs
            .into_iter()
            .map(|pair| {
                match self.get_exchange_rate_for_date(
                    &pair.from_currency,
                    &pair.to_currency,
                    pair.date,
                ) {
                    Ok(rate) => ExchangeRateDateResult {
                        from_currency: pair.from_currency,
                        to_currency: pair.to_currency,
                        date: pair.date,
                        rate: Some(rate),
                        error: None,
                    },
                    Err(e) => ExchangeRateDateResult {
                        from_currency: pair.from_currency,
                        to_currency: pair.to_currency,
                        date: pair.date,
                        rate: None,
                        error: Some(e.to_string()),
                    },
                }
            })
            .collect()
    }
    fn convert_currency(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
    ) -> Result<Decimal>;
    fn convert_currency_for_date(
        &self,
        amount: Decimal,
        from_currency: &str,
        to_currency: &str,
        date: NaiveDate,
    ) -> Result<Decimal>;
    fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>>;
    async fn add_exchange_rate(&self, new_rate: NewExchangeRate) -> Result<ExchangeRate>;
    async fn update_exchange_rate(
        &self,
        from_currency: &str,
        to_currency: &str,
        rate: Decimal,
    ) -> Result<ExchangeRate>;
    async fn delete_exchange_rate(&self, rate_id: &str) -> Result<()>;
    async fn register_currency_pair(&self, from_currency: &str, to_currency: &str) -> Result<()>;
    async fn register_currency_pair_manual(
        &self,
        from_currency: &str,
        to_currency: &str,
    ) -> Result<()>;

    /// Registers multiple FX pairs in batch.
    /// Pairs are (from_currency, to_currency).
    async fn ensure_fx_pairs(&self, pairs: Vec<(String, String)>) -> Result<()>;

    /// For each registered pair that has no conversion path at all (no direct
    /// rate and no route through other stored rates), registers `from/pivot`
    /// and `pivot/to`. The converter already routes through any stored pairs,
    /// so once those two have rates, `from -> to` converts through the pivot
    /// while a direct rate, when it exists, still wins as the shorter path.
    ///
    /// Providers do not quote every cross (Yahoo has no `COPAED=X`), and
    /// nothing else would register the legs. Returns the pivot pairs it
    /// asked for, deduplicated, in the order first needed, with canonical
    /// codes. A leg that fails to register is logged and does not stop the
    /// others.
    async fn ensure_pivot_fx_pairs(
        &self,
        pairs: Vec<(String, String)>,
        pivot: &str,
    ) -> Result<Vec<(String, String)>> {
        // Older versions stored some FX pairs as entered (`cop/AED`), while new
        // FX assets need upper-case codes. Normalize before upper-casing, so a
        // minor unit such as `GBp` maps to its major currency rather than to a
        // different code.
        let canonical = |code: &str| normalize_currency_code(code.trim()).to_ascii_uppercase();
        let pivot = canonical(pivot);
        let mut wanted: Vec<(String, String)> = Vec::new();
        for (from, to) in pairs {
            let (from, to) = (canonical(&from), canonical(&to));
            if from == to || from == pivot || to == pivot || from.is_empty() || to.is_empty() {
                continue;
            }
            if self.get_latest_exchange_rate(&from, &to).is_ok() {
                continue;
            }
            for leg in [(from.clone(), pivot.clone()), (pivot.clone(), to.clone())] {
                if !wanted.contains(&leg) {
                    wanted.push(leg);
                }
            }
        }
        for (from, to) in &wanted {
            if let Err(error) = self.register_currency_pair(from, to).await {
                log::warn!("Failed to register FX pivot pair {from}/{to}: {error}");
            }
        }
        Ok(wanted)
    }
}
