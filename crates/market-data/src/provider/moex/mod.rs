//! Moscow Exchange (MOEX) market data provider.
//!
//! Covers shares, depositary receipts and exchange-traded funds on the MOEX
//! stock market (MIC `MISX`) via the public ISS API
//! (<https://iss.moex.com/iss/reference/>). No API key required; current
//! prices on the free tier are delayed by about 15 minutes, end-of-day history
//! is complete.
//!
//! ISS answers every endpoint with named tables (`{"history": {"columns": [..],
//! "data": [[..], ..]}}`), pages history 100 rows at a time and lists one row
//! per trading board. Only the main T+ order-book boards carry the price a
//! holder cares about; odd-lot (`SMAL`) and settlement (`SPEQ`) boards are
//! ignored.

use async_trait::async_trait;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use log::debug;
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::time::Duration;
use urlencoding::encode;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, Coverage, InstrumentKind, ProviderId, ProviderInstrument, Quote, QuoteContext,
    SearchResult,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::registry::{RateLimitConfig, RateLimiter};

const PROVIDER_ID: &str = "MOEX";
const MIC: &str = "MISX";
const BASE_URL: &str = "https://iss.moex.com/iss";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound on history pages per board (100 rows each, ~40 years of
/// trading days) so a malformed cursor cannot loop forever.
const MAX_HISTORY_PAGES: usize = 100;
/// MOEX has observed UTC+3 all year since October 2014.
const MOSCOW_UTC_OFFSET_SECS: i32 = 3 * 3600;
/// End of the main trading session (18:50 Moscow time), used as the timestamp
/// of daily bars so their date is the trading date in every common timezone.
const SESSION_CLOSE: (u32, u32) = (18, 50);

/// Main T+ order-book boards of the shares market, in preference order.
/// A security trades on one of them at a time, but boards change over its
/// life (a fund can move from `TQTF` to `TQBR`), so history is merged per
/// trading date.
const MAIN_BOARDS: &[&str] = &[
    "TQBR", // shares and depositary receipts
    "TQTF", // ETFs
    "TQIF", // mutual fund units
    "TQTD", // ETFs in USD
    "TQTE", // ETFs in EUR
    "TQTY", // fund units in CNY
    "TQFD", // fund units in USD
    "TQFE", // fund units in EUR
    "TQTH", // fund units in HKD
];

// ---------------------------------------------------------------------------
// ISS table model
// ---------------------------------------------------------------------------

/// One named ISS table (`iss.meta=off` form).
#[derive(Debug, Default, Deserialize)]
struct IssTable {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    data: Vec<Vec<Value>>,
}

type IssResponse = HashMap<String, IssTable>;

impl IssTable {
    fn rows(&self) -> impl Iterator<Item = IssRow<'_>> {
        self.data.iter().map(move |values| IssRow {
            table: self,
            values,
        })
    }

    fn column(&self, name: &str) -> Option<usize> {
        self.columns
            .iter()
            .position(|column| column.eq_ignore_ascii_case(name))
    }
}

struct IssRow<'a> {
    table: &'a IssTable,
    values: &'a [Value],
}

impl<'a> IssRow<'a> {
    fn value(&self, column: &str) -> Option<&'a Value> {
        let index = self.table.column(column)?;
        self.values.get(index).filter(|value| !value.is_null())
    }

    fn text(&self, column: &str) -> Option<&'a str> {
        self.value(column)?
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    fn decimal(&self, column: &str) -> Option<Decimal> {
        match self.value(column)? {
            // Parse the JSON literal, not an f64, so 0.7941 stays 0.7941.
            Value::Number(number) => {
                let literal = number.to_string();
                Decimal::from_str(&literal)
                    .or_else(|_| Decimal::from_scientific(&literal))
                    .ok()
            }
            Value::String(text) => Decimal::from_str(text.trim()).ok(),
            _ => None,
        }
    }

    fn int(&self, column: &str) -> Option<i64> {
        self.value(column)?.as_i64()
    }

    fn date(&self, column: &str) -> Option<NaiveDate> {
        NaiveDate::parse_from_str(self.text(column)?, "%Y-%m-%d").ok()
    }

    fn board(&self) -> Option<&'a str> {
        self.text("BOARDID")
    }
}

