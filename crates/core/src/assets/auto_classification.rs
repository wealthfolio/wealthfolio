//! Auto-classification of assets based on provider profile data.
//!
//! Maps Yahoo/provider data to taxonomy categories:
//! - quote_type (EQUITY, ETF, MUTUALFUND) → instrument_type taxonomy
//! - quote_type → asset_classes taxonomy (EQUITY, DEBT, CASH, etc.)
//! - sector (Technology, Healthcare) → industries_gics taxonomy
//! - country (United States, Canada) → regions taxonomy

use crate::assets::assets_model::{AssetKind, InstrumentType};
use crate::taxonomies::{NewAssetTaxonomyAssignment, TaxonomyServiceTrait};
use log::{debug, warn};
use std::sync::Arc;

/// Maps Yahoo quote_type to instrument_type taxonomy category ID
/// Yahoo quoteType values: EQUITY, ETF, MUTUALFUND, INDEX, CRYPTOCURRENCY, OPTION, BOND, FUTURES, CURRENCY
/// Also handles: ECNQUOTE (Canadian ETFs), NONE (delisted)
///
/// Instrument type hierarchy:
/// - EQUITY_SECURITY: STOCK_COMMON, STOCK_PREFERRED, DEPOSITARY_RECEIPT, EQUITY_WARRANT_RIGHT, PARTNERSHIP_UNIT
/// - DEBT_SECURITY: BOND_GOVERNMENT, BOND_CORPORATE, BOND_MUNICIPAL, BOND_CONVERTIBLE, MONEY_MARKET_DEBT
/// - FUND: FUND_MUTUAL, FUND_CLOSED_END, FUND_PRIVATE, FUND_FOF
/// - ETP: ETF, ETN, ETC
/// - DERIVATIVE: OPTION, FUTURE, OTC_DERIVATIVE, CFD
/// - CASH_FX: CASH, DEPOSIT, FX_POSITION
/// - DIGITAL_ASSET: CRYPTO_NATIVE, STABLECOIN, TOKENIZED_SECURITY
fn map_quote_type_to_instrument_type(quote_type: &str, name: Option<&str>) -> Option<&'static str> {
    match quote_type.to_uppercase().as_str() {
        "EQUITY" => Some("STOCK_COMMON"),
        "ETF" => Some("ETF"),
        "MUTUALFUND" | "MUTUAL FUND" => Some("FUND_MUTUAL"),
        "INDEX" => Some("ETF"), // Index funds are typically ETFs
        "CRYPTOCURRENCY" | "CRYPTO" => Some("CRYPTO_NATIVE"),
        "OPTION" => Some("OPTION"),
        "BOND" => {
            if name.is_some_and(is_government_bond) {
                Some("BOND_GOVERNMENT")
            } else {
                Some("BOND_CORPORATE")
            }
        }
        "MONEYMARKET" => Some("MONEY_MARKET_DEBT"),
        "FUTURE" | "FUTURES" => Some("FUTURE"),
        // ECNQUOTE: Used by Yahoo for some Canadian/international ETFs and securities
        // Since we can't determine if it's a stock or ETF, skip classification
        // Users can manually classify these
        "ECNQUOTE" => None,
        // NONE: Delisted symbols - skip classification
        "NONE" => None,
        // CURRENCY/FOREX not mapped to instrument type (it's an FX rate, not a security)
        _ => None,
    }
}

/// Detect government/sovereign bonds by name keywords.
/// Covers US Treasuries, Canadian govt bonds, UK gilts, German bunds,
/// French OATs, Japanese JGBs, and generic sovereign patterns.
fn is_government_bond(name: &str) -> bool {
    let n = name.to_uppercase();
    // US
    n.contains("TREASURY") || n.contains("T-BILL") || n.contains("T-NOTE") || n.contains("T-BOND")
    // Canada
    || n.contains("GOVT OF CANADA") || n.contains("GOVERNMENT OF CANADA") || n.contains("CANADA GOVT")
    // UK
    || n.contains(" GILT")
    // Germany
    || n.contains("BUNDESREPUBLIK") || n.contains("BUNDESOBLIGATION")
    // France
    || n.contains("OAT ") || n.starts_with("OAT ")
    // Japan
    || n.contains("JAPAN GOVT") || n.contains("JAPANESE GOVERNMENT")
    // Generic
    || n.contains("SOVEREIGN")
}

