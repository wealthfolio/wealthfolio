//! Quote import models and services.
//!
//! This module provides functionality for importing quotes from external sources,
//! including CSV parsing, validation, and conversion to the internal Quote format.
//!
//! # Architecture
//!
//! The import system has two main components:
//!
//! 1. **Validation Types** - `QuoteImport`, `ImportValidation`, `ImportValidationStatus`
//! 2. **Import Service** - `QuoteImportService` for validating and saving manual quotes
//!
//! # Key Invariants
//!
//! - All imported quotes get `QuoteSource::Manual`
//! - Manual quotes are never overwritten by provider sync
//! - Quote IDs are deterministic: `{asset_id}_{YYYY-MM-DD}_MANUAL`

use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::constants::DATA_SOURCE_MANUAL;
use super::model::Quote;
use super::store::QuoteStore;
use super::types::{quote_id, AssetId, Currency, Day, QuoteSource};
use crate::errors::{Result, ValidationError};

// =============================================================================
// Validation Status (Original - for backward compatibility)
// =============================================================================

/// Validation status for an imported quote.
///
/// This is the original enum used by the legacy import code.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ImportValidationStatus {
    /// Quote passed all validation checks.
    #[default]
    Valid,
    /// Quote has minor issues but can still be imported.
    Warning(String),
    /// Quote has critical errors and cannot be imported.
    Error(String),
}

impl ImportValidationStatus {
    /// Returns true if the status indicates the quote can be imported.
    pub fn is_importable(&self) -> bool {
        matches!(
            self,
            ImportValidationStatus::Valid | ImportValidationStatus::Warning(_)
        )
    }

    /// Returns true if the status is valid (no warnings or errors).
    pub fn is_valid(&self) -> bool {
        matches!(self, ImportValidationStatus::Valid)
    }

    /// Returns the error or warning message, if any.
    pub fn message(&self) -> Option<&str> {
        match self {
            ImportValidationStatus::Valid => None,
            ImportValidationStatus::Warning(msg) | ImportValidationStatus::Error(msg) => Some(msg),
        }
    }
}

// =============================================================================
// Validation Status (New - for QuoteImportService)
// =============================================================================

/// Validation status for a quote import row (used by QuoteImportService).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum ValidationStatus {
    /// Quote passed all validation checks and can be imported.
    #[default]
    Valid,
    /// Quote is a duplicate of an existing quote.
    Duplicate,
    /// Quote has critical errors and cannot be imported.
    Invalid(String),
}

impl ValidationStatus {
    /// Returns true if the status indicates the quote can be imported.
    pub fn is_importable(&self) -> bool {
        matches!(self, ValidationStatus::Valid)
    }

    /// Returns true if the status is a duplicate.
    pub fn is_duplicate(&self) -> bool {
        matches!(self, ValidationStatus::Duplicate)
    }

    /// Returns true if the status is invalid (has errors).
    pub fn is_invalid(&self) -> bool {
        matches!(self, ValidationStatus::Invalid(_))
    }

    /// Returns the error message, if any.
    pub fn message(&self) -> Option<&str> {
        match self {
            ValidationStatus::Invalid(msg) => Some(msg),
            ValidationStatus::Valid | ValidationStatus::Duplicate => None,
        }
    }
}

// =============================================================================
// Quote Import (Input)
// =============================================================================

/// A quote to be imported from an external source.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuoteImport {
    /// The asset identifier for the quote (replaced with asset ID after validation).
    pub symbol: String,
    /// The original symbol from CSV, preserved for display.
    #[serde(default)]
    pub display_symbol: Option<String>,
    /// Date in ISO format (YYYY-MM-DD).
    pub date: String,
    /// Opening price (optional, defaults to close if not provided).
    pub open: Option<Decimal>,
    /// Highest price during the period (optional, defaults to close if not provided).
    pub high: Option<Decimal>,
    /// Lowest price during the period (optional, defaults to close if not provided).
    pub low: Option<Decimal>,
    /// Closing price (required).
    pub close: Decimal,
    /// Trading volume (optional, defaults to 0 if not provided).
    pub volume: Option<Decimal>,
    /// Currency code (e.g., "USD", "EUR").
    pub currency: String,
    /// Optional provenance or user note to preserve on the imported quote.
    #[serde(default)]
    pub notes: Option<String>,
    /// Validation status after processing.
    #[serde(default)]
    pub validation_status: ImportValidationStatus,
    /// Error message if validation failed.
    pub error_message: Option<String>,
}

