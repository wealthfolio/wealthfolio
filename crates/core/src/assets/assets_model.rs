//! Asset domain models.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use chrono::NaiveDateTime;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::asset_id::{parse_crypto_pair_symbol, parse_symbol_with_exchange_suffix};
use crate::errors::Result;
use crate::errors::ValidationError;
use crate::fx::currency::normalize_currency_code;
use crate::Error;
use wealthfolio_market_data::mic_to_currency;

// Re-export InstrumentId from market-data crate for convenience
pub use wealthfolio_market_data::InstrumentId;

/// Asset behavior classification.
///
/// `kind` is a behavioral category — broad for market instruments, granular for alternatives.
/// Market instruments are all `INVESTMENT`; the `instrument_type` field carries the
/// market-specific classification (EQUITY, CRYPTO, OPTION, etc.).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AssetKind {
    #[default]
    Investment, // All tradable, lot-tracked market instruments (stocks, ETFs, crypto, options)
    Property,      // Real estate
    Vehicle,       // Cars, motorcycles, boats, RVs
    Collectible,   // Art, wine, watches, jewelry, memorabilia
    PreciousMetal, // Physical gold/silver bars, coins (not ETFs)
    PrivateEquity, // Private shares, startup equity
    Liability,     // Debts (mortgages, loans, credit cards)
    Other,         // Catch-all for uncategorized assets
    Fx,            // Currency exchange rate (infrastructure, not holdable)
}

/// Market instrument type for provider routing.
///
/// Orthogonal to `kind` — tells the market data system which API/endpoint to use.
/// Only meaningful for `kind=INVESTMENT` or `kind=FX`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstrumentType {
    Equity, // Stocks, ETFs, funds
    Crypto, // Cryptocurrencies
    Fx,     // Currency exchange rates
    Option, // Options contracts
    Metal,  // Precious metal spot prices (XAU, XAG)
    Bond,   // Fixed-income instruments (bonds, T-bills, notes)
}

/// How the asset is priced/quoted
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QuoteMode {
    #[default]
    Market, // Priced via market data providers
    Manual, // User-entered quotes only
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProfile {
    #[serde(flatten)]
    pub asset: Asset,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valuation_market_price: Option<Decimal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valuation_market_currency: Option<String>,
}

impl AssetProfile {
    pub fn new(
        asset: Asset,
        valuation_market_price: Option<Decimal>,
        valuation_market_currency: Option<String>,
    ) -> Self {
        Self {
            asset,
            valuation_market_price,
            valuation_market_currency,
        }
    }
}

impl QuoteMode {
    /// Returns the database string representation (SCREAMING_SNAKE_CASE).
    pub const fn as_db_str(&self) -> &'static str {
        match self {
            QuoteMode::Market => "MARKET",
            QuoteMode::Manual => "MANUAL",
        }
    }
}

impl InstrumentType {
    /// Returns the database string representation (SCREAMING_SNAKE_CASE).
    pub const fn as_db_str(&self) -> &'static str {
        match self {
            InstrumentType::Equity => "EQUITY",
            InstrumentType::Crypto => "CRYPTO",
            InstrumentType::Fx => "FX",
            InstrumentType::Option => "OPTION",
            InstrumentType::Metal => "METAL",
            InstrumentType::Bond => "BOND",
        }
    }

    /// Parses an instrument type from its database string.
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "EQUITY" => Some(InstrumentType::Equity),
            "CRYPTO" => Some(InstrumentType::Crypto),
            "FX" => Some(InstrumentType::Fx),
            "OPTION" => Some(InstrumentType::Option),
            "METAL" => Some(InstrumentType::Metal),
            "BOND" => Some(InstrumentType::Bond),
            _ => None,
        }
    }

    /// Parses provider/UI instrument labels into the canonical instrument type.
    pub fn from_external_str(s: &str) -> Option<Self> {
        match s.trim().to_uppercase().as_str() {
            "EQUITY" | "STOCK" | "ETF" | "MUTUALFUND" | "MUTUAL_FUND" | "MUTUAL FUND" | "INDEX"
            | "FUTURE" | "FUTURES" => Some(InstrumentType::Equity),
            "CRYPTO" | "CRYPTOCURRENCY" => Some(InstrumentType::Crypto),
            "FX" | "FOREX" | "CURRENCY" => Some(InstrumentType::Fx),
            "OPTION" => Some(InstrumentType::Option),
            "METAL" | "COMMODITY" => Some(InstrumentType::Metal),
            "BOND" | "FIXEDINCOME" | "FIXED_INCOME" | "DEBT" | "MONEYMARKET" => {
                Some(InstrumentType::Bond)
            }
            _ => None,
        }
    }
}

/// Option contract specification stored in Asset.metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionSpec {
    pub underlying_asset_id: String,
    pub expiration: chrono::NaiveDate,
    pub right: String, // CALL or PUT
    pub strike: Decimal,
    pub multiplier: Decimal,
    pub occ_symbol: Option<String>,
}

/// Bond specification stored in Asset.metadata["bond"]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BondSpec {
    pub maturity_date: Option<chrono::NaiveDate>,
    pub coupon_rate: Option<Decimal>, // Annual coupon rate (e.g., 0.04375 = 4.375%)
    pub face_value: Option<Decimal>,  // Par value per bond (typically 1000.0)
    pub coupon_frequency: Option<String>, // ANNUAL, SEMI_ANNUAL, QUARTERLY, MONTHLY
    pub isin: Option<String>,
}

