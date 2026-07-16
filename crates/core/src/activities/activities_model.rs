//! Activity domain models.

use crate::activities::activities_constants::{
    ACTIVITY_SUBTYPE_BONUS, ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND, ACTIVITY_SUBTYPE_DRIP,
    ACTIVITY_SUBTYPE_OPTION_EXPIRY, ACTIVITY_SUBTYPE_POSITION_CLOSE,
    ACTIVITY_SUBTYPE_POSITION_OPEN, ACTIVITY_SUBTYPE_REBATE, ACTIVITY_SUBTYPE_REFUND,
    ACTIVITY_SUBTYPE_REIMBURSEMENT, ACTIVITY_SUBTYPE_STAKING_REWARD, ACTIVITY_TYPE_ADJUSTMENT,
    ACTIVITY_TYPE_BUY, ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_FEE, ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT,
    ACTIVITY_TYPE_TAX, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
    ACTIVITY_TYPE_WITHDRAWAL,
};
use crate::activities::csv_parser::ParseConfig;
use crate::assets::NewAsset;
use crate::Result;
use crate::{activities::activities_errors::ActivityError, QuoteMode};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;

/// Discriminator values for `import_account_templates.context_kind`.
pub mod import_type {
    pub const ACTIVITY: &str = "CSV_ACTIVITY";
    pub const HOLDINGS: &str = "CSV_HOLDINGS";
}

/// Template kind — discriminates the config shape stored in import_templates.config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TemplateKind {
    #[default]
    CsvActivity,
    CsvHoldings,
    BrokerActivity,
}

fn default_csv_activity_kind() -> TemplateKind {
    TemplateKind::CsvActivity
}

impl TemplateKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TemplateKind::CsvActivity => "CSV_ACTIVITY",
            TemplateKind::CsvHoldings => "CSV_HOLDINGS",
            TemplateKind::BrokerActivity => "BROKER_ACTIVITY",
        }
    }

    pub fn is_csv(&self) -> bool {
        matches!(self, TemplateKind::CsvActivity | TemplateKind::CsvHoldings)
    }
}

/// Value transformation for sync replay backward compat.
/// Old payloads may send "ACTIVITY"/"HOLDINGS" instead of "CSV_ACTIVITY"/"CSV_HOLDINGS".
pub fn normalize_context_kind_value(raw: &str) -> &str {
    match raw {
        "ACTIVITY" => import_type::ACTIVITY,
        "HOLDINGS" => import_type::HOLDINGS,
        _ => raw,
    }
}

/// Helper function to parse a string into a Decimal,
/// with support for scientific notation.
pub fn parse_decimal_string_tolerant(value_str: &str, field_name: &str) -> Decimal {
    // Attempt to parse directly as Decimal
    match Decimal::from_str(value_str) {
        Ok(d) => d,
        Err(e_decimal) => {
            // If direct parsing fails, try scientific notation parsing
            match Decimal::from_scientific(value_str) {
                Ok(d) => d,
                Err(e_scientific) => {
                    // If both attempts fail, log the original decimal error and the scientific error.
                    log::error!(
                        "Failed to parse {} '{}': as Decimal (err: {}), and as scientific (err: {}). Falling back to ZERO.",
                        field_name, value_str, e_decimal, e_scientific
                    );
                    Decimal::ZERO
                }
            }
        }
    }
}

/// Activity status for lifecycle management
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActivityStatus {
    #[default]
    Posted, // Live, affects calculations
    Pending, // Awaiting settlement/confirmation
    Draft,   // User-created, not yet confirmed
    Void,    // Cancelled/reversed (soft delete)
}

/// Domain model representing an activity in the system
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    // Identity
    pub id: String,
    pub account_id: String,
    pub asset_id: Option<String>, // NOW OPTIONAL - NULL for pure cash movements

    // Classification
    pub activity_type: String, // Canonical type (closed set of 14)
    pub activity_type_override: Option<String>, // User override (never touched by sync)
    pub source_type: Option<String>, // Raw provider label (REI, DIV, etc.)
    pub subtype: Option<String>, // Semantic variation (DRIP, STAKING_REWARD, etc.)
    pub status: ActivityStatus,

    // Timing
    #[serde(with = "timestamp_format")]
    pub activity_date: DateTime<Utc>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_date: Option<DateTime<Utc>>,

    // Quantities - NOW ALL OPTIONAL
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub quantity: Option<Decimal>,
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub unit_price: Option<Decimal>,
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub amount: Option<Decimal>,
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub fee: Option<Decimal>,
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub tax: Option<Decimal>,
    pub currency: String,
    #[serde(default)]
    #[serde(with = "optional_decimal_format")]
    pub fx_rate: Option<Decimal>,

    // Metadata
    pub notes: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>, // JSON blob

    // Source identity
    pub source_system: Option<String>, // SNAPTRADE, PLAID, MANUAL, CSV
    pub source_record_id: Option<String>, // Provider's record ID
    pub source_group_id: Option<String>, // Provider grouping key
    pub idempotency_key: Option<String>, // Stable hash for dedupe
    pub import_run_id: Option<String>, // Batch/run identifier

    // Sync flags
    #[serde(default)]
    pub is_user_modified: bool, // User edited; sync protects economics
    #[serde(default)]
    pub needs_review: bool, // Needs user review (low confidence, etc.)

    // Audit
    #[serde(with = "timestamp_format")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "timestamp_format")]
    pub updated_at: DateTime<Utc>,
}

impl Activity {
    /// Returns the effective activity type, respecting user overrides.
    /// This is what the compiler and calculator should use.
    pub fn effective_type(&self) -> &str {
        self.activity_type_override
            .as_deref()
            .unwrap_or(&self.activity_type)
    }

    /// Returns the effective date for this activity
    pub fn effective_date(&self) -> NaiveDate {
        self.activity_date.naive_utc().date()
    }

    /// Check if this activity is posted (should affect calculations)
    pub fn is_posted(&self) -> bool {
        self.status == ActivityStatus::Posted
    }

    /// Check if this activity has a user override
    pub fn has_override(&self) -> bool {
        self.activity_type_override.is_some()
    }

    /// Get quantity, defaulting to zero if not set.
    /// Always returns absolute value — direction is determined by activity type.
    pub fn qty(&self) -> Decimal {
        self.quantity.unwrap_or(Decimal::ZERO).abs()
    }

    /// Get unit price, defaulting to zero if not set.
    /// Always returns absolute value.
    pub fn price(&self) -> Decimal {
        self.unit_price.unwrap_or(Decimal::ZERO).abs()
    }

