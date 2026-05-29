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
//! Also exposes a TreasuryDirect auction-data lookup so the core crate can
//! enrich bonds that are missing coupon/maturity metadata.

use async_trait::async_trait;
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use log::{debug, warn};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::errors::MarketDataError;
use crate::models::{Coverage, InstrumentKind, ProviderInstrument, Quote, QuoteContext};
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
pub struct TreasuryBondDetails {
    pub coupon_rate: Decimal,
    pub maturity_date: NaiveDate,
    pub face_value: Decimal,
    pub coupon_frequency: String,
}

/// Response item from TreasuryDirect securities search.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TdSecurityItem {
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
}

impl Default for UsTreasuryCalcProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl UsTreasuryCalcProvider {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            client,
            curve_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Fetch bond details from TreasuryDirect for enrichment.
    /// Returns None if not a US Treasury ISIN or if lookup fails.
    pub async fn fetch_bond_details(
        client: &reqwest::Client,
        isin: &str,
    ) -> Option<TreasuryBondDetails> {
        if !is_us_treasury_isin(isin) || isin.len() < 11 {
            return None;
        }
        let cusip = &isin[2..11];
        let url = format!(
            "https://www.treasurydirect.gov/TA_WS/securities/search?cusip={}&format=json",
            cusip
        );

        let resp = client.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            warn!(
                "TreasuryDirect API returned {} for CUSIP {}",
                resp.status(),
                cusip
            );
            return None;
        }

        let items: Vec<TdSecurityItem> = resp.json().await.ok()?;
        let item = items.into_iter().next()?;

        let coupon_rate = item
            .interest_rate
            .as_ref()
            .filter(|r| !r.is_empty())
            .and_then(|r| r.parse::<f64>().ok())
            .map(|r| Decimal::try_from(r / 100.0).unwrap_or_default())
            .unwrap_or(Decimal::ZERO);

        let maturity_date = item.maturity_date.as_ref().and_then(|d| {
            // Format: "2043-05-15T00:00:00"
            NaiveDate::parse_from_str(&d[..10], "%Y-%m-%d").ok()
        })?;

        let is_zero_coupon = coupon_rate.is_zero();
        let coupon_frequency = item
            .interest_payment_frequency
            .as_ref()
            .filter(|f| !f.is_empty() && *f != "None")
            .map(|f| normalize_frequency(f))
            .unwrap_or_else(|| {
                if is_zero_coupon {
                    "ZERO".to_string()
                } else {
                    "SEMI_ANNUAL".to_string()
                }
            });

        Some(TreasuryBondDetails {
            coupon_rate,
            maturity_date,
            face_value: Decimal::from(US_TREASURY_FACE_VALUE as i64),
            coupon_frequency,
        })
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

        let timestamp =
            DateTime::<Utc>::from_naive_utc_and_offset(date.and_hms_opt(16, 0, 0).unwrap(), Utc);

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
            supports_profile: false,
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

    async fn get_latest_quote(
        &self,
        context: &QuoteContext,
        instrument: ProviderInstrument,
    ) -> Result<Quote, MarketDataError> {
        let isin = extract_isin(&instrument)?;
        guard_us_treasury(&isin)?;

        let bond =
            context
                .bond_metadata
                .as_ref()
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: "Bond metadata (coupon, maturity) required for calculated pricing"
                        .to_string(),
                })?;

        let today = Utc::now().date_naive();
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

        let bond =
            context
                .bond_metadata
                .as_ref()
                .ok_or_else(|| MarketDataError::ProviderError {
                    provider: PROVIDER_ID.to_string(),
                    message: "Bond metadata (coupon, maturity) required for calculated pricing"
                        .to_string(),
                })?;

        let start_date = start.date_naive();
        let end_date = end.date_naive();
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
    isin.starts_with("US912")
}

fn normalize_frequency(freq: &str) -> String {
    match freq.to_uppercase().as_str() {
        "SEMI-ANNUAL" | "SEMI_ANNUAL" | "SEMIANNUAL" => "SEMI_ANNUAL".to_string(),
        "ANNUAL" => "ANNUAL".to_string(),
        "QUARTERLY" => "QUARTERLY".to_string(),
        "NONE" | "ZERO" => "ZERO".to_string(),
        _ => "SEMI_ANNUAL".to_string(),
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
                let date_str = if d.len() >= 10 { &d[..10] } else { &d };
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
            points.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
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
    use rust_decimal_macros::dec;

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
        assert_eq!(normalize_frequency("unknown"), "SEMI_ANNUAL");
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
        assert!(!caps.supports_profile);
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