impl QuoteImport {
    /// Create a new QuoteImport with the required fields.
    pub fn new(symbol: String, date: String, close: Decimal, currency: String) -> Self {
        Self {
            symbol,
            display_symbol: None,
            date,
            open: None,
            high: None,
            low: None,
            close,
            volume: None,
            currency,
            notes: None,
            validation_status: ImportValidationStatus::Valid,
            error_message: None,
        }
    }

    /// Create a new QuoteImport with all OHLCV fields.
    #[allow(clippy::too_many_arguments)]
    pub fn with_ohlcv(
        symbol: String,
        date: String,
        open: Decimal,
        high: Decimal,
        low: Decimal,
        close: Decimal,
        volume: Decimal,
        currency: String,
    ) -> Self {
        Self {
            symbol,
            display_symbol: None,
            date,
            open: Some(open),
            high: Some(high),
            low: Some(low),
            close,
            volume: Some(volume),
            currency,
            notes: None,
            validation_status: ImportValidationStatus::Valid,
            error_message: None,
        }
    }

    /// Parse the date string into a NaiveDate.
    pub fn parse_date(&self) -> Result<NaiveDate> {
        NaiveDate::parse_from_str(&self.date, "%Y-%m-%d").map_err(|_| {
            ValidationError::InvalidInput(format!("Invalid date format: {}", self.date)).into()
        })
    }

    /// Parse the date string into a Day.
    pub fn parse_day(&self) -> Option<Day> {
        Day::parse(&self.date)
    }

    /// Get the open price, defaulting to close if not set.
    pub fn open_or_close(&self) -> Decimal {
        self.open.unwrap_or(self.close)
    }

    /// Get the high price, defaulting to close if not set.
    pub fn high_or_close(&self) -> Decimal {
        self.high.unwrap_or(self.close)
    }

    /// Get the low price, defaulting to close if not set.
    pub fn low_or_close(&self) -> Decimal {
        self.low.unwrap_or(self.close)
    }

    /// Get the volume, defaulting to zero if not set.
    pub fn volume_or_zero(&self) -> Decimal {
        self.volume.unwrap_or(Decimal::ZERO)
    }
}

// =============================================================================
// Import Validation (Output)
// =============================================================================

/// Result of validating an import row.
///
/// This struct is returned by `QuoteImportService::validate` and contains
/// the validated data along with status information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportValidation {
    /// The asset identifier.
    pub asset_id: AssetId,
    /// The day of the quote.
    pub day: Day,
    /// Closing price (required).
    pub close: Decimal,
    /// Opening price (optional).
    pub open: Option<Decimal>,
    /// Highest price (optional).
    pub high: Option<Decimal>,
    /// Lowest price (optional).
    pub low: Option<Decimal>,
    /// Trading volume (optional).
    pub volume: Option<Decimal>,
    /// Currency code.
    pub currency: Currency,
    /// Validation status.
    pub status: ValidationStatus,
    /// Additional message (e.g., error details).
    pub message: Option<String>,
}

impl ImportValidation {
    /// Create a valid import validation.
    #[allow(clippy::too_many_arguments)]
    pub fn valid(
        asset_id: AssetId,
        day: Day,
        close: Decimal,
        open: Option<Decimal>,
        high: Option<Decimal>,
        low: Option<Decimal>,
        volume: Option<Decimal>,
        currency: Currency,
    ) -> Self {
        Self {
            asset_id,
            day,
            close,
            open,
            high,
            low,
            volume,
            currency,
            status: ValidationStatus::Valid,
            message: None,
        }
    }

    /// Create a duplicate import validation.
    pub fn duplicate(asset_id: AssetId, day: Day, close: Decimal, currency: Currency) -> Self {
        Self {
            asset_id,
            day,
            close,
            open: None,
            high: None,
            low: None,
            volume: None,
            currency,
            status: ValidationStatus::Duplicate,
            message: Some("Quote already exists for this date".to_string()),
        }
    }