/// Maps Yahoo quote_type to asset_classes taxonomy category ID
/// Asset classes: CASH, EQUITY, FIXED_INCOME, REAL_ESTATE, COMMODITIES, ALTERNATIVES, DIGITAL_ASSETS
/// Note: Cash is assigned to CASH_BANK_DEPOSITS (child of CASH) for drill-down support
fn map_quote_type_to_asset_class(quote_type: &str) -> Option<&'static str> {
    match quote_type.to_uppercase().as_str() {
        // Equity class: stocks, ETFs, mutual funds, options
        "EQUITY" | "ETF" | "MUTUALFUND" | "MUTUAL FUND" | "INDEX" | "OPTION" => Some("EQUITY"),
        // Fixed Income class: bonds, money market
        "BOND" | "MONEYMARKET" => Some("FIXED_INCOME"),
        // Cash class - assign to child category for drill-down (rollup will sum to CASH)
        "CURRENCY" | "FOREX" | "FX" | "CASH" => Some("CASH_BANK_DEPOSITS"),
        // Cryptocurrency - classify as Digital Assets
        "CRYPTOCURRENCY" | "CRYPTO" => Some("DIGITAL_ASSETS"),
        // Commodities class
        "COMMODITY" | "FUTURE" | "FUTURES" => Some("COMMODITIES"),
        // ECNQUOTE: Unknown type (Canadian/international securities) - skip
        // NONE: Delisted - skip
        "ECNQUOTE" | "NONE" => None,
        _ => None,
    }
}

/// Maps InstrumentType enum to instrument_type taxonomy category ID.
/// Used at asset creation time when no provider profile is available yet.
fn map_instrument_type_to_taxonomy_category(
    instrument_type: &InstrumentType,
) -> Option<&'static str> {
    match instrument_type {
        InstrumentType::Equity => Some("STOCK_COMMON"),
        InstrumentType::Crypto => Some("CRYPTO_NATIVE"),
        InstrumentType::Option => Some("OPTION"),
        InstrumentType::Bond => Some("BOND_CORPORATE"),
        InstrumentType::Metal => Some("PHYSICAL_METAL"),
        InstrumentType::Fx => None,
    }
}

/// Maps InstrumentType enum to asset_classes taxonomy category ID.
/// Used at asset creation time when no provider profile is available yet.
fn map_instrument_type_to_asset_class(instrument_type: &InstrumentType) -> Option<&'static str> {
    match instrument_type {
        InstrumentType::Equity => Some("EQUITY"),
        InstrumentType::Crypto => Some("DIGITAL_ASSETS"),
        InstrumentType::Option => Some("EQUITY"),
        InstrumentType::Bond => Some("FIXED_INCOME"),
        InstrumentType::Metal => Some("COMMODITIES"),
        InstrumentType::Fx => None,
    }
}

/// Maps AssetKind to asset_classes taxonomy category ID.
/// Covers non-Investment kinds that don't have an InstrumentType.
fn map_kind_to_asset_class(kind: &AssetKind) -> Option<&'static str> {
    match kind {
        AssetKind::Property => Some("REAL_ESTATE"),
        AssetKind::PreciousMetal => Some("COMMODITIES"),
        AssetKind::PrivateEquity => Some("ALTERNATIVES"),
        AssetKind::Vehicle | AssetKind::Collectible | AssetKind::Other => Some("ALTERNATIVES"),
        AssetKind::Investment | AssetKind::Fx | AssetKind::Liability => None,
    }
}

/// Maps Yahoo sector name to GICS sector category ID
/// Yahoo uses simplified names, GICS uses formal names
fn map_sector_to_gics(sector: &str) -> Option<&'static str> {
    // Normalize sector name for matching
    let sector_lower = sector.to_lowercase();

    match sector_lower.as_str() {
        "energy" => Some("10"),
        "materials" | "basic materials" => Some("15"),
        "industrials" => Some("20"),
        "consumer discretionary" | "consumer cyclical" => Some("25"),
        "consumer staples" | "consumer defensive" => Some("30"),
        "health care" | "healthcare" => Some("35"),
        "financials" | "financial services" | "financial" => Some("40"),
        "information technology" | "technology" => Some("45"),
        "communication services" | "communication" | "telecommunications" => Some("50"),
        "utilities" => Some("55"),
        "real estate" | "realestate" => Some("60"),
        _ => None,
    }
}