fn table<'a>(response: &'a IssResponse, name: &str) -> Option<&'a IssTable> {
    response.get(name)
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/// ISS reports the Russian rouble under its pre-1998 code `SUR`.
fn iss_currency(code: Option<&str>) -> String {
    match code.map(|code| code.trim().to_uppercase()) {
        None => "RUB".to_string(),
        Some(code) if code.is_empty() || code == "SUR" || code == "RUR" => "RUB".to_string(),
        Some(code) => code,
    }
}

fn main_board_rank(board: &str) -> Option<usize> {
    MAIN_BOARDS
        .iter()
        .position(|main| main.eq_ignore_ascii_case(board))
}

/// Rank a board for a quote: boards trading in the hinted currency first,
/// then the `MAIN_BOARDS` order. `None` for boards that are not main boards.
fn board_rank(board: &str, currency: &str, currency_hint: Option<&str>) -> Option<(u8, usize)> {
    let rank = main_board_rank(board)?;
    let currency_mismatch = currency_hint.is_some_and(|hint| !hint.eq_ignore_ascii_case(currency));
    Some((u8::from(currency_mismatch), rank))
}

fn moscow() -> FixedOffset {
    FixedOffset::east_opt(MOSCOW_UTC_OFFSET_SECS).expect("valid Moscow offset")
}

fn session_close_utc(date: NaiveDate) -> DateTime<Utc> {
    let close = NaiveTime::from_hms_opt(SESSION_CLOSE.0, SESSION_CLOSE.1, 0).expect("valid time");
    moscow()
        .from_local_datetime(&date.and_time(close))
        .single()
        .expect("fixed offsets are unambiguous")
        .with_timezone(&Utc)
}

fn moscow_datetime_utc(text: &str) -> Option<DateTime<Utc>> {
    let local = NaiveDateTime::parse_from_str(text.trim(), "%Y-%m-%d %H:%M:%S").ok()?;
    moscow()
        .from_local_datetime(&local)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Main boards of the shares market whose history overlaps `[from, till]`.
fn history_boards(boards: &IssTable, from: NaiveDate, till: NaiveDate) -> Vec<String> {
    let mut selected: Vec<(usize, String)> = boards
        .rows()
        .filter(|row| {
            row.text("engine")
                .is_none_or(|engine| engine.eq_ignore_ascii_case("stock"))
                && row
                    .text("market")
                    .is_none_or(|market| market.eq_ignore_ascii_case("shares"))
        })
        .filter_map(|row| {
            let board = row.text("boardid")?;
            let rank = main_board_rank(board)?;
            // Missing bounds mean ISS has no history there yet: skip.
            let history_from = row.date("history_from")?;
            let history_till = row.date("history_till")?;
            (history_from <= till && history_till >= from).then(|| (rank, board.to_uppercase()))
        })
        .collect();
    selected.sort();
    selected.dedup_by(|a, b| a.1 == b.1);
    selected.into_iter().map(|(_, board)| board).collect()
}

/// Next `start` offset from a `history.cursor` table, if more pages remain.
fn next_history_start(cursor: Option<&IssTable>) -> Option<i64> {
    let row = cursor?.rows().next()?;
    let index = row.int("INDEX")?;
    let total = row.int("TOTAL")?;
    let page_size = row.int("PAGESIZE")?;
    let next = index + page_size;
    (page_size > 0 && next < total).then_some(next)
}

/// Merge history rows into one bar per trading date, picking the best-ranked
/// main board that has a price. `CLOSE` is empty on days without trades;
/// `LEGALCLOSEPRICE` (the official closing price) fills in when present.
fn merge_history_rows<'a>(
    rows: impl Iterator<Item = IssRow<'a>>,
    currency_hint: Option<&str>,
    merged: &mut BTreeMap<NaiveDate, ((u8, usize), Quote)>,
) {
    for row in rows {
        let (Some(board), Some(date)) = (row.board(), row.date("TRADEDATE")) else {
            continue;
        };
        let Some(close) = row
            .decimal("CLOSE")
            .or_else(|| row.decimal("LEGALCLOSEPRICE"))
        else {
            continue;
        };
        if close <= Decimal::ZERO {
            continue;
        }
        let currency = iss_currency(row.text("CURRENCYID"));
        let Some(rank) = board_rank(board, &currency, currency_hint) else {
            continue;
        };
        if merged
            .get(&date)
            .is_some_and(|(existing, _)| *existing <= rank)
        {
            continue;
        }
        let quote = Quote {
            timestamp: session_close_utc(date),
            open: row.decimal("OPEN"),
            high: row.decimal("HIGH"),
            low: row.decimal("LOW"),
            close,
            volume: row.decimal("VOLUME"),
            currency,
            source: PROVIDER_ID.to_string(),
        };
        merged.insert(date, (rank, quote));
    }
}