/// Builds structured asset metadata (OptionSpec, BondSpec) for the given instrument type.
///
/// Returns `Some(Value)` when the instrument type is Option or Bond and metadata
/// can be constructed from the symbol. Returns `None` for other types or unparseable symbols.
///
/// For options, uses the standard contract multiplier of 100. Callers that need
/// a different multiplier (e.g. mini options) should build the metadata directly
/// and pass it via `AssetSpec.metadata`.
pub fn build_asset_metadata(
    instrument_type: Option<&InstrumentType>,
    symbol: &str,
) -> Option<serde_json::Value> {
    match instrument_type? {
        InstrumentType::Option => {
            let parsed = crate::utils::occ_symbol::parse_occ_symbol(symbol).ok()?;
            let spec = OptionSpec {
                underlying_asset_id: parsed.underlying.clone(),
                expiration: parsed.expiration,
                right: parsed.option_type.as_str().to_string(),
                strike: parsed.strike_price,
                multiplier: Decimal::from(100),
                occ_symbol: Some(parsed.to_occ_symbol()),
            };
            Some(serde_json::json!({ "option": spec }))
        }
        InstrumentType::Bond => {
            // For US Treasury bills (CUSIP prefix 912797), set zero coupon.
            // Other bonds get None and rely on user/provider to fill in.
            let is_tbill = symbol.starts_with("US912797") || symbol.starts_with("912797");
            let spec = BondSpec {
                isin: Some(symbol.to_uppercase()),
                coupon_rate: if is_tbill { Some(Decimal::ZERO) } else { None },
                coupon_frequency: if is_tbill {
                    Some("ZERO".to_string())
                } else {
                    None
                },
                ..Default::default()
            };
            Some(serde_json::json!({ "bond": spec }))
        }
        _ => None,
    }
}

/// Builds option metadata with a specific contract multiplier.
///
/// Used by broker sync when the API provides `is_mini_option` to override
/// the standard 100 multiplier.
pub fn build_option_metadata(symbol: &str, multiplier: Decimal) -> Option<serde_json::Value> {
    let parsed = crate::utils::occ_symbol::parse_occ_symbol(symbol).ok()?;
    let spec = OptionSpec {
        underlying_asset_id: parsed.underlying.clone(),
        expiration: parsed.expiration,
        right: parsed.option_type.as_str().to_string(),
        strike: parsed.strike_price,
        multiplier,
        occ_symbol: Some(parsed.to_occ_symbol()),
    };
    Some(serde_json::json!({ "option": spec }))
}

/// Domain model representing an asset in the system.
///
/// Identity is opaque (UUID). Classification is mutable.
/// Market instrument identity is in `instrument_*` fields.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,

    // Core identity
    pub kind: AssetKind,
    pub name: Option<String>,
    pub display_code: Option<String>, // User-visible ticker/label
    pub notes: Option<String>,
    pub metadata: Option<Value>,

    // Status
    #[serde(default = "default_is_active")]
    pub is_active: bool,

    // Valuation
    pub quote_mode: QuoteMode,
    pub quote_ccy: String, // Currency prices/valuations are quoted in

    // Instrument identity (NULL for non-market assets)
    pub instrument_type: Option<InstrumentType>,
    pub instrument_symbol: Option<String>, // Canonical symbol (AAPL, BTC, EUR)
    pub instrument_exchange_mic: Option<String>, // ISO 10383 MIC (XNAS, XTSE)

    // Computed canonical key (read-only from DB generated column)
    #[serde(skip_deserializing)]
    pub instrument_key: Option<String>,

    // Provider configuration (single JSON blob)
    pub provider_config: Option<Value>,

    // Derived (not stored in DB)
    #[serde(skip_deserializing)]
    pub exchange_name: Option<String>, // Friendly exchange name (derived from MIC)

    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

fn default_is_active() -> bool {
    true
}

impl AssetKind {
    /// Returns the database string representation (SCREAMING_SNAKE_CASE).
    pub const fn as_db_str(&self) -> &'static str {
        match self {
            AssetKind::Investment => "INVESTMENT",
            AssetKind::Property => "PROPERTY",
            AssetKind::Vehicle => "VEHICLE",
            AssetKind::Collectible => "COLLECTIBLE",
            AssetKind::PreciousMetal => "PRECIOUS_METAL",
            AssetKind::PrivateEquity => "PRIVATE_EQUITY",
            AssetKind::Liability => "LIABILITY",
            AssetKind::Other => "OTHER",
            AssetKind::Fx => "FX",
        }
    }

    /// Returns a human-readable display name for the asset kind.
    pub const fn display_name(&self) -> &'static str {
        match self {
            AssetKind::Investment => "Investment",
            AssetKind::Property => "Property",
            AssetKind::Vehicle => "Vehicle",
            AssetKind::Collectible => "Collectible",
            AssetKind::PreciousMetal => "Precious Metal",
            AssetKind::PrivateEquity => "Private Equity",
            AssetKind::Liability => "Liability",
            AssetKind::Other => "Other",
            AssetKind::Fx => "FX Rate",
        }
    }

    /// Check if this asset kind is an alternative asset (Property, Vehicle, Collectible, etc.)
    /// Alternative assets are excluded from TWR/IRR performance calculations.
    pub fn is_alternative(&self) -> bool {
        matches!(
            self,
            AssetKind::Property
                | AssetKind::Vehicle
                | AssetKind::Collectible
                | AssetKind::PreciousMetal
                | AssetKind::Liability
                | AssetKind::Other
        )
    }

    /// Check if this asset kind should be included in investment performance calculations (TWR/IRR).
    pub fn is_investment(&self) -> bool {
        matches!(self, AssetKind::Investment | AssetKind::PrivateEquity)
    }

    /// Check if this asset kind is a liability (debts that reduce net worth).
    pub fn is_liability(&self) -> bool {
        matches!(self, AssetKind::Liability)
    }

    /// Parses an asset kind from its database string.
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "INVESTMENT" => Some(AssetKind::Investment),
            "PROPERTY" => Some(AssetKind::Property),
            "VEHICLE" => Some(AssetKind::Vehicle),
            "COLLECTIBLE" => Some(AssetKind::Collectible),
            "PRECIOUS_METAL" => Some(AssetKind::PreciousMetal),
            "PRIVATE_EQUITY" => Some(AssetKind::PrivateEquity),
            "LIABILITY" => Some(AssetKind::Liability),
            "OTHER" => Some(AssetKind::Other),
            "FX" => Some(AssetKind::Fx),
            _ => None,
        }
    }
}