    /// Create an invalid import validation.
    pub fn invalid(
        asset_id: AssetId,
        day: Day,
        close: Decimal,
        currency: Currency,
        error: String,
    ) -> Self {
        Self {
            asset_id,
            day,
            close,
            open: None,
            high: None,
            low: None,
            volume: None,
            currency,
            status: ValidationStatus::Invalid(error.clone()),
            message: Some(error),
        }
    }
}

// =============================================================================
// Import Result
// =============================================================================

/// Result of a quote import operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Number of quotes successfully imported.
    pub imported: usize,
    /// Number of quotes skipped (duplicates).
    pub skipped: usize,
    /// Error messages for failed imports.
    pub errors: Vec<String>,
}

impl ImportResult {
    /// Create a new empty ImportResult.
    pub fn new() -> Self {
        Self {
            imported: 0,
            skipped: 0,
            errors: Vec::new(),
        }
    }
}

impl Default for ImportResult {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Quote Export
// =============================================================================

/// A quote exported for CSV download.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteExport {
    /// Date in YYYY-MM-DD format.
    pub date: String,
    /// Opening price (optional).
    pub open: Option<Decimal>,
    /// Highest price (optional).
    pub high: Option<Decimal>,
    /// Lowest price (optional).
    pub low: Option<Decimal>,
    /// Closing price (required).
    pub close: Decimal,
    /// Trading volume (optional).
    pub volume: Option<Decimal>,
}

impl QuoteExport {
    /// Create a new QuoteExport from a Quote.
    pub fn from_quote(quote: &Quote) -> Self {
        Self {
            date: quote.timestamp.format("%Y-%m-%d").to_string(),
            open: if quote.open == Decimal::ZERO {
                None
            } else {
                Some(quote.open)
            },
            high: if quote.high == Decimal::ZERO {
                None
            } else {
                Some(quote.high)
            },
            low: if quote.low == Decimal::ZERO {
                None
            } else {
                Some(quote.low)
            },
            close: quote.close,
            volume: if quote.volume == Decimal::ZERO {
                None
            } else {
                Some(quote.volume)
            },
        }
    }
}

// =============================================================================
// Quote Import Service
// =============================================================================

/// Service for importing manual quotes.
///
/// This service handles:
/// - Validation of import data
/// - Duplicate detection
/// - Saving quotes with `QuoteSource::Manual`
/// - Exporting quotes to CSV format
///
/// # Key Invariants
///
/// - All imported quotes get `QuoteSource::Manual`
/// - Manual quotes are never overwritten by provider sync
/// - Quote IDs are deterministic using `quote_id()` function
pub struct QuoteImportService {
    quote_store: Arc<dyn QuoteStore>,
}

impl QuoteImportService {
    /// Create a new QuoteImportService.
    pub fn new(quote_store: Arc<dyn QuoteStore>) -> Self {
        Self { quote_store }
    }

    /// Validate import data before saving.
    ///
    /// This method:
    /// 1. Parses and validates each import row
    /// 2. Checks for existing quotes (duplicates)
    /// 3. Returns validation results for preview
    ///
    /// # Arguments
    ///
    /// * `imports` - The quotes to validate
    ///
    /// # Returns
    ///
    /// A vector of validation results
    pub async fn validate(&self, imports: Vec<QuoteImport>) -> Result<Vec<ImportValidation>> {
        let mut validations = Vec::with_capacity(imports.len());

        for import in imports {
            let validation = self.validate_single(&import)?;
            validations.push(validation);
        }

        Ok(validations)
    }

