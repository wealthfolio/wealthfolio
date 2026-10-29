//! AMFI (Association of Mutual Funds in India) NAV provider.
//!
//! Prices Indian mutual funds from AMFI's public data. No API key required.
//!
//! - `NAVAll.txt` lists published scheme codes, ISINs and latest NAVs. It supplies
//!   latest NAVs and maps a fund's ISIN to its scheme code, and one download is
//!   shared by every fund until it expires.
//! - History comes from the endpoint behind AMFI's NAV history page. It is not
//!   documented as an API and rejects spans of 1,825 days or more, so a long
//!   range is fetched in yearly windows.
//!
//! The resolver routes a fund here only when the user has chosen AMFI for it.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Days, NaiveDate, NaiveTime, TimeZone, Utc};
use log::debug;
use reqwest::{Client, RequestBuilder, StatusCode};
use rust_decimal::Decimal;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::errors::MarketDataError;
use crate::models::{
    Coverage, InstrumentKind, ProviderId, ProviderInstrument, Quote, QuoteContext,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};
use crate::registry::{RateLimitConfig, RateLimiter};
use crate::resolver::looks_like_isin;

const PROVIDER_ID: &str = "AMFI";
const CURRENCY: &str = "INR";
const NAV_ALL_URL: &str = "https://portal.amfiindia.com/spages/NAVAll.txt";
const HISTORY_URL: &str = "https://www.amfiindia.com/api/nav-history";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a downloaded `NAVAll.txt` is reused, so a sync's funds share one copy.
const NAV_ALL_TTL: Duration = Duration::from_secs(60 * 60);
/// Days per history request. AMFI rejects spans of 1,825 days or more, and a
/// year of NAVs takes it about five seconds to serve.
const HISTORY_WINDOW_DAYS: u64 = 365;

// ---------------------------------------------------------------------------
// Response structs
// ---------------------------------------------------------------------------

/// `{"data": {...}}` with NAVs, `{"message": "No records to display"}` for a
/// range without any, or `{"error": "..."}` with HTTP 400.
#[derive(Debug, Deserialize)]
struct HistoryResponse {
    data: Option<HistoryData>,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HistoryData {
    nav_groups: Vec<NavGroup>,
}

#[derive(Debug, Deserialize)]
struct NavGroup {
    historical_records: Vec<NavRecord>,
}

#[derive(Debug, Deserialize)]
struct NavRecord {
    date: String,
    nav: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// NAVAll.txt
// ---------------------------------------------------------------------------

/// How a fund is identified to AMFI.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SchemeRef {
    Code(String),
    Isin(String),
}

impl SchemeRef {
    fn parse(symbol: &str) -> Option<Self> {
        let symbol = symbol.trim().to_ascii_uppercase();
        if is_scheme_code(&symbol) {
            Some(Self::Code(symbol))
        } else if looks_like_isin(&symbol) {
            Some(Self::Isin(symbol))
        } else {
            None
        }
    }
}

/// One scheme row of `NAVAll.txt`.
#[derive(Debug)]
struct NavRow {
    code: String,
    /// The row's NAV and its own date, when both are usable.
    latest: Option<(NaiveDate, Decimal)>,
}

/// `NAVAll.txt` indexed by scheme code and ISIN.
#[derive(Debug, Default)]
struct NavIndex {
    rows: Vec<NavRow>,
    by_code: HashMap<String, usize>,
    /// `None` marks an ISIN listed under more than one scheme code.
    by_isin: HashMap<String, Option<usize>>,
}

impl NavIndex {
    /// Parse the semicolon-separated file. Scheme rows have eight fields: scheme
    /// code, ISIN (payout or growth), ISIN (reinvestment), scheme name, plan,
    /// option, NAV and date. Headings, fund-house names and blank lines don't.
    fn parse(text: &str) -> Self {
        let mut index = Self::default();
        for line in text.lines() {
            let fields: Vec<&str> = line.split(';').map(str::trim).collect();
            let &[code, payout_isin, reinvestment_isin, _, _, _, nav, date] = fields.as_slice()
            else {
                continue;
            };
            if !is_scheme_code(code) || index.by_code.contains_key(code) {
                continue;
            }
            let date = NaiveDate::parse_from_str(date, "%d-%b-%Y").ok();
            let nav = Decimal::from_str(nav)
                .ok()
                .filter(|nav| *nav > Decimal::ZERO);
            let row = index.rows.len();
            index.rows.push(NavRow {
                code: code.to_string(),
                latest: date.zip(nav),
            });
            index.by_code.insert(code.to_string(), row);
            // Missing ISINs are written as "-", and a few cells hold other text.
            for isin in [payout_isin, reinvestment_isin] {
                if looks_like_isin(isin) {
                    index
                        .by_isin
                        .entry(isin.to_string())
                        .and_modify(|existing| {
                            if *existing != Some(row) {
                                *existing = None;
                            }
                        })
                        .or_insert(Some(row));
                }
            }
        }
        index
    }

