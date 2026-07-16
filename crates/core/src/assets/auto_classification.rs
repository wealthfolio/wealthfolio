//! Auto-classification of assets based on provider profile data.
//!
//! Maps Yahoo/provider data to taxonomy categories:
//! - quote_type (EQUITY, ETF, MUTUALFUND) → instrument_type taxonomy
//! - provider composition or quote_type fallback → asset_classes taxonomy
//! - sector (Technology, Healthcare) → industries_gics taxonomy
//! - country (United States, Canada) → regions taxonomy

use crate::assets::assets_model::{AssetKind, InstrumentType};
use crate::taxonomies::{NewAssetTaxonomyAssignment, TaxonomyServiceTrait};
use log::{debug, warn};
use std::{collections::BTreeMap, sync::Arc};

const AUTO_SOURCE: &str = "AUTO";
const ASSET_CLASSES_TAXONOMY: &str = "asset_classes";
const INSTRUMENT_TYPE_TAXONOMY: &str = "instrument_type";

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

fn is_fund_quote_type(quote_type: &str) -> bool {
    matches!(
        quote_type.to_uppercase().as_str(),
        "ETF" | "ETN" | "ETC" | "MUTUALFUND" | "MUTUAL FUND" | "INDEX"
    )
}

fn contains_any(value: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| value.contains(keyword))
}

fn is_bond_fund_name(name: &str) -> bool {
    let n = name.to_uppercase();
    contains_any(
        &n,
        &[
            " BOND",
            "BOND ",
            "BONDS",
            "FIXED INCOME",
            "TREASURY",
            "T-BILL",
            "T-NOTE",
            "T-BOND",
            " GILT",
            "GILTS",
            "GOVERNMENT BOND",
            "GOVT BOND",
            "SOVEREIGN",
            "BUNDESREPUBLIK",
            "BUNDESOBLIGATION",
        ],
    )
}

fn is_physical_precious_metal_name(name: &str) -> bool {
    let n = name.to_uppercase();
    let has_metal = contains_any(&n, &["GOLD", "SILVER", "PLATINUM", "PALLADIUM"]);
    let has_physical_wrapper = contains_any(&n, &["PHYSICAL", "BULLION", " ETC", " ETC/", " ETP"]);
    has_metal && has_physical_wrapper
}

fn map_fund_name_to_asset_class(name: Option<&str>) -> Option<&'static str> {
    let name = name?;
    if is_bond_fund_name(name) {
        return Some("FIXED_INCOME");
    }
    if is_physical_precious_metal_name(name) {
        return Some("COMMODITIES");
    }
    None
}

/// Maps Yahoo quote_type to asset_classes taxonomy category ID
/// Asset classes: CASH, EQUITY, FIXED_INCOME, REAL_ESTATE, COMMODITIES, ALTERNATIVES, DIGITAL_ASSETS
/// Note: Cash is assigned to CASH_BANK_DEPOSITS (child of CASH) for drill-down support
fn map_quote_type_to_asset_class(quote_type: &str) -> Option<&'static str> {
    match quote_type.to_uppercase().as_str() {
        // Equity fallback: stocks, funds without composition data, options
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

fn map_provider_asset_class_to_taxonomy(name: &str) -> Option<&'static str> {
    let normalized = name.trim().replace(['_', '-'], " ").to_uppercase();

    match normalized.as_str() {
        "STOCK" | "STOCKS" | "EQUITY" | "EQUITIES" => Some("EQUITY"),
        "BOND"
        | "BONDS"
        | "FIXED INCOME"
        | "FIXEDINCOME"
        | "DEBT"
        | "PREFERRED"
        | "PREFERRED STOCK"
        | "PREFERRED SECURITIES"
        | "CONVERTIBLE"
        | "CONVERTIBLES"
        | "CONVERTIBLE BOND"
        | "CONVERTIBLE BONDS" => Some("FIXED_INCOME"),
        "CASH" | "MONEY MARKET" | "MONEYMARKET" => Some("CASH_BANK_DEPOSITS"),
        "COMMODITY" | "COMMODITIES" => Some("COMMODITIES"),
        "OTHER" => None,
        _ => None,
    }
}

fn parse_provider_weight(weight: f64) -> Option<f64> {
    if !weight.is_finite() || weight <= 0.0 {
        return None;
    }
    if weight <= 1.0 {
        Some(weight)
    } else if weight <= 100.0 {
        Some(weight / 100.0)
    } else {
        None
    }
}