    /// Validate a single import row.
    fn validate_single(&self, import: &QuoteImport) -> Result<ImportValidation> {
        let asset_id = AssetId::new(&import.symbol);
        let currency = Currency::new(&import.currency);

        // Parse and validate date
        let day = match Day::parse(&import.date) {
            Some(d) => d,
            None => {
                return Ok(ImportValidation::invalid(
                    asset_id,
                    Day::today(),
                    import.close,
                    currency,
                    format!("Invalid date format: {}. Expected YYYY-MM-DD", import.date),
                ));
            }
        };

        // Validate symbol
        if import.symbol.trim().is_empty() {
            return Ok(ImportValidation::invalid(
                asset_id,
                day,
                import.close,
                currency,
                "Symbol is required".to_string(),
            ));
        }

        // Validate close price
        if import.close <= Decimal::ZERO {
            return Ok(ImportValidation::invalid(
                asset_id,
                day,
                import.close,
                currency,
                "Close price must be greater than 0".to_string(),
            ));
        }

        // Validate OHLC logic
        if let (Some(high), Some(low)) = (import.high, import.low) {
            if high < low {
                return Ok(ImportValidation::invalid(
                    asset_id,
                    day,
                    import.close,
                    currency,
                    "High price cannot be less than low price".to_string(),
                ));
            }
        }

        // Check for existing quote (duplicate detection)
        let existing = self
            .quote_store
            .latest(&asset_id, Some(&QuoteSource::Manual))?;
        if let Some(existing_quote) = existing {
            let existing_day = Day::new(existing_quote.timestamp.date_naive());
            if existing_day == day {
                return Ok(ImportValidation::duplicate(
                    asset_id,
                    day,
                    import.close,
                    currency,
                ));
            }
        }

        // Also check by range for more thorough duplicate detection
        let quotes_on_day =
            self.quote_store
                .range(&asset_id, day, day, Some(&QuoteSource::Manual))?;
        if !quotes_on_day.is_empty() {
            return Ok(ImportValidation::duplicate(
                asset_id,
                day,
                import.close,
                currency,
            ));
        }

        // All validations passed
        Ok(ImportValidation::valid(
            asset_id,
            day,
            import.close,
            import.open,
            import.high,
            import.low,
            import.volume,
            currency,
        ))
    }

    /// Save validated imports as manual quotes.
    ///
    /// This method:
    /// 1. Filters to only valid imports
    /// 2. Generates deterministic IDs using `quote_id()`
    /// 3. Saves quotes with `QuoteSource::Manual`
    ///
    /// # Arguments
    ///
    /// * `validated` - The validated imports to save
    ///
    /// # Returns
    ///
    /// The number of quotes saved
    pub async fn save(&self, validated: Vec<ImportValidation>) -> Result<usize> {
        let quotes: Vec<Quote> = validated
            .into_iter()
            .filter(|v| v.status.is_importable())
            .map(|v| self.validation_to_quote(v))
            .collect();

        if quotes.is_empty() {
            return Ok(0);
        }

        self.quote_store.upsert_quotes(&quotes).await
    }

    /// Convert a validated import to a Quote.
    fn validation_to_quote(&self, validation: ImportValidation) -> Quote {
        let source = QuoteSource::Manual;
        let id = quote_id(&validation.asset_id, validation.day, &source);

        // Convert Day to DateTime<Utc> at noon UTC
        let timestamp = validation.day.0.and_hms_opt(12, 0, 0).unwrap().and_utc();

        Quote {
            id,
            asset_id: validation.asset_id.0,
            timestamp,
            open: validation.open.unwrap_or(validation.close),
            high: validation.high.unwrap_or(validation.close),
            low: validation.low.unwrap_or(validation.close),
            close: validation.close,
            adjclose: validation.close,
            volume: validation.volume.unwrap_or(Decimal::ZERO),
            currency: validation.currency.0,
            data_source: DATA_SOURCE_MANUAL.to_string(),
            created_at: Utc::now(),
            notes: None,
        }
    }

    /// Import with validation in one step.
    ///
    /// This is a convenience method that combines `validate` and `save`.
    ///
    /// # Arguments
    ///
    /// * `imports` - The quotes to import
    ///
    /// # Returns
    ///
    /// An `ImportResult` with counts and any error messages
    pub async fn import(&self, imports: Vec<QuoteImport>) -> Result<ImportResult> {
        let validations = self.validate(imports).await?;

        let mut result = ImportResult::new();

        // Count by status
        for validation in &validations {
            match &validation.status {
                ValidationStatus::Valid => {}
                ValidationStatus::Duplicate => {
                    result.skipped += 1;
                }
                ValidationStatus::Invalid(msg) => {
                    result.errors.push(format!(
                        "{} on {}: {}",
                        validation.asset_id.0, validation.day, msg
                    ));
                }
            }
        }

        // Save valid imports
        let valid_imports: Vec<ImportValidation> = validations
            .into_iter()
            .filter(|v| v.status.is_importable())
            .collect();

        result.imported = self.save(valid_imports).await?;

        Ok(result)
    }