    /// The scheme's row; `None` when it isn't listed or its ISIN is ambiguous.
    fn find(&self, scheme: &SchemeRef) -> Option<&NavRow> {
        let row = match scheme {
            SchemeRef::Code(code) => self.by_code.get(code).copied(),
            SchemeRef::Isin(isin) => self.by_isin.get(isin).copied().flatten(),
        }?;
        self.rows.get(row)
    }
}

struct CachedIndex {
    fetched_at: Instant,
    index: Arc<NavIndex>,
}

// ---------------------------------------------------------------------------
// Provider struct
// ---------------------------------------------------------------------------

pub struct AmfiProvider {
    client: Client,
    /// Held while downloading, so concurrent syncs wait for one download.
    nav_all: Mutex<Option<CachedIndex>>,
    request_limiter: RateLimiter,
}

impl Default for AmfiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AmfiProvider {
    pub fn new() -> Self {
        let client = wealthfolio_http::client_builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| wealthfolio_http::client());
        let request_limiter = RateLimiter::new();
        // The registry takes one token per provider call, but a long history
        // range makes several requests, so meter each one.
        request_limiter.configure(
            &Cow::Borrowed(PROVIDER_ID),
            RateLimitConfig {
                requests_per_minute: 30,
                burst_capacity: 2.0,
            },
        );

        Self {
            client,
            nav_all: Mutex::new(None),
            request_limiter,
        }
    }