/// Maps country name to regions taxonomy category ID
/// Uses specific country codes where available, falls back to regional groupings
/// Regions hierarchy: R10=Europe, R20=Americas, R2010=North America, R2040=South America,
///                    R30=Asia, R3030=East Asia, R40=Africa, R50=Oceania
fn map_country_to_region(country: &str) -> Option<&'static str> {
    // Normalize country name
    let country_lower = country.to_lowercase();

    match country_lower.as_str() {
        // ========== Countries with specific entries ==========
        // North America
        "united states" | "usa" | "us" => Some("country_US"),
        "canada" => Some("country_CA"),

        // East Asia
        "japan" | "日本" => Some("country_JP"),
        "china" | "中国" => Some("country_CN"),
        "hong kong" | "香港" => Some("country_HK"),

        // Oceania
        "australia" => Some("country_AU"),

        // ========== Countries mapped to regional groups ==========
        // Europe (R10)
        "united kingdom" | "uk" | "great britain" | "england" | "germany" | "deutschland"
        | "france" | "switzerland" | "schweiz" | "netherlands" | "holland" | "spain" | "españa"
        | "italy" | "italia" | "sweden" | "sverige" | "ireland" | "belgium" | "denmark"
        | "danmark" | "norway" | "norge" | "finland" | "suomi" | "austria" | "österreich"
        | "portugal" | "poland" | "polska" | "greece" | "czech republic" | "czechia" | "russia" => {
            Some("R10")
        } // Europe

        // North America (R2010) - countries without specific entries
        "mexico" | "méxico" => Some("R2010"),

        // South America (R2040)
        "brazil" | "brasil" | "argentina" | "chile" | "colombia" | "peru" => Some("R2040"),

        // East Asia (R3030) - countries without specific entries
        "south korea" | "korea" | "대한민국" | "taiwan" | "臺灣" => Some("R3030"),

        // Asia (R30) - other Asian countries
        "singapore" | "india" | "भारत" | "indonesia" | "malaysia" | "thailand" | "vietnam"
        | "philippines" => Some("R30"),

        // Oceania (R50)
        "new zealand" => Some("R50"),

        // Africa (R40)
        "south africa" | "nigeria" | "egypt" => Some("R40"),

        // For unmapped countries, skip
        _ => None,
    }
}

/// Sector weight data from provider profile
#[derive(Debug, Clone)]
pub struct SectorWeight {
    pub name: String,
    pub weight: f64,
}

/// Parsed provider profile for auto-classification
#[derive(Debug, Clone, Default)]
pub struct ClassificationInput {
    pub quote_type: Option<String>,
    pub name: Option<String>,
    pub sectors: Vec<SectorWeight>,
    pub country: Option<String>,
}

impl ClassificationInput {
    /// Parse from ProviderProfile fields.
    ///
    /// Handles both:
    /// - Single sector (for stocks): `sector` = "Technology" with 100% weight
    /// - Multiple sectors (for ETFs): `sectors_json` = `[{"name": "Technology", "weight": 0.30}, ...]`
    ///
    /// For country, handles both:
    /// - Single country (for stocks): `country` = "United States"
    /// - Multiple countries (for ETFs): `countries_json` = `[{"name": "United States", "weight": 0.60}, ...]`
    ///
    /// Exchange MIC is intentionally not used as a region fallback: trading venue
    /// is not issuer domicile or portfolio exposure.
    pub fn from_provider_profile(
        quote_type: Option<&str>,
        name: Option<&str>,
        sector: Option<&str>,
        sectors_json: Option<&str>,
        country: Option<&str>,
        countries_json: Option<&str>,
        _exchange_mic: Option<&str>,
    ) -> Self {
        let mut input = ClassificationInput {
            quote_type: quote_type.map(String::from),
            name: name.map(String::from),
            ..Default::default()
        };

        // Parse sectors: prefer JSON array (ETFs), fall back to single sector (stocks)
        if let Some(json) = sectors_json {
            if let Ok(sectors) = serde_json::from_str::<Vec<serde_json::Value>>(json) {
                input.sectors = sectors
                    .iter()
                    .filter_map(|v| {
                        let name = v.get("name")?.as_str()?.to_string();
                        let weight = v.get("weight")?.as_f64()?;
                        Some(SectorWeight { name, weight })
                    })
                    .collect();
            }
        }

        // If no sectors from JSON, use single sector with 100% weight
        if input.sectors.is_empty() {
            if let Some(sector_name) = sector {
                if !sector_name.is_empty() {
                    input.sectors.push(SectorWeight {
                        name: sector_name.to_string(),
                        weight: 1.0, // 100% weight for single-sector stocks
                    });
                }
            }
        }

        // Parse country: prefer JSON array (ETFs), fall back to single country (stocks)
        if let Some(json) = countries_json {
            if let Ok(countries) = serde_json::from_str::<Vec<serde_json::Value>>(json) {
                input.country = countries
                    .first()
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
        }

        // If no country from JSON, use single country field
        if input.country.is_none() {
            if let Some(country_name) = country {
                if !country_name.is_empty() {
                    input.country = Some(country_name.to_string());
                }
            }
        }

        input
    }
}

/// Auto-classification service
pub struct AutoClassificationService {
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
}

impl AutoClassificationService {
    pub fn new(taxonomy_service: Arc<dyn TaxonomyServiceTrait>) -> Self {
        Self { taxonomy_service }
    }