    /// Export quotes for an asset to CSV format.
    ///
    /// # Arguments
    ///
    /// * `asset_id` - The asset to export quotes for
    /// * `start` - Optional start date (inclusive)
    /// * `end` - Optional end date (inclusive)
    ///
    /// # Returns
    ///
    /// A vector of `QuoteExport` records suitable for CSV output
    pub fn export(
        &self,
        asset_id: &AssetId,
        start: Option<Day>,
        end: Option<Day>,
    ) -> Result<Vec<QuoteExport>> {
        let start_day = start.unwrap_or_else(|| Day::from_ymd(1900, 1, 1).unwrap());
        let end_day = end.unwrap_or_else(Day::today);

        let quotes = self.quote_store.range(asset_id, start_day, end_day, None)?;

        Ok(quotes.iter().map(QuoteExport::from_quote).collect())
    }
}

// =============================================================================
// Quote Validator (for backward compatibility)
// =============================================================================

/// Validates quote data for import.
///
/// This is kept for backward compatibility with existing code.
pub struct QuoteValidator;

impl QuoteValidator {
    /// Validate a QuoteImport and return the validation status.
    pub fn validate(quote: &QuoteImport) -> ImportValidationStatus {
        // Validate symbol
        if quote.symbol.trim().is_empty() {
            return ImportValidationStatus::Error("Symbol is required".to_string());
        }

        // Validate date format
        if NaiveDate::parse_from_str(&quote.date, "%Y-%m-%d").is_err() {
            return ImportValidationStatus::Error(
                "Invalid date format. Expected YYYY-MM-DD".to_string(),
            );
        }

        // Validate close price (required)
        if quote.close <= Decimal::ZERO {
            return ImportValidationStatus::Error("Close price must be greater than 0".to_string());
        }

        // Validate OHLC logic
        if let (Some(open), Some(high), Some(low)) = (quote.open, quote.high, quote.low) {
            if high < low {
                return ImportValidationStatus::Error(
                    "High price cannot be less than low price".to_string(),
                );
            }
            if open > high || open < low {
                return ImportValidationStatus::Warning(
                    "Open price is outside high-low range".to_string(),
                );
            }
            if quote.close > high || quote.close < low {
                return ImportValidationStatus::Warning(
                    "Close price is outside high-low range".to_string(),
                );
            }
        }

        ImportValidationStatus::Valid
    }

    /// Validate a batch of quotes and update their validation status.
    pub fn validate_batch(quotes: &mut [QuoteImport]) {
        for quote in quotes.iter_mut() {
            quote.validation_status = Self::validate(quote);
        }
    }
}

// =============================================================================
// Legacy Converter (for backward compatibility)
// =============================================================================

/// Converts QuoteImport to internal Quote representation.
///
/// This is kept for backward compatibility with existing code.
pub struct QuoteConverter;

impl QuoteConverter {
    /// Generate a unique ID for a quote based on symbol and date.
    ///
    /// Format: `{symbol}_{YYYY-MM-DD}_MANUAL`
    /// This format matches types::quote_id() for consistency.
    pub fn generate_id(symbol: &str, date: &str) -> String {
        format!("{}_{}_MANUAL", symbol, date)
    }

    /// Convert a QuoteImport to a timestamp (noon UTC on the given date).
    pub fn date_to_timestamp(date: &str) -> Result<chrono::DateTime<Utc>> {
        let naive_date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| ValidationError::InvalidInput(format!("Invalid date: {}", date)))?;

        let timestamp = naive_date
            .and_hms_opt(12, 0, 0)
            .ok_or_else(|| ValidationError::InvalidInput("Invalid time".to_string()))?
            .and_local_timezone(Utc)
            .single()
            .ok_or_else(|| ValidationError::InvalidInput("Invalid timezone".to_string()))?;