fn weights_to_basis_points(weights: BTreeMap<&'static str, f64>) -> Vec<(String, i32)> {
    let total_weight: f64 = weights.values().sum();
    if total_weight <= 0.0 {
        return Vec::new();
    }

    let target_basis_points = if total_weight <= 1.0 {
        (total_weight * 10000.0).round() as i32
    } else {
        10000
    };

    let mut scaled: Vec<(&'static str, i32, f64)> = weights
        .into_iter()
        .map(|(category_id, weight)| {
            let exact = weight / total_weight * f64::from(target_basis_points);
            let floor = exact.floor() as i32;
            (category_id, floor, exact - f64::from(floor))
        })
        .collect();

    let assigned: i32 = scaled
        .iter()
        .map(|(_, basis_points, _)| *basis_points)
        .sum();
    scaled.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let remainder = target_basis_points.saturating_sub(assigned) as usize;
    for (_, basis_points, _) in scaled.iter_mut().take(remainder) {
        *basis_points += 1;
    }

    scaled
        .into_iter()
        .filter(|(_, basis_points, _)| *basis_points > 0)
        .map(|(category_id, basis_points, _)| (category_id.to_string(), basis_points.min(10000)))
        .collect()
}

fn asset_class_assignments_from_provider(classes: &[ClassWeight]) -> Vec<(String, i32)> {
    let mut mapped = BTreeMap::new();
    for class in classes {
        if let Some(category_id) = map_provider_asset_class_to_taxonomy(&class.name) {
            *mapped.entry(category_id).or_insert(0.0) += class.weight;
        }
    }
    weights_to_basis_points(mapped)
}

fn asset_class_assignments_from_input(input: &ClassificationInput) -> Vec<(String, i32)> {
    if !input.asset_classes.is_empty() {
        return asset_class_assignments_from_provider(&input.asset_classes);
    }

    let Some(quote_type) = input.quote_type.as_deref() else {
        return Vec::new();
    };

    let category_id = if is_fund_quote_type(quote_type) {
        map_fund_name_to_asset_class(input.name.as_deref())
            .or_else(|| map_quote_type_to_asset_class(quote_type))
    } else {
        map_quote_type_to_asset_class(quote_type)
    };

    category_id
        .map(|category_id| vec![(category_id.to_string(), 10000)])
        .unwrap_or_default()
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

/// Weight data from provider profile JSON.
#[derive(Debug, Clone)]
pub struct ProviderWeight {
    pub name: String,
    pub weight: f64,
}

pub type SectorWeight = ProviderWeight;
pub type ClassWeight = ProviderWeight;

fn parse_weighted_json(json: &str) -> Vec<ProviderWeight> {
    serde_json::from_str::<Vec<serde_json::Value>>(json)
        .map(|weights| {
            weights
                .iter()
                .filter_map(|v| {
                    let name = v.get("name")?.as_str()?.to_string();
                    let weight = parse_provider_weight(v.get("weight")?.as_f64()?)?;
                    Some(ProviderWeight { name, weight })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parsed provider profile for auto-classification
#[derive(Debug, Clone, Default)]
pub struct ClassificationInput {
    pub quote_type: Option<String>,
    pub name: Option<String>,
    pub asset_classes: Vec<ClassWeight>,
    pub sectors: Vec<SectorWeight>,
    pub country: Option<String>,
}

/// Raw provider profile fields used for taxonomy classification.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderProfileClassification<'a> {
    pub quote_type: Option<&'a str>,
    pub name: Option<&'a str>,
    pub sector: Option<&'a str>,
    pub sectors_json: Option<&'a str>,
    pub classes_json: Option<&'a str>,
    pub country: Option<&'a str>,
    pub countries_json: Option<&'a str>,
    pub exchange_mic: Option<&'a str>,
}

impl ClassificationInput {
    /// Parse from ProviderProfile fields.
    ///
    /// Handles both:
    /// - Single sector (for stocks): `sector` = "Technology" with 100% weight
    /// - Multiple sectors (for ETFs): `sectors_json` = `[{"name": "Technology", "weight": 0.30}, ...]`
    /// - Asset-class breakdowns: `classes_json` = `[{"name": "bond", "weight": 0.70}, ...]`
    ///
    /// For country, handles both:
    /// - Single country (for stocks): `country` = "United States"
    /// - Multiple countries (for ETFs): `countries_json` = `[{"name": "United States", "weight": 0.60}, ...]`
    ///
    /// Exchange MIC is intentionally not used as a region fallback: trading venue
    /// is not issuer domicile or portfolio exposure.
    pub fn from_provider_profile(profile: ProviderProfileClassification<'_>) -> Self {
        let _exchange_mic = profile.exchange_mic;
        let mut input = ClassificationInput {
            quote_type: profile.quote_type.map(String::from),
            name: profile.name.map(String::from),
            ..Default::default()
        };

        if let Some(json) = profile.classes_json {
            input.asset_classes = parse_weighted_json(json);
        }

        // Parse sectors: prefer JSON array (ETFs), fall back to single sector (stocks)
        if let Some(json) = profile.sectors_json {
            input.sectors = parse_weighted_json(json);
        }

        // If no sectors from JSON, use single sector with 100% weight
        if input.sectors.is_empty() {
            if let Some(sector_name) = profile.sector {
                if !sector_name.is_empty() {
                    input.sectors.push(SectorWeight {
                        name: sector_name.to_string(),
                        weight: 1.0, // 100% weight for single-sector stocks
                    });
                }
            }
        }

        // Parse country: prefer JSON array (ETFs), fall back to single country (stocks)
        if let Some(json) = profile.countries_json {
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
            if let Some(country_name) = profile.country {
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
            let instrument_type_assignments =
                map_quote_type_to_instrument_type(quote_type, input.name.as_deref())
                    .map(|category_id| vec![(category_id.to_string(), 10000)])
                    .unwrap_or_default();
            let first_instrument_type = instrument_type_assignments
                .first()
                .map(|(category_id, _)| category_id.clone());

            match self
                .replace_auto_taxonomy_assignments(
                    asset_id,
                    INSTRUMENT_TYPE_TAXONOMY,
                    instrument_type_assignments,
                )
                .await
            {
                Ok(assigned_count) if assigned_count > 0 => {
                    if let Some(category_id) = first_instrument_type {
                        debug!(
                            "Auto-classified {} as {} in instrument_type",
                            asset_id, category_id
                        );
                        result.security_type = Some(category_id);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    warn!(
                        "Failed to auto-classify {} instrument_type: {}",
                        asset_id, e
                    );
                }
            }
        }

        // 2. Classify asset class. Prefer provider fund composition when available.
        let asset_class_assignments = asset_class_assignments_from_input(input);
        if !asset_class_assignments.is_empty()
            || !input.asset_classes.is_empty()
            || input.quote_type.is_some()
        {
            let first_asset_class = asset_class_assignments
                .first()
                .map(|(category_id, _)| category_id.clone());
            match self
                .replace_auto_taxonomy_assignments(
                    asset_id,
                    ASSET_CLASSES_TAXONOMY,
                    asset_class_assignments,
                )
                .await
            {
                Ok(assigned_count) if assigned_count > 0 => {
                    result.asset_class = first_asset_class;
                }
                Ok(_) => {}
                Err(e) => {
                    warn!("Failed to auto-classify {} asset_classes: {}", asset_id, e);
                }
            }
        }

        // 3. Classify sectors (industries_gics)
        let sector_assignments: Vec<(String, i32)> = input
            .sectors
            .iter()
            .filter_map(|sector| {
                let category_id = map_sector_to_gics(&sector.name)?;
                let weight_bp = (sector.weight * 10000.0).round() as i32;
                if weight_bp > 0 {
                    Some((category_id.to_string(), weight_bp.min(10000)))
                } else {
                    None
                }
            })
            .collect();
        if !sector_assignments.is_empty() || !input.sectors.is_empty() {
            let result_sectors: Vec<(String, f64)> = sector_assignments
                .iter()
                .map(|(category_id, weight_bp)| {
                    (category_id.clone(), f64::from(*weight_bp) / 10000.0)
                })
                .collect();
            match self
                .replace_auto_taxonomy_assignments(asset_id, "industries_gics", sector_assignments)
                .await
            {
                Ok(assigned_count) if assigned_count > 0 => {
                    result.sectors.extend(result_sectors);
                }
                Ok(_) => {}
                Err(e) => {
                    warn!(
                        "Failed to auto-classify {} industries_gics: {}",
                        asset_id, e
                    );
                }
            }
        }

        // 4. Classify region
        if let Some(country) = &input.country {
            let region_assignments = map_country_to_region(country)
                .map(|category_id| vec![(category_id.to_string(), 10000)])
                .unwrap_or_default();
            let first_region = region_assignments
                .first()
                .map(|(category_id, _)| category_id.clone());

            match self
                .replace_auto_taxonomy_assignments(asset_id, "regions", region_assignments)
                .await
            {
                Ok(assigned_count) if assigned_count > 0 => {
                    if let Some(category_id) = first_region {
                        debug!("Auto-classified {} as {} in regions", asset_id, category_id);
                        result.region = Some(category_id);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    warn!("Failed to auto-classify {} regions: {}", asset_id, e);
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
                    .replace_auto_taxonomy_assignments(
                        asset_id,
                        INSTRUMENT_TYPE_TAXONOMY,
                        vec![(category_id.to_string(), 10000)],
                    )
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
                .replace_auto_taxonomy_assignments(
                    asset_id,
                    ASSET_CLASSES_TAXONOMY,
                    vec![(category_id.to_string(), 10000)],
                )
                .await
            {
                debug!(
                    "Initial classification of {} asset_classes failed: {}",
                    asset_id, e
                );
            }
        }
    }

    async fn replace_auto_taxonomy_assignments(
        &self,
        asset_id: &str,
        taxonomy_id: &str,
        assignments: Vec<(String, i32)>,
    ) -> Result<usize, String> {
        let existing_assignments = self
            .taxonomy_service
            .get_asset_assignments(asset_id)
            .map_err(|e| e.to_string())?;
        let taxonomy_assignments: Vec<_> = existing_assignments
            .into_iter()
            .filter(|assignment| assignment.taxonomy_id == taxonomy_id)
            .collect();

        let has_non_auto_assignment = taxonomy_assignments
            .iter()
            .any(|assignment| !assignment.source.eq_ignore_ascii_case(AUTO_SOURCE));

        for assignment in taxonomy_assignments
            .iter()
            .filter(|assignment| assignment.source.eq_ignore_ascii_case(AUTO_SOURCE))
        {
            self.taxonomy_service
                .remove_asset_assignment(&assignment.id)
                .await
                .map_err(|e| e.to_string())?;
        }

        if has_non_auto_assignment {
            debug!(
                "Skipping AUTO classification for {} {} because non-AUTO assignments exist",
                asset_id, taxonomy_id
            );
            return Ok(0);
        }

        let assignment_count = assignments.len();
        for (category_id, weight) in assignments {
            self.assign_to_taxonomy(asset_id, taxonomy_id, &category_id, weight)
                .await?;
        }

        Ok(assignment_count)
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
            source: AUTO_SOURCE.to_string(),
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
    use crate::taxonomies::{
        AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
        Taxonomy, TaxonomyWithCategories,
    };
    use crate::Result;
    use chrono::Utc;
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

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
    fn test_asset_class_assignments_from_provider_weights() {
        let classes = vec![
            ClassWeight {
                name: "stock".to_string(),
                weight: 0.60,
            },
            ClassWeight {
                name: "bond".to_string(),
                weight: 0.30,
            },
            ClassWeight {
                name: "other".to_string(),
                weight: 0.10,
            },
        ];

        let assignments = asset_class_assignments_from_provider(&classes);
        let assignment_map: BTreeMap<_, _> = assignments.into_iter().collect();

        assert_eq!(assignment_map.get("EQUITY"), Some(&6000));
        assert_eq!(assignment_map.get("FIXED_INCOME"), Some(&3000));
        assert_eq!(assignment_map.values().sum::<i32>(), 9000);
    }

    #[test]
    fn test_asset_class_assignments_normalize_above_100_percent() {
        let classes = vec![
            ClassWeight {
                name: "stock".to_string(),
                weight: 0.80,
            },
            ClassWeight {
                name: "bond".to_string(),
                weight: 0.40,
            },
        ];

        let assignments = asset_class_assignments_from_provider(&classes);

        assert_eq!(
            assignments.iter().map(|(_, weight)| weight).sum::<i32>(),
            10000
        );
    }

    #[test]
    fn test_asset_class_assignments_aggregate_fixed_income_components() {
        let classes = vec![
            ClassWeight {
                name: "stock".to_string(),
                weight: 0.50,
            },
            ClassWeight {
                name: "bond".to_string(),
                weight: 0.30,
            },
            ClassWeight {
                name: "preferred".to_string(),
                weight: 0.10,
            },
            ClassWeight {
                name: "convertible".to_string(),
                weight: 0.10,
            },
        ];

        let assignments = asset_class_assignments_from_provider(&classes);
        let assignment_map: BTreeMap<_, _> = assignments.into_iter().collect();

        assert_eq!(assignment_map.get("EQUITY"), Some(&5000));
        assert_eq!(assignment_map.get("FIXED_INCOME"), Some(&5000));
        assert!(!assignment_map.contains_key("FI_PREFERRED"));
        assert!(!assignment_map.contains_key("FI_CONVERTIBLE"));
    }

    #[test]
    fn test_asset_class_assignments_do_not_exceed_100_percent_after_rounding() {
        let classes = vec![
            ClassWeight {
                name: "stock".to_string(),
                weight: 0.33335,
            },
            ClassWeight {
                name: "bond".to_string(),
                weight: 0.33335,
            },
            ClassWeight {
                name: "cash".to_string(),
                weight: 0.33330,
            },
        ];

        let assignments = asset_class_assignments_from_provider(&classes);

        assert_eq!(
            assignments.iter().map(|(_, weight)| weight).sum::<i32>(),
            10000
        );
    }

    #[test]
    fn test_fund_name_fallbacks_for_bond_and_physical_metal_etps() {
        let bond_input = ClassificationInput {
            quote_type: Some("ETF".to_string()),
            name: Some("Amundi Euro Government Bond 3-5Y UCITS ETF".to_string()),
            ..Default::default()
        };
        assert_eq!(
            asset_class_assignments_from_input(&bond_input),
            vec![("FIXED_INCOME".to_string(), 10000)]
        );

        let gold_input = ClassificationInput {
            quote_type: Some("ETF".to_string()),
            name: Some("iShares Physical Gold ETC".to_string()),
            ..Default::default()
        };
        assert_eq!(
            asset_class_assignments_from_input(&gold_input),
            vec![("COMMODITIES".to_string(), 10000)]
        );

        let miners_input = ClassificationInput {
            quote_type: Some("ETF".to_string()),
            name: Some("Gold Miners ETF".to_string()),
            ..Default::default()
        };
        assert_eq!(
            asset_class_assignments_from_input(&miners_input),
            vec![("EQUITY".to_string(), 10000)]
        );
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
        let input = ClassificationInput::from_provider_profile(ProviderProfileClassification {
            sectors_json: Some(json),
            ..Default::default()
        });
        assert_eq!(input.sectors.len(), 2);
        assert_eq!(input.sectors[0].name, "Technology");
        assert_eq!(input.sectors[0].weight, 0.30);
    }

    #[test]
    fn test_parse_classes_json() {
        let json = r#"[{"name":"stock","weight":60},{"name":"bond","weight":40}]"#;
        let input = ClassificationInput::from_provider_profile(ProviderProfileClassification {
            quote_type: Some("ETF"),
            classes_json: Some(json),
            ..Default::default()
        });

        assert_eq!(input.asset_classes.len(), 2);
        assert_eq!(input.asset_classes[0].name, "stock");
        assert_eq!(input.asset_classes[0].weight, 0.60);
        assert_eq!(input.asset_classes[1].name, "bond");
        assert_eq!(input.asset_classes[1].weight, 0.40);
    }

    #[test]
    fn test_parse_single_sector() {
        // For stocks: single sector with 100% weight
        let input = ClassificationInput::from_provider_profile(ProviderProfileClassification {
            quote_type: Some("EQUITY"),
            sector: Some("Technology"),
            country: Some("United States"),
            ..Default::default()
        });
        assert_eq!(input.sectors.len(), 1);
        assert_eq!(input.sectors[0].name, "Technology");
        assert_eq!(input.sectors[0].weight, 1.0);
        assert_eq!(input.country, Some("United States".to_string()));
    }

    #[test]
    fn test_exchange_mic_does_not_fallback_to_country() {
        let input = ClassificationInput::from_provider_profile(ProviderProfileClassification {
            quote_type: Some("ETF"),
            exchange_mic: Some("XETR"),
            ..Default::default()
        });
        assert_eq!(input.country, None);
    }

    #[tokio::test]
    async fn test_auto_classification_removes_stale_auto_but_preserves_manual_assignment() {
        let service = Arc::new(MockTaxonomyService::with_assignments(vec![
            assignment(
                "auto-equity",
                "asset-1",
                ASSET_CLASSES_TAXONOMY,
                "EQUITY",
                10000,
                AUTO_SOURCE,
            ),
            assignment(
                "manual-commodities",
                "asset-1",
                ASSET_CLASSES_TAXONOMY,
                "COMMODITIES",
                10000,
                "manual",
            ),
        ]));
        let classifier = AutoClassificationService::new(service.clone());
        let input = ClassificationInput {
            quote_type: Some("ETF".to_string()),
            name: Some("Amundi Euro Government Bond 3-5Y UCITS ETF".to_string()),
            ..Default::default()
        };

        classifier.classify_asset("asset-1", &input).await.unwrap();

        let assignments = service.assignments_for("asset-1", ASSET_CLASSES_TAXONOMY);
        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0].category_id, "COMMODITIES");
        assert_eq!(assignments[0].source, "manual");
    }

    #[tokio::test]
    async fn test_auto_classification_replaces_auto_asset_class_weights() {
        let service = Arc::new(MockTaxonomyService::with_assignments(vec![assignment(
            "auto-equity",
            "asset-1",
            ASSET_CLASSES_TAXONOMY,
            "EQUITY",
            10000,
            AUTO_SOURCE,
        )]));
        let classifier = AutoClassificationService::new(service.clone());
        let input = ClassificationInput::from_provider_profile(ProviderProfileClassification {
            quote_type: Some("ETF"),
            name: Some("Balanced ETF"),
            classes_json: Some(r#"[{"name":"stock","weight":0.60},{"name":"bond","weight":0.40}]"#),
            ..Default::default()
        });

        classifier.classify_asset("asset-1", &input).await.unwrap();

        let assignments = service.assignments_for("asset-1", ASSET_CLASSES_TAXONOMY);
        let assignment_map: BTreeMap<_, _> = assignments
            .iter()
            .map(|assignment| (assignment.category_id.as_str(), assignment.weight))
            .collect();

        assert_eq!(assignments.len(), 2);
        assert_eq!(assignment_map.get("EQUITY"), Some(&6000));
        assert_eq!(assignment_map.get("FIXED_INCOME"), Some(&4000));
        assert!(assignments
            .iter()
            .all(|assignment| assignment.source == AUTO_SOURCE));
    }

    #[tokio::test]
    async fn test_auto_classification_clears_stale_auto_when_provider_data_is_unmapped() {
        let service = Arc::new(MockTaxonomyService::with_assignments(vec![
            assignment(
                "auto-instrument",
                "asset-1",
                INSTRUMENT_TYPE_TAXONOMY,
                "ETF",
                10000,
                AUTO_SOURCE,
            ),
            assignment(
                "auto-equity",
                "asset-1",
                ASSET_CLASSES_TAXONOMY,
                "EQUITY",
                10000,
                AUTO_SOURCE,
            ),
            assignment(
                "auto-sector",
                "asset-1",
                "industries_gics",
                "45",
                10000,
                AUTO_SOURCE,
            ),
            assignment(
                "auto-region",
                "asset-1",
                "regions",
                "country_US",
                10000,
                AUTO_SOURCE,
            ),
        ]));
        let classifier = AutoClassificationService::new(service.clone());
        let input = ClassificationInput {
            quote_type: Some("ECNQUOTE".to_string()),
            sectors: vec![SectorWeight {
                name: "Unknown Sector".to_string(),
                weight: 1.0,
            }],
            country: Some("Unknown Country".to_string()),
            ..Default::default()
        };

        classifier.classify_asset("asset-1", &input).await.unwrap();

        assert!(service
            .assignments_for("asset-1", INSTRUMENT_TYPE_TAXONOMY)
            .is_empty());
        assert!(service
            .assignments_for("asset-1", ASSET_CLASSES_TAXONOMY)
            .is_empty());
        assert!(service
            .assignments_for("asset-1", "industries_gics")
            .is_empty());
        assert!(service.assignments_for("asset-1", "regions").is_empty());
    }

    fn assignment(
        id: &str,
        asset_id: &str,
        taxonomy_id: &str,
        category_id: &str,
        weight: i32,
        source: &str,
    ) -> AssetTaxonomyAssignment {
        let now = Utc::now().naive_utc();
        AssetTaxonomyAssignment {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            weight,
            source: source.to_string(),
            created_at: now,
            updated_at: now,
        }
    }

    #[derive(Default)]
    struct MockTaxonomyService {
        assignments: Mutex<Vec<AssetTaxonomyAssignment>>,
    }

    impl MockTaxonomyService {
        fn with_assignments(assignments: Vec<AssetTaxonomyAssignment>) -> Self {
            Self {
                assignments: Mutex::new(assignments),
            }
        }

        fn assignments_for(
            &self,
            asset_id: &str,
            taxonomy_id: &str,
        ) -> Vec<AssetTaxonomyAssignment> {
            self.assignments
                .lock()
                .unwrap()
                .iter()
                .filter(|assignment| {
                    assignment.asset_id == asset_id && assignment.taxonomy_id == taxonomy_id
                })
                .cloned()
                .collect()
        }
    }

    #[async_trait::async_trait]
    impl TaxonomyServiceTrait for MockTaxonomyService {
        fn get_taxonomies(&self) -> Result<Vec<Taxonomy>> {
            unimplemented!("unused in auto-classification tests")
        }

        fn get_taxonomy(&self, _id: &str) -> Result<Option<TaxonomyWithCategories>> {
            unimplemented!("unused in auto-classification tests")
        }

        fn get_taxonomies_with_categories(&self) -> Result<Vec<TaxonomyWithCategories>> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn create_taxonomy(&self, _taxonomy: NewTaxonomy) -> Result<Taxonomy> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn update_taxonomy(&self, _taxonomy: Taxonomy) -> Result<Taxonomy> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn delete_taxonomy(&self, _id: &str) -> Result<usize> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn create_category(&self, _category: NewCategory) -> Result<Category> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn update_category(&self, _category: Category) -> Result<Category> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn delete_category(&self, _taxonomy_id: &str, _category_id: &str) -> Result<usize> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn move_category(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
            _new_parent_id: Option<String>,
            _position: i32,
        ) -> Result<Category> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn import_taxonomy_json(&self, _json_str: &str) -> Result<Taxonomy> {
            unimplemented!("unused in auto-classification tests")
        }

        fn export_taxonomy_json(&self, _id: &str) -> Result<String> {
            unimplemented!("unused in auto-classification tests")
        }

        fn get_asset_assignments(&self, asset_id: &str) -> Result<Vec<AssetTaxonomyAssignment>> {
            Ok(self
                .assignments
                .lock()
                .unwrap()
                .iter()
                .filter(|assignment| assignment.asset_id == asset_id)
                .cloned()
                .collect())
        }

        fn get_category_assignments(
            &self,
            _taxonomy_id: &str,
            _category_id: &str,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn assign_asset_to_category(
            &self,
            assignment: NewAssetTaxonomyAssignment,
        ) -> Result<AssetTaxonomyAssignment> {
            let mut assignments = self.assignments.lock().unwrap();
            if let Some(existing) = assignments.iter_mut().find(|existing| {
                existing.asset_id == assignment.asset_id
                    && existing.taxonomy_id == assignment.taxonomy_id
                    && existing.category_id == assignment.category_id
            }) {
                existing.weight = assignment.weight;
                existing.source = assignment.source;
                existing.updated_at = Utc::now().naive_utc();
                return Ok(existing.clone());
            }

            let id = assignment
                .id
                .unwrap_or_else(|| format!("assignment-{}", assignments.len() + 1));
            let created = self::assignment(
                &id,
                &assignment.asset_id,
                &assignment.taxonomy_id,
                &assignment.category_id,
                assignment.weight,
                &assignment.source,
            );
            assignments.push(created.clone());
            Ok(created)
        }

        async fn replace_asset_taxonomy_assignments(
            &self,
            _asset_id: &str,
            _taxonomy_id: &str,
            _assignments: Vec<NewAssetTaxonomyAssignment>,
        ) -> Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!("unused in auto-classification tests")
        }

        async fn remove_asset_assignment(&self, id: &str) -> Result<usize> {
            let mut assignments = self.assignments.lock().unwrap();
            let before = assignments.len();
            assignments.retain(|assignment| assignment.id != id);
            Ok(before - assignments.len())
        }
    }
}