    /// Get amount, defaulting to zero if not set.
    /// Always returns absolute value — direction is determined by activity type.
    pub fn amt(&self) -> Decimal {
        self.amount.unwrap_or(Decimal::ZERO).abs()
    }

    /// Get fee, defaulting to zero if not set.
    /// Always returns absolute value.
    pub fn fee_amt(&self) -> Decimal {
        self.fee.unwrap_or(Decimal::ZERO).abs()
    }

    /// Get tax or withholding amount, defaulting to zero if not set.
    /// Always returns absolute value.
    pub fn tax_amt(&self) -> Decimal {
        self.tax.unwrap_or(Decimal::ZERO).abs()
    }

    /// Get the charge amount for standalone charge handling.
    pub(crate) fn charge_amt_for(&self, activity_type: &ActivityType) -> Decimal {
        if matches!(activity_type, ActivityType::Tax) && !self.tax_amt().is_zero() {
            return self.tax_amt();
        }

        if !self.fee_amt().is_zero() {
            return self.fee_amt();
        }

        self.amt()
    }

    /// Get typed metadata value
    pub fn get_meta<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.metadata
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

/// Input for asset identification when creating/updating activities.
/// Consolidates all asset-related fields into a single nested object.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssetResolutionInput {
    /// Existing asset ID. When provided without natural identity, it must refer to a persisted asset.
    pub id: Option<String>,
    /// Symbol (e.g., "AAPL", "BTC") used to resolve or create an asset.
    pub symbol: Option<String>,
    /// Exchange MIC code (e.g., "XNAS", "XTSE") for securities.
    pub exchange_mic: Option<String>,
    /// Asset kind hint (e.g., "SECURITY", "CRYPTO") - if not provided, inferred.
    pub kind: Option<String>,
    /// Asset name hint for custom/manual assets.
    pub name: Option<String>,
    /// Quote mode hint: "MARKET" or "MANUAL".
    pub quote_mode: Option<String>,
    /// Optional quote currency from symbol search/provider (e.g., "GBp").
    pub quote_ccy: Option<String>,
    /// Optional instrument type from symbol search/provider (e.g., "EQUITY", "CRYPTO").
    pub instrument_type: Option<String>,
    /// Market data provider that resolved this symbol, if selected.
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    pub provider_symbol: Option<String>,
}

/// Input model for creating a new activity
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewActivity {
    pub id: Option<String>,
    pub account_id: String,

    /// Asset resolution input. Accepts the old `symbol` JSON field during transition.
    /// Optional for cash activities which don't require an asset
    #[serde(alias = "symbol")]
    pub asset: Option<AssetResolutionInput>,

    pub activity_type: String,
    pub subtype: Option<String>, // Semantic variation (DRIP, STAKING_REWARD, etc.)
    pub activity_date: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub quantity: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub unit_price: Option<Decimal>,
    pub currency: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub fee: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub tax: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub amount: Option<Decimal>,
    pub status: Option<ActivityStatus>,
    #[serde(alias = "comment")]
    pub notes: Option<String>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub fx_rate: Option<Decimal>,
    // Sync-related fields
    pub metadata: Option<String>,         // JSON blob for sync metadata
    pub needs_review: Option<bool>,       // Flag for activities needing user review
    pub source_system: Option<String>,    // SNAPTRADE, PLAID, MANUAL, CSV
    pub source_record_id: Option<String>, // Provider's record ID
    pub source_group_id: Option<String>,  // Provider grouping key
    pub idempotency_key: Option<String>,  // Stable hash for dedupe
    pub import_run_id: Option<String>,    // Import batch identifier
}