        Ok(timestamp)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    #[test]
    fn test_import_validation_status() {
        // Test ImportValidationStatus (legacy, with Valid/Warning/Error)
        assert!(ImportValidationStatus::Valid.is_importable());
        assert!(ImportValidationStatus::Warning("minor issue".to_string()).is_importable());
        assert!(!ImportValidationStatus::Error("critical error".to_string()).is_importable());
    }

    #[test]
    fn test_import_validation_status_message() {
        assert!(ImportValidationStatus::Valid.message().is_none());
        assert_eq!(
            ImportValidationStatus::Warning("test".to_string()).message(),
            Some("test")
        );
        assert_eq!(
            ImportValidationStatus::Error("error".to_string()).message(),
            Some("error")
        );
    }

    #[test]
    fn test_validation_status() {
        // Test ValidationStatus (new, with Valid/Duplicate/Invalid)
        assert!(ValidationStatus::Valid.is_importable());
        assert!(!ValidationStatus::Duplicate.is_importable());
        assert!(!ValidationStatus::Invalid("error".to_string()).is_importable());

        assert!(ValidationStatus::Duplicate.is_duplicate());
        assert!(!ValidationStatus::Valid.is_duplicate());

        assert!(ValidationStatus::Invalid("error".to_string()).is_invalid());
        assert!(!ValidationStatus::Valid.is_invalid());
    }

    #[test]
    fn test_validation_status_message() {
        assert!(ValidationStatus::Valid.message().is_none());
        assert!(ValidationStatus::Duplicate.message().is_none());
        assert_eq!(
            ValidationStatus::Invalid("test error".to_string()).message(),
            Some("test error")
        );
    }

    #[test]
    fn test_quote_import_new() {
        let quote = QuoteImport::new(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            "USD".to_string(),
        );

        assert_eq!(quote.symbol, "AAPL");
        assert_eq!(quote.date, "2024-01-15");
        assert_eq!(quote.close, Decimal::new(150, 0));
        assert!(quote.open.is_none());
        assert!(quote.validation_status.is_valid());
    }

    #[test]
    fn test_quote_import_defaults() {
        let quote = QuoteImport::new(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            "USD".to_string(),
        );

        assert_eq!(quote.open_or_close(), Decimal::new(150, 0));
        assert_eq!(quote.high_or_close(), Decimal::new(150, 0));
        assert_eq!(quote.low_or_close(), Decimal::new(150, 0));
        assert_eq!(quote.volume_or_zero(), Decimal::ZERO);
    }

    #[test]
    fn test_quote_import_parse_day() {
        let quote = QuoteImport::new(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            "USD".to_string(),
        );

        let day = quote.parse_day().unwrap();
        assert_eq!(day.to_string(), "2024-01-15");
    }

    #[test]
    fn test_import_validation_constructors() {
        let asset_id = AssetId::new("AAPL");
        let day = Day::from_ymd(2024, 1, 15).unwrap();
        let close = Decimal::new(150, 0);
        let currency = Currency::new("USD");

        let valid = ImportValidation::valid(
            asset_id.clone(),
            day,
            close,
            Some(Decimal::new(148, 0)),
            Some(Decimal::new(152, 0)),
            Some(Decimal::new(147, 0)),
            Some(Decimal::new(1000000, 0)),
            currency.clone(),
        );
        assert!(valid.status.is_importable());
        assert!(valid.message.is_none());

        let duplicate = ImportValidation::duplicate(asset_id.clone(), day, close, currency.clone());
        assert!(duplicate.status.is_duplicate());
        assert!(duplicate.message.is_some());

        let invalid =
            ImportValidation::invalid(asset_id, day, close, currency, "Test error".to_string());
        assert!(invalid.status.is_invalid());
        assert_eq!(invalid.message, Some("Test error".to_string()));
    }

    #[test]
    fn test_import_result() {
        let mut result = ImportResult::new();
        assert_eq!(result.imported, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty());

        result.imported = 5;
        result.skipped = 2;
        result.errors.push("Test error".to_string());

        assert_eq!(result.imported, 5);
        assert_eq!(result.skipped, 2);
        assert_eq!(result.errors.len(), 1);
    }

