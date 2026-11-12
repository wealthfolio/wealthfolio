//! Exchange rate read tool (MCP-only).
//!
//! Reads the stored exchange rates valuations use: the latest rate of each
//! registered pair, or the rate of given currencies on given dates. It reads
//! stored rates only and never fetches from a market data provider.

use std::collections::BTreeSet;
use std::sync::Arc;

use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use wealthfolio_core::fx::{ExchangeRateDateQuery, FxServiceTrait};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Max dates per call.
const MAX_DATES: usize = 31;
/// Max currency-and-date lookups per call.
const MAX_LOOKUPS: usize = 200;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetExchangeRatesArgs {
    #[serde(default)]
    pub currencies: Vec<String>,
    #[serde(default)]
    pub dates: Vec<String>,
    #[serde(default)]
    pub to: Option<String>,
}

/// One rate: 1 unit of `from` is `rate` units of `to`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRateDto {
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<String>,
    /// The rate's own day for the latest rates; the requested day otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Currency codes as the FX service reads them (see `currency_code`).
fn currency_list(currencies: &[String]) -> Result<BTreeSet<String>, AgentToolError> {
    currencies
        .iter()
        .map(|code| {
            super::currency_code(code).ok_or_else(|| {
                AgentToolError::InvalidInput(format!(
                    "currency '{}' must be a currency code of letters, such as EUR or GBp",
                    code.trim()
                ))
            })
        })
        .collect()
}

fn latest_rates(
    fx: &dyn FxServiceTrait,
    currencies: &BTreeSet<String>,
) -> Result<Vec<ExchangeRateDto>, AgentToolError> {
    let mut rates: Vec<ExchangeRateDto> = fx
        .get_latest_exchange_rates()
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .into_iter()
        .filter(|rate| {
            currencies.is_empty()
                || currencies.contains(&rate.from_currency)
                || currencies.contains(&rate.to_currency)
        })
        .map(|rate| {
            // Storage lists a pair registered before its first quote with a
            // rate of 0, dated when it was registered; that is not a rate.
            if rate.rate <= Decimal::ZERO {
                return ExchangeRateDto {
                    from: rate.from_currency,
                    to: rate.to_currency,
                    rate: None,
                    date: None,
                    source: None,
                    error: Some("No rate is stored for this pair yet".to_string()),
                };
            }
            ExchangeRateDto {
                from: rate.from_currency,
                to: rate.to_currency,
                rate: Some(rate.rate.normalize().to_string()),
                date: Some(rate.timestamp.date_naive().to_string()),
                source: Some(rate.source),
                error: None,
            }
        })
        .collect();
    rates.sort_by(|a, b| (&a.from, &a.to).cmp(&(&b.from, &b.to)));
    Ok(rates)
}

fn dated_rates(
    fx: &dyn FxServiceTrait,
    currencies: &BTreeSet<String>,
    dates: &[NaiveDate],
    to: &str,
) -> Vec<ExchangeRateDto> {
    let queries = currencies
        .iter()
        .filter(|currency| currency.as_str() != to)
        .flat_map(|currency| {
            dates.iter().map(|date| ExchangeRateDateQuery {
                from_currency: currency.clone(),
                to_currency: to.to_string(),
                date: *date,
            })
        })
        .collect();
    fx.get_exchange_rates_for_dates(queries)
        .into_iter()
        .map(|result| ExchangeRateDto {
            from: result.from_currency,
            to: result.to_currency,
            rate: result.rate.map(|rate| rate.normalize().to_string()),
            date: Some(result.date.to_string()),
            source: None,
            error: result
                .error
                .map(|_| "No rate is stored for this pair on or before this date".to_string()),
        })
        .collect()
}

/// Read stored exchange rates.
pub struct GetExchangeRates;

