//! Yahoo Finance API response models.
//!
//! These models are used for parsing the quoteSummary API responses
//! which provide richer data than the standard quote endpoints.

use serde::Deserialize;

/// Main response wrapper for quoteSummary API
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooQuoteSummaryResponse {
    pub quote_summary: YahooQuoteSummary,
}

/// Quote summary container
#[derive(Debug, Deserialize)]
pub struct YahooQuoteSummary {
    pub result: Vec<YahooQuoteSummaryResult>,
    // Note: error field exists in API but we handle errors via HTTP status/empty results
}

/// Individual result from quoteSummary API
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooQuoteSummaryResult {
    pub price: Option<YahooPriceData>,
    pub summary_profile: Option<YahooSummaryProfile>,
    pub summary_detail: Option<YahooSummaryDetail>,
    pub top_holdings: Option<YahooTopHoldings>,
}

/// Price data from quoteSummary API
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooPriceData {
    pub currency: Option<String>,
    pub short_name: Option<String>,
    pub long_name: Option<String>,
    pub quote_type: Option<String>,
    pub regular_market_price: Option<YahooPriceDetail>,
    pub regular_market_open: Option<YahooPriceDetail>,
    pub regular_market_day_high: Option<YahooPriceDetail>,
    pub regular_market_day_low: Option<YahooPriceDetail>,
    pub regular_market_volume: Option<YahooPriceDetail>,
    pub regular_market_time: Option<i64>,
}

/// Price detail with raw and formatted values
#[derive(Debug, Deserialize, Clone)]
pub struct YahooPriceDetail {
    pub raw: Option<f64>,
    // Note: fmt field exists but we only use raw values
}

/// Summary profile data (company info)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooSummaryProfile {
    pub sector: Option<String>,
    pub industry: Option<String>,
    pub website: Option<String>,
    pub long_business_summary: Option<String>,
    #[serde(alias = "description")]
    pub description: Option<String>,
    pub country: Option<String>,
    pub full_time_employees: Option<u64>,
    // Note: city, state exist but not in AssetProfile model
}

/// Summary detail data (financial metrics)
/// Yahoo returns these as nested objects like {"raw": 123.45, "fmt": "123.45"}
/// or empty objects {} when no data is available.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooSummaryDetail {
    pub market_cap: Option<YahooPriceDetail>,
    #[serde(rename = "trailingPE")]
    pub trailing_pe: Option<YahooPriceDetail>,
    pub dividend_yield: Option<YahooPriceDetail>,
    pub fifty_two_week_high: Option<YahooPriceDetail>,
    pub fifty_two_week_low: Option<YahooPriceDetail>,
    // Note: forward_pe, dividend_rate, beta, etc. exist but not in AssetProfile model
}