impl NewActivity {
    pub fn canonicalize_subtype(subtype: Option<&str>) -> Option<String> {
        let subtype = subtype.map(str::trim).filter(|value| !value.is_empty())?;

        let canonical = if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DRIP) {
            ACTIVITY_SUBTYPE_DRIP
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND) {
            ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_STAKING_REWARD) {
            ACTIVITY_SUBTYPE_STAKING_REWARD
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_BONUS) {
            ACTIVITY_SUBTYPE_BONUS
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_REBATE) {
            ACTIVITY_SUBTYPE_REBATE
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_REFUND) {
            ACTIVITY_SUBTYPE_REFUND
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_REIMBURSEMENT) {
            ACTIVITY_SUBTYPE_REIMBURSEMENT
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_OPTION_EXPIRY) {
            ACTIVITY_SUBTYPE_OPTION_EXPIRY
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_POSITION_OPEN) {
            ACTIVITY_SUBTYPE_POSITION_OPEN
        } else if subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_POSITION_CLOSE) {
            ACTIVITY_SUBTYPE_POSITION_CLOSE
        } else {
            subtype
        };

        Some(canonical.to_string())
    }

    pub fn canonicalize_subtype_for_activity(
        activity_type: &str,
        subtype: Option<&str>,
    ) -> Option<String> {
        let subtype = subtype.map(str::trim).filter(|value| !value.is_empty())?;
        let normalized = subtype
            .chars()
            .map(|c| match c {
                ' ' | '-' => '_',
                _ => c.to_ascii_uppercase(),
            })
            .collect::<String>();

        let canonical = if activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_BUY) {
            match normalized.as_str() {
                "BTO" | "BUY_TO_OPEN" | "BUY_OPEN" | "OPEN_BUY" => {
                    Some(ACTIVITY_SUBTYPE_POSITION_OPEN)
                }
                "BTC" | "BUY_TO_CLOSE" | "BUY_CLOSE" | "CLOSE_BUY" | "BUY_TO_COVER"
                | "BUY_COVER" | "COVER_SHORT" => Some(ACTIVITY_SUBTYPE_POSITION_CLOSE),
                _ => None,
            }
        } else if activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_SELL) {
            match normalized.as_str() {
                "STO" | "SELL_TO_OPEN" | "SELL_OPEN" | "OPEN_SELL" | "SELL_SHORT"
                | "SHORT_SELL" | "SELL_SHORT_TO_OPEN" => Some(ACTIVITY_SUBTYPE_POSITION_OPEN),
                "STC" | "SELL_TO_CLOSE" | "SELL_CLOSE" | "CLOSE_SELL" => {
                    Some(ACTIVITY_SUBTYPE_POSITION_CLOSE)
                }
                _ => None,
            }
        } else {
            None
        };

        canonical
            .map(|value| value.to_string())
            .or_else(|| Self::canonicalize_subtype(Some(subtype)))
    }

    pub(crate) fn is_asset_backed_income_subtype(
        activity_type: &str,
        subtype: Option<&str>,
    ) -> bool {
        let Some(subtype) = subtype.map(str::trim).filter(|value| !value.is_empty()) else {
            return false;
        };

        (activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_DIVIDEND)
            && (subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DRIP)
                || subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND)))
            || (activity_type.eq_ignore_ascii_case(ACTIVITY_TYPE_INTEREST)
                && subtype.eq_ignore_ascii_case(ACTIVITY_SUBTYPE_STAKING_REWARD))
    }

    pub(crate) fn validate_asset_backed_income_values(
        activity_type: &str,
        subtype: Option<&str>,
        quantity: Option<Decimal>,
        unit_price: Option<Decimal>,
        amount: Option<Decimal>,
    ) -> std::result::Result<(), ActivityError> {
        if !Self::is_asset_backed_income_subtype(activity_type, subtype) {
            return Ok(());
        }

        match quantity {
            Some(quantity) if quantity.is_sign_positive() && !quantity.is_zero() => {}
            _ => {
                return Err(ActivityError::InvalidData(
                    "Asset-backed income activities require a positive quantity".to_string(),
                ));
            }
        }

        let has_positive_unit_price =
            unit_price.is_some_and(|value| value.is_sign_positive() && !value.is_zero());
        let has_positive_amount =
            amount.is_some_and(|value| value.is_sign_positive() && !value.is_zero());

        if !has_positive_unit_price && !has_positive_amount {
            return Err(ActivityError::InvalidData(
                "Asset-backed income activities require an amount or FMV per unit".to_string(),
            ));
        }

        if unit_price.is_some_and(|value| value.is_sign_negative()) {
            return Err(ActivityError::InvalidData(
                "FMV per unit cannot be negative".to_string(),
            ));
        }

        if amount.is_some_and(|value| value.is_sign_negative()) {
            return Err(ActivityError::InvalidData(
                "Income amount cannot be negative".to_string(),
            ));
        }

        Ok(())
    }

    /// Validates the new activity data
    pub fn validate(&self) -> std::result::Result<(), ActivityError> {
        if self.account_id.trim().is_empty() {
            return Err(crate::activities::ActivityError::InvalidData(
                "Account ID cannot be empty".to_string(),
            ));
        }
        if self.activity_type.trim().is_empty() {
            return Err(crate::activities::ActivityError::InvalidData(
                "Activity type cannot be empty".to_string(),
            ));
        }

        // Validate date format
        if DateTime::parse_from_rfc3339(&self.activity_date).is_err()
            && NaiveDate::parse_from_str(&self.activity_date, "%Y-%m-%d").is_err()
        {
            return Err(crate::activities::ActivityError::InvalidData(
                "Invalid date format. Expected ISO 8601/RFC3339 or YYYY-MM-DD".to_string(),
            ));
        }

        Self::validate_asset_backed_income_values(
            &self.activity_type,
            self.subtype.as_deref(),
            self.quantity,
            self.unit_price,
            self.amount,
        )?;

        Ok(())
    }

    // Helper methods to extract fields from nested asset resolution input.

    pub fn get_asset_resolution_id(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.id.as_deref())
    }

    pub fn get_asset_symbol(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.symbol.as_deref())
    }

    pub fn get_asset_exchange_mic(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.exchange_mic.as_deref())
    }

    pub fn get_symbol_id(&self) -> Option<&str> {
        self.get_asset_resolution_id()
    }

    pub fn get_symbol_code(&self) -> Option<&str> {
        self.get_asset_symbol()
    }

    pub fn get_exchange_mic(&self) -> Option<&str> {
        self.get_asset_exchange_mic()
    }

    pub fn get_kind(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.kind.as_deref())
    }

    pub fn get_name(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.name.as_deref())
    }

    pub fn get_quote_mode(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.quote_mode.as_deref())
    }

    pub fn get_quote_ccy(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.quote_ccy.as_deref())
    }

    pub fn get_instrument_type(&self) -> Option<&str> {
        self.asset
            .as_ref()
            .and_then(|a| a.instrument_type.as_deref())
    }
}

/// Input model for updating an existing activity
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpdate {
    pub id: String,
    pub account_id: String,

    /// Asset resolution input. Accepts the old `symbol` JSON field during transition.
    /// Optional for cash activities which don't require an asset
    #[serde(alias = "symbol")]
    pub asset: Option<AssetResolutionInput>,

    pub activity_type: String,
    #[serde(
        default,
        deserialize_with = "subtype_patch_format::deserialize_patch_subtype"
    )]
    pub subtype: Option<String>, // Semantic variation (DRIP, STAKING_REWARD, etc.)
    pub activity_date: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub quantity: Option<Option<Decimal>>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub unit_price: Option<Option<Decimal>>,
    pub currency: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub fee: Option<Option<Decimal>>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub tax: Option<Option<Decimal>>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub amount: Option<Option<Decimal>>,
    pub status: Option<ActivityStatus>,
    #[serde(alias = "comment")]
    pub notes: Option<String>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_patch_decimal"
    )]
    pub fx_rate: Option<Option<Decimal>>,
    pub metadata: Option<String>, // JSON blob for metadata (e.g., flow.is_external)
}

impl ActivityUpdate {
    /// Validates the activity update data
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(crate::activities::ActivityError::InvalidData(
                "Activity ID is required for updates".to_string(),
            )
            .into());
        }
        if self.account_id.trim().is_empty() {
            return Err(crate::activities::ActivityError::InvalidData(
                "Account ID cannot be empty".to_string(),
            )
            .into());
        }
        if self.activity_type.trim().is_empty() {
            return Err(crate::activities::ActivityError::InvalidData(
                "Activity type cannot be empty".to_string(),
            )
            .into());
        }
        Ok(())
    }

    // Helper methods to extract fields from nested asset resolution input.

    pub fn get_asset_resolution_id(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.id.as_deref())
    }

    pub fn get_asset_symbol(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.symbol.as_deref())
    }

    pub fn get_asset_exchange_mic(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.exchange_mic.as_deref())
    }

    pub fn get_symbol_id(&self) -> Option<&str> {
        self.get_asset_resolution_id()
    }

    pub fn get_symbol_code(&self) -> Option<&str> {
        self.get_asset_symbol()
    }

    pub fn get_exchange_mic(&self) -> Option<&str> {
        self.get_asset_exchange_mic()
    }

    pub fn get_kind(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.kind.as_deref())
    }

    pub fn get_name(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.name.as_deref())
    }

    pub fn get_quote_mode(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.quote_mode.as_deref())
    }

    pub fn get_quote_ccy(&self) -> Option<&str> {
        self.asset.as_ref().and_then(|a| a.quote_ccy.as_deref())
    }

    pub fn get_instrument_type(&self) -> Option<&str> {
        self.asset
            .as_ref()
            .and_then(|a| a.instrument_type.as_deref())
    }
}