impl Asset {
    /// Enrich the asset with derived fields like exchange_name.
    /// Call this when returning assets to the frontend.
    pub fn enrich(mut self) -> Self {
        self.exchange_name = self
            .instrument_exchange_mic
            .as_ref()
            .and_then(|mic| wealthfolio_market_data::mic_to_exchange_name(mic))
            .map(String::from);
        self
    }

    /// Check if this asset is holdable (can have positions)
    pub fn is_holdable(&self) -> bool {
        !matches!(self.kind, AssetKind::Fx)
    }

    /// Check if this asset needs pricing
    pub fn needs_pricing(&self) -> bool {
        self.quote_mode == QuoteMode::Market
    }

    /// Check if this asset is an alternative asset type.
    pub fn is_alternative(&self) -> bool {
        self.kind.is_alternative()
    }

    /// Check if this asset is included in investment performance calculations.
    pub fn is_investment(&self) -> bool {
        self.kind.is_investment()
    }

    /// Check if this asset is a liability.
    pub fn is_liability(&self) -> bool {
        self.kind.is_liability()
    }

    /// Returns true if this asset is an options contract.
    pub fn is_option(&self) -> bool {
        self.instrument_type == Some(InstrumentType::Option)
    }

    /// Returns true for stock/ETF/fund-style investment assets.
    ///
    /// Legacy assets may not have `instrument_type` populated, so untyped
    /// investment assets are treated as equity-like for lot accounting.
    pub fn is_equity_like(&self) -> bool {
        matches!(self.kind, AssetKind::Investment)
            && matches!(self.instrument_type, None | Some(InstrumentType::Equity))
    }

    /// Returns true if this asset is a bond / fixed-income instrument.
    pub fn is_bond(&self) -> bool {
        self.instrument_type == Some(InstrumentType::Bond)
    }

    /// Returns true if this asset is a precious metal.
    pub fn is_metal(&self) -> bool {
        self.instrument_type == Some(InstrumentType::Metal)
    }

    /// Returns the contract multiplier for this asset.
    ///
    /// For options, this is the number of shares per contract (typically 100).
    /// For all other instruments it is 1.
    pub fn contract_multiplier(&self) -> Decimal {
        if let Some(spec) = self.option_spec() {
            spec.multiplier
        } else if self.is_option() {
            // Option without metadata — default to standard 100 multiplier
            Decimal::from(100)
        } else {
            Decimal::ONE
        }
    }

