//! US Treasury calculated-price provider.
//!
//! Computes bond prices from the daily Treasury yield curve published by
//! Treasury.gov.  The provider fetches one XML feed per calendar year
//! (containing every trading day's curve) and caches it in memory.
//!
//! **Data flow:**
//! 1. Extract CUSIP from ISIN (US ISINs only: prefix "US912").
//! 2. Fetch the yield curve for the relevant year(s).
//! 3. Interpolate the yield at the bond's remaining maturity.
//! 4. Discount coupon + principal cash flows to get PV as fraction-of-par.
//!
//! Supplies TreasuryDirect bond terms through the standard provider profile interface.

use async_trait::async_trait;
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use log::{debug, warn};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::errors::MarketDataError;
use crate::models::{
    AssetProfile, BondProfile, Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext,
};
use crate::provider::{MarketDataProvider, ProviderCapabilities, RateLimit};

const PROVIDER_ID: &str = "US_TREASURY_CALC";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Standard US Treasury face value.
const US_TREASURY_FACE_VALUE: f64 = 1000.0;

// ---------------------------------------------------------------------------
// Yield curve types
// ---------------------------------------------------------------------------

/// A single day's yield curve: sorted vec of (tenor_years, yield_pct).
/// Yields are in percent (e.g. 4.25 means 4.25%).
#[derive(Clone, Debug)]
struct YieldCurve(Vec<(f64, f64)>);

impl YieldCurve {
    /// Linearly interpolate the yield for a given maturity in years.
    fn interpolate(&self, years: f64) -> Option<f64> {
        let pts = &self.0;
        if pts.is_empty() {
            return None;
        }
        // Clamp to range
        if years <= pts[0].0 {
            return Some(pts[0].1);
        }
        if years >= pts[pts.len() - 1].0 {
            return Some(pts[pts.len() - 1].1);
        }
        // Find surrounding points
        for i in 0..pts.len() - 1 {
            if pts[i].0 <= years && years <= pts[i + 1].0 {
                let t = (years - pts[i].0) / (pts[i + 1].0 - pts[i].0);
                return Some(pts[i].1 + t * (pts[i + 1].1 - pts[i].1));
            }
        }
        None
    }
}

/// Map from date → YieldCurve for one calendar year.
type YearCurves = Vec<(NaiveDate, YieldCurve)>;

// ---------------------------------------------------------------------------
// TreasuryDirect bond details (for enrichment)
// ---------------------------------------------------------------------------

/// Bond details returned by the TreasuryDirect API.
#[derive(Debug, Clone)]
struct TreasuryBondDetails {
    /// TreasuryDirect `type` distinguishes nominal notes from TIPS and FRNs.
    pub treasury_type: String,
    pub coupon_rate: Option<Decimal>,
    pub maturity_date: Option<NaiveDate>,
    pub face_value: Decimal,
    pub coupon_frequency: Option<String>,
}

/// Response item from TreasuryDirect securities search.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TdSecurityItem {
    cusip: String,
    #[serde(rename = "type")]
    treasury_type: String,
    #[serde(default)]
    interest_rate: Option<String>,
    #[serde(default)]
    maturity_date: Option<String>,
    #[serde(default)]
    interest_payment_frequency: Option<String>,
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

pub struct UsTreasuryCalcProvider {
    client: reqwest::Client,
    /// Cached yield curves keyed by calendar year.
    curve_cache: Arc<RwLock<HashMap<i32, YearCurves>>>,
    fixtures: Option<TreasuryFixtures>,
}

struct TreasuryFixtures {
    securities: Vec<TdSecurityItem>,
    as_of: NaiveDate,
}

impl Default for UsTreasuryCalcProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl UsTreasuryCalcProvider {
    pub fn new() -> Self {
        let client = wealthfolio_http::client_builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| wealthfolio_http::client());