/// Request payload grouping multiple activity mutations.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBulkMutationRequest {
    #[serde(default)]
    pub creates: Vec<NewActivity>,
    #[serde(default)]
    pub updates: Vec<ActivityUpdate>,
    #[serde(default)]
    pub delete_ids: Vec<String>,
}

/// Summary of the results for a bulk mutation request.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBulkMutationResult {
    pub created: Vec<Activity>,
    pub updated: Vec<Activity>,
    pub deleted: Vec<Activity>,
    #[serde(default)]
    pub created_mappings: Vec<ActivityBulkIdentifierMapping>,
    #[serde(default)]
    pub errors: Vec<ActivityBulkMutationError>,
}

/// Pair-aware request for creating or updating an internal cash transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalTransferPairRequest {
    #[serde(default)]
    pub transfer_out_id: Option<String>,
    #[serde(default)]
    pub transfer_in_id: Option<String>,
    #[serde(default)]
    pub source_group_id: Option<String>,
    pub from_account_id: String,
    pub to_account_id: String,
    pub activity_date: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub source_amount: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub destination_amount: Option<Decimal>,
    pub source_currency: String,
    pub destination_currency: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub fx_rate: Option<Decimal>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub transfer_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalTransferPairResponse {
    pub transfer_out: Activity,
    pub transfer_in: Activity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferMatchCandidateRequest {
    pub activity_id: String,
    #[serde(default)]
    pub window_days: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferMatchCandidate {
    pub activity: Activity,
    pub match_kind: String,
    pub confidence: String,
    pub score: i32,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
}

/// Structured error reported for a single bulk mutation entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBulkMutationError {
    pub id: Option<String>,
    pub action: String,
    pub message: String,
}

/// Maps a temporary client identifier to the persisted activity identifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBulkIdentifierMapping {
    pub temp_id: Option<String>,
    pub activity_id: String,
}

/// Model for activity details including related data
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDetails {
    pub id: String,
    pub account_id: String,
    pub asset_id: String,
    pub activity_type: String,
    pub subtype: Option<String>,
    pub status: ActivityStatus,
    pub date: String,
    pub quantity: Option<String>,
    pub unit_price: Option<String>,
    pub currency: String,
    pub fee: Option<String>,
    pub tax: Option<String>,
    pub amount: Option<String>,
    pub needs_review: bool,
    pub comment: Option<String>,
    pub fx_rate: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub account_name: String,
    pub account_currency: String,
    pub asset_symbol: String,
    pub asset_name: Option<String>,
    pub exchange_mic: Option<String>,
    pub asset_pricing_mode: String, // MARKET, MANUAL, DERIVED, NONE
    pub instrument_type: Option<String>,
    // Sync/source metadata
    pub source_system: Option<String>,
    pub source_record_id: Option<String>,
    pub source_group_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub import_run_id: Option<String>,
    pub is_user_modified: bool,
    pub metadata: Option<Value>,
}

impl ActivityDetails {
    pub fn get_quantity(&self) -> Decimal {
        self.quantity
            .as_ref()
            .map(|s| parse_decimal_string_tolerant(s, "quantity"))
            .unwrap_or(Decimal::ZERO)
    }

    pub fn get_unit_price(&self) -> Decimal {
        self.unit_price
            .as_ref()
            .map(|s| parse_decimal_string_tolerant(s, "unit_price"))
            .unwrap_or(Decimal::ZERO)
    }

    pub fn get_fee(&self) -> Decimal {
        self.fee
            .as_ref()
            .map(|s| parse_decimal_string_tolerant(s, "fee"))
            .unwrap_or(Decimal::ZERO)
    }

    pub fn get_tax(&self) -> Decimal {
        self.tax
            .as_ref()
            .map(|s| parse_decimal_string_tolerant(s, "tax"))
            .unwrap_or(Decimal::ZERO)
    }

    pub fn get_amount(&self) -> Option<Decimal> {
        self.amount
            .as_ref()
            .map(|s| parse_decimal_string_tolerant(s, "amount"))
    }

    // Helper to parse the date string
    pub fn get_date(&self) -> std::result::Result<DateTime<Utc>, chrono::ParseError> {
        DateTime::parse_from_rfc3339(&self.date).map(|dt| dt.with_timezone(&Utc))
    }

    // Helper to parse the created_at string
    pub fn get_created_at(&self) -> std::result::Result<DateTime<Utc>, chrono::ParseError> {
        DateTime::parse_from_rfc3339(&self.created_at).map(|dt| dt.with_timezone(&Utc))
    }

    // Helper to parse the updated_at string
    pub fn get_updated_at(&self) -> std::result::Result<DateTime<Utc>, chrono::ParseError> {
        DateTime::parse_from_rfc3339(&self.updated_at).map(|dt| dt.with_timezone(&Utc))
    }
}

/// Model for activity search response metadata
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySearchResponseMeta {
    pub total_row_count: i64,
}

/// Model for activity search response
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySearchResponse {
    pub data: Vec<ActivityDetails>,
    pub meta: ActivitySearchResponseMeta,
}

/// Model for importing activities
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityImport {
    pub id: Option<String>,
    pub date: String,
    pub symbol: String,
    pub activity_type: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub quantity: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub unit_price: Option<Decimal>,
    pub currency: String,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub fee: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub tax: Option<Decimal>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub amount: Option<Decimal>,
    pub comment: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub symbol_name: Option<String>,
    /// Resolved exchange MIC for the symbol (populated during validation)
    pub exchange_mic: Option<String>,
    /// Optional quote currency for the resolved symbol (e.g., "GBp")
    pub quote_ccy: Option<String>,
    /// Optional resolved instrument type (e.g., "EQUITY", "CRYPTO")
    pub instrument_type: Option<String>,
    /// Optional quote mode (e.g., "MANUAL", "MARKET")
    pub quote_mode: Option<String>,
    /// Market data provider that resolved this import row, if selected.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Provider-native symbol/code selected by search/import.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_symbol: Option<String>,
    pub errors: Option<std::collections::HashMap<String, Vec<String>>>,
    pub warnings: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of_id: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of_line_number: Option<i32>,
    pub is_draft: bool,
    pub is_valid: bool,
    pub line_number: Option<i32>,
    #[serde(
        default,
        deserialize_with = "decimal_input_format::deserialize_option_decimal"
    )]
    pub fx_rate: Option<Decimal>,
    pub subtype: Option<String>,
    /// Resolved asset UUID, populated during validation when the asset already exists in the DB.
    /// Used to align the review-step idempotency key with the apply-step key (which uses UUIDs).
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// ISIN identifier from the CSV (e.g. GB0007188757). Used for unambiguous exchange resolution.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isin: Option<String>,
    /// When true, bypasses duplicate detection for this row and inserts it regardless of whether
    /// a matching activity already exists. The idempotency key is cleared before insert so the
    /// DB unique constraint is not violated. Set by the user in the review step.
    #[serde(default)]
    pub force_import: bool,
    /// True when a TRANSFER_IN/OUT crosses the tracked-account boundary (e.g. RSU grant deposit).
    /// Persisted as `metadata.flow.is_external` so net-contribution and flow classification work.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_external: Option<bool>,
}