    /// Get option metadata if this is an option (instrument_type = OPTION)
    pub fn option_spec(&self) -> Option<OptionSpec> {
        if !self.is_option() {
            return None;
        }
        self.metadata
            .as_ref()
            .and_then(|m| m.get("option"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// Get bond metadata if this is a bond (instrument_type = BOND)
    pub fn bond_spec(&self) -> Option<BondSpec> {
        if !self.is_bond() {
            return None;
        }
        self.metadata
            .as_ref()
            .and_then(|m| m.get("bond"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    fn metadata_identifier(&self, key: &str) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("identifiers"))
            .and_then(|v| v.as_object())
            .and_then(|ids| ids.get(key))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// Convert to canonical instrument for market data resolution.
    /// Returns None for asset kinds that are not resolvable to market data.
    pub fn to_instrument_id(&self) -> Option<InstrumentId> {
        let inst_type = self.instrument_type.as_ref()?;

        match inst_type {
            InstrumentType::Equity => {
                let symbol = self.instrument_symbol.as_ref()?;
                let canonical = canonicalize_market_identity(
                    Some(InstrumentType::Equity),
                    Some(symbol.as_str()),
                    self.instrument_exchange_mic.as_deref(),
                    Some(self.quote_ccy.as_str()),
                );
                Some(InstrumentId::Equity {
                    ticker: Arc::from(
                        canonical
                            .instrument_symbol
                            .as_deref()
                            .unwrap_or(symbol.as_str()),
                    ),
                    mic: canonical
                        .instrument_exchange_mic
                        .or_else(|| self.instrument_exchange_mic.clone())
                        .map(Cow::Owned),
                })
            }
            InstrumentType::Crypto => {
                let symbol = self.instrument_symbol.as_ref()?;
                Some(InstrumentId::Crypto {
                    base: Arc::from(symbol.as_str()),
                    quote: Cow::Owned(self.quote_ccy.clone()),
                })
            }
            InstrumentType::Fx => {
                let symbol = self.instrument_symbol.as_ref()?;
                Some(InstrumentId::Fx {
                    base: Cow::Owned(symbol.clone()),
                    quote: Cow::Owned(self.quote_ccy.clone()),
                })
            }
            InstrumentType::Metal => {
                let symbol = self.instrument_symbol.as_ref()?;
                Some(InstrumentId::Metal {
                    code: Arc::from(symbol.as_str()),
                    quote: Cow::Owned(self.quote_ccy.clone()),
                })
            }
            InstrumentType::Option => {
                let symbol = self.instrument_symbol.as_ref()?;
                // OCC symbol is stored as instrument_symbol
                Some(InstrumentId::Option {
                    occ_symbol: Arc::from(symbol.as_str()),
                })
            }
            InstrumentType::Bond => {
                let isin = self
                    .metadata_identifier("isin")
                    .map(|isin| isin.to_uppercase())
                    .or_else(|| self.instrument_symbol.as_ref().map(|s| s.to_uppercase()))?;
                Some(InstrumentId::Bond {
                    isin: Arc::from(isin),
                })
            }
        }
    }

    /// Get the preferred provider from provider_config JSON.
    pub fn preferred_provider(&self) -> Option<String> {
        self.provider_config
            .as_ref()
            .and_then(|c| c.get("preferred_provider"))
            .and_then(|v| v.as_str())
            .map(String::from)
    }

    /// Get provider overrides from provider_config JSON.
    pub fn provider_overrides(&self) -> Option<&Value> {
        self.provider_config
            .as_ref()
            .and_then(|c| c.get("overrides"))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sector {
    pub name: String,
    pub weight: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Country {
    pub name: String,
    pub weight: f64,
}

/// Profile data returned by market data providers.
/// Used to create/enrich assets from external sources.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: Option<String>,
    pub isin: Option<String>,
    pub name: Option<String>,
    pub asset_type: Option<String>,
    pub symbol: String,
    pub quote_symbol: Option<String>, // Symbol for quote fetching (replaces symbol_mapping)
    pub notes: Option<String>,
    pub countries: Option<String>,
    pub categories: Option<String>,
    pub classes: Option<String>,
    pub attributes: Option<String>,
    pub currency: String,
    pub data_source: String,
    pub sectors: Option<String>,
    pub industry: Option<String>,
    pub url: Option<String>,
    // Financial metrics
    pub market_cap: Option<f64>,
    pub pe_ratio: Option<f64>,
    pub dividend_yield: Option<f64>,
    pub week_52_high: Option<f64>,
    pub week_52_low: Option<f64>,
}

/// Input model for creating a new asset.
///
/// If `id` is None, the database generates a UUID.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewAsset {
    pub id: Option<String>,

    // Core identity
    pub kind: AssetKind,
    pub name: Option<String>,
    pub display_code: Option<String>,

    // Status
    #[serde(default = "default_is_active")]
    pub is_active: bool,

    // Valuation
    pub quote_mode: QuoteMode,
    pub quote_ccy: String,

    // Instrument identity (for market assets)
    pub instrument_type: Option<InstrumentType>,
    pub instrument_symbol: Option<String>,
    pub instrument_exchange_mic: Option<String>,

    // Provider configuration
    pub provider_config: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_symbol: Option<String>,

    // Metadata
    pub notes: Option<String>,
    pub metadata: Option<Value>,
}

impl NewAsset {
    /// Validates the new asset data
    pub fn validate(&self) -> Result<()> {
        if self.quote_ccy.trim().is_empty() {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Currency (quote_ccy) cannot be empty".to_string(),
            )));
        }

        // Investments with MARKET pricing require instrument fields
        if self.kind == AssetKind::Investment
            && self.quote_mode == QuoteMode::Market
            && self
                .instrument_symbol
                .as_ref()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(Error::Validation(ValidationError::InvalidInput(
                "Investments with MARKET pricing require an instrument_symbol".to_string(),
            )));
        }

        Ok(())
    }

    /// Creates a new FX asset.
    ///
    /// - `kind`: FX
    /// - `instrument_type`: FX
    /// - `instrument_symbol`: base currency (e.g., "EUR")
    /// - `quote_ccy`: quote currency (e.g., "USD")
    /// - `instrument_key` (generated): "FX:EUR/USD"
    pub fn new_fx_asset(base_currency: &str, quote_currency: &str, provider: &str) -> Self {
        let base_upper = base_currency.to_uppercase();
        let quote_upper = quote_currency.to_uppercase();

        let readable_name = format!("{}/{} Exchange Rate", base_upper, quote_upper);
        let display = format!("{}/{}", base_upper, quote_upper);

        let provider_config = if provider == "YAHOO" {
            Some(serde_json::json!({
                "preferred_provider": "YAHOO",
                "overrides": {
                    "YAHOO": {
                        "type": "fx_symbol",
                        "symbol": format!("{}{}=X", base_upper, quote_upper)
                    }
                }
            }))
        } else if provider == "ALPHA_VANTAGE" {
            Some(serde_json::json!({
                "preferred_provider": "ALPHA_VANTAGE",
                "overrides": {
                    "ALPHA_VANTAGE": {
                        "type": "fx_pair",
                        "from": base_upper,
                        "to": quote_upper
                    }
                }
            }))
        } else if let Some(custom_code) = provider.strip_prefix("CUSTOM_SCRAPER:") {
            Some(serde_json::json!({
                "preferred_provider": "CUSTOM_SCRAPER",
                "custom_provider_code": custom_code
            }))
        } else {
            Some(serde_json::json!({ "preferred_provider": provider }))
        };

        Self {
            id: None, // DB generates UUID
            kind: AssetKind::Fx,
            name: Some(readable_name),
            display_code: Some(display),
            quote_mode: QuoteMode::Market,
            quote_ccy: quote_upper,
            instrument_type: Some(InstrumentType::Fx),
            instrument_symbol: Some(base_upper),
            instrument_exchange_mic: None,
            provider_config,
            notes: None,
            is_active: true,
            ..Default::default()
        }
    }

    /// Creates a new option contract asset from an OptionSpec.
    ///
    /// The OCC symbol is used as `instrument_symbol`.
    /// Metadata stores the full OptionSpec under the "option" key.
    pub fn new_option_contract(spec: &OptionSpec, currency: &str) -> Self {
        let occ = spec.occ_symbol.clone().unwrap_or_else(|| {
            // Build from components if OCC symbol not provided
            spec.underlying_asset_id.clone()
        });
        let name = format!(
            "{} {} ${} {}",
            spec.underlying_asset_id,
            spec.right,
            spec.strike,
            spec.expiration.format("%Y-%m-%d")
        );

        Self {
            kind: AssetKind::Investment,
            name: Some(name.clone()),
            display_code: Some(occ.clone()),
            quote_mode: QuoteMode::Market,
            quote_ccy: currency.to_uppercase(),
            instrument_type: Some(InstrumentType::Option),
            instrument_symbol: Some(occ),
            metadata: Some(serde_json::json!({ "option": spec })),
            is_active: true,
            ..Default::default()
        }
    }

    /// Creates a new bond asset from a BondSpec and ISIN.
    ///
    /// Bonds use Market quote mode — prices are fetched via the
    /// US_TREASURY_CALC or BOERSE_FRANKFURT providers.
    pub fn new_bond(isin: &str, name: Option<String>, spec: BondSpec, currency: &str) -> Self {
        let display = name.clone().unwrap_or_else(|| isin.to_uppercase());

        Self {
            kind: AssetKind::Investment,
            name,
            display_code: Some(display),
            quote_mode: QuoteMode::Market,
            quote_ccy: currency.to_uppercase(),
            instrument_type: Some(InstrumentType::Bond),
            instrument_symbol: Some(isin.to_uppercase()),
            metadata: Some(serde_json::json!({ "bond": spec })),
            is_active: true,
            ..Default::default()
        }
    }
}

impl From<ProviderProfile> for NewAsset {
    fn from(profile: ProviderProfile) -> Self {
        // Build provider_config from profile
        let mut config = serde_json::Map::new();

        // Set preferred_provider
        let data_source = profile.data_source.clone();
        if matches!(
            data_source.as_str(),
            "YAHOO" | "ALPHA_VANTAGE" | "MARKETDATA_APP" | "METAL_PRICE_API"
        ) {
            config.insert(
                "preferred_provider".to_string(),
                Value::String(data_source.clone()),
            );
        }

        // Build overrides if quote_symbol differs from symbol
        if let Some(ref qs) = profile.quote_symbol {
            if qs != &profile.symbol {
                let overrides = serde_json::json!({
                    data_source.clone(): {
                        "type": "equity_symbol",
                        "symbol": qs
                    }
                });
                config.insert("overrides".to_string(), overrides);
            }
        }

        let provider_config = if config.is_empty() {
            None
        } else {
            Some(Value::Object(config))
        };

        // Build metadata.identifiers from provider profile (only ISIN for now)
        let metadata = profile
            .isin
            .as_ref()
            .filter(|isin| !isin.is_empty())
            .map(|isin| serde_json::json!({ "identifiers": { "isin": isin } }));

        let canonical = canonicalize_market_identity(
            Some(InstrumentType::Equity),
            Some(profile.symbol.as_str()),
            None,
            Some(profile.currency.as_str()),
        );

        Self {
            id: profile.id,
            kind: AssetKind::Investment,
            name: profile.name,
            display_code: canonical.display_code,
            quote_mode: QuoteMode::Market,
            quote_ccy: canonical.quote_ccy.unwrap_or(profile.currency),
            instrument_type: Some(InstrumentType::Equity), // Default; caller can override
            instrument_symbol: canonical.instrument_symbol,
            instrument_exchange_mic: canonical.instrument_exchange_mic,
            provider_config,
            provider_id: None,
            provider_symbol: None,
            notes: profile.notes,
            metadata,
            is_active: true,
        }
    }
}

/// Input model for updating an asset profile
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetProfile {
    pub name: Option<String>,
    pub display_code: Option<String>,
    pub notes: String,
    pub kind: Option<AssetKind>,
    pub quote_mode: Option<QuoteMode>,
    pub quote_ccy: Option<String>,
    pub instrument_type: Option<InstrumentType>,
    pub instrument_symbol: Option<String>,
    pub instrument_exchange_mic: Option<String>,
    pub provider_config: Option<Value>,
    pub metadata: Option<Value>,
}

/// Optional asset metadata that can be passed during activity creation.
/// Allows users to provide/override asset details inline.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadata {
    pub name: Option<String>,
    pub kind: Option<AssetKind>,
    pub instrument_exchange_mic: Option<String>,
    pub instrument_symbol: Option<String>,
    pub instrument_type: Option<InstrumentType>,
    pub display_code: Option<String>,
    /// Input quote currency provided by caller/search/provider (e.g. "GBp").
    pub requested_quote_ccy: Option<String>,
    /// Explicit asset-level provider config. Keep this asset-owned; import/activity
    /// payloads should normally pass provider_id/provider_symbol instead.
    pub provider_config: Option<Value>,
    /// Provider that resolved this asset, if selected by search/import.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Structured metadata (e.g. OptionSpec under "option", BondSpec under "bond").
    pub asset_metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalMarketIdentity {
    pub instrument_symbol: Option<String>,
    pub instrument_exchange_mic: Option<String>,
    pub display_code: Option<String>,
    pub quote_ccy: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteCcyResolutionSource {
    ExplicitInput,
    ExistingAsset,
    ProviderQuote,
    MicFallback,
    TerminalFallback,
}

fn normalize_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_uppercase())
}

fn normalize_quote_ccy(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|s| !s.is_empty())?;

