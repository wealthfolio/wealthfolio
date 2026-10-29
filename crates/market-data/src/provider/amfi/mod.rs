//! AMFI (Association of Mutual Funds in India) NAV provider.
//!
//! Prices Indian mutual funds from AMFI's public data. No API key required.
//!
//! - `NAVAll.txt` lists published scheme codes, ISINs and latest NAVs. It supplies
//!   latest NAVs and maps a fund's ISIN to its scheme code, and one download is
//!   shared by every fund until it expires.
//! - History comes from the endpoint behind AMFI's NAV history page. It is not
//!   documented as an API and rejects spans of 1,825 days or more, so a long
//!   range is fetched in yearly windows, up to the first window without NAVs
//!   after earlier ones.
//! - Many closed and merged funds are missing from `NAVAll.txt`. Their ISINs are
//!   looked up in AMFI's NAV history report, which lists every NAV published on
//!   a day, for days in the requested range. The codes in every report read are
//!   kept, so later lookups can reuse them.
//!
//! The resolver routes a fund here only when the user has chosen AMFI for it.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveTime, TimeZone, Utc, Weekday};
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
const REPORT_URL: &str = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a downloaded `NAVAll.txt` is reused, so a sync's funds share one copy.
const NAV_ALL_TTL: Duration = Duration::from_secs(60 * 60);
/// Days per history request. AMFI rejects spans of 1,825 days or more, and a
/// year of NAVs takes it about five seconds to serve.
const HISTORY_WINDOW_DAYS: u64 = 365;
/// Maximum report days per ISIN lookup, at about 1 MB a day. Quote sync
/// requests a new fund's history from 45 days before its first activity;
/// nine lookups reach about two months into the range.
const REPORT_LOOKUPS: usize = 9;
/// Weekdays between report lookups after the first two. Six, so consecutive
/// lookups fall on different weekdays: some funds don't publish a NAV every
/// weekday.
const REPORT_LOOKUP_STEP_WEEKDAYS: usize = 6;
/// The NAV history report's first line. Rows are read by position, so a report
/// with other columns isn't read.
const REPORT_HEADER: &str = "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date";
/// What AMFI's page says for a day without NAVs.
const REPORT_NO_DATA: &str = "No data found on the basis of selected parameters for this report";

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
                    add_isin(&mut index.by_isin, isin, row);
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
// NAV history report
// ---------------------------------------------------------------------------

/// Scheme codes by ISIN from the NAV history reports read so far, kept for as
/// long as the provider so later lookups don't download a day again.
#[derive(Debug, Default)]
struct ReportIndex {
    /// Days whose report has been read.
    dates: HashSet<NaiveDate>,
    /// `None` marks an ISIN listed under more than one scheme code.
    codes: HashMap<String, Option<String>>,
}

impl ReportIndex {
    /// Add one day's semicolon-separated report. Scheme rows have eight fields:
    /// scheme code, NAV name, plan, option, ISIN (payout or growth), ISIN
    /// (reinvestment), NAV and date. Headings, fund-house names and blank lines
    /// don't.
    fn add(&mut self, date: NaiveDate, report: &str) {
        for line in report.lines() {
            let fields: Vec<&str> = line.split(';').map(str::trim).collect();
            let &[code, _, _, _, payout_isin, reinvestment_isin, _, _] = fields.as_slice() else {
                continue;
            };
            if !is_scheme_code(code) {
                continue;
            }
            for isin in [payout_isin, reinvestment_isin] {
                if looks_like_isin(isin) {
                    add_isin(&mut self.codes, isin, code.to_string());
                }
            }
        }
        self.dates.insert(date);
    }

    /// The ISIN's scheme code; `None` when no report read lists it or it is
    /// ambiguous.
    fn code(&self, isin: &str) -> Option<&str> {
        self.codes.get(isin)?.as_deref()
    }
}

// ---------------------------------------------------------------------------
// Provider struct
// ---------------------------------------------------------------------------

pub struct AmfiProvider {
    client: Client,
    urls: Urls,
    /// Held while downloading, so concurrent syncs wait for one download.
    nav_all: Mutex<Option<CachedIndex>>,
    /// Held while downloading, so concurrent lookups share reports.
    reports: Mutex<ReportIndex>,
    request_limiter: RateLimiter,
}