/// Model for sorting activities
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub id: String,
    pub desc: bool,
}

/// Domain model for activity import profile mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMapping {
    pub account_id: String,
    /// context_kind value (CSV_ACTIVITY, CSV_HOLDINGS, BROKER_ACTIVITY)
    pub context_kind: String,
    pub source_system: String,
    pub template_id: Option<String>,
    pub name: String,
    /// JSON config blob
    pub config: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// Rich metadata for a resolved symbol mapping (exchange MIC, display name, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMappingMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_ccy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrument_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_mode: Option<QuoteMode>,
}

fn default_csv_activity_context_kind() -> String {
    import_type::ACTIVITY.to_string()
}

/// Model for activity import mapping data with structured mappings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMappingData {
    pub account_id: String,
    /// context_kind value — defaults to CSV_ACTIVITY for backward compat
    #[serde(default = "default_csv_activity_context_kind", alias = "importType")]
    pub context_kind: String,
    #[serde(default)]
    pub name: String,
    /// The ID of the template this mapping is linked to (if any)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default)]
    pub field_mappings: std::collections::HashMap<String, FieldMappingValue>,
    #[serde(default)]
    pub activity_mappings: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub symbol_mappings: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub account_mappings: std::collections::HashMap<String, String>,
    /// Rich metadata for resolved symbol mappings (exchange MIC, display name)
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub symbol_mapping_meta: std::collections::HashMap<String, SymbolMappingMeta>,
    /// CSV parsing configuration (delimiter, date format, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_config: Option<ParseConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ImportTemplateScope {
    System,
    #[default]
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTemplate {
    pub id: String,
    pub name: String,
    pub scope: ImportTemplateScope,
    pub kind: TemplateKind,
    #[serde(default)]
    pub source_system: String,
    #[serde(default = "default_config_version")]
    pub config_version: i32,
    /// JSON config blob — shape depends on `kind`
    pub config: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

fn default_config_version() -> i32 {
    1
}

/// A field mapping value: either a single column name or an ordered list of
/// fallback columns (first non-empty value per row wins).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum FieldMappingValue {
    Single(String),
    Fallback(Vec<String>),
}

impl From<String> for FieldMappingValue {
    fn from(s: String) -> Self {
        FieldMappingValue::Single(s)
    }
}