    #[test]
    fn test_quote_export_from_quote() {
        let quote = Quote {
            id: "AAPL_2024-01-15_MANUAL".to_string(),
            asset_id: "AAPL".to_string(),
            timestamp: chrono::DateTime::parse_from_rfc3339("2024-01-15T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            open: Decimal::new(148, 0),
            high: Decimal::new(152, 0),
            low: Decimal::new(147, 0),
            close: Decimal::new(150, 0),
            adjclose: Decimal::new(150, 0),
            volume: Decimal::new(1000000, 0),
            currency: "USD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: Utc::now(),
            notes: None,
        };

        let export = QuoteExport::from_quote(&quote);
        assert_eq!(export.date, "2024-01-15");
        assert_eq!(export.open, Some(Decimal::new(148, 0)));
        assert_eq!(export.high, Some(Decimal::new(152, 0)));
        assert_eq!(export.low, Some(Decimal::new(147, 0)));
        assert_eq!(export.close, Decimal::new(150, 0));
        assert_eq!(export.volume, Some(Decimal::new(1000000, 0)));
    }

    #[test]
    fn test_quote_export_zero_values() {
        let quote = Quote {
            id: "AAPL_2024-01-15_MANUAL".to_string(),
            asset_id: "AAPL".to_string(),
            timestamp: chrono::DateTime::parse_from_rfc3339("2024-01-15T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            open: Decimal::ZERO,
            high: Decimal::ZERO,
            low: Decimal::ZERO,
            close: Decimal::new(150, 0),
            adjclose: Decimal::new(150, 0),
            volume: Decimal::ZERO,
            currency: "USD".to_string(),
            data_source: "MANUAL".to_string(),
            created_at: Utc::now(),
            notes: None,
        };

        let export = QuoteExport::from_quote(&quote);
        assert!(export.open.is_none());
        assert!(export.high.is_none());
        assert!(export.low.is_none());
        assert!(export.volume.is_none());
    }

    #[test]
    fn test_validator_empty_symbol() {
        let quote = QuoteImport::new(
            "".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(matches!(status, ImportValidationStatus::Error(_)));
    }

    #[test]
    fn test_validator_invalid_date() {
        let quote = QuoteImport::new(
            "AAPL".to_string(),
            "invalid-date".to_string(),
            Decimal::new(150, 0),
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(matches!(status, ImportValidationStatus::Error(_)));
    }

    #[test]
    fn test_validator_zero_close() {
        let quote = QuoteImport::new(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::ZERO,
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(matches!(status, ImportValidationStatus::Error(_)));
    }

    #[test]
    fn test_validator_high_less_than_low() {
        let quote = QuoteImport::with_ohlcv(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            Decimal::new(140, 0), // high less than low
            Decimal::new(145, 0),
            Decimal::new(148, 0),
            Decimal::new(1000000, 0),
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(matches!(status, ImportValidationStatus::Error(_)));
    }

    #[test]
    fn test_validator_open_outside_range() {
        let quote = QuoteImport::with_ohlcv(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(160, 0), // open above high
            Decimal::new(155, 0),
            Decimal::new(145, 0),
            Decimal::new(150, 0),
            Decimal::new(1000000, 0),
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(matches!(status, ImportValidationStatus::Warning(_)));
    }

    #[test]
    fn test_validator_valid_quote() {
        let quote = QuoteImport::with_ohlcv(
            "AAPL".to_string(),
            "2024-01-15".to_string(),
            Decimal::new(150, 0),
            Decimal::new(155, 0),
            Decimal::new(148, 0),
            Decimal::new(152, 0),
            Decimal::new(1000000, 0),
            "USD".to_string(),
        );

        let status = QuoteValidator::validate(&quote);
        assert!(status.is_valid());
    }

    #[test]
    fn test_quote_converter_generate_id() {
        let id = QuoteConverter::generate_id("AAPL", "2024-01-15");
        assert_eq!(id, "AAPL_2024-01-15_MANUAL");
    }

    #[test]
    fn test_quote_converter_date_to_timestamp() {
        let timestamp = QuoteConverter::date_to_timestamp("2024-01-15").unwrap();
        assert_eq!(timestamp.date_naive().to_string(), "2024-01-15");
        assert_eq!(timestamp.time().hour(), 12);
    }
}