    // Preserve canonical minor-unit spellings where case is meaningful.
    if trimmed == "GBp" {
        return Some("GBp".to_string());
    }
    if trimmed.eq_ignore_ascii_case("GBX") {
        return Some("GBX".to_string());
    }
    if trimmed == "ZAc" || trimmed.eq_ignore_ascii_case("ZAC") {
        return Some("ZAc".to_string());
    }

    Some(trimmed.to_uppercase())
}

pub fn normalize_quote_ccy_code(value: Option<&str>) -> Option<String> {
    normalize_quote_ccy(value)
}

pub fn resolve_quote_ccy_precedence(
    explicit_quote_ccy: Option<&str>,
    existing_asset_quote_ccy: Option<&str>,
    provider_quote_ccy: Option<&str>,
    mic_fallback_quote_ccy: Option<&str>,
    terminal_fallback_quote_ccy: Option<&str>,
) -> Option<(String, QuoteCcyResolutionSource)> {
    if let Some(ccy) = normalize_quote_ccy(explicit_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::ExplicitInput));
    }
    if let Some(ccy) = normalize_quote_ccy(existing_asset_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::ExistingAsset));
    }
    if let Some(ccy) = normalize_quote_ccy(provider_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::ProviderQuote));
    }
    if let Some(ccy) = normalize_quote_ccy(mic_fallback_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::MicFallback));
    }
    normalize_quote_ccy(terminal_fallback_quote_ccy)
        .map(|ccy| (ccy, QuoteCcyResolutionSource::TerminalFallback))
}