    /// Auto-classify an asset based on provider profile data.
    /// Creates taxonomy assignments for instrument_type, asset_classes, industries_gics, and regions.
    pub async fn classify_asset(
        &self,
        asset_id: &str,
        input: &ClassificationInput,
    ) -> Result<ClassificationResult, String> {
        let mut result = ClassificationResult::default();

        // 1. Classify instrument type
        if let Some(quote_type) = &input.quote_type {
            if let Some(category_id) =
                map_quote_type_to_instrument_type(quote_type, input.name.as_deref())
            {
                match self
                    .assign_to_taxonomy(asset_id, "instrument_type", category_id, 10000)
                    .await
                {
                    Ok(_) => {
                        debug!(
                            "Auto-classified {} as {} in instrument_type",
                            asset_id, category_id
                        );
                        result.security_type = Some(category_id.to_string());
                    }
                    Err(e) => {
                        warn!(
                            "Failed to auto-classify {} instrument_type: {}",
                            asset_id, e
                        );
                    }
                }
            }

            // 2. Classify asset class (EQUITY, DEBT, CASH, COMMODITY, REAL_ESTATE)
            if let Some(category_id) = map_quote_type_to_asset_class(quote_type) {
                match self
                    .assign_to_taxonomy(asset_id, "asset_classes", category_id, 10000)
                    .await
                {
                    Ok(_) => {
                        debug!(
                            "Auto-classified {} as {} in asset_classes",
                            asset_id, category_id
                        );
                        result.asset_class = Some(category_id.to_string());
                    }
                    Err(e) => {
                        warn!("Failed to auto-classify {} asset_classes: {}", asset_id, e);
                    }
                }
            }
        }

        // 3. Classify sectors (industries_gics)
        for sector in &input.sectors {
            if let Some(category_id) = map_sector_to_gics(&sector.name) {
                // Convert weight from 0-1 to basis points (0-10000)
                let weight_bp = (sector.weight * 10000.0).round() as i32;
                match self
                    .assign_to_taxonomy(asset_id, "industries_gics", category_id, weight_bp)
                    .await
                {
                    Ok(_) => {
                        debug!(
                            "Auto-classified {} as {} ({}%) in industries_gics",
                            asset_id,
                            category_id,
                            sector.weight * 100.0
                        );
                        result
                            .sectors
                            .push((category_id.to_string(), sector.weight));
                    }
                    Err(e) => {
                        warn!(
                            "Failed to auto-classify {} industries_gics: {}",
                            asset_id, e
                        );
                    }
                }
            }
        }

        // 4. Classify region
        if let Some(country) = &input.country {
            if let Some(category_id) = map_country_to_region(country) {
                match self
                    .assign_to_taxonomy(asset_id, "regions", category_id, 10000)
                    .await
                {
                    Ok(_) => {
                        debug!("Auto-classified {} as {} in regions", asset_id, category_id);
                        result.region = Some(category_id.to_string());
                    }
                    Err(e) => {
                        warn!("Failed to auto-classify {} regions: {}", asset_id, e);
                    }
                }
            }
        }

        Ok(result)
    }