/// Convert a simple String-keyed map into a FieldMappingValue-keyed map.
pub fn into_field_mapping_values(
    map: std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, FieldMappingValue> {
    map.into_iter()
        .map(|(k, v)| (k, FieldMappingValue::Single(v)))
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTemplateData {
    pub id: String,
    pub name: String,
    pub scope: ImportTemplateScope,
    #[serde(default = "default_csv_activity_kind")]
    pub kind: TemplateKind,
    #[serde(default)]
    pub field_mappings: std::collections::HashMap<String, FieldMappingValue>,
    #[serde(default)]
    pub activity_mappings: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub symbol_mappings: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub account_mappings: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub symbol_mapping_meta: std::collections::HashMap<String, SymbolMappingMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_config: Option<ParseConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetCandidate {
    pub key: String,
    pub account_id: String,
    pub symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instrument_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_ccy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_mic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ImportAssetPreviewStatus {
    ExistingAsset,
    AutoResolvedNewAsset,
    NeedsFixing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetPreviewItem {
    pub key: String,
    pub status: ImportAssetPreviewStatus,
    pub resolution_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<NewAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<std::collections::HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<std::collections::HashMap<String, Vec<String>>>,
}

/// Internal config structure for JSON serialization
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportMappingConfig {
    #[serde(default)]
    pub field_mappings: std::collections::HashMap<String, FieldMappingValue>,
    #[serde(default)]
    pub activity_mappings: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub symbol_mappings: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub account_mappings: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub symbol_mapping_meta: std::collections::HashMap<String, SymbolMappingMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_config: Option<ParseConfig>,
}

/// Config for broker activity profiles — only reusable normalization rules.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrokerActivityProfileConfig {
    #[serde(default)]
    pub activity_mappings: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub symbol_mappings: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub symbol_mapping_meta: std::collections::HashMap<String, SymbolMappingMeta>,
}

/// Frontend/backend DTO for broker sync profiles (separate from CSV ImportTemplateData).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrokerSyncProfileData {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub scope: ImportTemplateScope,
    #[serde(default)]
    pub source_system: String,
    #[serde(default)]
    pub activity_mappings: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub symbol_mappings: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub symbol_mapping_meta: std::collections::HashMap<String, SymbolMappingMeta>,
}

/// Scope for saving broker sync profile rules.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerProfileScope {
    Account,
    Broker,
}

/// Request to save broker sync profile rules.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBrokerSyncProfileRulesRequest {
    pub account_id: String,
    pub source_system: String,
    pub scope: BrokerProfileScope,
    #[serde(default)]
    pub activity_rule_patches: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub security_rule_patches: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub security_rule_meta_patches: std::collections::HashMap<String, SymbolMappingMeta>,
}

impl Default for ImportMappingData {
    fn default() -> Self {
        let mut field_mappings = std::collections::HashMap::new();
        field_mappings.insert(
            "date".to_string(),
            FieldMappingValue::Single("date".to_string()),
        );
        field_mappings.insert(
            "symbol".to_string(),
            FieldMappingValue::Single("symbol".to_string()),
        );
        field_mappings.insert(
            "quantity".to_string(),
            FieldMappingValue::Single("quantity".to_string()),
        );
        field_mappings.insert(
            "activityType".to_string(),
            FieldMappingValue::Single("activityType".to_string()),
        );
        field_mappings.insert(
            "unitPrice".to_string(),
            FieldMappingValue::Single("unitPrice".to_string()),
        );
        field_mappings.insert(
            "amount".to_string(),
            FieldMappingValue::Single("amount".to_string()),
        );
        field_mappings.insert(
            "comment".to_string(),
            FieldMappingValue::Single("comment".to_string()),
        );
        field_mappings.insert(
            "currency".to_string(),
            FieldMappingValue::Single("currency".to_string()),
        );
        field_mappings.insert(
            "fee".to_string(),
            FieldMappingValue::Single("fee".to_string()),
        );
        field_mappings.insert(
            "account".to_string(),
            FieldMappingValue::Single("account".to_string()),
        );

        let mut activity_mappings = std::collections::HashMap::new();
        for activity_type in [
            ACTIVITY_TYPE_BUY,
            ACTIVITY_TYPE_SELL,
            ACTIVITY_TYPE_DIVIDEND,
            ACTIVITY_TYPE_INTEREST,
            ACTIVITY_TYPE_DEPOSIT,
            ACTIVITY_TYPE_WITHDRAWAL,
            ACTIVITY_TYPE_TRANSFER_IN,
            ACTIVITY_TYPE_TRANSFER_OUT,
            ACTIVITY_TYPE_SPLIT,
            ACTIVITY_TYPE_FEE,
            ACTIVITY_TYPE_TAX,
            ACTIVITY_TYPE_CREDIT,
            ACTIVITY_TYPE_ADJUSTMENT,
        ] {
            activity_mappings.insert(activity_type.to_string(), vec![activity_type.to_string()]);
        }

        ImportMappingData {
            account_id: String::new(),
            context_kind: import_type::ACTIVITY.to_string(),
            template_id: None,
            name: String::new(),
            field_mappings,
            activity_mappings,
            symbol_mappings: std::collections::HashMap::new(),
            account_mappings: std::collections::HashMap::new(),
            symbol_mapping_meta: std::collections::HashMap::new(),
            parse_config: None,
        }
    }
}

impl Default for ImportTemplateData {
    fn default() -> Self {
        let mapping = ImportMappingData::default();

        Self {
            id: String::new(),
            name: String::new(),
            scope: ImportTemplateScope::User,
            kind: TemplateKind::CsvActivity,
            field_mappings: mapping.field_mappings,
            activity_mappings: mapping.activity_mappings,
            symbol_mappings: mapping.symbol_mappings,
            account_mappings: mapping.account_mappings,
            symbol_mapping_meta: mapping.symbol_mapping_meta,
            parse_config: mapping.parse_config,
        }
    }
}

impl ImportMapping {
    pub fn to_mapping_data(&self) -> std::result::Result<ImportMappingData, serde_json::Error> {
        // Parse the config JSON blob
        let config: ImportMappingConfig = serde_json::from_str(&self.config)?;

        Ok(ImportMappingData {
            account_id: self.account_id.clone(),
            context_kind: self.context_kind.clone(),
            template_id: self.template_id.clone(),
            name: self.name.clone(),
            field_mappings: config.field_mappings,
            activity_mappings: config.activity_mappings,
            symbol_mappings: config.symbol_mappings,
            account_mappings: config.account_mappings,
            symbol_mapping_meta: config.symbol_mapping_meta,
            parse_config: config.parse_config,
        })
    }

    pub fn from_mapping_data(
        data: &ImportMappingData,
    ) -> std::result::Result<Self, serde_json::Error> {
        // Create the config object
        let config = ImportMappingConfig {
            field_mappings: data.field_mappings.clone(),
            activity_mappings: data.activity_mappings.clone(),
            symbol_mappings: data.symbol_mappings.clone(),
            account_mappings: data.account_mappings.clone(),
            symbol_mapping_meta: data.symbol_mapping_meta.clone(),
            parse_config: data.parse_config.clone(),
        };

        Ok(Self {
            account_id: data.account_id.clone(),
            context_kind: data.context_kind.clone(),
            source_system: String::new(),
            template_id: data.template_id.clone(),
            name: data.name.clone(),
            config: serde_json::to_string(&config)?,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        })
    }
}

impl ImportTemplate {
    pub fn to_template_data(&self) -> std::result::Result<ImportTemplateData, serde_json::Error> {
        let config: ImportMappingConfig = serde_json::from_str(&self.config)?;

        Ok(ImportTemplateData {
            id: self.id.clone(),
            name: self.name.clone(),
            scope: self.scope.clone(),
            kind: self.kind.clone(),
            field_mappings: config.field_mappings,
            activity_mappings: config.activity_mappings,
            symbol_mappings: config.symbol_mappings,
            account_mappings: config.account_mappings,
            symbol_mapping_meta: config.symbol_mapping_meta,
            parse_config: config.parse_config,
        })
    }

    pub fn to_broker_profile_data(
        &self,
    ) -> std::result::Result<BrokerSyncProfileData, serde_json::Error> {
        let config: BrokerActivityProfileConfig = serde_json::from_str(&self.config)?;

        Ok(BrokerSyncProfileData {
            id: self.id.clone(),
            name: self.name.clone(),
            scope: self.scope.clone(),
            source_system: self.source_system.clone(),
            activity_mappings: config.activity_mappings,
            symbol_mappings: config.symbol_mappings,
            symbol_mapping_meta: config.symbol_mapping_meta,
        })
    }

    pub fn from_template_data(
        data: &ImportTemplateData,
    ) -> std::result::Result<Self, serde_json::Error> {
        let config = ImportMappingConfig {
            field_mappings: data.field_mappings.clone(),
            activity_mappings: data.activity_mappings.clone(),
            symbol_mappings: data.symbol_mappings.clone(),
            account_mappings: data.account_mappings.clone(),
            symbol_mapping_meta: data.symbol_mapping_meta.clone(),
            parse_config: data.parse_config.clone(),
        };

        Ok(Self {
            id: data.id.clone(),
            name: data.name.clone(),
            scope: data.scope.clone(),
            kind: data.kind.clone(),
            source_system: String::new(),
            config_version: 1,
            config: serde_json::to_string(&config)?,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        })
    }

    pub fn from_broker_profile_data(
        data: &BrokerSyncProfileData,
    ) -> std::result::Result<Self, serde_json::Error> {
        let config = BrokerActivityProfileConfig {
            activity_mappings: data.activity_mappings.clone(),
            symbol_mappings: data.symbol_mappings.clone(),
            symbol_mapping_meta: data.symbol_mapping_meta.clone(),
        };

        Ok(Self {
            id: data.id.clone(),
            name: data.name.clone(),
            scope: data.scope.clone(),
            kind: TemplateKind::BrokerActivity,
            source_system: data.source_system.clone(),
            config_version: 1,
            config: serde_json::to_string(&config)?,
            created_at: chrono::Utc::now().naive_utc(),
            updated_at: chrono::Utc::now().naive_utc(),
        })
    }
}

/// Enum representing different types of activities
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ActivityType {
    Buy,
    Sell,
    Dividend,
    Interest,
    Deposit,
    Withdrawal,
    TransferIn,
    TransferOut,
    Fee,
    Tax,
    Split,
    Credit,     // Cash-only credit: refunds, rebates, bonuses
    Adjustment, // Non-trade correction / transformation (usually no cash)
    Unknown,    // Unmapped/unknown activity types
}

impl ActivityType {
    pub fn as_str(&self) -> &'static str {
        use crate::activities::activities_constants::*;
        match self {
            ActivityType::Buy => ACTIVITY_TYPE_BUY,
            ActivityType::Sell => ACTIVITY_TYPE_SELL,
            ActivityType::Dividend => ACTIVITY_TYPE_DIVIDEND,
            ActivityType::Interest => ACTIVITY_TYPE_INTEREST,
            ActivityType::Deposit => ACTIVITY_TYPE_DEPOSIT,
            ActivityType::Withdrawal => ACTIVITY_TYPE_WITHDRAWAL,
            ActivityType::TransferIn => ACTIVITY_TYPE_TRANSFER_IN,
            ActivityType::TransferOut => ACTIVITY_TYPE_TRANSFER_OUT,
            ActivityType::Fee => ACTIVITY_TYPE_FEE,
            ActivityType::Tax => ACTIVITY_TYPE_TAX,
            ActivityType::Split => ACTIVITY_TYPE_SPLIT,
            ActivityType::Credit => ACTIVITY_TYPE_CREDIT,
            ActivityType::Adjustment => ACTIVITY_TYPE_ADJUSTMENT,
            ActivityType::Unknown => ACTIVITY_TYPE_UNKNOWN,
        }
    }
}