    async fn send(&self, request: RequestBuilder) -> Result<(StatusCode, String), MarketDataError> {
        let provider_id: ProviderId = Cow::Borrowed(PROVIDER_ID);
        self.request_limiter.acquire(&provider_id).await;
        let response = request.send().await.map_err(request_error)?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(MarketDataError::RateLimited {
                provider: PROVIDER_ID.to_string(),
            });
        }
        let body = response.text().await.map_err(request_error)?;
        Ok((status, body))
    }

    /// The parsed `NAVAll.txt`, downloaded at most once per [`NAV_ALL_TTL`].
    async fn nav_index(&self) -> Result<Arc<NavIndex>, MarketDataError> {
        let mut cached = self.nav_all.lock().await;
        if let Some(fresh) = cached
            .as_ref()
            .filter(|entry| entry.fetched_at.elapsed() < NAV_ALL_TTL)
        {
            return Ok(Arc::clone(&fresh.index));
        }

        debug!("AMFI: downloading NAVAll.txt");
        let (status, body) = self.send(self.client.get(NAV_ALL_URL)).await?;
        if !status.is_success() {
            return Err(provider_error(format!("NAVAll.txt returned HTTP {status}")));
        }
        let index = NavIndex::parse(&body);
        if index.rows.is_empty() {
            return Err(provider_error("NAVAll.txt listed no schemes".to_string()));
        }

        let index = Arc::new(index);
        *cached = Some(CachedIndex {
            fetched_at: Instant::now(),
            index: Arc::clone(&index),
        });
        Ok(index)
    }

    async fn scheme_code(&self, scheme: &SchemeRef) -> Result<String, MarketDataError> {
        match scheme {
            SchemeRef::Code(code) => Ok(code.clone()),
            SchemeRef::Isin(isin) => self
                .nav_index()
                .await?
                .find(scheme)
                .map(|row| row.code.clone())
                .ok_or_else(|| MarketDataError::SymbolNotFound(isin.clone())),
        }
    }

    /// Fetch one window of a scheme's NAVs; it must span fewer than 1,825 days.
    async fn fetch_history_window(
        &self,
        code: &str,
        from: NaiveDate,
        to: NaiveDate,
    ) -> Result<Vec<(NaiveDate, Decimal)>, MarketDataError> {
        let from_date = from.format("%Y-%m-%d").to_string();
        let to_date = to.format("%Y-%m-%d").to_string();
        debug!("AMFI: history for scheme {code} from {from_date} to {to_date}");
        let request = self.client.get(HISTORY_URL).query(&[
            ("query_type", "historical_period"),
            ("from_date", from_date.as_str()),
            ("to_date", to_date.as_str()),
            ("sd_id", code),
        ]);
        let (status, body) = self.send(request).await?;
        parse_history(status, &body)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// AMFI scheme codes are plain numbers, such as 122639.
fn is_scheme_code(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn provider_error(message: String) -> MarketDataError {
    MarketDataError::ProviderError {
        provider: PROVIDER_ID.to_string(),
        message,
    }
}

fn request_error(error: reqwest::Error) -> MarketDataError {
    if error.is_timeout() {
        MarketDataError::Timeout {
            provider: PROVIDER_ID.to_string(),
        }
    } else {
        provider_error(format!("HTTP request failed: {error}"))
    }
}

fn scheme_ref(instrument: &ProviderInstrument) -> Result<SchemeRef, MarketDataError> {
    match instrument {
        ProviderInstrument::EquitySymbol { symbol } => SchemeRef::parse(symbol)
            .ok_or_else(|| MarketDataError::SymbolNotFound(symbol.to_string())),
        _ => Err(MarketDataError::UnsupportedAssetType(format!(
            "{:?}",
            instrument
        ))),
    }
}

/// Split `first..=last` into consecutive windows the history endpoint accepts.
fn history_windows(first: NaiveDate, last: NaiveDate) -> Vec<(NaiveDate, NaiveDate)> {
    let mut windows = Vec::new();
    let mut from = first;
    while from <= last {
        let to = from
            .checked_add_days(Days::new(HISTORY_WINDOW_DAYS - 1))
            .map_or(last, |to| to.min(last));
        windows.push((from, to));
        match to.succ_opt() {
            Some(next) => from = next,
            None => break,
        }
    }
    windows
}

/// Read one history response. Records without a usable date or a positive NAV
/// are skipped; a response of any other shape is an error.
fn parse_history(
    status: StatusCode,
    body: &str,
) -> Result<Vec<(NaiveDate, Decimal)>, MarketDataError> {
    let response = serde_json::from_str::<HistoryResponse>(body);
    if !status.is_success() {
        let message = response
            .ok()
            .and_then(|response| response.error)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(provider_error(format!("NAV history: {message}")));
    }
    let response =
        response.map_err(|e| provider_error(format!("NAV history JSON parse error: {e}")))?;
    if let Some(error) = response.error {
        return Err(provider_error(format!("NAV history: {error}")));
    }
    let Some(data) = response.data else {
        return match response.message {
            Some(message) if message == "No records to display" => Ok(Vec::new()),
            message => Err(provider_error(format!(
                "NAV history: {}",
                message.unwrap_or_else(|| "unexpected response".to_string())
            ))),
        };
    };

    Ok(data
        .nav_groups
        .into_iter()
        .flat_map(|group| group.historical_records)
        .filter_map(|record| {
            let date = NaiveDate::parse_from_str(&record.date, "%Y-%m-%d").ok()?;
            let nav = match record.nav? {
                serde_json::Value::Number(nav) => Decimal::from_str(&nav.to_string()).ok(),
                serde_json::Value::String(nav) => Decimal::from_str(nav.trim()).ok(),
                _ => None,
            }
            .filter(|nav| *nav > Decimal::ZERO);
            if nav.is_none() {
                debug!(
                    "AMFI: skipping NAV record dated {} without a usable NAV",
                    record.date
                );
            }
            Some((date, nav?))
        })
        .collect())
}

/// A NAV dated midnight UTC, so its day is the same in every time zone's storage.
fn nav_quote(date: NaiveDate, nav: Decimal) -> Quote {
    Quote::new(
        Utc.from_utc_datetime(&date.and_time(NaiveTime::MIN)),
        nav,
        CURRENCY.to_string(),
        PROVIDER_ID.to_string(),
    )
}

// ---------------------------------------------------------------------------
// MarketDataProvider impl
// ---------------------------------------------------------------------------

#[async_trait]
impl MarketDataProvider for AmfiProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        15
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Equity],
            // Mutual funds aren't listed on an exchange; the resolver decides
            // which funds come here.
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: false,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 30,
            max_concurrency: 2,
            min_delay: Duration::from_millis(500),
        }
    }

    async fn get_latest_quote(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let scheme = scheme_ref(&instrument)?;
        let index = self.nav_index().await?;
        let row = index
            .find(&scheme)
            .ok_or_else(|| MarketDataError::SymbolNotFound(instrument.to_symbol_string()))?;
        let (date, nav) = row.latest.ok_or(MarketDataError::NoDataForRange)?;
        Ok(nav_quote(date, nav))
    }

    async fn get_historical_quotes(
        &self,
        _context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let scheme = scheme_ref(&instrument)?;
        let code = self.scheme_code(&scheme).await?;
        let (first, last) = (start.date_naive(), end.date_naive());

        let mut navs = BTreeMap::new();
        for (from, to) in history_windows(first, last) {
            for (date, nav) in self.fetch_history_window(&code, from, to).await? {
                if (first..=last).contains(&date) {
                    navs.entry(date).or_insert(nav);
                }
            }
        }

        if navs.is_empty() {
            return Err(MarketDataError::NoDataForRange);
        }
        Ok(navs
            .into_iter()
            .map(|(date, nav)| nav_quote(date, nav))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn date(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").expect("valid test date")
    }

    /// Lines from `NAVAll.txt` (29 October 2026), including its headings,
    /// placeholder ISIN cells, an old NAV and an ISIN listed under two codes.
    const NAV_ALL: &str = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\r
 \r
Open Ended Schemes(Equity Scheme - Flexi Cap Fund)\r
 \r
PPFAS Mutual Fund\r
 \r
122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;88.8018;28-Oct-2026\r
135763;INF846K01WS2;INF846K01WQ6;Axis Children's Fund;Direct Plan;IDCW Option;26.7364;28-Oct-2026\r
152713;INF179KC1IM3;HDFCNIVODG;HDFC NIFTY100 Low Volatility 30 Index Fund;Direct Plan;Growth Option;9.7019;28-Oct-2026\r
130565;INF613Q01025;Redeemed;IL&FS Infrastructure Debt Fund Series 1A;;;1680494.0463;31-Dec-2018\r
142916;INF204KB1XN0;-;Nippon India Fixed Horizon Fund XXXVI- Series 9;;;10.0000;10-May-2021\r
143451;INF204KB1XN0;-;Nippon India Fixed Horizon Fund XXXVII- Series 9;;;13.5859;26-May-2022\r
100001;-;-;Scheme without a NAV;;;N.A.;28-Oct-2026\r
";

    #[test]
    fn nav_all_maps_either_isin_column_to_the_scheme_code() {
        let index = NavIndex::parse(NAV_ALL);

        let find = |isin: &str| {
            index
                .find(&SchemeRef::Isin(isin.to_string()))
                .map(|row| row.code.as_str())
        };
        assert_eq!(find("INF879O01027"), Some("122639"));
        assert_eq!(find("INF846K01WS2"), Some("135763"));
        assert_eq!(find("INF846K01WQ6"), Some("135763"));
        assert_eq!(find("INF179KC1IM3"), Some("152713"));
        assert_eq!(find("INF613Q01025"), Some("130565"));
        // Text in an ISIN column isn't an ISIN.
        assert!(!index.by_isin.contains_key("HDFCNIVODG"));
        assert!(!index.by_isin.contains_key("REDEEMED"));
        assert!(!index.by_isin.contains_key("-"));
    }

    #[test]
    fn nav_all_isin_under_two_codes_matches_neither() {
        let index = NavIndex::parse(NAV_ALL);

        assert!(index
            .find(&SchemeRef::Isin("INF204KB1XN0".to_string()))
            .is_none());
        // Each code is still reachable directly.
        assert!(index.find(&SchemeRef::Code("142916".to_string())).is_some());
        assert!(index.find(&SchemeRef::Code("143451".to_string())).is_some());
    }

    #[test]
    fn nav_all_keeps_each_navs_own_date() {
        let index = NavIndex::parse(NAV_ALL);

        let latest = |code: &str| {
            index
                .find(&SchemeRef::Code(code.to_string()))
                .and_then(|row| row.latest)
        };
        assert_eq!(latest("122639"), Some((date("2026-10-28"), dec!(88.8018))));
        assert_eq!(
            latest("130565"),
            Some((date("2018-12-31"), dec!(1680494.0463)))
        );
        // A listed scheme without a numeric NAV has no latest NAV.
        assert!(index.find(&SchemeRef::Code("100001".to_string())).is_some());
        assert_eq!(latest("100001"), None);
        // Headings and fund-house names aren't schemes.
        assert_eq!(index.rows.len(), 7);
    }

    #[test]
    fn symbols_are_scheme_codes_or_isins() {
        assert_eq!(
            SchemeRef::parse(" 122639 "),
            Some(SchemeRef::Code("122639".to_string()))
        );
        assert_eq!(
            SchemeRef::parse("inf879o01027"),
            Some(SchemeRef::Isin("INF879O01027".to_string()))
        );
        assert_eq!(SchemeRef::parse("0P0000YWL1"), None);
        assert_eq!(SchemeRef::parse(""), None);
    }

    #[test]
    fn history_windows_stay_under_amfis_limit_without_gaps_or_overlaps() {
        let first = date("2014-03-15");
        let last = date("2026-10-28");
        let windows = history_windows(first, last);

        assert_eq!(windows.first().map(|w| w.0), Some(first));
        assert_eq!(windows.last().map(|w| w.1), Some(last));
        for (from, to) in &windows {
            assert!(from <= to);
            assert!((*to - *from).num_days() < 1825);
        }
        for pair in windows.windows(2) {
            assert_eq!(pair[0].1.succ_opt(), Some(pair[1].0));
        }
    }

    #[test]
    fn history_windows_for_a_short_or_empty_range() {
        let day = date("2026-10-28");
        assert_eq!(history_windows(day, day), vec![(day, day)]);
        assert!(history_windows(day, date("2026-10-27")).is_empty());
    }

    #[test]
    fn history_response_reads_dated_navs() {
        let body = r#"{"data":{"mf_name":"PPFAS Mutual Fund","scheme_name":"Parag Parikh Flexi Cap Fund","date_range":"From 27-Oct-2026 to 28-Oct-2026","nav_groups":[{"nav_name":"Parag Parikh Flexi Cap Fund - Direct Plan - Growth","historical_records":[
            {"date":"2026-10-27","nav":89.2762,"upload_time":"2026-10-28T07:48:56.000Z","repurchase":"","reissue":"","Plan":"Direct Plan","Option":"Growth"},
            {"date":"2026-10-28","nav":88.8018,"upload_time":"2026-10-29T07:41:06.000Z","repurchase":"","reissue":"","Plan":"Direct Plan","Option":"Growth"},
            {"date":"2026-10-29","nav":null},
            {"date":"not a date","nav":1.0}]}]}}"#;

        let navs = parse_history(StatusCode::OK, body).expect("history parses");

        assert_eq!(
            navs,
            vec![
                (date("2026-10-27"), dec!(89.2762)),
                (date("2026-10-28"), dec!(88.8018)),
            ]
        );
    }

    #[test]
    fn history_response_without_records_is_empty() {
        for body in [
            r#"{"message":"No records to display"}"#,
            r#"{"data":{"nav_groups":[]}}"#,
            r#"{"data":{"nav_groups":[{"historical_records":[]}]}}"#,
        ] {
            let navs = parse_history(StatusCode::OK, body).expect("an empty range is not an error");
            assert!(navs.is_empty());
        }
    }

    #[test]
    fn history_response_errors_are_reported() {
        let rejected = parse_history(
            StatusCode::BAD_REQUEST,
            r#"{"error":"from_date to to_date range must be less than 5 years"}"#,
        );
        assert!(matches!(
            rejected,
            Err(MarketDataError::ProviderError { message, .. })
                if message.contains("less than 5 years")
        ));

        assert!(parse_history(StatusCode::OK, r#"{"unexpected":true}"#).is_err());
        assert!(parse_history(StatusCode::BAD_GATEWAY, "<html></html>").is_err());
    }

    #[test]
    fn history_response_rejects_unrecognized_empty_windows() {
        for body in [
            r#"{"message":"Temporarily unavailable"}"#,
            r#"{"message":"No records to display","error":"upstream failure"}"#,
            r#"{"data":{}}"#,
            r#"{"data":{"nav_groups":[{}]}}"#,
            r#"{"data":{"nav_groups":[]},"error":"upstream failure"}"#,
        ] {
            assert!(
                matches!(
                    parse_history(StatusCode::OK, body),
                    Err(MarketDataError::ProviderError { .. })
                ),
                "unexpected successful history window: {body}"
            );
        }
    }

    #[test]
    fn nav_quotes_keep_their_day_in_utc() {
        let quote = nav_quote(date("2026-10-28"), dec!(88.8018));

        assert_eq!(quote.timestamp.date_naive(), date("2026-10-28"));
        assert_eq!(quote.close, dec!(88.8018));
        assert_eq!(quote.currency, "INR");
        assert_eq!(quote.source, "AMFI");
        assert!(quote.open.is_none() && quote.volume.is_none());
    }
}