        Self {
            client,
            curve_cache: Arc::new(RwLock::new(HashMap::new())),
            fixtures: None,
        }
    }

    /// Use synthetic upstream responses with the production parser and calculator.
    /// Missing securities or years fail closed; this instance never makes HTTP requests.
    pub fn with_fixtures(fixture_dir: impl AsRef<Path>) -> Result<Self, MarketDataError> {
        let read = |filename: &str| {
            std::fs::read_to_string(fixture_dir.as_ref().join(filename)).map_err(|_| {
                treasury_details_error(&format!("Cannot read Treasury fixture {filename}"))
            })
        };
        let securities = serde_json::from_str(&read("treasury-securities.json")?)
            .map_err(|_| treasury_details_error("Invalid Treasury securities fixture"))?;
        let curves = parse_yield_curve_xml(&read("treasury-yield-curves.xml")?)?;
        let as_of = curves
            .iter()
            .map(|(date, _)| *date)
            .max()
            .ok_or(MarketDataError::NoDataForRange)?;
        let mut cache: HashMap<i32, YearCurves> = HashMap::new();
        for (date, curve) in curves {
            cache.entry(date.year()).or_default().push((date, curve));
        }
        Ok(Self {
            curve_cache: Arc::new(RwLock::new(cache)),
            fixtures: Some(TreasuryFixtures { securities, as_of }),
            ..Self::new()
        })
    }

    /// Fetch authoritative terms for profiles and calculated quotes.
    async fn fetch_bond_details(&self, isin: &str) -> Result<TreasuryBondDetails, MarketDataError> {
        guard_us_treasury(isin)?;
        let cusip = isin
            .get(2..11)
            .ok_or_else(|| treasury_details_error("Invalid Treasury identifier"))?;
        if let Some(fixtures) = &self.fixtures {
            let item = fixtures
                .securities
                .iter()
                .find(|item| item.cusip == cusip)
                .ok_or_else(|| treasury_details_error("Treasury security absent from fixtures"))?;
            return parse_bond_details(item.clone());
        }
        let url = format!(
            "https://www.treasurydirect.gov/TA_WS/securities/search?cusip={}&format=json",
            cusip
        );
        let resp = self
            .client
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|_| treasury_details_error("Treasury details request failed"))?
            .error_for_status()
            .map_err(|_| treasury_details_error("Treasury details request failed"))?;
        let items: Vec<TdSecurityItem> = resp
            .json()
            .await
            .map_err(|_| treasury_details_error("Invalid Treasury details response"))?;
        let item = items
            .into_iter()
            .find(|item| item.cusip == cusip)
            .ok_or_else(|| treasury_details_error("Treasury details unavailable"))?;
        parse_bond_details(item)
    }

    // -----------------------------------------------------------------------
    // Yield curve fetching
    // -----------------------------------------------------------------------

    /// Ensure the curve cache has data for the given year.
    async fn ensure_curves(&self, year: i32) -> Result<(), MarketDataError> {
        {
            let cache = self.curve_cache.read().await;
            if cache.contains_key(&year) {
                return Ok(());
            }
        }

        let curves = self.fetch_year_curves(year).await?;
        {
            let mut cache = self.curve_cache.write().await;
            cache.insert(year, curves);
        }
        Ok(())
    }

    /// Fetch and parse one year of yield curve data from Treasury.gov XML.
    async fn fetch_year_curves(&self, year: i32) -> Result<YearCurves, MarketDataError> {
        if self.fixtures.is_some() {
            return Err(MarketDataError::NoDataForRange);
        }
        let url = format!(
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={}",
            year
        );

        debug!("Fetching Treasury yield curve for year {}", year);

        let resp =
            self.client
                .get(&url)
                .send()
                .await
                .map_err(|e| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: format!("HTTP request failed: {}", e),
                })?;

        if !resp.status().is_success() {
            return Err(MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        let body = resp
            .text()
            .await
            .map_err(|e| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("Failed to read response: {}", e),
            })?;

        parse_yield_curve_xml(&body)
    }

    /// Look up the yield curve for a specific date, falling back to previous
    /// trading days if the exact date is not available.
    async fn get_curve_for_date(&self, date: NaiveDate) -> Result<YieldCurve, MarketDataError> {
        self.ensure_curves(date.year()).await?;

        let cache = self.curve_cache.read().await;
        let curves = cache
            .get(&date.year())
            .ok_or_else(|| MarketDataError::ProviderError {
                provider: PROVIDER_ID.to_string(),
                message: format!("No curve data for year {}", date.year()),
            })?;

        // Find closest date <= target date
        let mut best: Option<&(NaiveDate, YieldCurve)> = None;
        for entry in curves {
            if entry.0 <= date {
                match best {
                    Some(b) if entry.0 > b.0 => best = Some(entry),
                    None => best = Some(entry),
                    _ => {}
                }
            }
        }

        best.map(|(_, c)| c.clone())
            .ok_or(MarketDataError::NoDataForRange)
    }

    // -----------------------------------------------------------------------
    // Bond pricing
    // -----------------------------------------------------------------------

    /// Calculate bond price as fraction of par for a given date.
    fn calculate_price(
        curve: &YieldCurve,
        settlement_date: NaiveDate,
        maturity_date: NaiveDate,
        coupon_rate: f64,
        coupon_frequency: &str,
        face_value: f64,
    ) -> Result<f64, MarketDataError> {
        let years_to_maturity = (maturity_date - settlement_date).num_days() as f64 / 365.25;

        if years_to_maturity <= 0.0 {
            // Bond has matured — return par
            return Ok(1.0);
        }

        let yield_pct =
            curve
                .interpolate(years_to_maturity)
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: "Could not interpolate yield".to_string(),
                })?;

        let yield_dec = yield_pct / 100.0; // e.g. 4.25% → 0.0425

        let price = if coupon_frequency == "ZERO" || coupon_rate == 0.0 {
            // T-bill / zero-coupon: simple discount
            // P = F / (1 + y * t/360)  (money-market convention)
            let days = (maturity_date - settlement_date).num_days() as f64;
            face_value / (1.0 + yield_dec * days / 360.0)
        } else {
            // Coupon bond PV: semi-annual assumed unless ANNUAL/QUARTERLY
            let freq = match coupon_frequency {
                "ANNUAL" => 1.0,
                "QUARTERLY" => 4.0,
                _ => 2.0, // SEMI_ANNUAL default
            };

            let coupon_payment = face_value * coupon_rate / freq;
            let periods = (years_to_maturity * freq).ceil() as u32;
            let period_yield = yield_dec / freq;

            let mut pv = 0.0;
            for i in 1..=periods {
                pv += coupon_payment / (1.0 + period_yield).powi(i as i32);
            }
            pv += face_value / (1.0 + period_yield).powi(periods as i32);
            pv
        };

        // Return as fraction of par
        Ok(price / face_value)
    }

    /// Build a Quote from a calculated price.
    fn make_quote(
        date: NaiveDate,
        price_fraction: f64,
        currency: &str,
    ) -> Result<Quote, MarketDataError> {
        let close =
            Decimal::try_from(price_fraction).map_err(|_| MarketDataError::ValidationFailed {
                message: format!("Invalid price: {}", price_fraction),
            })?;

        let timestamp = DateTime::<Utc>::from_naive_utc_and_offset(
            date.and_hms_opt(16, 0, 0)
                .expect("16:00:00 is a valid time"),
            Utc,
        );

        Ok(Quote::new(
            timestamp,
            close,
            currency.to_string(),
            PROVIDER_ID.to_string(),
        ))
    }
}

// ---------------------------------------------------------------------------
// MarketDataProvider impl
// ---------------------------------------------------------------------------