#[async_trait::async_trait]
impl AgentTool for GetExchangeRates {
    fn name(&self) -> &'static str {
        "get_exchange_rates"
    }

    fn description(&self) -> &'static str {
        "Read the stored exchange rates that valuations use; nothing is fetched from a provider. Without dates: the latest rate of each registered currency pair (from, to, rate, the rate's date and source), optionally only pairs involving the given currencies; a pair with no stored rate yet returns an error instead. With dates (YYYY-MM-DD, up to 31): for each given currency, its rate into `to` (default: the base currency) on each date, as valuations would use it; a pair with no stored rate returns an error for that row. A rate means 1 unit of from = rate units of to."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "currencies": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Currency codes, such as USD; minor units such as GBp are case-sensitive. Required with dates."
                },
                "dates": {
                    "type": "array",
                    "maxItems": MAX_DATES,
                    "items": { "type": "string" },
                    "description": "Days to read the rates on, YYYY-MM-DD."
                },
                "to": { "type": "string", "description": "Target currency for dated rates; the base currency when left out." }
            }
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::HoldingsRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetExchangeRatesArgs = serde_json::from_value(args)?;
        let currencies = currency_list(&args.currencies)?;
        if args.dates.len() > MAX_DATES {
            return Err(AgentToolError::InvalidInput(format!(
                "Up to {MAX_DATES} dates per call, got {}",
                args.dates.len()
            )));
        }
        let dates = args
            .dates
            .iter()
            .map(|date| {
                NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|_| {
                    AgentToolError::InvalidInput(format!(
                        "date '{date}' isn't valid; use YYYY-MM-DD"
                    ))
                })
            })
            .collect::<Result<BTreeSet<_>, _>>()?
            .into_iter()
            .collect::<Vec<_>>();
        if !dates.is_empty() && currencies.is_empty() {
            return Err(AgentToolError::InvalidInput(
                "currencies are required with dates".to_string(),
            ));
        }
        if currencies.len() * dates.len() > MAX_LOOKUPS {
            return Err(AgentToolError::InvalidInput(format!(
                "Up to {MAX_LOOKUPS} currency-and-date lookups per call"
            )));
        }
        let base_currency = env.base_currency();
        let to = match args.to.as_deref() {
            Some(to) => currency_list(&[to.to_string()])?
                .into_iter()
                .next()
                .unwrap_or_default(),
            None => base_currency.clone(),
        };
        if !dates.is_empty() && to.trim().is_empty() {
            return Err(AgentToolError::InvalidInput(
                "No base currency is set; pass `to` for dated rates".to_string(),
            ));
        }
        let fx = env.fx_service().ok_or_else(|| {
            AgentToolError::ExecutionFailed(
                "Exchange rates are not available in this environment".to_string(),
            )
        })?;
        let rates = if dates.is_empty() {
            latest_rates(fx.as_ref(), &currencies)?
        } else {
            dated_rates(fx.as_ref(), &currencies, &dates, &to)
        };
        Ok(AgentToolResult {
            content: json!({
                "baseCurrency": base_currency,
                "rates": rates,
                "count": rates.len(),
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use wealthfolio_core::errors::Result;
    use wealthfolio_core::fx::{ExchangeRate, NewExchangeRate};

    /// Latest rates as storage lists them; every other call is unused here.
    struct LatestRates(Vec<ExchangeRate>);

    #[async_trait::async_trait]
    impl FxServiceTrait for LatestRates {
        fn initialize(&self) -> Result<()> {
            unimplemented!()
        }
        fn get_historical_rates(&self, _: &str, _: &str, _: i64) -> Result<Vec<ExchangeRate>> {
            unimplemented!()
        }
        fn get_latest_exchange_rate(&self, _: &str, _: &str) -> Result<Decimal> {
            unimplemented!()
        }
        fn get_exchange_rate_for_date(&self, _: &str, _: &str, _: NaiveDate) -> Result<Decimal> {
            unimplemented!()
        }
        fn convert_currency(&self, _: Decimal, _: &str, _: &str) -> Result<Decimal> {
            unimplemented!()
        }
        fn convert_currency_for_date(
            &self,
            _: Decimal,
            _: &str,
            _: &str,
            _: NaiveDate,
        ) -> Result<Decimal> {
            unimplemented!()
        }
        fn get_latest_exchange_rates(&self) -> Result<Vec<ExchangeRate>> {
            Ok(self.0.clone())
        }
        async fn add_exchange_rate(&self, _: NewExchangeRate) -> Result<ExchangeRate> {
            unimplemented!()
        }
        async fn update_exchange_rate(&self, _: &str, _: &str, _: Decimal) -> Result<ExchangeRate> {
            unimplemented!()
        }
        async fn delete_exchange_rate(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn register_currency_pair(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn register_currency_pair_manual(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }
        async fn ensure_fx_pairs(&self, _: Vec<(String, String)>) -> Result<()> {
            unimplemented!()
        }
    }

    fn rate(from: &str, rate: Decimal) -> ExchangeRate {
        ExchangeRate {
            id: format!("{from}USD=X"),
            from_currency: from.to_string(),
            to_currency: "USD".to_string(),
            rate,
            source: "YAHOO".to_string(),
            timestamp: Utc.with_ymd_and_hms(2026, 11, 9, 0, 0, 0).unwrap(),
        }
    }

    #[test]
    fn a_registered_pair_without_a_stored_rate_reports_no_rate() {
        // Storage lists a pair registered before its first quote with a rate of 0.
        let fx = LatestRates(vec![
            rate("SEK", Decimal::ZERO),
            rate("EUR", Decimal::new(1085, 3)),
        ]);
        let rates = latest_rates(&fx, &BTreeSet::new()).unwrap();
        let [eur, sek] = rates.as_slice() else {
            panic!("expected two rows: {rates:?}");
        };
        assert_eq!(eur.rate.as_deref(), Some("1.085"));
        assert_eq!(eur.source.as_deref(), Some("YAHOO"));
        assert_eq!(eur.error, None);
        assert_eq!(eur.date.as_deref(), Some("2026-11-09"));
        assert_eq!(sek.from, "SEK");
        assert_eq!(sek.rate, None, "{sek:?}");
        assert_eq!(sek.date, None, "{sek:?}");
        assert_eq!(sek.source, None, "{sek:?}");
        assert_eq!(
            sek.error.as_deref(),
            Some("No rate is stored for this pair yet")
        );
    }

    #[test]
    fn minor_units_keep_their_spelling() {
        assert_eq!(
            currency_list(&["GBp".to_string(), "gbp".to_string(), "ZAc".to_string()]).unwrap(),
            BTreeSet::from(["GBP".to_string(), "GBp".to_string(), "ZAc".to_string()])
        );
        assert!(currency_list(&["usdt".to_string()])
            .unwrap()
            .contains("USDT"));
    }

    #[test]
    fn currencies_must_be_letters() {
        assert_eq!(
            currency_list(&["usd".to_string(), " EUR ".to_string()]).unwrap(),
            BTreeSet::from(["EUR".to_string(), "USD".to_string()])
        );
        for bad in ["", "E1R", "EUR/USD"] {
            assert!(currency_list(&[bad.to_string()]).is_err(), "{bad}");
        }
    }
}