/// Build the latest quote from the `securities` and `marketdata` tables of
/// `engines/stock/markets/shares/securities/{SECID}`.
///
/// Uses the last trade (`LAST`), then the current official price
/// (`LCURRENTPRICE`), and before the first trade of the day the previous
/// close (`PREVPRICE`) stamped with its own date.
fn latest_quote_from_tables(
    securities: &IssTable,
    marketdata: &IssTable,
    currency_hint: Option<&str>,
) -> Option<Quote> {
    let board_info: HashMap<String, IssRow<'_>> = securities
        .rows()
        .filter_map(|row| Some((row.board()?.to_uppercase(), row)))
        .collect();

    let mut best: Option<((u8, usize), Quote)> = None;
    for row in marketdata.rows() {
        let Some(board) = row.board() else {
            continue;
        };
        let Some(security) = board_info.get(&board.to_uppercase()) else {
            continue;
        };
        let currency = iss_currency(security.text("CURRENCYID"));
        let Some(rank) = board_rank(board, &currency, currency_hint) else {
            continue;
        };

        let live = row.decimal("LAST").or_else(|| row.decimal("LCURRENTPRICE"));
        let quote = match live.filter(|price| *price > Decimal::ZERO) {
            Some(close) => Quote {
                timestamp: row
                    .text("SYSTIME")
                    .and_then(moscow_datetime_utc)
                    .unwrap_or_else(Utc::now),
                open: row.decimal("OPEN"),
                high: row.decimal("HIGH"),
                low: row.decimal("LOW"),
                close,
                volume: row.decimal("VOLTODAY"),
                currency,
                source: PROVIDER_ID.to_string(),
            },
            None => {
                let Some(close) = security
                    .decimal("PREVPRICE")
                    .filter(|price| *price > Decimal::ZERO)
                else {
                    continue;
                };
                let Some(date) = security.date("PREVDATE") else {
                    continue;
                };
                Quote {
                    timestamp: session_close_utc(date),
                    open: None,
                    high: None,
                    low: None,
                    close,
                    volume: None,
                    currency,
                    source: PROVIDER_ID.to_string(),
                }
            }
        };

        if best.as_ref().is_none_or(|(existing, _)| rank < *existing) {
            best = Some((rank, quote));
        }
    }
    best.map(|(_, quote)| quote)
}

/// Map an ISS security `type` to Wealthfolio's search asset types.
fn asset_type_for(iss_type: &str) -> &'static str {
    match iss_type {
        "exchange_ppif" | "etf_ppif" => "ETF",
        "public_ppif" | "interval_ppif" | "private_ppif" | "stock_mortgage" => "MUTUALFUND",
        _ => "EQUITY",
    }
}