impl FromStr for ActivityType {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        use crate::activities::activities_constants::*;
        match s {
            s if s == ACTIVITY_TYPE_BUY => Ok(ActivityType::Buy),
            s if s == ACTIVITY_TYPE_SELL => Ok(ActivityType::Sell),
            s if s == ACTIVITY_TYPE_DIVIDEND => Ok(ActivityType::Dividend),
            s if s == ACTIVITY_TYPE_INTEREST => Ok(ActivityType::Interest),
            s if s == ACTIVITY_TYPE_DEPOSIT => Ok(ActivityType::Deposit),
            s if s == ACTIVITY_TYPE_WITHDRAWAL => Ok(ActivityType::Withdrawal),
            s if s == ACTIVITY_TYPE_TRANSFER_IN => Ok(ActivityType::TransferIn),
            s if s == ACTIVITY_TYPE_TRANSFER_OUT => Ok(ActivityType::TransferOut),
            s if s == ACTIVITY_TYPE_FEE => Ok(ActivityType::Fee),
            s if s == ACTIVITY_TYPE_TAX => Ok(ActivityType::Tax),
            s if s == ACTIVITY_TYPE_SPLIT => Ok(ActivityType::Split),
            s if s == ACTIVITY_TYPE_CREDIT => Ok(ActivityType::Credit),
            s if s == ACTIVITY_TYPE_ADJUSTMENT => Ok(ActivityType::Adjustment),
            s if s == ACTIVITY_TYPE_UNKNOWN => Ok(ActivityType::Unknown),
            _ => Err(format!("Unknown activity type: {}", s)),
        }
    }
}

// Custom serialization for timestamps to ensure consistent ISO 8601 formatting
mod timestamp_format {
    use chrono::{DateTime, NaiveDate, TimeZone, Utc};
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(date: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Always serialize in ISO 8601 format with UTC timezone
        serializer.serialize_str(&date.to_rfc3339())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DateTime<Utc>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;

        // First try parsing as RFC3339/ISO8601
        if let Ok(dt) = DateTime::parse_from_rfc3339(&s) {
            return Ok(dt.with_timezone(&Utc));
        }

        // Then try as date-only format
        if let Ok(date) = NaiveDate::parse_from_str(&s, "%Y-%m-%d") {
            // Use midnight UTC for date-only values
            return Ok(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap_or_default()));
        }

        Err(serde::de::Error::custom(format!(
            "Invalid timestamp format: {}. Expected ISO 8601/RFC3339 or YYYY-MM-DD",
            s
        )))
    }
}

// Custom deserialization for Decimal inputs to support strings, numbers, nulls, and scientific notation
mod decimal_input_format {
    use rust_decimal::Decimal;
    use serde::{self, Deserialize, Deserializer};
    use serde_json::Number;
    use std::str::FromStr;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum DecimalInput {
        String(String),
        Number(Number),
        Null,
    }

    fn parse_decimal_value(value: &str) -> Result<Decimal, String> {
        let trimmed = value.trim();
        Decimal::from_str(trimmed)
            .or_else(|_| Decimal::from_scientific(trimmed))
            .map_err(|e| format!("Invalid decimal value '{}': {}", value, e))
    }

    pub fn deserialize_option_decimal<'de, D>(deserializer: D) -> Result<Option<Decimal>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Option::<DecimalInput>::deserialize(deserializer)?;
        match raw {
            None | Some(DecimalInput::Null) => Ok(None),
            Some(DecimalInput::String(s)) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                parse_decimal_value(trimmed)
                    .map(Some)
                    .map_err(serde::de::Error::custom)
            }
            Some(DecimalInput::Number(n)) => parse_decimal_value(&n.to_string())
                .map(Some)
                .map_err(serde::de::Error::custom),
        }
    }

    pub fn deserialize_patch_decimal<'de, D>(
        deserializer: D,
    ) -> Result<Option<Option<Decimal>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = serde_json::Value::deserialize(deserializer)?;
        match raw {
            serde_json::Value::Null => Ok(Some(None)),
            serde_json::Value::String(s) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    return Ok(Some(None));
                }
                parse_decimal_value(trimmed)
                    .map(|value| Some(Some(value)))
                    .map_err(serde::de::Error::custom)
            }
            serde_json::Value::Number(n) => parse_decimal_value(&n.to_string())
                .map(|value| Some(Some(value)))
                .map_err(serde::de::Error::custom),
            _ => Err(serde::de::Error::custom("Invalid decimal value type")),
        }
    }
}