#[async_trait]
impl MarketDataProvider for UsTreasuryCalcProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn priority(&self) -> u8 {
        10
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            instrument_kinds: &[InstrumentKind::Bond],
            coverage: Coverage::global_best_effort(),
            supports_latest: true,
            supports_historical: true,
            supports_search: false,
            supports_profile: true,
            supports_dividends: false,
        }
    }

    fn rate_limit(&self) -> RateLimit {
        RateLimit {
            requests_per_minute: 120,
            max_concurrency: 5,
            min_delay: Duration::from_millis(500),
        }
    }

    async fn get_profile(&self, symbol: &str) -> Result<AssetProfile, MarketDataError> {
        guard_us_treasury(symbol)?;
        let details = self.fetch_bond_details(symbol).await?;
        Ok(details.into_profile(symbol))
    }

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let isin = extract_isin(&instrument)?;
        guard_us_treasury(&isin)?;

        let bond = resolve_calculated_terms(
            context.bond_metadata.as_ref(),
            self.fetch_bond_details(&isin),
        )
        .await?;

        let today = match &self.fixtures {
            Some(fixtures) => super::fixture::fixture_as_of_date(fixtures.as_of, PROVIDER_ID)?,
            None => Utc::now().date_naive(),
        };
        let curve = match self.get_curve_for_date(today).await {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "US_TREASURY_CALC: yield curve fetch failed for {}: {}",
                    isin, e
                );
                return Err(e);
            }
        };

        let coupon_rate: f64 = bond.coupon_rate.try_into().unwrap_or(0.0);
        let face_value: f64 = bond.face_value.try_into().unwrap_or(US_TREASURY_FACE_VALUE);

        let price = match Self::calculate_price(
            &curve,
            today,
            bond.maturity_date,
            coupon_rate,
            &bond.coupon_frequency,
            face_value,
        ) {
            Ok(p) => {
                debug!(
                    "US_TREASURY_CALC: {} price={:.6} (coupon={}, maturity={}, freq={})",
                    isin, p, coupon_rate, bond.maturity_date, bond.coupon_frequency
                );
                p
            }
            Err(e) => {
                warn!(
                    "US_TREASURY_CALC: price calculation failed for {}: {}",
                    isin, e
                );
                return Err(e);
            }
        };

        let currency = context.currency_hint.as_deref().unwrap_or("USD");
        Self::make_quote(today, price, currency)
    }

    async fn get_historical_quotes(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Quote>, MarketDataError> {
        let isin = extract_isin(&instrument)?;
        guard_us_treasury(&isin)?;

        let bond = resolve_calculated_terms(
            context.bond_metadata.as_ref(),
            self.fetch_bond_details(&isin),
        )
        .await?;

        let start_date = start.date_naive();
        let end_date = match &self.fixtures {
            Some(fixtures) => end.date_naive().min(super::fixture::fixture_as_of_date(
                fixtures.as_of,
                PROVIDER_ID,
            )?),
            None => end.date_naive(),
        };
        if self.fixtures.is_some() && start_date > end_date {
            return Err(MarketDataError::NoDataForRange);
        }
        let currency = context.currency_hint.as_deref().unwrap_or("USD");

        let coupon_rate: f64 = bond.coupon_rate.try_into().unwrap_or(0.0);
        let face_value: f64 = bond.face_value.try_into().unwrap_or(US_TREASURY_FACE_VALUE);

        // Ensure we have curves for all years in range
        for year in start_date.year()..=end_date.year() {
            self.ensure_curves(year).await?;
        }

        let cache = self.curve_cache.read().await;
        let mut quotes = Vec::new();

        // Collect all curve dates in range
        for year in start_date.year()..=end_date.year() {
            if let Some(year_curves) = cache.get(&year) {
                for (date, curve) in year_curves {
                    if *date >= start_date && *date <= end_date {
                        match Self::calculate_price(
                            curve,
                            *date,
                            bond.maturity_date,
                            coupon_rate,
                            &bond.coupon_frequency,
                            face_value,
                        ) {
                            Ok(price) => match Self::make_quote(*date, price, currency) {
                                Ok(q) => quotes.push(q),
                                Err(e) => {
                                    debug!("Skipping date {}: {}", date, e);
                                }
                            },
                            Err(e) => {
                                debug!("Skipping date {}: {}", date, e);
                            }
                        }
                    }
                }
            }
        }

        quotes.sort_by_key(|q| q.timestamp);
        Ok(quotes)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_isin(instrument: &ProviderInstrument) -> Result<String, MarketDataError> {
    match instrument {
        ProviderInstrument::BondIsin { isin } => Ok(isin.to_string()),
        _ => Err(MarketDataError::UnsupportedAssetType(format!(
            "{:?}",
            instrument
        ))),
    }
}

/// Only accept US Treasury ISINs (prefix "US912").
fn guard_us_treasury(isin: &str) -> Result<(), MarketDataError> {
    if !is_us_treasury_isin(isin) {
        return Err(MarketDataError::SymbolNotFound(format!(
            "{} is not a US Treasury ISIN",
            isin
        )));
    }
    Ok(())
}

fn is_us_treasury_isin(isin: &str) -> bool {
    isin.starts_with("US912") && isin.len() == 12 && isin.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn treasury_details_error(message: &str) -> MarketDataError {
    MarketDataError::ProviderError {
        provider: PROVIDER_ID.to_string(),
        message: message.to_string(),
    }
}

fn parse_bond_details(item: TdSecurityItem) -> Result<TreasuryBondDetails, MarketDataError> {
    let supported = matches!(item.treasury_type.as_str(), "Bill" | "Note" | "Bond");
    let coupon_rate = if item.treasury_type == "Bill" {
        Some(Decimal::ZERO)
    } else {
        item.interest_rate
            .as_deref()
            .and_then(|r| r.parse::<Decimal>().ok())
            .filter(|rate| *rate >= Decimal::ZERO)
            .map(|r| r / Decimal::from(100))
    };
    let maturity_date = item
        .maturity_date
        .as_deref()
        .and_then(|d| d.get(..10))
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let coupon_frequency = if item.treasury_type == "Bill" {
        Some("ZERO".to_string())
    } else {
        item.interest_payment_frequency
            .as_deref()
            .map(normalize_frequency)
            .filter(|f| matches!(f.as_str(), "SEMI_ANNUAL" | "ANNUAL" | "QUARTERLY"))
    };
    if item.treasury_type.trim().is_empty() {
        return Err(treasury_details_error("Missing Treasury type"));
    }
    let details = TreasuryBondDetails {
        treasury_type: item.treasury_type,
        coupon_rate,
        maturity_date,
        coupon_frequency,
        face_value: Decimal::from(US_TREASURY_FACE_VALUE as i64),
    };
    if supported {
        details.clone().into_calculated_terms()?;
    }
    Ok(details)
}

// Only validated, complete nominal terms reach the price calculator.
struct CalculatedBondTerms {
    coupon_rate: Decimal,
    maturity_date: NaiveDate,
    face_value: Decimal,
    coupon_frequency: String,
}

impl TryFrom<&crate::models::BondQuoteMetadata> for CalculatedBondTerms {
    type Error = MarketDataError;

    fn try_from(bond: &crate::models::BondQuoteMetadata) -> Result<Self, Self::Error> {
        if !bond.has_valid_treasury_terms() {
            return Err(treasury_details_error(
                "Confirmed nominal Treasury terms required for calculated pricing",
            ));
        }
        let incomplete = || treasury_details_error("Incomplete Treasury terms");
        Ok(Self {
            coupon_rate: bond.coupon_rate.ok_or_else(incomplete)?,
            maturity_date: bond.maturity_date.ok_or_else(incomplete)?,
            face_value: bond.face_value,
            coupon_frequency: bond.coupon_frequency.clone().ok_or_else(incomplete)?,
        })
    }
}

// Resolve older assets on the quote path too: they may never enter broker sync.
async fn resolve_calculated_terms(
    supplied: Option<&crate::models::BondQuoteMetadata>,
    fetch: impl std::future::Future<Output = Result<TreasuryBondDetails, MarketDataError>>,
) -> Result<CalculatedBondTerms, MarketDataError> {
    if let Some(bond) = supplied {
        if let Ok(terms) = CalculatedBondTerms::try_from(bond) {
            return Ok(terms);
        }
        if bond
            .treasury_type
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "Bill" | "Note" | "Bond"))
        {
            return Err(treasury_details_error("Unsupported Treasury type"));
        }
    }
    let details = fetch.await?;
    details.into_calculated_terms()
}

impl TreasuryBondDetails {
    fn into_profile(self, isin: &str) -> AssetProfile {
        let mut name = format!("United States Treasury {}", self.treasury_type);
        if let Some(maturity) = self.maturity_date {
            name.push_str(&format!(" {maturity}"));
        }
        AssetProfile {
            name: Some(name),
            source: Some(PROVIDER_ID.into()),
            isin: Some(isin.into()),
            quote_type: Some("BOND".into()),
            currency: Some("USD".into()),
            bond: Some(BondProfile {
                isin: Some(isin.into()),
                treasury_type: Some(self.treasury_type),
                coupon_rate: self.coupon_rate,
                maturity_date: self.maturity_date,
                face_value: Some(self.face_value),
                coupon_frequency: self.coupon_frequency,
            }),
            ..Default::default()
        }
    }

    fn into_calculated_terms(self) -> Result<CalculatedBondTerms, MarketDataError> {
        let bond = crate::models::BondQuoteMetadata {
            treasury_type: Some(self.treasury_type),
            coupon_rate: self.coupon_rate,
            maturity_date: self.maturity_date,
            face_value: self.face_value,
            coupon_frequency: self.coupon_frequency,
        };
        CalculatedBondTerms::try_from(&bond)
    }
}

fn normalize_frequency(freq: &str) -> String {
    match freq.to_uppercase().as_str() {
        "SEMI-ANNUAL" | "SEMI_ANNUAL" | "SEMIANNUAL" => "SEMI_ANNUAL".to_string(),
        "ANNUAL" => "ANNUAL".to_string(),
        "QUARTERLY" => "QUARTERLY".to_string(),
        "NONE" | "ZERO" => "ZERO".to_string(),
        _ => freq.to_string(),
    }
}

// ---------------------------------------------------------------------------
// XML parsing for Treasury yield curve
// ---------------------------------------------------------------------------

/// Tenor labels in the XML and their year-fractions.
const TENOR_MAP: &[(&str, f64)] = &[
    ("BC_1MONTH", 1.0 / 12.0),
    ("BC_2MONTH", 2.0 / 12.0),
    ("BC_3MONTH", 3.0 / 12.0),
    ("BC_4MONTH", 4.0 / 12.0),
    ("BC_6MONTH", 6.0 / 12.0),
    ("BC_1YEAR", 1.0),
    ("BC_2YEAR", 2.0),
    ("BC_3YEAR", 3.0),
    ("BC_5YEAR", 5.0),
    ("BC_7YEAR", 7.0),
    ("BC_10YEAR", 10.0),
    ("BC_20YEAR", 20.0),
    ("BC_30YEAR", 30.0),
];

/// Parse the Treasury.gov XML feed into a vec of (date, YieldCurve).
///
/// The XML uses Atom + custom namespace.  We do simple text scanning rather
/// than a full XML parse to avoid heavy dependencies.
fn parse_yield_curve_xml(xml: &str) -> Result<YearCurves, MarketDataError> {
    let mut results: YearCurves = Vec::new();

    // Each entry is between <entry> ... </entry>
    for entry in xml.split("<entry>").skip(1) {
        let entry_end = entry.find("</entry>").unwrap_or(entry.len());
        let entry = &entry[..entry_end];

        // Find the content section
        let content = match entry.find("<content") {
            Some(start) => &entry[start..],
            None => continue,
        };

        // Extract date from NEW_DATE
        let date = match extract_xml_value(content, "NEW_DATE") {
            Some(d) => {
                // Format: "2025-01-02T00:00:00" or similar
                let date_str = d.get(..10).unwrap_or(&d);
                match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    Ok(nd) => nd,
                    Err(_) => continue,
                }
            }
            None => continue,
        };

        // Extract yield values for each tenor
        let mut points: Vec<(f64, f64)> = Vec::new();
        for (label, tenor_years) in TENOR_MAP {
            if let Some(val_str) = extract_xml_value(content, label) {
                if let Ok(yield_val) = val_str.parse::<f64>() {
                    points.push((*tenor_years, yield_val));
                }
            }
        }

        if !points.is_empty() {
            points.sort_by(|a, b| a.0.total_cmp(&b.0));
            results.push((date, YieldCurve(points)));
        }
    }

    if results.is_empty() {
        return Err(MarketDataError::ProviderError {
            provider: PROVIDER_ID.to_string(),
            message: "No yield curve data found in XML".to_string(),
        });
    }

    Ok(results)
}