    /// Classify a newly created asset using InstrumentType and AssetKind.
    /// This is a lightweight classification at creation time, before any provider data is available.
    /// Only assigns instrument_type and asset_class taxonomies.
    pub async fn classify_from_spec(
        &self,
        asset_id: &str,
        instrument_type: Option<&InstrumentType>,
        kind: &AssetKind,
    ) {
        // 1. Classify instrument type (only if we have an InstrumentType)
        if let Some(it) = instrument_type {
            if let Some(category_id) = map_instrument_type_to_taxonomy_category(it) {
                if let Err(e) = self
                    .assign_to_taxonomy(asset_id, "instrument_type", category_id, 10000)
                    .await
                {
                    debug!(
                        "Initial classification of {} instrument_type failed: {}",
                        asset_id, e
                    );
                }
            }
        }

        // 2. Classify asset class — prefer InstrumentType mapping, fall back to AssetKind
        let asset_class = instrument_type
            .and_then(map_instrument_type_to_asset_class)
            .or_else(|| map_kind_to_asset_class(kind));

        if let Some(category_id) = asset_class {
            if let Err(e) = self
                .assign_to_taxonomy(asset_id, "asset_classes", category_id, 10000)
                .await
            {
                debug!(
                    "Initial classification of {} asset_classes failed: {}",
                    asset_id, e
                );
            }
        }
    }