/// Where AMFI's files are downloaded from; tests use a local server.
struct Urls {
    nav_all: Cow<'static, str>,
    history: Cow<'static, str>,
    report: Cow<'static, str>,
}

impl Default for AmfiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AmfiProvider {
    pub fn new() -> Self {
        Self::with_urls(Urls {
            nav_all: Cow::Borrowed(NAV_ALL_URL),
            history: Cow::Borrowed(HISTORY_URL),
            report: Cow::Borrowed(REPORT_URL),
        })
    }

    fn with_urls(urls: Urls) -> Self {
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
            urls,
            nav_all: Mutex::new(None),
            reports: Mutex::new(ReportIndex::default()),
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
        let (status, body) = self
            .send(self.client.get(self.urls.nav_all.as_ref()))
            .await?;
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

    /// The scheme's code. An ISIN missing from `NAVAll.txt` is looked up in the
    /// NAV history reports for days from `first` to `last`.
    async fn scheme_code(
        &self,
        scheme: &SchemeRef,
        first: NaiveDate,
        last: NaiveDate,
    ) -> Result<String, MarketDataError> {
        let isin = match scheme {
            SchemeRef::Code(code) => return Ok(code.clone()),
            SchemeRef::Isin(isin) => isin,
        };
        let index = self.nav_index().await?;
        if let Some(row) = index.find(scheme) {
            return Ok(row.code.clone());
        }
        // An ISIN listed under more than one code stays unresolved.
        if index.by_isin.contains_key(isin) {
            return Err(MarketDataError::SymbolNotFound(isin.clone()));
        }
        self.report_code(isin, first, last).await
    }

    /// Look an ISIN up in the NAV history reports for [`report_dates`], until
    /// a report read lists it.
    async fn report_code(
        &self,
        isin: &str,
        first: NaiveDate,
        last: NaiveDate,
    ) -> Result<String, MarketDataError> {
        let mut reports = self.reports.lock().await;
        for date in report_dates(first, last) {
            if reports.codes.contains_key(isin) {
                break;
            }
            if reports.dates.contains(&date) {
                continue;
            }
            let day = date.format("%d-%b-%Y").to_string();
            debug!("AMFI: NAV history report for {day}");
            let request = self
                .client
                .get(self.urls.report.as_ref())
                .query(&[("frmdt", day.as_str()), ("todt", day.as_str())]);
            let (status, body) = self.send(request).await?;
            reports.add(date, report_text(status, &body)?.unwrap_or_default());
        }
        reports
            .code(isin)
            .map(str::to_string)
            .ok_or_else(|| MarketDataError::SymbolNotFound(isin.to_string()))
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
        let request = self.client.get(self.urls.history.as_ref()).query(&[
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

/// Record that `isin` belongs to `scheme`, or mark it ambiguous (`None`) when
/// it already belongs to another.
fn add_isin<T: PartialEq>(by_isin: &mut HashMap<String, Option<T>>, isin: &str, scheme: T) {
    by_isin
        .entry(isin.to_string())
        .and_modify(|existing| {
            if existing.as_ref() != Some(&scheme) {
                *existing = None;
            }
        })
        .or_insert(Some(scheme));
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

/// Days to look an ISIN up in the NAV history report: the range's first two
/// weekdays, as the first may be a holiday, then every
/// [`REPORT_LOOKUP_STEP_WEEKDAYS`]th. A closed fund that is still held is
/// synced from a few days before its last NAV, so only the first lookups can
/// find it. Weekends are skipped, as only a few funds publish NAVs on them.
fn report_dates(first: NaiveDate, last: NaiveDate) -> Vec<NaiveDate> {
    first
        .iter_days()
        .take_while(|day| *day <= last)
        .filter(|day| !matches!(day.weekday(), Weekday::Sat | Weekday::Sun))
        .enumerate()
        .filter(|(weekday, _)| *weekday == 0 || weekday % REPORT_LOOKUP_STEP_WEEKDAYS == 1)
        .map(|(_, day)| day)
        .take(REPORT_LOOKUPS)
        .collect()
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

/// Read one day's NAV history report: its text, or `None` for a day without
/// NAVs, which AMFI answers with an HTML page saying no data was found.
fn report_text(status: StatusCode, body: &str) -> Result<Option<&str>, MarketDataError> {
    if !status.is_success() {
        return Err(provider_error(format!(
            "NAV history report returned HTTP {status}"
        )));
    }
    if body.trim_start().lines().next() == Some(REPORT_HEADER) {
        Ok(Some(body))
    } else if body.contains(REPORT_NO_DATA) {
        Ok(None)
    } else {
        Err(provider_error(
            "NAV history report: unexpected response".to_string(),
        ))
    }
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
        let (first, last) = (start.date_naive(), end.date_naive());
        let code = self.scheme_code(&scheme, first, last).await?;

        let mut navs = BTreeMap::new();
        for (from, to) in history_windows(first, last) {
            let window = self.fetch_history_window(&code, from, to).await?;
            // Stop at the first empty window after NAVs, so the rest of a
            // closed fund's range isn't requested.
            if window.is_empty() && !navs.is_empty() {
                break;
            }
            for (date, nav) in window {
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

    /// Lines from AMFI's NAV history report for 17 March 2017, including its
    /// headings, placeholder and malformed ISIN cells, and an ISIN listed under
    /// two codes.
    const REPORT: &str = "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date\r
\r
Open Ended Schemes ( Income )\r
\r
\r
Tata Mutual Fund\r
101828;Tata Gilt Securities Short Maturity Fund -Regular Fund-Quarterly DIvidend;;;INF277K01DP6;INF277K01568;12.2900;17-Mar-2017\r
121701;Reliance Yearly Interval Fund - Series 5 - Direct Plan - Growth Plan - Growth Option;Direct Plan;Growth Option;INF204K01T57;-;13.8528;17-Mar-2017\r
123716;HSBC Fixed Term Series 94-Growth;;;NF336L01FZ2;;13.5315;17-Mar-2017\r
139251;Reliance Dual Advantage Fixed Tenure Fund IX- Plan C- Direct Plan-Dividend Payout Option;;;INF204KB1304;;11.0903;17-Mar-2017\r
139252;Reliance Dual Advantage Fixed Tenure Fund IX- Plan C- Dividend Payout Option;;;INF204KB1304;;10.9848;17-Mar-2017\r
";

    /// A report that lists only another fund (its line from 17 March 2017).
    const OTHER_REPORT: &str = "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date\r
119661;Aditya Birla Sun Life Tax Plan - Direct Plan - Growth Option;;;INF209K01VV9;;32.63;17-Mar-2017\r
";

    /// AMFI's answer for a day without NAVs, abridged.
    const NO_DATA: &str = r#"<html><head><title>View/Download NAV History</title></head><body><span id="ctl00_amfiHomeContent_lblErrMsg" class="labelRed">No data found on the basis of selected parameters for this report</span></body></html>"#;

    #[test]
    fn report_maps_either_isin_column_to_the_scheme_code() {
        let mut reports = ReportIndex::default();
        reports.add(date("2017-03-17"), REPORT);

        assert_eq!(reports.code("INF277K01DP6"), Some("101828"));
        assert_eq!(reports.code("INF277K01568"), Some("101828"));
        assert_eq!(reports.code("INF204K01T57"), Some("121701"));
        assert!(reports.dates.contains(&date("2017-03-17")));
        // Text in an ISIN column isn't an ISIN.
        assert!(!reports.codes.contains_key("NF336L01FZ2"));
        assert!(!reports.codes.contains_key("-"));
        assert!(!reports.codes.contains_key("ISIN Div Payout/ISIN Growth"));
    }

    #[test]
    fn report_isin_under_two_codes_matches_neither() {
        let mut reports = ReportIndex::default();
        reports.add(date("2017-03-17"), REPORT);
        // Listed under two codes in one report.
        assert!(reports.codes.contains_key("INF204KB1304"));
        assert_eq!(reports.code("INF204KB1304"), None);

        // Listed under another code in a later report.
        reports.add(
            date("2017-03-20"),
            "999999;Another fund;;;INF277K01DP6;;10.0000;20-Mar-2017",
        );
        assert_eq!(reports.code("INF277K01DP6"), None);
    }

    #[test]
    fn report_responses_are_reports_days_without_navs_or_errors() {
        assert_eq!(
            report_text(StatusCode::OK, REPORT).expect("a report"),
            Some(REPORT)
        );
        assert_eq!(
            report_text(StatusCode::OK, NO_DATA).expect("a day without NAVs"),
            None
        );
        // A page without the no-data message, such as the one an invalid date
        // redirects to, isn't a report.
        for body in [
            "<html><head><title>View/Download NAV History</title></head></html>",
            "Scheme Code;unrelated csv",
            NAV_ALL,
            r#"{"error":"No data found"}"#,
            "<html>No data found</html>",
        ] {
            assert!(report_text(StatusCode::OK, body).is_err(), "{body}");
        }
        assert!(report_text(StatusCode::BAD_GATEWAY, REPORT).is_err());
    }

    #[test]
    fn report_dates_are_weekdays_that_rotate_through_the_week() {
        // A Saturday.
        let first = date("2017-01-28");
        let dates = report_dates(first, date("2017-12-31"));

        assert_eq!(dates.len(), REPORT_LOOKUPS);
        // The first two weekdays of the range.
        assert_eq!(dates[..2], [date("2017-01-30"), date("2017-01-31")]);
        for day in &dates {
            assert!(!matches!(day.weekday(), Weekday::Sat | Weekday::Sun));
        }
        for pair in dates.windows(2) {
            assert_ne!(pair[0].weekday(), pair[1].weekday());
        }
        // A new fund's range starts 45 days before its first activity; two
        // lookups fall after it, in case one is a holiday.
        let first_activity = first
            .checked_add_days(Days::new(45))
            .expect("valid test date");
        assert_eq!(dates.iter().filter(|day| **day > first_activity).count(), 2);
    }

    #[test]
    fn report_dates_stay_in_the_range() {
        assert_eq!(
            report_dates(date("2017-03-13"), date("2017-03-22")),
            vec![date("2017-03-13"), date("2017-03-14"), date("2017-03-22")]
        );
        assert!(report_dates(date("2017-03-18"), date("2017-03-19")).is_empty());
        assert!(report_dates(date("2017-03-20"), date("2017-03-19")).is_empty());
    }

    // -----------------------------------------------------------------------
    // Requests, against a local server
    // -----------------------------------------------------------------------

    type Requests = Arc<std::sync::Mutex<Vec<String>>>;

    /// A provider whose AMFI files come from a local server. The server answers
    /// each request's path and query with `respond` and records it.
    async fn local_provider(
        respond: impl Fn(&str) -> (u16, String) + Send + Sync + 'static,
    ) -> (AmfiProvider, Requests) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a local port");
        let base = format!("http://{}", listener.local_addr().expect("local address"));
        let requests = Requests::default();
        let log = Arc::clone(&requests);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut head = Vec::new();
                let mut buffer = [0; 1024];
                while !head.ends_with(b"\r\n\r\n") {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => head.extend_from_slice(&buffer[..read]),
                    }
                }
                let head = String::from_utf8_lossy(&head);
                let target = head.split_whitespace().nth(1).unwrap_or_default();
                let (status, body) = respond(target);
                log.lock().expect("request log").push(target.to_string());
                let response = format!(
                    "HTTP/1.1 {status} Canned\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        let mut provider = AmfiProvider::with_urls(Urls {
            nav_all: Cow::Owned(format!("{base}/NAVAll.txt")),
            history: Cow::Owned(format!("{base}/history")),
            report: Cow::Owned(format!("{base}/report")),
        });
        provider.client = wealthfolio_http::client_builder()
            .no_proxy()
            .build()
            .expect("local client");
        provider.request_limiter.configure(
            &Cow::Borrowed(PROVIDER_ID),
            RateLimitConfig {
                requests_per_minute: 60_000,
                burst_capacity: 1_000.0,
            },
        );
        (provider, requests)
    }

    /// A query parameter of a recorded request.
    fn param<'a>(target: &'a str, name: &str) -> Option<&'a str> {
        target
            .split_once('?')?
            .1
            .split('&')
            .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
    }

    /// The recorded requests to `path`, by the value of their `name` parameter.
    fn requested(requests: &Requests, path: &str, name: &str) -> Vec<String> {
        requests
            .lock()
            .expect("request log")
            .iter()
            .filter(|target| target.starts_with(path))
            .filter_map(|target| param(target, name).map(str::to_string))
            .collect()
    }

    fn history_body(navs: &[(&str, &str)]) -> String {
        if navs.is_empty() {
            return r#"{"message":"No records to display"}"#.to_string();
        }
        let records: Vec<String> = navs
            .iter()
            .map(|(date, nav)| format!(r#"{{"date":"{date}","nav":{nav}}}"#))
            .collect();
        format!(
            r#"{{"data":{{"nav_groups":[{{"historical_records":[{}]}}]}}}}"#,
            records.join(",")
        )
    }

    async fn history(
        provider: &AmfiProvider,
        symbol: &str,
        first: &str,
        last: &str,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let context = QuoteContext {
            instrument: crate::models::InstrumentId::Equity {
                ticker: symbol.into(),
                mic: None,
            },
            identifiers: crate::models::QuoteIdentifiers::default(),
            overrides: None,
            currency_hint: Some("INR".into()),
            preferred_provider: Some(PROVIDER_ID.into()),
            bond_metadata: None,
            custom_provider_code: None,
        };
        let at = |day: &str| Utc.from_utc_datetime(&date(day).and_time(NaiveTime::MIN));
        provider
            .get_historical_quotes(
                &context,
                ProviderInstrument::EquitySymbol {
                    symbol: symbol.into(),
                },
                at(first),
                at(last),
            )
            .await
    }

    #[tokio::test]
    async fn funds_nav_all_resolves_never_download_reports() {
        let (provider, requests) = local_provider(|target| {
            if target.starts_with("/NAVAll.txt") {
                (200, NAV_ALL.to_string())
            } else if target.starts_with("/history") {
                (200, history_body(&[("2026-10-27", "89.2762")]))
            } else {
                (404, String::new())
            }
        })
        .await;

        for symbol in ["INF879O01027", "INF846K01WQ6", "122639", "999999"] {
            let quotes = history(&provider, symbol, "2026-10-01", "2026-10-28")
                .await
                .expect("NAVs by ISIN or scheme code");
            assert_eq!(quotes.len(), 1);
        }
        // Listed under two codes in NAVAll.txt: unresolved, without a report.
        assert!(matches!(
            history(&provider, "INF204KB1XN0", "2026-10-01", "2026-10-28").await,
            Err(MarketDataError::SymbolNotFound(_))
        ));

        assert_eq!(
            requested(&requests, "/history", "sd_id"),
            vec!["122639", "135763", "122639", "999999"]
        );
        let requests = requests.lock().expect("request log");
        assert!(requests.iter().all(|target| !target.starts_with("/report")));
        assert_eq!(
            requests
                .iter()
                .filter(|target| target.starts_with("/NAVAll.txt"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn concurrent_missing_isins_share_reports_from_the_range_start() {
        let (provider, requests) = local_provider(|target| {
            if target.starts_with("/NAVAll.txt") {
                return (200, NAV_ALL.to_string());
            }
            if target.starts_with("/history") {
                return (200, history_body(&[("2017-03-17", "12.29")]));
            }
            match param(target, "frmdt") {
                Some("01-Feb-2017") => (200, NO_DATA.to_string()),
                Some("02-Feb-2017") => (200, OTHER_REPORT.to_string()),
                Some("10-Feb-2017") => (200, REPORT.to_string()),
                _ => (404, String::new()),
            }
        })
        .await;

        // Lookups on 1, 2 and 10 February, until a report lists the ISIN; its
        // history is then requested by scheme code.
        let (payout, reinvestment) = tokio::join!(
            history(&provider, "INF277K01DP6", "2017-02-01", "2017-03-31"),
            history(&provider, "INF277K01568", "2017-02-01", "2017-03-31")
        );
        let quotes = payout.expect("NAVs of a fund missing from NAVAll.txt");
        assert_eq!(quotes.len(), 1);
        assert_eq!(reinvestment.expect("the same fund's other ISIN").len(), 1);
        assert_eq!(quotes[0].timestamp.date_naive(), date("2017-03-17"));
        assert_eq!(
            requested(&requests, "/report", "frmdt"),
            vec!["01-Feb-2017", "02-Feb-2017", "10-Feb-2017"]
        );
        assert_eq!(
            requested(&requests, "/history", "sd_id"),
            vec!["101828", "101828"]
        );

        // ISINs in the reports already read are found without downloading
        // another, whatever the range.
        history(&provider, "INF277K01DP6", "2017-03-01", "2017-03-31")
            .await
            .expect("the same fund again");
        history(&provider, "INF209K01VV9", "2017-03-01", "2017-03-31")
            .await
            .expect("a fund from another report");
        assert_eq!(requested(&requests, "/report", "frmdt").len(), 3);
        assert_eq!(
            requested(&requests, "/history", "sd_id"),
            vec!["101828", "101828", "101828", "119661"]
        );
    }

    #[tokio::test]
    async fn isin_listed_under_two_codes_in_a_report_stays_unresolved() {
        let (provider, requests) = local_provider(|target| {
            if target.starts_with("/NAVAll.txt") {
                (200, NAV_ALL.to_string())
            } else if target.starts_with("/report") {
                (200, REPORT.to_string())
            } else {
                (404, String::new())
            }
        })
        .await;

        assert!(matches!(
            history(&provider, "INF204KB1304", "2017-03-17", "2017-06-30").await,
            Err(MarketDataError::SymbolNotFound(_))
        ));
        // Later reports can't make it unambiguous, so none is downloaded.
        assert_eq!(
            requested(&requests, "/report", "frmdt"),
            vec!["17-Mar-2017"]
        );
        assert!(requested(&requests, "/history", "sd_id").is_empty());
    }

    #[tokio::test]
    async fn report_that_failed_to_download_is_requested_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = AtomicUsize::new(0);
        let (provider, requests) = local_provider(move |target| {
            if target.starts_with("/NAVAll.txt") {
                (200, NAV_ALL.to_string())
            } else if target.starts_with("/history") {
                (200, history_body(&[("2017-03-17", "12.29")]))
            } else {
                match attempts.fetch_add(1, Ordering::SeqCst) {
                    0 => (200, r#"{"error":"No data found"}"#.to_string()),
                    1 => (502, String::new()),
                    _ => (200, REPORT.to_string()),
                }
            }
        })
        .await;

        for _ in 0..2 {
            assert!(matches!(
                history(&provider, "INF277K01DP6", "2017-03-17", "2017-03-31").await,
                Err(MarketDataError::ProviderError { .. })
            ));
        }
        history(&provider, "INF277K01DP6", "2017-03-17", "2017-03-31")
            .await
            .expect("the report downloads the third time");
        assert_eq!(
            requested(&requests, "/report", "frmdt"),
            vec!["17-Mar-2017", "17-Mar-2017", "17-Mar-2017"]
        );
    }

    #[tokio::test]
    async fn history_stops_at_the_first_empty_window_after_navs() {
        let (provider, requests) = local_provider(|target| {
            // NAVs only in the window starting on 1 January 2016.
            if param(target, "from_date") == Some("2016-01-01") {
                (200, history_body(&[("2016-06-30", "11.92")]))
            } else {
                (200, history_body(&[]))
            }
        })
        .await;

        let quotes = history(&provider, "101828", "2015-01-01", "2020-12-31")
            .await
            .expect("NAVs of a closed fund");
        assert_eq!(quotes.len(), 1);
        // An empty window before the first NAVs doesn't stop the requests.
        assert_eq!(
            requested(&requests, "/history", "from_date"),
            vec!["2015-01-01", "2016-01-01", "2016-12-31"]
        );
    }
}