/// Extract the text content of a simple XML element like `<d:TAG>value</d:TAG>`.
/// Handles both `d:TAG` and `TAG` namespace prefixes.
fn extract_xml_value(xml: &str, tag: &str) -> Option<String> {
    // Try d:TAG first (common namespace prefix)
    let patterns = [format!("d:{}", tag), tag.to_string()];
    for pat in &patterns {
        // Match opening tag with optional attributes: <d:TAG> or <d:TAG m:type="...">
        let open_prefix = format!("<{}", pat);
        if let Some(tag_start) = xml.find(&open_prefix) {
            let after_tag = &xml[tag_start + open_prefix.len()..];
            // Find the end of the opening tag (either > or whitespace+attributes+>)
            let content_start = after_tag.find('>')?;
            let after_open = &after_tag[content_start + 1..];
            let close = format!("</{}>", pat);
            if let Some(end) = after_open.find(&close) {
                return Some(after_open[..end].trim().to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;

    fn fixture_provider() -> UsTreasuryCalcProvider {
        UsTreasuryCalcProvider::with_fixtures(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../e2e/fixtures/quotes"),
        )
        .unwrap()
    }

    fn fixture_context(isin: &str) -> QuoteContext {
        QuoteContext {
            instrument: crate::models::InstrumentId::Bond { isin: isin.into() },
            currency_hint: Some("USD".into()),
            overrides: None,
            preferred_provider: None,
            identifiers: Default::default(),
            bond_metadata: None,
            custom_provider_code: None,
        }
    }

    #[tokio::test]
    async fn fixtures_use_validated_terms_and_real_treasury_calculator() {
        let provider = fixture_provider();
        let profile = provider.get_profile("US91282CRF04").await.unwrap();
        let bond = profile.bond.unwrap();
        assert_eq!(profile.isin.as_deref(), Some("US91282CRF04"));
        assert_eq!(bond.treasury_type.as_deref(), Some("Note"));
        assert_eq!(bond.coupon_rate, Some(dec!(0.04)));
        assert_eq!(bond.coupon_frequency.as_deref(), Some("SEMI_ANNUAL"));

        for (isin, expected) in [
            ("US91282CRF04", 1.0),
            // 365-day bill at 4%: 1 / (1 + 0.04 * 365 / 360).
            ("US912797VR56", 0.961025093433),
            // 60 semiannual payments of 2.5% discounted at 2% per period.
            ("US912810UW61", 1.173804433385),
        ] {
            let quotes = provider
                .get_historical_quotes(
                    &fixture_context(isin),
                    ProviderInstrument::BondIsin { isin: isin.into() },
                    Utc.with_ymd_and_hms(2026, 5, 12, 0, 0, 0).unwrap(),
                    Utc.with_ymd_and_hms(2026, 5, 12, 23, 59, 59).unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(quotes.len(), 1);
            assert_eq!(quotes[0].source, PROVIDER_ID);
            assert_eq!(quotes[0].currency, "USD");
            let close: f64 = quotes[0].close.try_into().unwrap();
            assert!((close - expected).abs() < 1e-10);
        }
    }

    #[tokio::test]
    async fn treasury_fixtures_reject_unsupported_or_missing_inputs_without_live_fallback() {
        let provider = fixture_provider();
        for isin in ["US91282CRE39", "US91282CRD55"] {
            assert!(provider.get_profile(isin).await.unwrap().bond.is_some());
            assert!(provider
                .get_historical_quotes(
                    &fixture_context(isin),
                    ProviderInstrument::BondIsin { isin: isin.into() },
                    Utc.with_ymd_and_hms(2026, 5, 12, 0, 0, 0).unwrap(),
                    Utc.with_ymd_and_hms(2026, 5, 12, 23, 59, 59).unwrap(),
                )
                .await
                .is_err());
        }
        let missing = provider.get_profile("US912810TH14").await.unwrap_err();
        assert!(missing.to_string().contains("absent from fixtures"));
        assert!(matches!(
            provider.ensure_curves(2025).await,
            Err(MarketDataError::NoDataForRange)
        ));
        assert!(UsTreasuryCalcProvider::with_fixtures(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("missing-fixtures"),
        )
        .is_err());
    }

    #[tokio::test]
    async fn treasury_fixture_history_stops_at_as_of_without_fetching_future_years() {
        let quotes = fixture_provider()
            .get_historical_quotes(
                &fixture_context("US91282CRF04"),
                ProviderInstrument::BondIsin {
                    isin: "US91282CRF04".into(),
                },
                Utc.with_ymd_and_hms(2026, 5, 11, 0, 0, 0).unwrap(),
                Utc.with_ymd_and_hms(2027, 6, 1, 23, 59, 59).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(quotes.len(), 2);
        assert_eq!(
            quotes[1].timestamp.date_naive(),
            NaiveDate::from_ymd_opt(2026, 5, 12).unwrap()
        );
    }

    #[test]
    fn test_is_us_treasury_isin() {
        assert!(is_us_treasury_isin("US912810TH12"));
        assert!(is_us_treasury_isin("US9128283M69"));
        assert!(!is_us_treasury_isin("DE0001102481"));
        assert!(!is_us_treasury_isin("US037833100")); // Apple, not Treasury
    }

    #[test]
    fn test_guard_us_treasury() {
        assert!(guard_us_treasury("US912810TH12").is_ok());
        assert!(guard_us_treasury("DE0001102481").is_err());
    }

    #[test]
    fn test_normalize_frequency() {
        assert_eq!(normalize_frequency("Semi-Annual"), "SEMI_ANNUAL");
        assert_eq!(normalize_frequency("SEMI_ANNUAL"), "SEMI_ANNUAL");
        assert_eq!(normalize_frequency("Annual"), "ANNUAL");
        assert_eq!(normalize_frequency("Quarterly"), "QUARTERLY");
        assert_eq!(normalize_frequency("None"), "ZERO");
        assert_eq!(normalize_frequency("unknown"), "unknown");
    }

    #[test]
    fn test_yield_curve_interpolation() {
        let curve = YieldCurve(vec![
            (1.0, 4.0),
            (2.0, 4.2),
            (5.0, 4.5),
            (10.0, 4.8),
            (30.0, 5.0),
        ]);

        // Exact match
        assert!((curve.interpolate(1.0).unwrap() - 4.0).abs() < 1e-10);
        assert!((curve.interpolate(10.0).unwrap() - 4.8).abs() < 1e-10);

        // Interpolation: midpoint between 1.0 and 2.0
        assert!((curve.interpolate(1.5).unwrap() - 4.1).abs() < 1e-10);

        // Below range clamps to first
        assert!((curve.interpolate(0.5).unwrap() - 4.0).abs() < 1e-10);

        // Above range clamps to last
        assert!((curve.interpolate(40.0).unwrap() - 5.0).abs() < 1e-10);
    }

    #[test]
    fn test_yield_curve_empty() {
        let curve = YieldCurve(vec![]);
        assert!(curve.interpolate(5.0).is_none());
    }

    #[test]
    fn test_calculate_price_matured_bond() {
        let curve = YieldCurve(vec![(1.0, 4.0), (10.0, 4.5)]);
        let today = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();
        let maturity = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(); // already matured

        let price = UsTreasuryCalcProvider::calculate_price(
            &curve,
            today,
            maturity,
            0.05,
            "SEMI_ANNUAL",
            1000.0,
        )
        .unwrap();
        assert!((price - 1.0).abs() < 1e-10); // par
    }

    #[test]
    fn test_calculate_price_zero_coupon() {
        let curve = YieldCurve(vec![(0.25, 5.0), (0.5, 5.1), (1.0, 5.2)]);
        let today = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let maturity = NaiveDate::from_ymd_opt(2025, 7, 1).unwrap(); // ~6 months

        let price =
            UsTreasuryCalcProvider::calculate_price(&curve, today, maturity, 0.0, "ZERO", 1000.0)
                .unwrap();

        // Should be slightly less than 1.0 (discounted)
        assert!(price < 1.0);
        assert!(price > 0.95);
    }

    #[test]
    fn test_calculate_price_coupon_bond() {
        let curve = YieldCurve(vec![(1.0, 4.0), (2.0, 4.2), (5.0, 4.5), (10.0, 4.8)]);
        let today = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let maturity = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap(); // 5 years

        // 5% coupon, semi-annual, at ~4.5% yield → price should be > par
        let price = UsTreasuryCalcProvider::calculate_price(
            &curve,
            today,
            maturity,
            0.05,
            "SEMI_ANNUAL",
            1000.0,
        )
        .unwrap();

        assert!(price > 1.0, "5% coupon at 4.5% yield should be above par");
        assert!(price < 1.05, "Should be close to par: {}", price);
    }

    #[test]
    fn test_calculate_price_discount_bond() {
        let curve = YieldCurve(vec![(1.0, 5.0), (2.0, 5.2), (5.0, 5.5), (10.0, 5.8)]);
        let today = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let maturity = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();

        // 3% coupon at ~5.5% yield → discount
        let price = UsTreasuryCalcProvider::calculate_price(
            &curve,
            today,
            maturity,
            0.03,
            "SEMI_ANNUAL",
            1000.0,
        )
        .unwrap();

        assert!(price < 1.0, "3% coupon at 5.5% yield should be below par");
        assert!(price > 0.85, "Should not be too far below par: {}", price);
    }

    #[test]
    fn test_parse_yield_curve_xml() {
        let xml = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <content type="application/xml">
      <m:properties>
        <d:NEW_DATE>2025-01-02T00:00:00</d:NEW_DATE>
        <d:BC_1MONTH>4.34</d:BC_1MONTH>
        <d:BC_3MONTH>4.31</d:BC_3MONTH>
        <d:BC_6MONTH>4.28</d:BC_6MONTH>
        <d:BC_1YEAR>4.22</d:BC_1YEAR>
        <d:BC_2YEAR>4.25</d:BC_2YEAR>
        <d:BC_5YEAR>4.40</d:BC_5YEAR>
        <d:BC_10YEAR>4.57</d:BC_10YEAR>
        <d:BC_30YEAR>4.78</d:BC_30YEAR>
      </m:properties>
    </content>
  </entry>
  <entry>
    <content type="application/xml">
      <m:properties>
        <d:NEW_DATE>2025-01-03T00:00:00</d:NEW_DATE>
        <d:BC_1MONTH>4.35</d:BC_1MONTH>
        <d:BC_3MONTH>4.32</d:BC_3MONTH>
        <d:BC_10YEAR>4.60</d:BC_10YEAR>
        <d:BC_30YEAR>4.82</d:BC_30YEAR>
      </m:properties>
    </content>
  </entry>
</feed>"#;

        let curves = parse_yield_curve_xml(xml).unwrap();
        assert_eq!(curves.len(), 2);

        // First entry
        assert_eq!(curves[0].0, NaiveDate::from_ymd_opt(2025, 1, 2).unwrap());
        assert_eq!(curves[0].1 .0.len(), 8); // 8 tenors parsed

        // Check first tenor value
        let first_point = &curves[0].1 .0[0];
        assert!((first_point.0 - 1.0 / 12.0).abs() < 0.01); // 1 month
        assert!((first_point.1 - 4.34).abs() < 1e-10);

        // Second entry
        assert_eq!(curves[1].0, NaiveDate::from_ymd_opt(2025, 1, 3).unwrap());
        assert_eq!(curves[1].1 .0.len(), 4); // only 4 tenors in this entry
    }

    #[test]
    fn test_parse_yield_curve_xml_skips_non_ascii_date() {
        // The first NEW_DATE is 20 bytes, with byte 10 inside the 'é'
        let xml = r#"<feed>
  <entry><content><m:properties>
    <d:NEW_DATE>2025-01-0éT00:00:00</d:NEW_DATE>
    <d:BC_10YEAR>4.57</d:BC_10YEAR>
  </m:properties></content></entry>
  <entry><content><m:properties>
    <d:NEW_DATE>2025-01-03T00:00:00</d:NEW_DATE>
    <d:BC_10YEAR>4.60</d:BC_10YEAR>
  </m:properties></content></entry>
</feed>"#;

        let curves = parse_yield_curve_xml(xml).unwrap();
        assert_eq!(curves.len(), 1);
        assert_eq!(curves[0].0, NaiveDate::from_ymd_opt(2025, 1, 3).unwrap());
    }

    #[test]
    fn test_parse_yield_curve_xml_empty() {
        let xml = "<feed></feed>";
        assert!(parse_yield_curve_xml(xml).is_err());
    }

    #[test]
    fn test_extract_xml_value() {
        let xml = "<d:BC_10YEAR>4.57</d:BC_10YEAR>";
        assert_eq!(
            extract_xml_value(xml, "BC_10YEAR"),
            Some("4.57".to_string())
        );

        // Without namespace
        let xml = "<BC_1YEAR>4.22</BC_1YEAR>";
        assert_eq!(extract_xml_value(xml, "BC_1YEAR"), Some("4.22".to_string()));

        // Missing
        assert_eq!(extract_xml_value(xml, "BC_5YEAR"), None);
    }

    #[test]
    fn test_provider_id() {
        let provider = UsTreasuryCalcProvider::new();
        assert_eq!(provider.id(), "US_TREASURY_CALC");
    }

    #[test]
    fn test_provider_capabilities() {
        let provider = UsTreasuryCalcProvider::new();
        let caps = provider.capabilities();
        assert_eq!(caps.instrument_kinds, &[InstrumentKind::Bond]);
        assert!(caps.supports_latest);
        assert!(caps.supports_historical);
        assert!(!caps.supports_search);
        assert!(caps.supports_profile);
    }

    #[test]
    fn test_make_quote() {
        let date = NaiveDate::from_ymd_opt(2025, 6, 15).unwrap();
        let quote = UsTreasuryCalcProvider::make_quote(date, 0.97025, "USD").unwrap();
        assert_eq!(quote.currency, "USD");
        assert_eq!(quote.source, "US_TREASURY_CALC");
        assert!(quote.close > dec!(0));
    }

    #[test]
    fn treasury_terms_require_explicit_type_and_valid_values() {
        let fixture = |kind: &str, rate: &str, maturity: &str| -> TdSecurityItem {
            serde_json::from_value(serde_json::json!({
                "cusip": "912810TH1", "type": kind, "securityType": "Note",
                "interestRate": rate, "maturityDate": maturity,
                "interestPaymentFrequency": "Semi-Annual"
            }))
            .unwrap()
        };
        let bill = parse_bond_details(fixture("Bill", "", "2027-01-01")).unwrap();
        assert_eq!(bill.coupon_rate, Some(Decimal::ZERO));
        assert_eq!(bill.coupon_frequency.as_deref(), Some("ZERO"));
        for rate in ["", "n/a", "NaN", "-1"] {
            assert!(parse_bond_details(fixture("Note", rate, "2030-01-01")).is_err());
        }
        assert_eq!(
            parse_bond_details(fixture("Bond", "4.125", "2030-01-01"))
                .unwrap()
                .coupon_rate,
            Some(dec!(0.04125))
        );
        assert!(parse_bond_details(fixture("Bond", "0", "2030-01-01")).is_err());
        let mut annual = fixture("Note", "4", "2030-01-01");
        annual.interest_payment_frequency = Some("Annual".into());
        assert!(parse_bond_details(annual).is_err());
        for date in ["", "bad", "éééééé", "2030-99-99"] {
            assert!(parse_bond_details(fixture("Note", "4", date)).is_err());
        }
        for kind in ["TIPS", "FRN", "STRIPS"] {
            let details = parse_bond_details(fixture(kind, "", "2030-01-01")).unwrap();
            assert_eq!(details.treasury_type, kind);
            assert_eq!(details.coupon_rate, None);
        }
        assert!(parse_bond_details(fixture("", "4", "2030-01-01")).is_err());
    }

    #[test]
    fn treasury_profile_carries_terms_including_unsupported_types() {
        for kind in ["Bill", "Note", "Bond", "TIPS", "FRN"] {
            let item = serde_json::from_value(serde_json::json!({
                "cusip": "912810TH1", "type": kind,
                "interestRate": if matches!(kind, "TIPS" | "FRN") { "" } else { "5" },
                "maturityDate": "2043-05-15", "interestPaymentFrequency": "Semi-Annual",
            }))
            .unwrap();
            let profile = parse_bond_details(item)
                .unwrap()
                .into_profile("US912810TH14");
            assert_eq!(profile.source.as_deref(), Some(PROVIDER_ID));
            assert_eq!(
                profile.name,
                Some(format!("United States Treasury {kind} 2043-05-15"))
            );
            assert_eq!(profile.isin.as_deref(), Some("US912810TH14"));
            let bond = profile.bond.unwrap();
            assert_eq!(bond.treasury_type.as_deref(), Some(kind));
            assert_eq!(bond.maturity_date, NaiveDate::from_ymd_opt(2043, 5, 15));
            if matches!(kind, "TIPS" | "FRN") {
                assert!(bond.coupon_rate.is_none());
            }
        }
    }

    #[tokio::test]
    async fn non_treasury_profile_is_rejected_before_fetching() {
        let provider = UsTreasuryCalcProvider::new();
        assert!(provider.get_profile("US037833EZ91").await.is_err());
    }

    #[tokio::test]
    async fn legacy_quote_terms_are_verified_on_demand() {
        let legacy = crate::models::BondQuoteMetadata {
            treasury_type: None,
            coupon_rate: Some(Decimal::ZERO),
            maturity_date: NaiveDate::from_ymd_opt(2030, 1, 1),
            coupon_frequency: Some("ZERO".into()),
            face_value: dec!(1000),
        };
        for supplied in [None, Some(&legacy)] {
            let verified = resolve_calculated_terms(supplied, async {
                Ok(TreasuryBondDetails {
                    treasury_type: "Note".into(),
                    coupon_rate: Some(dec!(0.04)),
                    maturity_date: legacy.maturity_date,
                    coupon_frequency: Some("SEMI_ANNUAL".into()),
                    face_value: dec!(1000),
                })
            })
            .await
            .unwrap();
            assert_eq!(verified.coupon_rate, dec!(0.04));
        }
        assert!(resolve_calculated_terms(Some(&legacy), async {
            Err(treasury_details_error("temporary outage"))
        })
        .await
        .is_err());
        let mut tips = legacy;
        tips.treasury_type = Some("TIPS".into());
        assert!(resolve_calculated_terms(Some(&tips), async {
            panic!("known unsupported types must not refetch")
        })
        .await
        .is_err());
        let mut verified = tips;
        verified.treasury_type = Some("Bill".into());
        assert!(resolve_calculated_terms(Some(&verified), async {
            panic!("valid verified terms must not refetch")
        })
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn incomplete_unsupported_terms_never_fetch() {
        for kind in ["TIPS", "FRN", "STRIPS"] {
            let metadata = crate::models::BondQuoteMetadata {
                treasury_type: Some(kind.into()),
                coupon_rate: None,
                maturity_date: None,
                face_value: dec!(1000),
                coupon_frequency: None,
            };
            let result = resolve_calculated_terms(Some(&metadata), async {
                panic!("known unsupported Treasury types must not request terms")
            })
            .await;
            assert!(
                matches!(result, Err(MarketDataError::ProviderError { message, .. })
                if message == "Unsupported Treasury type")
            );
        }
    }

    #[tokio::test]
    async fn incomplete_nominal_terms_fetch_before_pricing() {
        for kind in [None, Some("Note")] {
            // Each missing field must prevent use of the supplied terms.
            for missing in ["coupon", "maturity", "frequency"] {
                let metadata = crate::models::BondQuoteMetadata {
                    treasury_type: kind.map(str::to_string),
                    coupon_rate: (missing != "coupon").then_some(dec!(0.01)),
                    maturity_date: (missing != "maturity")
                        .then(|| NaiveDate::from_ymd_opt(2030, 1, 1).unwrap()),
                    face_value: dec!(1000),
                    coupon_frequency: (missing != "frequency").then(|| "SEMI_ANNUAL".into()),
                };
                let terms = resolve_calculated_terms(Some(&metadata), async {
                    Ok(TreasuryBondDetails {
                        treasury_type: "Note".into(),
                        coupon_rate: Some(dec!(0.04)),
                        maturity_date: NaiveDate::from_ymd_opt(2030, 1, 1),
                        face_value: dec!(1000),
                        coupon_frequency: Some("SEMI_ANNUAL".into()),
                    })
                })
                .await
                .unwrap();
                assert_eq!(terms.coupon_rate, dec!(0.04));
            }
        }
    }

    #[test]
    fn incomplete_treasury_profile_still_has_a_name() {
        let item = serde_json::from_value(serde_json::json!({
            "cusip": "912810TH1", "type": "FRN",
        }))
        .unwrap();
        let profile = parse_bond_details(item)
            .unwrap()
            .into_profile("US912810TH14");
        assert_eq!(profile.name.as_deref(), Some("United States Treasury FRN"));
    }

    #[test]
    fn treasury_pricing_requires_supported_confirmed_terms() {
        let mut bond = crate::models::BondQuoteMetadata {
            treasury_type: Some("Bond".into()),
            coupon_rate: Some(dec!(0.04)),
            maturity_date: NaiveDate::from_ymd_opt(2030, 1, 1),
            coupon_frequency: Some("SEMI_ANNUAL".into()),
            face_value: dec!(1000),
        };
        assert!(CalculatedBondTerms::try_from(&bond).is_ok());
        for kind in [None, Some("TIPS"), Some("FRN"), Some("STRIPS")] {
            bond.treasury_type = kind.map(str::to_string);
            assert!(CalculatedBondTerms::try_from(&bond).is_err());
        }
        bond.treasury_type = Some("Bill".into());
        assert!(CalculatedBondTerms::try_from(&bond).is_err());
        bond.coupon_rate = Some(Decimal::ZERO);
        bond.coupon_frequency = Some("ZERO".into());
        assert!(CalculatedBondTerms::try_from(&bond).is_ok());
        // A nominal zero-rate long bond must not enter the bill discount formula.
        bond.treasury_type = Some("Bond".into());
        assert!(CalculatedBondTerms::try_from(&bond).is_err());
    }

    #[test]
    fn test_parse_treasury_direct_response() {
        let json = r#"[{
            "cusip": "912810TH1",
            "type": "Bond",
            "interestRate": "2.875",
            "maturityDate": "2043-05-15T00:00:00",
            "interestPaymentFrequency": "Semi-Annual"
        }]"#;

        let items: Vec<TdSecurityItem> = serde_json::from_str(json).unwrap();
        assert_eq!(items.len(), 1);

        let item = &items[0];
        let rate: f64 = item.interest_rate.as_ref().unwrap().parse().unwrap();
        assert!((rate - 2.875).abs() < 1e-10);

        let mat_str = item.maturity_date.as_ref().unwrap();
        let mat = NaiveDate::parse_from_str(&mat_str[..10], "%Y-%m-%d").unwrap();
        assert_eq!(mat, NaiveDate::from_ymd_opt(2043, 5, 15).unwrap());

        assert_eq!(
            normalize_frequency(item.interest_payment_frequency.as_ref().unwrap()),
            "SEMI_ANNUAL"
        );
    }

    #[test]
    fn test_calculate_price_tbill_182_day() {
        // Concrete T-bill example: 182-day T-bill at 4.5% yield
        // Expected price = face / (1 + yield * days/360)
        // = 1000 / (1 + 0.045 * 182/360)
        // = 1000 / 1.02275
        // = ~977.76 => fraction ~0.97776
        let curve = YieldCurve(vec![(0.5, 4.5)]);
        let today = NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        let maturity = NaiveDate::from_ymd_opt(2025, 7, 2).unwrap(); // 182 days

        let price = UsTreasuryCalcProvider::calculate_price(
            &curve, today, maturity, 0.0, // zero coupon
            "ZERO", 1000.0,
        )
        .unwrap();

        // P = 1000 / (1 + 0.045 * 182/360) / 1000 = 1 / 1.02275
        let expected = 1.0 / (1.0 + 0.045 * 182.0 / 360.0);
        assert!(
            (price - expected).abs() < 0.001,
            "T-bill price {:.6} should be close to expected {:.6}",
            price,
            expected
        );
        // Verify it is below par (discounted)
        assert!(price < 1.0);
        assert!(price > 0.97);
    }
}