pub fn resolve_import_quote_ccy_precedence(
    explicit_quote_ccy: Option<&str>,
    existing_asset_quote_ccy: Option<&str>,
    activity_quote_ccy: Option<&str>,
    provider_quote_ccy: Option<&str>,
    mic_fallback_quote_ccy: Option<&str>,
    terminal_fallback_quote_ccy: Option<&str>,
) -> Option<(String, QuoteCcyResolutionSource)> {
    if let Some(ccy) = normalize_quote_ccy(explicit_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::ExplicitInput));
    }
    if let Some(ccy) = normalize_quote_ccy(existing_asset_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::ExistingAsset));
    }
    let activity_ccy = normalize_quote_ccy(activity_quote_ccy);
    let provider_ccy = normalize_quote_ccy(provider_quote_ccy);
    if let Some(provider) = provider_ccy.as_deref() {
        if activity_ccy
            .as_deref()
            .is_some_and(|activity| provider_quote_unit_matches_activity_major(provider, activity))
        {
            return Some((
                provider.to_string(),
                QuoteCcyResolutionSource::ProviderQuote,
            ));
        }
        if let Some(activity) = activity_ccy {
            return Some((activity, QuoteCcyResolutionSource::ExplicitInput));
        }
        return Some((
            provider.to_string(),
            QuoteCcyResolutionSource::ProviderQuote,
        ));
    }
    if let Some(ccy) = activity_ccy {
        return Some((ccy, QuoteCcyResolutionSource::ExplicitInput));
    }
    if let Some(ccy) = normalize_quote_ccy(mic_fallback_quote_ccy) {
        return Some((ccy, QuoteCcyResolutionSource::MicFallback));
    }
    normalize_quote_ccy(terminal_fallback_quote_ccy)
        .map(|ccy| (ccy, QuoteCcyResolutionSource::TerminalFallback))
}

fn provider_quote_unit_matches_activity_major(provider_quote: &str, activity_quote: &str) -> bool {
    let provider_major = normalize_currency_code(provider_quote);
    provider_major != provider_quote && provider_major.eq_ignore_ascii_case(activity_quote)
}

fn parse_fx_symbol_parts(symbol: &str) -> Option<(String, String)> {
    let trimmed = symbol.trim().to_uppercase();
    let cleaned = trimmed.strip_suffix("=X").unwrap_or(&trimmed);

    if let Some((base, quote)) = cleaned.split_once('/') {
        if base.len() == 3
            && quote.len() == 3
            && base.chars().all(|c| c.is_ascii_alphabetic())
            && quote.chars().all(|c| c.is_ascii_alphabetic())
        {
            return Some((base.to_string(), quote.to_string()));
        }
    }

    if cleaned.len() == 6 && cleaned.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some((cleaned[..3].to_string(), cleaned[3..].to_string()));
    }

    None
}