/// Top holdings data for ETFs and Mutual Funds
/// Contains sector weightings and other fund-specific data
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YahooTopHoldings {
    /// Sector weightings - each element is a map with sector name as key
    /// e.g., [{"technology": {"raw": 0.30}}, {"healthcare": {"raw": 0.15}}]
    #[serde(default)]
    pub sector_weightings: Vec<std::collections::HashMap<String, YahooPriceDetail>>,

    pub stock_position: Option<YahooPriceDetail>,
    pub bond_position: Option<YahooPriceDetail>,
    pub cash_position: Option<YahooPriceDetail>,
    pub other_position: Option<YahooPriceDetail>,
    pub preferred_position: Option<YahooPriceDetail>,
    pub convertible_position: Option<YahooPriceDetail>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_price_detail() {
        let json = r#"{"raw": 150.25, "fmt": "150.25"}"#;
        let detail: YahooPriceDetail = serde_json::from_str(json).unwrap();
        assert_eq!(detail.raw, Some(150.25));
    }

    #[test]
    fn test_deserialize_price_detail_null() {
        let json = r#"{"raw": null, "fmt": null}"#;
        let detail: YahooPriceDetail = serde_json::from_str(json).unwrap();
        assert_eq!(detail.raw, None);
    }

    #[test]
    fn test_deserialize_summary_profile() {
        let json = r#"{
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "website": "https://www.apple.com",
            "country": "United States",
            "fullTimeEmployees": 164000
        }"#;
        let profile: YahooSummaryProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.sector, Some("Technology".to_string()));
        assert_eq!(profile.industry, Some("Consumer Electronics".to_string()));
        assert_eq!(profile.full_time_employees, Some(164000));
    }

    #[test]
    fn test_deserialize_summary_detail() {
        let json = r#"{
            "marketCap": {"raw": 2800000000000, "fmt": "2.8T"},
            "trailingPE": {"raw": 28.5, "fmt": "28.50"},
            "dividendYield": {"raw": 0.005, "fmt": "0.50%"},
            "fiftyTwoWeekHigh": {"raw": 199.62, "fmt": "199.62"},
            "fiftyTwoWeekLow": {"raw": 124.17, "fmt": "124.17"}
        }"#;
        let detail: YahooSummaryDetail = serde_json::from_str(json).unwrap();
        assert_eq!(
            detail.market_cap.as_ref().and_then(|d| d.raw),
            Some(2800000000000.0)
        );
        assert_eq!(detail.trailing_pe.as_ref().and_then(|d| d.raw), Some(28.5));
        assert_eq!(
            detail.dividend_yield.as_ref().and_then(|d| d.raw),
            Some(0.005)
        );
        assert_eq!(
            detail.fifty_two_week_high.as_ref().and_then(|d| d.raw),
            Some(199.62)
        );
        assert_eq!(
            detail.fifty_two_week_low.as_ref().and_then(|d| d.raw),
            Some(124.17)
        );
    }

    #[test]
    fn test_deserialize_summary_detail_empty_objects() {
        // Yahoo returns empty objects {} for fields with no data (e.g., stocks without dividends)
        let json = r#"{
            "marketCap": {"raw": 1000000000000, "fmt": "1T"},
            "trailingPE": {"raw": 50.0, "fmt": "50.00"},
            "dividendYield": {},
            "fiftyTwoWeekHigh": {"raw": 300.0, "fmt": "300.00"},
            "fiftyTwoWeekLow": {"raw": 200.0, "fmt": "200.00"}
        }"#;
        let detail: YahooSummaryDetail = serde_json::from_str(json).unwrap();
        assert_eq!(
            detail.market_cap.as_ref().and_then(|d| d.raw),
            Some(1000000000000.0)
        );
        // dividendYield is empty object - raw should be None
        assert_eq!(detail.dividend_yield.as_ref().and_then(|d| d.raw), None);
        assert_eq!(
            detail.fifty_two_week_high.as_ref().and_then(|d| d.raw),
            Some(300.0)
        );
    }

    #[test]
    fn test_deserialize_top_holdings() {
        // Yahoo returns sector weightings as array of single-key objects
        let json = r#"{
            "sectorWeightings": [
                {"realestate": {"raw": 0.0261, "fmt": "2.61%"}},
                {"consumer_cyclical": {"raw": 0.1023, "fmt": "10.23%"}},
                {"technology": {"raw": 0.2915, "fmt": "29.15%"}}
            ],
            "stockPosition": {"raw": 0.65, "fmt": "65.00%"},
            "bondPosition": {"raw": 0.25, "fmt": "25.00%"},
            "cashPosition": {"raw": 0.05, "fmt": "5.00%"},
            "otherPosition": {"raw": 0.05, "fmt": "5.00%"}
        }"#;
        let holdings: YahooTopHoldings = serde_json::from_str(json).unwrap();
        assert_eq!(holdings.sector_weightings.len(), 3);
        assert_eq!(
            holdings.stock_position.as_ref().and_then(|d| d.raw),
            Some(0.65)
        );
        assert_eq!(
            holdings.bond_position.as_ref().and_then(|d| d.raw),
            Some(0.25)
        );
        assert_eq!(
            holdings.cash_position.as_ref().and_then(|d| d.raw),
            Some(0.05)
        );
        assert_eq!(
            holdings.other_position.as_ref().and_then(|d| d.raw),
            Some(0.05)
        );

        // Check first sector
        let first = &holdings.sector_weightings[0];
        assert!(first.contains_key("realestate"));
        assert_eq!(first.get("realestate").and_then(|d| d.raw), Some(0.0261));

        // Check technology sector
        let tech = &holdings.sector_weightings[2];
        assert!(tech.contains_key("technology"));
        assert_eq!(tech.get("technology").and_then(|d| d.raw), Some(0.2915));
    }

    #[test]
    fn test_deserialize_top_holdings_empty() {
        let json = r#"{"sectorWeightings": []}"#;
        let holdings: YahooTopHoldings = serde_json::from_str(json).unwrap();
        assert!(holdings.sector_weightings.is_empty());
    }
}