    /// Helper to assign an asset to a taxonomy category
    async fn assign_to_taxonomy(
        &self,
        asset_id: &str,
        taxonomy_id: &str,
        category_id: &str,
        weight: i32,
    ) -> Result<(), String> {
        let assignment = NewAssetTaxonomyAssignment {
            id: None, // Auto-generate ID
            asset_id: asset_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            weight,
            source: "AUTO".to_string(),
        };

        self.taxonomy_service
            .assign_asset_to_category(assignment)
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

/// Result of auto-classification
#[derive(Debug, Default)]
pub struct ClassificationResult {
    pub security_type: Option<String>,
    pub asset_class: Option<String>,
    pub sectors: Vec<(String, f64)>,
    pub region: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_map_quote_type_to_instrument_type() {
        assert_eq!(
            map_quote_type_to_instrument_type("EQUITY", None),
            Some("STOCK_COMMON")
        );
        assert_eq!(map_quote_type_to_instrument_type("ETF", None), Some("ETF"));
        assert_eq!(
            map_quote_type_to_instrument_type("MUTUALFUND", None),
            Some("FUND_MUTUAL")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("CRYPTOCURRENCY", None),
            Some("CRYPTO_NATIVE")
        );
        // Bond without name defaults to corporate
        assert_eq!(
            map_quote_type_to_instrument_type("BOND", None),
            Some("BOND_CORPORATE")
        );
        // Bond with government name
        assert_eq!(
            map_quote_type_to_instrument_type("BOND", Some("US TREASURY N/B - T 3.25 05/15/42")),
            Some("BOND_GOVERNMENT")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("BOND", Some("GOVT OF CANADA 2.75 12/01/48")),
            Some("BOND_GOVERNMENT")
        );
        // Bond with corporate name stays corporate
        assert_eq!(
            map_quote_type_to_instrument_type("BOND", Some("APPLE INC 3.0 06/20/27")),
            Some("BOND_CORPORATE")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("MONEYMARKET", None),
            Some("MONEY_MARKET_DEBT")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("FUTURE", None),
            Some("FUTURE")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("FUTURES", None),
            Some("FUTURE")
        );
        assert_eq!(
            map_quote_type_to_instrument_type("OPTION", None),
            Some("OPTION")
        );
        assert_eq!(map_quote_type_to_instrument_type("unknown", None), None);
    }

    #[test]
    fn test_is_government_bond() {
        // US Treasuries
        assert!(is_government_bond("US TREASURY N/B - T 3.25 05/15/42"));
        assert!(is_government_bond("US Treasury Bond 2.0 11/15/41"));
        assert!(is_government_bond("T-BILL 0.0 03/20/25"));
        // Canada
        assert!(is_government_bond("GOVT OF CANADA 2.75 12/01/48"));
        assert!(is_government_bond("Government of Canada Bond 1.5"));
        // UK
        assert!(is_government_bond("UK GILT 1.625 10/22/54"));
        // Germany
        assert!(is_government_bond(
            "BUNDESREPUBLIK DEUTSCHLAND 0.0 08/15/30"
        ));
        // Generic
        assert!(is_government_bond("Some Sovereign Bond 3.0"));
        // Corporate - should NOT match
        assert!(!is_government_bond("APPLE INC 3.0 06/20/27"));
        assert!(!is_government_bond("MICROSOFT CORP 2.5 09/15/50"));
    }

    #[test]
    fn test_map_asset_class() {
        // Equity class
        assert_eq!(map_quote_type_to_asset_class("EQUITY"), Some("EQUITY"));
        assert_eq!(map_quote_type_to_asset_class("ETF"), Some("EQUITY"));
        assert_eq!(map_quote_type_to_asset_class("MUTUALFUND"), Some("EQUITY"));
        assert_eq!(
            map_quote_type_to_asset_class("CRYPTOCURRENCY"),
            Some("DIGITAL_ASSETS")
        );
        // Fixed Income class
        assert_eq!(map_quote_type_to_asset_class("BOND"), Some("FIXED_INCOME"));
        // Cash class (assigned to child category for drill-down)
        assert_eq!(
            map_quote_type_to_asset_class("CURRENCY"),
            Some("CASH_BANK_DEPOSITS")
        );
        // Commodities class
        assert_eq!(
            map_quote_type_to_asset_class("COMMODITY"),
            Some("COMMODITIES")
        );
        // Unknown
        assert_eq!(map_quote_type_to_asset_class("unknown"), None);
    }

    #[test]
    fn test_map_sector() {
        assert_eq!(map_sector_to_gics("Technology"), Some("45"));
        assert_eq!(map_sector_to_gics("Information Technology"), Some("45"));
        assert_eq!(map_sector_to_gics("Healthcare"), Some("35"));
        assert_eq!(map_sector_to_gics("Health Care"), Some("35"));
        assert_eq!(map_sector_to_gics("Financial Services"), Some("40"));
        assert_eq!(map_sector_to_gics("Consumer Cyclical"), Some("25"));
        assert_eq!(map_sector_to_gics("unknown sector"), None);
    }

    #[test]
    fn test_map_country() {
        // Specific country entries
        assert_eq!(map_country_to_region("United States"), Some("country_US"));
        assert_eq!(map_country_to_region("USA"), Some("country_US"));
        assert_eq!(map_country_to_region("Canada"), Some("country_CA"));
        assert_eq!(map_country_to_region("Japan"), Some("country_JP"));
        assert_eq!(map_country_to_region("China"), Some("country_CN"));
        assert_eq!(map_country_to_region("Hong Kong"), Some("country_HK"));
        assert_eq!(map_country_to_region("Australia"), Some("country_AU"));

        // European countries -> Europe region (R10)
        assert_eq!(map_country_to_region("United Kingdom"), Some("R10"));
        assert_eq!(map_country_to_region("Germany"), Some("R10"));
        assert_eq!(map_country_to_region("France"), Some("R10"));
        assert_eq!(map_country_to_region("Switzerland"), Some("R10"));

        // South American countries -> South America region (R2040)
        assert_eq!(map_country_to_region("Brazil"), Some("R2040"));

        // Asian countries -> Asia region (R30)
        assert_eq!(map_country_to_region("Singapore"), Some("R30"));
        assert_eq!(map_country_to_region("India"), Some("R30"));

        // Unknown
        assert_eq!(map_country_to_region("Unknown Country"), None);
    }

    #[test]
    fn test_parse_sectors_json() {
        let json = r#"[{"name":"Technology","weight":0.30},{"name":"Healthcare","weight":0.15}]"#;
        let input = ClassificationInput::from_provider_profile(
            None,
            None,
            None,
            Some(json),
            None,
            None,
            None,
        );
        assert_eq!(input.sectors.len(), 2);
        assert_eq!(input.sectors[0].name, "Technology");
        assert_eq!(input.sectors[0].weight, 0.30);
    }

    #[test]
    fn test_parse_single_sector() {
        // For stocks: single sector with 100% weight
        let input = ClassificationInput::from_provider_profile(
            Some("EQUITY"),
            None, // no name
            Some("Technology"),
            None, // no sectors JSON
            Some("United States"),
            None, // no countries JSON
            None, // no exchange_mic
        );
        assert_eq!(input.sectors.len(), 1);
        assert_eq!(input.sectors[0].name, "Technology");
        assert_eq!(input.sectors[0].weight, 1.0);
        assert_eq!(input.country, Some("United States".to_string()));
    }

    #[test]
    fn test_exchange_mic_does_not_fallback_to_country() {
        let input = ClassificationInput::from_provider_profile(
            Some("ETF"),
            None,
            None,
            None,
            None,         // no country from provider
            None,         // no countries JSON
            Some("XETR"), // German trading venue
        );
        assert_eq!(input.country, None);
    }
}