/// Canonicalizes market identity fields for stable storage and display.
///
/// Rules:
/// - EQUITY/OPTION/METAL: strip known Yahoo exchange suffixes from symbol, keep MIC separately.
/// - CRYPTO: collapse pair symbols (e.g., BTC-USD) to base symbol (BTC), clear MIC.
/// - FX: normalize to base symbol + quote currency, display as BASE/QUOTE.
pub fn canonicalize_market_identity(
    instrument_type: Option<InstrumentType>,
    symbol: Option<&str>,
    exchange_mic: Option<&str>,
    quote_ccy: Option<&str>,
) -> CanonicalMarketIdentity {
    let mut instrument_symbol = normalize_opt(symbol);
    let mut instrument_exchange_mic = normalize_opt(exchange_mic);
    let mut normalized_quote = normalize_quote_ccy(quote_ccy);

    match instrument_type {
        Some(InstrumentType::Equity)
        | Some(InstrumentType::Option)
        | Some(InstrumentType::Metal) => {
            if let Some(raw) = instrument_symbol.as_deref() {
                let (base, suffix_mic) = parse_symbol_with_exchange_suffix(raw);
                instrument_symbol = Some(base.to_uppercase());
                if instrument_exchange_mic.is_none() {
                    instrument_exchange_mic = suffix_mic.map(str::to_string);
                }
            }

            // Exchange MIC provides a fallback quote currency when no explicit quote is supplied.
            if normalized_quote.is_none() {
                if let Some(mic) = instrument_exchange_mic.as_deref() {
                    if let Some(ccy) = mic_to_currency(mic) {
                        normalized_quote = normalize_quote_ccy(Some(ccy));
                    }
                }
            }

            CanonicalMarketIdentity {
                display_code: instrument_symbol.clone(),
                instrument_symbol,
                instrument_exchange_mic,
                quote_ccy: normalized_quote,
            }
        }
        Some(InstrumentType::Crypto) => {
            if let Some(raw) = instrument_symbol.clone() {
                if let Some((base, quote)) = parse_crypto_pair_symbol(&raw) {
                    instrument_symbol = Some(base.to_uppercase());
                    if normalized_quote.is_none() {
                        normalized_quote = Some(quote);
                    }
                }
            }
            CanonicalMarketIdentity {
                display_code: instrument_symbol.clone(),
                instrument_symbol,
                instrument_exchange_mic: None,
                quote_ccy: normalized_quote,
            }
        }
        Some(InstrumentType::Fx) => {
            if let Some(raw) = instrument_symbol.clone() {
                if let Some((base, quote)) = parse_fx_symbol_parts(&raw) {
                    instrument_symbol = Some(base);
                    normalized_quote = Some(quote);
                }
            }

            let display_code = match (instrument_symbol.as_deref(), normalized_quote.as_deref()) {
                (Some(base), Some(quote)) => Some(format!("{}/{}", base, quote)),
                _ => instrument_symbol.clone(),
            };

            CanonicalMarketIdentity {
                display_code,
                instrument_symbol,
                instrument_exchange_mic: None,
                quote_ccy: normalized_quote,
            }
        }
        Some(InstrumentType::Bond) => {
            // Bonds use ISIN as symbol (uppercase, no exchange suffix)
            if let Some(raw) = instrument_symbol.as_deref() {
                let upper = raw.to_uppercase();
                // Auto-convert 9-char CUSIPs to 12-char ISINs for proper
                // provider routing (US_TREASURY_CALC, BOERSE_FRANKFURT).
                // Country code comes from the search result's currency (set by
                // the provider, e.g. OpenFIGI's securityType → "USD").
                instrument_symbol = Some(if crate::utils::cusip::looks_like_cusip(&upper) {
                    let country = match normalized_quote.as_deref() {
                        Some("CAD") => "CA",
                        Some("BMD") => "BM",
                        _ => "US",
                    };
                    crate::utils::cusip::cusip_to_isin(&upper, country)
                } else {
                    upper
                });
            }
            CanonicalMarketIdentity {
                display_code: instrument_symbol.clone(),
                instrument_symbol,
                instrument_exchange_mic: None,
                quote_ccy: normalized_quote,
            }
        }
        None => CanonicalMarketIdentity {
            display_code: normalize_opt(symbol),
            instrument_symbol: normalize_opt(symbol),
            instrument_exchange_mic,
            quote_ccy: normalized_quote,
        },
    }
}

impl UpdateAssetProfile {
    /// Validates the asset profile update data
    pub fn validate(&self) -> Result<()> {
        Ok(())
    }
}

/// Specification for ensuring an asset exists.
/// Used by `ensure_assets()` to batch-create missing assets.
#[derive(Debug, Clone)]
pub struct AssetSpec {
    /// Optional pre-assigned ID. If None, DB generates UUID.
    pub id: Option<String>,
    /// Display code (user-visible ticker)
    pub display_code: Option<String>,
    /// Instrument symbol for market data
    pub instrument_symbol: Option<String>,
    /// Exchange MIC code for securities
    pub instrument_exchange_mic: Option<String>,
    /// Instrument type for routing
    pub instrument_type: Option<InstrumentType>,
    /// Currency for quotes/valuations
    pub quote_ccy: String,
    /// Input quote currency from caller/search/provider.
    pub requested_quote_ccy: Option<String>,
    /// Asset kind
    pub kind: AssetKind,
    /// Optional quote mode override
    pub quote_mode: Option<QuoteMode>,
    /// User-provided name
    pub name: Option<String>,
    /// Provider routing config captured from search/resolution.
    pub provider_config: Option<serde_json::Value>,
    /// Provider that resolved this spec, if selected by search/import.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
    /// Pre-built asset metadata (e.g. OptionSpec with custom multiplier).
    /// When set, `new_asset_from_spec` uses this instead of calling `build_asset_metadata`.
    pub metadata: Option<serde_json::Value>,
}

impl AssetSpec {
    /// Builds a market instrument spec with the required canonical identity.
    pub fn market_instrument(
        display_code: String,
        instrument_symbol: String,
        instrument_exchange_mic: Option<String>,
        instrument_type: InstrumentType,
        quote_ccy: String,
    ) -> Self {
        Self {
            id: None,
            display_code: Some(display_code),
            instrument_symbol: Some(instrument_symbol),
            instrument_exchange_mic,
            instrument_type: Some(instrument_type),
            quote_ccy: quote_ccy.clone(),
            requested_quote_ccy: Some(quote_ccy),
            kind: AssetKind::Investment,
            quote_mode: None,
            name: None,
            provider_config: None,
            provider_id: None,
            provider_symbol: None,
            metadata: None,
        }
    }

    /// Extracts the option contract multiplier from pre-built metadata, if present.
    /// Handles both numeric (serde-float) and string serialization of Decimal.
    pub fn option_multiplier(&self) -> Option<Decimal> {
        let v = self.metadata.as_ref()?.get("option")?.get("multiplier")?;
        v.as_f64()
            .and_then(Decimal::from_f64_retain)
            .or_else(|| v.as_str().and_then(|s| s.parse::<Decimal>().ok()))
    }
}