fn search_results_from_table(securities: &IssTable) -> Vec<SearchResult> {
    securities
        .rows()
        .filter(|row| row.int("is_traded") == Some(1))
        .filter_map(|row| {
            let board = row.text("primary_boardid")?;
            main_board_rank(board)?;
            let secid = row.text("secid")?;
            let name = row
                .text("name")
                .or_else(|| row.text("shortname"))
                .unwrap_or(secid);
            let asset_type = asset_type_for(row.text("type").unwrap_or_default());
            Some(
                SearchResult::new(secid.to_string(), name.to_string(), "MOEX", asset_type)
                    .with_exchange_mic(MIC)
                    .with_exchange_name("Moscow Exchange")
                    .with_data_source(PROVIDER_ID),
            )
        })
        .collect()
}

fn profile_from_description(description: &IssTable) -> Option<AssetProfile> {
    let fields: HashMap<String, &str> = description
        .rows()
        .filter_map(|row| Some((row.text("name")?.to_uppercase(), row.text("value")?)))
        .collect();
    let name = fields.get("NAME").or_else(|| fields.get("SHORTNAME"))?;

    let mut profile = AssetProfile {
        source: Some(PROVIDER_ID.to_string()),
        name: Some((*name).to_string()),
        quote_type: fields
            .get("TYPE")
            .map(|iss_type| asset_type_for(iss_type).to_string()),
        exchange: Some("MOEX".to_string()),
        ..Default::default()
    };
    if let Some(isin) = fields.get("ISIN") {
        profile = profile.isin(*isin);
    }
    Some(profile)
}

/// ISS security codes are upper-case ASCII letters, digits and a few
/// separators. Rejecting anything else keeps user input out of the URL path.
fn normalize_secid(symbol: &str) -> Result<String, MarketDataError> {
    let secid = symbol.trim().to_uppercase();
    let valid = !secid.is_empty()
        && secid.len() <= 51
        && secid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(secid)
    } else {
        Err(MarketDataError::SymbolNotFound(symbol.to_string()))
    }
}

fn secid_from_instrument(instrument: &ProviderInstrument) -> Result<String, MarketDataError> {
    match instrument {
        ProviderInstrument::EquitySymbol { symbol } => normalize_secid(symbol),
        other => Err(MarketDataError::UnsupportedAssetType(format!(
            "{:?}",
            other
        ))),
    }
}

fn currency_hint(context: &QuoteContext) -> Option<String> {
    context
        .currency_hint
        .as_ref()
        .map(|currency| currency.to_uppercase())
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct MoexProvider {
    client: Client,
    request_limiter: RateLimiter,
}

impl Default for MoexProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MoexProvider {
    pub fn new() -> Self {
        let client = wealthfolio_http::client_builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| wealthfolio_http::client());
        let request_limiter = RateLimiter::new();
        let provider_id: ProviderId = Cow::Borrowed(PROVIDER_ID);
        // History pagination issues several requests per sync; meter each one.
        request_limiter.configure(
            &provider_id,
            RateLimitConfig {
                requests_per_minute: 120,
                burst_capacity: 4.0,
            },
        );
        Self {
            client,
            request_limiter,
        }
    }

    async fn get_json(&self, path_and_query: &str) -> Result<IssResponse, MarketDataError> {
        let provider_id: ProviderId = Cow::Borrowed(PROVIDER_ID);
        self.request_limiter.acquire(&provider_id).await;
        let url = format!("{}/{}", BASE_URL, path_and_query);
        debug!("MOEX GET {}", url);
        let response =
            self.client
                .get(&url)
                .send()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("HTTP request failed: {}", e),
                })?;
        if !response.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", response.status()),
            });
        }
        response
            .json::<IssResponse>()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("JSON parse error: {}", e),
            })
    }
}