mod subtype_patch_format {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize_patch_subtype<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(Some(
            Option::<String>::deserialize(deserializer)?.unwrap_or_default(),
        ))
    }
}

// Custom serialization for optional Decimal fields to handle string representation
mod optional_decimal_format {
    use rust_decimal::Decimal;
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::str::FromStr;

    pub fn serialize<S>(value: &Option<Decimal>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(d) => serializer.serialize_str(&d.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Decimal>, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Use an untagged enum to handle both string and number representations
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum DecimalOrString {
            Decimal(Decimal),
            String(String),
            Null,
        }

        match Option::<DecimalOrString>::deserialize(deserializer)? {
            Some(DecimalOrString::Decimal(d)) => Ok(Some(d)),
            Some(DecimalOrString::String(s)) if s.is_empty() => Ok(None),
            Some(DecimalOrString::String(s)) => {
                let trimmed = s.trim();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                Decimal::from_str(trimmed)
                    .or_else(|_| Decimal::from_scientific(trimmed))
                    .map(Some)
                    .map_err(serde::de::Error::custom)
            }
            Some(DecimalOrString::Null) | None => Ok(None),
        }
    }
}

/// Model for income data from activities
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeData {
    pub date: String,
    pub income_type: String,
    pub asset_id: String,
    pub asset_kind: String,
    pub symbol: String,
    pub symbol_name: String,
    pub currency: String,
    pub amount: Decimal,
    pub account_id: String,
    pub account_name: String,
}

/// Result of importing activities, includes import run metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportActivitiesResult {
    /// The validated/imported activities
    pub activities: Vec<ActivityImport>,
    /// Import run ID for tracking this batch
    pub import_run_id: String,
    /// Summary statistics for the import
    pub summary: ImportActivitiesSummary,
}

/// Summary statistics for an activity import
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportActivitiesSummary {
    /// Total number of activities in the import request
    pub total: u32,
    /// Number of activities successfully imported
    pub imported: u32,
    /// Number of activities skipped (invalid or errors)
    pub skipped: u32,
    /// Number of duplicate activities detected and skipped
    pub duplicates: u32,
    /// Number of new assets created during import
    pub assets_created: u32,
    /// Whether the import was successful (no validation errors)
    pub success: bool,
    /// Human-readable reason for failure, if success is false
    pub error_message: Option<String>,
}

/// Input model for upserting activities (insert or update on conflict).
/// Used by broker sync to efficiently sync activities with idempotency support.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityUpsert {
    /// Provider activity ID (used as primary key for upsert)
    pub id: String,
    pub account_id: String,
    pub asset_id: Option<String>,
    pub activity_type: String,
    pub subtype: Option<String>,
    pub activity_date: String,
    pub quantity: Option<Decimal>,
    pub unit_price: Option<Decimal>,
    pub currency: String,
    pub fee: Option<Decimal>,
    pub tax: Option<Decimal>,
    pub amount: Option<Decimal>,
    pub status: Option<ActivityStatus>,
    pub notes: Option<String>,
    pub fx_rate: Option<Decimal>,
    pub metadata: Option<String>,
    pub needs_review: Option<bool>,
    pub source_system: Option<String>,
    pub source_record_id: Option<String>,
    pub source_group_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub import_run_id: Option<String>,
}

/// Result of a bulk upsert operation
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkUpsertResult {
    /// Total number of activities processed
    pub upserted: usize,
    /// Number of activities that were newly created
    pub created: usize,
    /// Number of activities that were updated
    pub updated: usize,
    /// Number of activities skipped (e.g., user-modified)
    pub skipped: usize,
    /// Asset ids of pre-existing SPLIT rows that were overwritten, so callers can
    /// emit asset-level split events even when the incoming row is no longer a SPLIT
    #[serde(skip)]
    pub updated_split_asset_ids: Vec<String>,
}

/// Activity ready for persistence
#[derive(Debug, Clone)]
pub struct PreparedActivity {
    pub activity: NewActivity,
    pub resolved_asset_id: Option<String>,
    pub fx_pair: Option<(String, String)>, // (from_currency, to_currency)
}

/// Result of prepare_activities
#[derive(Debug, Default)]
pub struct PrepareActivitiesResult {
    pub prepared: Vec<PreparedActivity>,
    pub errors: Vec<(usize, String)>, // (index, error_message)
    pub assets_created: u32,
    pub created_asset_ids: Vec<String>,
}

impl From<ActivityImport> for NewActivity {
    fn from(import: ActivityImport) -> Self {
        let asset = if import.symbol.is_empty() {
            import
                .asset_id
                .as_ref()
                .map(|asset_id| AssetResolutionInput {
                    id: Some(asset_id.clone()),
                    symbol: None,
                    exchange_mic: None,
                    kind: None,
                    name: import.symbol_name.clone(),
                    quote_mode: import.quote_mode.clone(),
                    quote_ccy: import.quote_ccy.clone(),
                    instrument_type: import.instrument_type.clone(),
                    provider_id: import.provider_id.clone(),
                    provider_symbol: import.provider_symbol.clone(),
                })
        } else {
            Some(AssetResolutionInput {
                id: import.asset_id.clone(),
                symbol: Some(import.symbol),
                exchange_mic: import.exchange_mic,
                kind: None,
                name: import.symbol_name,
                quote_mode: import.quote_mode.clone(),
                quote_ccy: import.quote_ccy,
                instrument_type: import.instrument_type,
                provider_id: import.provider_id,
                provider_symbol: import.provider_symbol,
            })
        };

        let status = if import.is_draft {
            Some(ActivityStatus::Draft)
        } else {
            Some(ActivityStatus::Posted)
        };

        // Persist `is_external` as flow metadata so net_contribution and flow classification
        // see this transfer the same way the manual activity form would.
        let is_transfer = import.activity_type == ACTIVITY_TYPE_TRANSFER_IN
            || import.activity_type == ACTIVITY_TYPE_TRANSFER_OUT;
        let metadata = if is_transfer && import.is_external == Some(true) {
            Some(serde_json::json!({ "flow": { "is_external": true } }).to_string())
        } else {
            None
        };

        NewActivity {
            id: import.id,
            account_id: import.account_id.unwrap_or_default(),
            asset,
            activity_type: import.activity_type,
            subtype: import.subtype,
            activity_date: import.date,
            quantity: import.quantity,
            unit_price: import.unit_price,
            currency: import.currency,
            fee: import.fee,
            tax: import.tax,
            amount: import.amount,
            status,
            notes: import.comment,
            fx_rate: import.fx_rate,
            metadata,
            needs_review: None,
            source_system: Some("CSV".to_string()),
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
        }
    }
}