impl AssetSpec {
    /// Computes the instrument_key that would be generated for this spec's instrument fields.
    /// Mirrors the DB GENERATED STORED column:
    ///   - Crypto/FX: `{TYPE}:{SYMBOL}/{QUOTE_CCY}`
    ///   - With MIC:  `{TYPE}:{SYMBOL}@{MIC}`
    ///   - Bare:      `{TYPE}:{SYMBOL}`
    pub fn instrument_key(&self) -> Option<String> {
        let instrument_type = self.instrument_type.as_ref()?;
        let instrument_symbol = self.instrument_symbol.as_ref()?;
        if instrument_symbol.is_empty() {
            return None;
        }
        match instrument_type {
            InstrumentType::Crypto | InstrumentType::Fx => Some(format!(
                "{}:{}/{}",
                instrument_type.as_db_str(),
                instrument_symbol.to_uppercase(),
                self.quote_ccy.to_uppercase()
            )),
            _ => match self
                .instrument_exchange_mic
                .as_ref()
                .filter(|s| !s.is_empty())
            {
                Some(mic) => Some(format!(
                    "{}:{}@{}",
                    instrument_type.as_db_str(),
                    instrument_symbol.to_uppercase(),
                    mic.to_uppercase()
                )),
                None => Some(format!(
                    "{}:{}",
                    instrument_type.as_db_str(),
                    instrument_symbol.to_uppercase()
                )),
            },
        }
    }
}

/// Result of ensuring assets exist via `ensure_assets()`.
#[derive(Debug, Default)]
pub struct EnsureAssetsResult {
    /// All assets (existing + created), keyed by asset ID
    pub assets: HashMap<String, Asset>,
    /// IDs of newly created assets
    pub created_ids: Vec<String>,
    /// Merge candidates: (resolved_id, unknown_id) pairs where UNKNOWN was merged into resolved
    pub merge_candidates: Vec<(String, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn test_build_asset_metadata_tbill_isin() {
        let meta = build_asset_metadata(Some(&InstrumentType::Bond), "US912797NQ65");
        let meta = meta.expect("T-bill should produce metadata");
        let bond: BondSpec = serde_json::from_value(meta.get("bond").cloned().unwrap()).unwrap();

        // T-bill (912797 prefix) should get zero coupon
        assert_eq!(
            bond.coupon_rate,
            Some(dec!(0)),
            "T-bill coupon_rate should be 0"
        );
        assert_eq!(
            bond.coupon_frequency.as_deref(),
            Some("ZERO"),
            "T-bill coupon_frequency should be ZERO"
        );
        assert_eq!(
            bond.isin.as_deref(),
            Some("US912797NQ65"),
            "ISIN should be preserved"
        );
    }

    #[test]
    fn test_build_asset_metadata_corporate_bond_isin() {
        let meta = build_asset_metadata(Some(&InstrumentType::Bond), "US00507VAJ89");
        let meta = meta.expect("Corporate bond should produce metadata");
        let bond: BondSpec = serde_json::from_value(meta.get("bond").cloned().unwrap()).unwrap();

        // Non-T-bill bond: coupon_rate and coupon_frequency should be None
        assert_eq!(
            bond.coupon_rate, None,
            "Corporate bond coupon_rate should be None"
        );
        assert_eq!(
            bond.coupon_frequency, None,
            "Corporate bond coupon_frequency should be None"
        );
    }

    #[test]
    fn test_canonicalize_market_identity_cusip_to_isin() {
        // 9-char CUSIP for a bond should be converted to 12-char ISIN
        let result = canonicalize_market_identity(
            Some(InstrumentType::Bond),
            Some("912797NQ6"),
            None,
            Some("USD"),
        );

        let sym = result.instrument_symbol.expect("should have symbol");
        assert_eq!(sym.len(), 12, "CUSIP should be converted to 12-char ISIN");
        assert!(
            sym.starts_with("US"),
            "ISIN should start with US country code"
        );
    }

    #[test]
    fn test_canonicalize_market_identity_isin_passthrough() {
        // 12-char ISIN for a bond should pass through unchanged
        let result = canonicalize_market_identity(
            Some(InstrumentType::Bond),
            Some("US912797NQ65"),
            None,
            Some("USD"),
        );

        let sym = result.instrument_symbol.expect("should have symbol");
        assert_eq!(sym, "US912797NQ65", "ISIN should pass through unchanged");
    }

    #[test]
    fn test_canonicalize_market_identity_cusip_to_isin_canadian() {
        // Canadian bond CUSIP should produce a CA-prefixed ISIN
        let result = canonicalize_market_identity(
            Some(InstrumentType::Bond),
            Some("135087D26"),
            None,
            Some("CAD"),
        );

        let sym = result.instrument_symbol.expect("should have symbol");
        assert_eq!(sym.len(), 12, "CUSIP should be converted to 12-char ISIN");
        assert!(
            sym.starts_with("CA"),
            "Canadian bond ISIN should start with CA, got {}",
            sym
        );
    }

    #[test]
    fn test_canonicalize_market_identity_cusip_defaults_to_us() {
        // When no currency is provided, CUSIP should default to US
        let result =
            canonicalize_market_identity(Some(InstrumentType::Bond), Some("912797NQ6"), None, None);

        let sym = result.instrument_symbol.expect("should have symbol");
        assert!(
            sym.starts_with("US"),
            "CUSIP with no currency should default to US, got {}",
            sym
        );
    }

    #[test]
    fn test_canonicalize_market_identity_us_treasury_with_usd_currency() {
        // When the search provider sets currency to USD (from securityType),
        // US Treasury CUSIPs get the correct US prefix.
        let result = canonicalize_market_identity(
            Some(InstrumentType::Bond),
            Some("912797TR8"),
            None,
            Some("USD"),
        );

        let sym = result.instrument_symbol.expect("should have symbol");
        assert!(
            sym.starts_with("US"),
            "US Treasury CUSIP with USD currency should get US prefix, got {}",
            sym
        );
    }
}