#[async_trait]
impl MarketDataProvider for MoexProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        14
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            coverage: Coverage::moex(),
            supports_latest: true,
            supports_historical: true,
            supports_search: true,
            supports_profile: true,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 60,
            max_concurrency: 2,
            min_delay: Duration::from_millis(250),
        }
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let secid = secid_from_instrument(&instrument)?;
        let response = self
            .get_json(&format!(
                "engines/stock/markets/shares/securities/{}.json?iss.meta=off\
                 &iss.only=securities,marketdata\
                 &securities.columns=SECID,BOARDID,PREVPRICE,PREVDATE,CURRENCYID\
                 &marketdata.columns=SECID,BOARDID,LAST,LCURRENTPRICE,OPEN,HIGH,LOW,VOLTODAY,SYSTIME",
                encode(&secid)
            ))
            .await?;
        let empty = IssTable::default();
        let securities = table(&response, "securities").unwrap_or(&empty);
        let marketdata = table(&response, "marketdata").unwrap_or(&empty);
        latest_quote_from_tables(securities, marketdata, currency_hint(context).as_deref()).ok_or(
            MarketDataError::SymbolNotFound(format!("{}@{}", secid, MIC)),
        )
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let secid = secid_from_instrument(&instrument)?;
        let from = start.with_timezone(&moscow()).date_naive();
        let till = end.with_timezone(&moscow()).date_naive();
        if from > till {
            return Ok(Vec::new());
        }

        let boards_response = self
            .get_json(&format!(
                "securities/{}.json?iss.meta=off&iss.only=boards\
                 &boards.columns=boardid,market,engine,history_from,history_till",
                encode(&secid)
            ))
            .await?;
        let empty = IssTable::default();
        let boards = history_boards(
            table(&boards_response, "boards").unwrap_or(&empty),
            from,
            till,
        );
        if boards.is_empty() {
            return Err(MarketDataError::SymbolNotFound(format!(
                "{}@{}",
                secid, MIC
            )));
        }

        let hint = currency_hint(context);
        let mut merged = BTreeMap::new();
        for board in boards {
            let mut start_offset = 0_i64;
            for _ in 0..MAX_HISTORY_PAGES {
                let page = self
                    .get_json(&format!(
                        "history/engines/stock/markets/shares/boards/{}/securities/{}.json\
                         ?iss.meta=off&iss.only=history,history.cursor&from={}&till={}&start={}\
                         &history.columns=BOARDID,TRADEDATE,OPEN,HIGH,LOW,CLOSE,LEGALCLOSEPRICE,VOLUME,CURRENCYID",
                        encode(&board),
                        encode(&secid),
                        from.format("%Y-%m-%d"),
                        till.format("%Y-%m-%d"),
                        start_offset
                    ))
                    .await?;
                if let Some(history) = table(&page, "history") {
                    merge_history_rows(history.rows(), hint.as_deref(), &mut merged);
                }
                match next_history_start(table(&page, "history.cursor")) {
                    Some(next) => start_offset = next,
                    None => break,
                }
            }
        }

        Ok(merged.into_values().map(|(_, quote)| quote).collect())
    }

    async fn search(&self, query: &str) -> Result<Vec<SearchResult>, MarketDataError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let response = self
            .get_json(&format!(
                "securities.json?iss.meta=off&q={}&engine=stock&market=shares&limit=20\
                 &securities.columns=secid,shortname,name,isin,is_traded,type,primary_boardid",
                encode(query)
            ))
            .await?;
        Ok(table(&response, "securities")
            .map(search_results_from_table)
            .unwrap_or_default())
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        // The registry may pass "MISX:SECID" or a bare SECID.
        let bare = symbol
            .split_once(':')
            .map(|(_, secid)| secid)
            .unwrap_or(symbol);
        let secid = normalize_secid(bare)?;
        let response = self
            .get_json(&format!(
                "securities/{}.json?iss.meta=off&iss.only=description\
                 &description.columns=name,value",
                encode(&secid)
            ))
            .await?;
        table(&response, "description")
            .and_then(profile_from_description)
            .ok_or(MarketDataError::SymbolNotFound(format!(
                "{}@{}",
                secid, MIC
            )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::InstrumentId;
    use std::sync::Arc;

    fn parse(json: &str) -> IssResponse {
        serde_json::from_str(json).expect("fixture parses")
    }

    fn context(currency: Option<&str>) -> QuoteContext {
        QuoteContext {
            instrument: InstrumentId::Equity {
                ticker: Arc::from("AFLT"),
                mic: Some(Cow::Borrowed(MIC)),
            },
            identifiers: Default::default(),
            overrides: None,
            currency_hint: currency.map(|c| Cow::Owned(c.to_string())),
            preferred_provider: None,
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    // Trimmed real ISS response for AFLT, 2020-02-25/26: TQBR plus the
    // odd-lot (SMAL) and settlement (SPEQ) boards that must be ignored.
    const HISTORY_ALL_BOARDS: &str = r#"{
        "history": {
            "columns": ["BOARDID","TRADEDATE","OPEN","HIGH","LOW","CLOSE","LEGALCLOSEPRICE","VOLUME","CURRENCYID"],
            "data": [
                ["SMAL","2020-02-25",113.06,113.2,109.82,109.82,null,37,"SUR"],
                ["SPEQ","2020-02-25",null,null,null,null,null,0,"SUR"],
                ["TQBR","2020-02-25",112.5,113.86,109.5,109.8,109.8,17019110,"SUR"],
                ["SMAL","2020-02-26",107,108.24,105.8,108.24,null,6,"SUR"],
                ["TQBR","2020-02-26",109,109,104.58,108.22,108.22,18743020,"SUR"]
            ]
        },
        "history.cursor": {"columns": ["INDEX","TOTAL","PAGESIZE"], "data": [[0,5,100]]}
    }"#;

    #[test]
    fn provider_identity_and_capabilities() {
        let provider = MoexProvider::new();
        assert_eq!(provider.id(), "MOEX");
        let caps = provider.capabilities();
        assert!(caps.supports_latest && caps.supports_historical);
        assert!(caps.supports_search && caps.supports_profile);
        assert!(!caps.supports_dividends);
        assert!(caps.supports_instrument(&context(None).instrument));
        let xpar = InstrumentId::Equity {
            ticker: Arc::from("AFLT"),
            mic: Some(Cow::Borrowed("XPAR")),
        };
        assert!(!caps.supports_instrument(&xpar));
    }

    #[test]
    fn history_keeps_only_main_board_and_maps_sur_to_rub() {
        let response = parse(HISTORY_ALL_BOARDS);
        let mut merged = BTreeMap::new();
        merge_history_rows(response["history"].rows(), Some("RUB"), &mut merged);
        let quotes: Vec<Quote> = merged.into_values().map(|(_, q)| q).collect();

        assert_eq!(quotes.len(), 2);
        assert_eq!(quotes[0].close, Decimal::from_str("109.8").unwrap());
        assert_eq!(quotes[1].close, Decimal::from_str("108.22").unwrap());
        assert_eq!(quotes[1].low, Some(Decimal::from_str("104.58").unwrap()));
        assert_eq!(quotes[1].volume, Some(Decimal::from(18_743_020)));
        assert!(quotes
            .iter()
            .all(|q| q.currency == "RUB" && q.source == "MOEX"));
        // 18:50 Moscow = 15:50 UTC on the trading date.
        assert_eq!(
            quotes[0].timestamp,
            Utc.with_ymd_and_hms(2020, 2, 25, 15, 50, 0).unwrap()
        );
    }

    #[test]
    fn history_uses_legal_close_when_no_trades() {
        let response = parse(
            r#"{"history": {
                "columns": ["BOARDID","TRADEDATE","CLOSE","LEGALCLOSEPRICE","CURRENCYID"],
                "data": [
                    ["TQBR","2022-03-01",null,251.3,"SUR"],
                    ["TQBR","2022-03-02",null,null,"SUR"]
                ]}}"#,
        );
        let mut merged = BTreeMap::new();
        merge_history_rows(response["history"].rows(), None, &mut merged);
        assert_eq!(merged.len(), 1);
        let (_, quote) = merged.values().next().unwrap();
        assert_eq!(quote.close, Decimal::from_str("251.3").unwrap());
    }

    #[test]
    fn history_prefers_board_in_hinted_currency() {
        let response = parse(
            r#"{"history": {
                "columns": ["BOARDID","TRADEDATE","CLOSE","CURRENCYID"],
                "data": [
                    ["TQTF","2024-05-02",8.1,"SUR"],
                    ["TQTD","2024-05-02",0.088,"USD"]
                ]}}"#,
        );
        let mut usd = BTreeMap::new();
        merge_history_rows(response["history"].rows(), Some("USD"), &mut usd);
        assert_eq!(usd.values().next().unwrap().1.currency, "USD");

        let mut rub = BTreeMap::new();
        merge_history_rows(response["history"].rows(), Some("RUB"), &mut rub);
        assert_eq!(rub.values().next().unwrap().1.currency, "RUB");
    }

    #[test]
    fn history_cursor_pages_until_total() {
        let first = parse(
            r#"{"history.cursor": {"columns": ["INDEX","TOTAL","PAGESIZE"], "data": [[0,145,100]]}}"#,
        );
        assert_eq!(next_history_start(first.get("history.cursor")), Some(100));
        let last = parse(
            r#"{"history.cursor": {"columns": ["INDEX","TOTAL","PAGESIZE"], "data": [[100,145,100]]}}"#,
        );
        assert_eq!(next_history_start(last.get("history.cursor")), None);
        assert_eq!(next_history_start(None), None);
    }

    #[test]
    fn history_boards_follow_board_moves_and_skip_odd_lots() {
        // TMOS moved from TQTF to TQBR in June 2026.
        let response = parse(
            r#"{"boards": {
                "columns": ["boardid","market","engine","history_from","history_till"],
                "data": [
                    ["TQTF","shares","stock","2020-08-26","2026-06-19"],
                    ["TQBR","shares","stock","2026-06-22","2026-09-23"],
                    ["SMAL","shares","stock","2020-08-26","2026-09-23"],
                    ["TQDP","shares","stock",null,null],
                    ["RPMA","repo","stock","2020-08-26","2026-09-23"]
                ]}}"#,
        );
        let boards = &response["boards"];
        let date = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(
            history_boards(boards, date("2026-01-01"), date("2026-09-01")),
            vec!["TQBR".to_string(), "TQTF".to_string()]
        );
        assert_eq!(
            history_boards(boards, date("2021-01-01"), date("2021-12-31")),
            vec!["TQTF".to_string()]
        );
        assert!(history_boards(boards, date("2010-01-01"), date("2010-12-31")).is_empty());
    }

    #[test]
    fn latest_quote_prefers_last_trade_on_main_board() {
        let response = parse(
            r#"{
            "securities": {"columns": ["SECID","BOARDID","PREVPRICE","PREVDATE","CURRENCYID"],
                "data": [["AFLT","SMAL",31.83,"2026-09-23","SUR"],["AFLT","TQBR",33.01,"2026-09-23","SUR"]]},
            "marketdata": {"columns": ["SECID","BOARDID","LAST","LCURRENTPRICE","OPEN","HIGH","LOW","VOLTODAY","SYSTIME"],
                "data": [["AFLT","SMAL",31.72,null,31.72,31.72,31.72,1,"2026-09-24 19:16:23"],
                         ["AFLT","TQBR",32.85,32.83,33.01,33.05,32.52,7821500,"2026-09-24 19:27:44"]]}
            }"#,
        );
        let quote = latest_quote_from_tables(
            &response["securities"],
            &response["marketdata"],
            Some("RUB"),
        )
        .unwrap();
        assert_eq!(quote.close, Decimal::from_str("32.85").unwrap());
        assert_eq!(quote.currency, "RUB");
        assert_eq!(quote.volume, Some(Decimal::from(7_821_500)));
        assert_eq!(
            quote.timestamp,
            Utc.with_ymd_and_hms(2026, 9, 24, 16, 27, 44).unwrap()
        );
    }

    #[test]
    fn latest_quote_falls_back_to_previous_close_before_first_trade() {
        let response = parse(
            r#"{
            "securities": {"columns": ["SECID","BOARDID","PREVPRICE","PREVDATE","CURRENCYID"],
                "data": [["SBER","TQBR",301.5,"2026-09-23","SUR"]]},
            "marketdata": {"columns": ["SECID","BOARDID","LAST","LCURRENTPRICE","SYSTIME"],
                "data": [["SBER","TQBR",null,null,"2026-09-24 06:50:00"]]}
            }"#,
        );
        let quote =
            latest_quote_from_tables(&response["securities"], &response["marketdata"], None)
                .unwrap();
        assert_eq!(quote.close, Decimal::from_str("301.5").unwrap());
        assert_eq!(
            quote.timestamp,
            Utc.with_ymd_and_hms(2026, 9, 23, 15, 50, 0).unwrap()
        );
    }

    #[test]
    fn latest_quote_is_none_for_unknown_security() {
        let response = parse(
            r#"{"securities": {"columns": [], "data": []}, "marketdata": {"columns": [], "data": []}}"#,
        );
        assert!(
            latest_quote_from_tables(&response["securities"], &response["marketdata"], None)
                .is_none()
        );
    }

    #[test]
    fn search_keeps_traded_main_board_listings() {
        let response = parse(
            r#"{"securities": {
                "columns": ["secid","shortname","name","isin","is_traded","type","primary_boardid"],
                "data": [
                    ["AFLT","Аэрофлот","Аэрофлот-росс.авиалин(ПАО)ао","RU0009062285",1,"common_share","TQBR"],
                    ["RU0009062285","Аэрофлот-2","ОАО Аэрофлот (2 в)",null,0,"common_share","EQBS"],
                    ["TMOS","TMOS ETF","БПИФ Т-Капитал Индекс МосБиржи","RU000A101X76",1,"exchange_ppif","TQBR"]
                ]}}"#,
        );
        let results = search_results_from_table(&response["securities"]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].symbol, "AFLT");
        assert_eq!(results[0].exchange_mic.as_deref(), Some("MISX"));
        assert_eq!(results[0].asset_type, "EQUITY");
        assert_eq!(results[0].data_source.as_deref(), Some("MOEX"));
        assert_eq!(results[1].asset_type, "ETF");
    }

    #[test]
    fn profile_reads_name_isin_and_type() {
        let response = parse(
            r#"{"description": {"columns": ["name","value"], "data": [
                ["SECID","MAIL"],["NAME","ГДР VK Company Limited ORD SHS"],
                ["ISIN","US5603172082"],["TYPE","depositary_receipt"]]}}"#,
        );
        let profile = profile_from_description(&response["description"]).unwrap();
        assert_eq!(
            profile.name.as_deref(),
            Some("ГДР VK Company Limited ORD SHS")
        );
        assert_eq!(profile.isin.as_deref(), Some("US5603172082"));
        assert_eq!(profile.quote_type.as_deref(), Some("EQUITY"));
        assert_eq!(profile.source.as_deref(), Some("MOEX"));
    }

    #[test]
    fn secid_validation_rejects_path_injection() {
        assert_eq!(normalize_secid(" aflt ").unwrap(), "AFLT");
        assert_eq!(normalize_secid("SBER-001D").unwrap(), "SBER-001D");
        assert!(normalize_secid("").is_err());
        assert!(normalize_secid("../secrets").is_err());
        assert!(normalize_secid("AFLT?x=1").is_err());
    }

    #[test]
    fn currency_codes_map_legacy_rouble() {
        assert_eq!(iss_currency(Some("SUR")), "RUB");
        assert_eq!(iss_currency(Some("RUR")), "RUB");
        assert_eq!(iss_currency(None), "RUB");
        assert_eq!(iss_currency(Some("usd")), "USD");
    }

    #[test]
    fn decimals_keep_the_json_literal() {
        let response = parse(r#"{"t": {"columns": ["P"], "data": [[0.7941]]}}"#);
        let row = response["t"].rows().next().unwrap();
        assert_eq!(row.decimal("P"), Some(Decimal::from_str("0.7941").unwrap()));
    }
}
