//! CSV import tool — mapping inference only.
//!
//! The AI tool is responsible for figuring out HOW to interpret the CSV
//! (parse config, column → field mappings, value normalization, symbol
//! name → ticker translation). It does NOT do parse/validate/dedup — those
//! live in the backend pipeline (`parse_csv` → `check_activities_import` →
//! `import_activities`), which the chat tool UI drives directly.
//!
//! Flow:
//! 1. Tool receives the name of an attached CSV file + optional account_id +
//!    LLM-proposed mapping. It reads the file from the chat's attachments, so
//!    the model never copies rows into the call.
//! 2. If account has a saved template, short-circuit and return it
//! 3. Otherwise run `parse_csv` to get headers + sample rows, auto-detect
//!    field mappings, merge with LLM-provided overrides
//! 4. Return `(ParseConfig, ImportMappingData)` plus a small sample for UI

use log::debug;
use rig::tool::PortableTool as Tool;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Deserialize a HashMap<String, String> tolerating null values (drops them).
/// LLMs sometimes produce {"key": null} when they mean "no mapping".
fn deserialize_nullable_string_map<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Option<HashMap<String, Option<String>>> = Option::deserialize(deserializer)?;
    Ok(raw.map(|m| {
        m.into_iter()
            .filter_map(|(k, v)| v.map(|val| (k, val)))
            .collect()
    }))
}

/// Field mappings tolerating null values, like `deserialize_nullable_string_map`.
/// A value is one column or a list of fallback columns.
fn deserialize_nullable_field_mappings<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, FieldMappingValue>>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw: Option<HashMap<String, Option<FieldMappingValue>>> =
        Option::deserialize(deserializer)?;
    Ok(raw.map(|m| {
        m.into_iter()
            .filter_map(|(k, v)| v.map(|val| (k, val)))
            .collect()
    }))
}

/// Drops blank columns, and mappings left with none.
fn clean_field_mappings(
    map: Option<HashMap<String, FieldMappingValue>>,
) -> HashMap<String, FieldMappingValue> {
    map.unwrap_or_default()
        .into_iter()
        .filter_map(|(field, value)| match value {
            FieldMappingValue::Single(column) => {
                (!column.trim().is_empty()).then_some((field, FieldMappingValue::Single(column)))
            }
            FieldMappingValue::Fallback(columns) => {
                let columns: Vec<String> = columns
                    .into_iter()
                    .filter(|column| !column.trim().is_empty())
                    .collect();
                (!columns.is_empty()).then_some((field, FieldMappingValue::Fallback(columns)))
            }
        })
        .collect()
}

fn clean_string_map(map: Option<HashMap<String, String>>) -> HashMap<String, String> {
    map.unwrap_or_default()
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect()
}

fn has_usable_string_map(map: &Option<HashMap<String, String>>) -> bool {
    map.as_ref()
        .is_some_and(|m| m.values().any(|value| !value.trim().is_empty()))
}

fn has_usable_activity_mappings(map: &Option<HashMap<String, Vec<String>>>) -> bool {
    map.as_ref().is_some_and(|m| {
        m.values()
            .any(|values| values.iter().any(|value| !value.trim().is_empty()))
    })
}

fn has_usable_llm_mappings(args: &ImportCsvArgs) -> bool {
    !clean_field_mappings(args.field_mappings.clone()).is_empty()
        || has_usable_activity_mappings(&args.activity_mappings)
        || has_usable_string_map(&args.symbol_mappings)
        || has_usable_string_map(&args.account_mappings)
}

use wealthfolio_core::accounts::{account_types, Account};
use wealthfolio_core::activities::{
    import_type, FieldMappingValue, ImportMappingData, ParseConfig,
};

use super::AccountOption;
use crate::env::AiEnvironment;
use crate::error::AiError;
use crate::types::MessageAttachment;

fn merge_parse_config(
    mut base: ParseConfig,
    overrides: &ParseConfig,
    override_default_currency: bool,
) -> ParseConfig {
    if overrides.delimiter.is_some() {
        base.delimiter = overrides.delimiter.clone();
    }
    if overrides.skip_top_rows.is_some() {
        base.skip_top_rows = overrides.skip_top_rows;
    }
    if overrides.skip_bottom_rows.is_some() {
        base.skip_bottom_rows = overrides.skip_bottom_rows;
    }
    if overrides.date_format.is_some() {
        base.date_format = overrides.date_format.clone();
    }
    if overrides.decimal_separator.is_some() {
        base.decimal_separator = overrides.decimal_separator.clone();
    }
    if overrides.thousands_separator.is_some() {
        base.thousands_separator = overrides.thousands_separator.clone();
    }
    if override_default_currency && overrides.default_currency.is_some() {
        base.default_currency = overrides.default_currency.clone();
    }
    base
}

// ============================================================================
// Tool Arguments
// ============================================================================

/// Arguments for the import_csv tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCsvArgs {
    /// Name of the attached CSV file to import.
    pub attachment_name: String,

    /// Account ID to assign to all activities and load saved mapping from.
    pub account_id: Option<String>,

    /// Maps field names to CSV header names (or fallback lists of them).
    #[serde(default, deserialize_with = "deserialize_nullable_field_mappings")]
    pub field_mappings: Option<HashMap<String, FieldMappingValue>>,

    /// Maps canonical activity types to CSV values.
    #[serde(default)]
    pub activity_mappings: Option<HashMap<String, Vec<String>>>,

    /// Maps CSV symbol *values* to canonical tickers.
    #[serde(default, deserialize_with = "deserialize_nullable_string_map")]
    pub symbol_mappings: Option<HashMap<String, String>>,

    /// Maps CSV account values to app account IDs.
    #[serde(default, deserialize_with = "deserialize_nullable_string_map")]
    pub account_mappings: Option<HashMap<String, String>>,

    /// CSV delimiter: ",", ";", "\t", or "auto"
    pub delimiter: Option<String>,

    /// Number of rows to skip at the top before the header (default: 0)
    pub skip_top_rows: Option<usize>,

    /// Number of rows to skip at the bottom (default: 0)
    pub skip_bottom_rows: Option<usize>,

    /// Date format hint: "auto" or strftime format like "%d/%m/%Y"
    pub date_format: Option<String>,

    /// Decimal separator: "auto", ".", ","
    pub decimal_separator: Option<String>,

    /// Thousands separator: "auto", ",", ".", " ", "none"
    pub thousands_separator: Option<String>,

    /// Default currency for rows that do not specify one.
    pub default_currency: Option<String>,
}

// ============================================================================
// Output Types
// ============================================================================

/// Mapping confidence — rough signal for the UI badge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MappingConfidence {
    High,
    Medium,
    Low,
}

/// Output of the import_csv mapping tool.
///
/// The chat tool UI uses this to drive the backend pipeline (parse_csv →
/// check_activities_import → import_activities). No drafts, no validation,
/// no normalization happens here.
///
/// NOTE: the CSV text is NOT echoed here, because the result goes back to the
/// model. The frontend reads it from the live tool call event, where the app
/// fills `csvContent` from the attached file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCsvMappingOutput {
    /// The attached CSV file the mapping applies to.
    pub attachment_name: String,

    /// The mapping the AI (or saved template) settled on.
    pub applied_mapping: ImportMappingData,

    /// Parse config the frontend should use (delimiter, date_format, skips, …).
    pub parse_config: ParseConfig,

    /// AI's inferred account (None if ambiguous — chat UI will prompt).
    pub account_id: Option<String>,

    /// Headers detected by parse_csv.
    pub detected_headers: Vec<String>,

    /// Always empty; the UI parses the attached file itself.
    pub sample_rows: Vec<Vec<String>>,

    /// Total number of rows parsed (before truncation).
    pub total_rows: usize,

    /// Rough confidence badge for the mapping.
    pub mapping_confidence: MappingConfidence,

    /// Accounts available for selection in the chat UI.
    pub available_accounts: Vec<AccountOption>,

    /// True when the mapping came from a saved template (no LLM inference).
    #[serde(default)]
    pub used_saved_profile: bool,
}

// ============================================================================
// Field Constants (matching ImportMappingData keys)
// ============================================================================

const FIELD_DATE: &str = "date";
const FIELD_ACTIVITY_TYPE: &str = "activityType";
const FIELD_SYMBOL: &str = "symbol";
const FIELD_QUANTITY: &str = "quantity";
const FIELD_UNIT_PRICE: &str = "unitPrice";
const FIELD_AMOUNT: &str = "amount";
const FIELD_FEE: &str = "fee";
const FIELD_CURRENCY: &str = "currency";
const FIELD_ACCOUNT: &str = "account";
const FIELD_COMMENT: &str = "comment";
const FIELD_FX_RATE: &str = "fxRate";
const FIELD_SUBTYPE: &str = "subtype";

// ============================================================================
// Header Detection Patterns (fallback when LLM omits field_mappings)
// ============================================================================

const DATE_PATTERNS: &[&str] = &[
    "date",
    "trade date",
    "activity date",
    "transaction date",
    "settlement date",
    "trade_date",
    "activity_date",
    "transaction_date",
    "time",
    "datetime",
];

const ACTIVITY_TYPE_PATTERNS: &[&str] = &[
    "type",
    "activity type",
    "transaction type",
    "action",
    "activity",
    "activity_type",
    "transaction_type",
    "trans type",
    "operation",
];

const SYMBOL_PATTERNS: &[&str] = &[
    "symbol",
    "ticker",
    "stock",
    "security",
    "asset",
    "instrument",
    "ticker symbol",
    "stock symbol",
    "isin",
    "cusip",
];

const QUANTITY_PATTERNS: &[&str] = &[
    "quantity",
    "qty",
    "shares",
    "units",
    "no of shares",
    "number of shares",
    "volume",
];

const UNIT_PRICE_PATTERNS: &[&str] = &[
    "price",
    "unit price",
    "share price",
    "cost per share",
    "avg price",
    "unit_price",
    "share_price",
    "execution price",
    "trade price",
];

const AMOUNT_PATTERNS: &[&str] = &[
    "total",
    "amount",
    "transaction amount",
    "value",
    "net amount",
    "gross amount",
    "market value",
    "total amount",
    "total value",
    "proceeds",
    "cost",
    "net value",
];

const TRANSACTION_AMOUNT_PATTERNS: &[&str] = &[
    "debit",
    "credit",
    "charge",
    "charges",
    "payment",
    "payments",
    "withdrawal",
    "withdrawals",
    "deposit",
    "deposits",
    "money out",
    "money in",
    "paid out",
    "paid in",
];

const CURRENCY_PATTERNS: &[&str] = &["currency", "ccy", "currency code", "curr", "trade currency"];

const FEE_PATTERNS: &[&str] = &[
    "fee",
    "fees",
    "commission",
    "commissions",
    "trading fee",
    "transaction fee",
    "brokerage",
    "charges",
];

const ACCOUNT_PATTERNS: &[&str] = &[
    "account",
    "account id",
    "account name",
    "portfolio",
    "account number",
];

const COMMENT_PATTERNS: &[&str] = &[
    "comment",
    "comments",
    "note",
    "notes",
    "description",
    "transaction description",
    "memo",
    "remarks",
    "details",
];

const TRANSACTION_COMMENT_PATTERNS: &[&str] = &[
    "merchant",
    "merchant name",
    "payee",
    "payer",
    "vendor",
    "name",
    "transaction name",
    "narrative",
];

const FX_RATE_PATTERNS: &[&str] = &[
    "fx rate",
    "fxrate",
    "fx_rate",
    "exchange rate",
    "exchangerate",
    "exchange_rate",
    "forex rate",
    "conversion rate",
];

const SUBTYPE_PATTERNS: &[&str] = &[
    "subtype",
    "sub type",
    "sub_type",
    "variation",
    "subcategory",
];

// ============================================================================
// Helpers
// ============================================================================

fn is_transaction_account_type(account_type: Option<&str>) -> bool {
    matches!(
        account_type,
        Some(account_types::CASH) | Some(account_types::CREDIT_CARD)
    )
}

/// Auto-detect field mappings from CSV headers.
#[cfg(test)]
fn auto_detect_field_mappings(headers: &[String]) -> HashMap<String, String> {
    auto_detect_field_mapping_values(headers, false)
        .into_iter()
        .filter_map(|(field, value)| match value {
            FieldMappingValue::Single(header) => Some((field, header)),
            FieldMappingValue::Fallback(headers) => headers.into_iter().next().map(|h| (field, h)),
        })
        .collect()
}

fn header_matches_patterns(header: &str, patterns: &[&str]) -> bool {
    let lower = header.to_lowercase();
    patterns.iter().any(|p| lower == *p || lower.contains(p))
}

/// Auto-detect field mappings from CSV headers, with a transaction-account
/// profile that avoids treating merchant/payee columns as investment symbols.
fn auto_detect_field_mapping_values(
    headers: &[String],
    is_transaction_account: bool,
) -> HashMap<String, FieldMappingValue> {
    let mut mappings = HashMap::new();
    let mut used_headers = HashSet::new();

    let investment_patterns: &[(&str, &[&str])] = &[
        (FIELD_DATE, DATE_PATTERNS),
        (FIELD_ACTIVITY_TYPE, ACTIVITY_TYPE_PATTERNS),
        (FIELD_SYMBOL, SYMBOL_PATTERNS),
        (FIELD_QUANTITY, QUANTITY_PATTERNS),
        (FIELD_UNIT_PRICE, UNIT_PRICE_PATTERNS),
        (FIELD_AMOUNT, AMOUNT_PATTERNS),
        (FIELD_CURRENCY, CURRENCY_PATTERNS),
        (FIELD_FEE, FEE_PATTERNS),
        (FIELD_ACCOUNT, ACCOUNT_PATTERNS),
        (FIELD_COMMENT, COMMENT_PATTERNS),
        (FIELD_FX_RATE, FX_RATE_PATTERNS),
        (FIELD_SUBTYPE, SUBTYPE_PATTERNS),
    ];
    let transaction_patterns: &[(&str, &[&str])] = &[
        (FIELD_DATE, DATE_PATTERNS),
        (FIELD_ACTIVITY_TYPE, ACTIVITY_TYPE_PATTERNS),
        (FIELD_AMOUNT, AMOUNT_PATTERNS),
        (FIELD_CURRENCY, CURRENCY_PATTERNS),
        (FIELD_FEE, FEE_PATTERNS),
        (FIELD_ACCOUNT, ACCOUNT_PATTERNS),
        (FIELD_COMMENT, COMMENT_PATTERNS),
        (FIELD_FX_RATE, FX_RATE_PATTERNS),
        (FIELD_SUBTYPE, SUBTYPE_PATTERNS),
    ];

    let field_patterns = if is_transaction_account {
        transaction_patterns
    } else {
        investment_patterns
    };

    for (field, patterns) in field_patterns {
        for header in headers {
            if used_headers.contains(header) {
                continue;
            }
            let matches_base = header_matches_patterns(header, patterns);
            let matches_transaction_comment = is_transaction_account
                && *field == FIELD_COMMENT
                && header_matches_patterns(header, TRANSACTION_COMMENT_PATTERNS);
            let matches_transaction_amount = is_transaction_account
                && *field == FIELD_AMOUNT
                && header_matches_patterns(header, TRANSACTION_AMOUNT_PATTERNS);

            if matches_base || matches_transaction_comment || matches_transaction_amount {
                mappings.insert(field.to_string(), FieldMappingValue::Single(header.clone()));
                used_headers.insert(header.clone());
                break;
            }
        }
    }

    if is_transaction_account {
        let amount_headers: Vec<String> = headers
            .iter()
            .filter(|header| {
                header_matches_patterns(header, AMOUNT_PATTERNS)
                    || header_matches_patterns(header, TRANSACTION_AMOUNT_PATTERNS)
            })
            .cloned()
            .collect();
        if amount_headers.len() > 1 {
            mappings.insert(
                FIELD_AMOUNT.to_string(),
                FieldMappingValue::Fallback(amount_headers),
            );
        }
    }

    mappings
}

/// Default activity-type mappings — CSV value → canonical type. Covers the
/// common broker verbs so a plain CSV with "Buy"/"Purchase"/"Dividend" values
/// maps correctly even when the LLM skips `activity_mappings`. Matches the
/// manual wizard's default template behavior.
fn default_activity_mappings() -> HashMap<String, Vec<String>> {
    let entries: &[(&str, &[&str])] = &[
        (
            "BUY",
            &[
                "BUY",
                "BOUGHT",
                "PURCHASE",
                "B",
                "LONG",
                "MARKET BUY",
                "LIMIT BUY",
            ],
        ),
        (
            "SELL",
            &["SELL", "SOLD", "S", "SHORT", "MARKET SELL", "LIMIT SELL"],
        ),
        (
            "DIVIDEND",
            &["DIVIDEND", "DIV", "CASH DIVIDEND", "QUALIFIED DIVIDEND"],
        ),
        (
            "INTEREST",
            &["INTEREST", "INT", "INTEREST EARNED", "CASH INTEREST"],
        ),
        (
            "DEPOSIT",
            &[
                "DEPOSIT",
                "DEP",
                "CASH DEPOSIT",
                "WIRE IN",
                "ACH IN",
                "FUNDING",
                "WIRE TRANSFER IN",
            ],
        ),
        (
            "WITHDRAWAL",
            &[
                "WITHDRAWAL",
                "WITHDRAW",
                "CASH WITHDRAWAL",
                "WIRE OUT",
                "ACH OUT",
            ],
        ),
        (
            "TRANSFER_IN",
            &["TRANSFER IN", "TRANSFER_IN", "JOURNAL IN", "ACAT IN"],
        ),
        (
            "TRANSFER_OUT",
            &["TRANSFER OUT", "TRANSFER_OUT", "JOURNAL OUT", "ACAT OUT"],
        ),
        (
            "SPLIT",
            &["SPLIT", "STOCK SPLIT", "FORWARD SPLIT", "REVERSE SPLIT"],
        ),
        ("FEE", &["FEE", "FEES", "SERVICE FEE", "MANAGEMENT FEE"]),
        ("TAX", &["TAX", "TAXES", "WITHHOLDING", "TAX WITHHELD"]),
    ];
    entries
        .iter()
        .map(|(k, vs)| (k.to_string(), vs.iter().map(|v| v.to_string()).collect()))
        .collect()
}

fn default_transaction_activity_mappings(
    account_type: Option<&str>,
) -> HashMap<String, Vec<String>> {
    let entries: &[(&str, &[&str])] = if account_type == Some(account_types::CREDIT_CARD) {
        &[
            (
                "WITHDRAWAL",
                &[
                    "WITHDRAWAL",
                    "CHARGE",
                    "PURCHASE",
                    "CARD PURCHASE",
                    "DEBIT",
                    "SALE",
                    "PAYMENT TO",
                    "TRANSACTION",
                ],
            ),
            (
                "TRANSFER_IN",
                &[
                    "TRANSFER_IN",
                    "TRANSFER IN",
                    "PAYMENT",
                    "PAYMENT RECEIVED",
                    "AUTOPAY PAYMENT",
                    "THANK YOU",
                    "THANK YOU PAYMENT",
                    "CREDIT CARD PAYMENT",
                ],
            ),
            (
                "CREDIT",
                &[
                    "CREDIT",
                    "REFUND",
                    "RETURN",
                    "REVERSAL",
                    "STATEMENT CREDIT",
                    "CREDIT ADJUSTMENT",
                ],
            ),
            (
                "FEE",
                &["FEE", "FEES", "ANNUAL FEE", "LATE FEE", "SERVICE FEE"],
            ),
            (
                "INTEREST",
                &["INTEREST", "INTEREST CHARGE", "FINANCE CHARGE"],
            ),
        ]
    } else {
        &[
            (
                "DEPOSIT",
                &[
                    "DEPOSIT",
                    "PAYROLL",
                    "DIRECT DEPOSIT",
                    "E-TRANSFER IN",
                    "WIRE IN",
                    "ACH IN",
                ],
            ),
            (
                "WITHDRAWAL",
                &[
                    "WITHDRAWAL",
                    "DEBIT",
                    "PAYMENT",
                    "PURCHASE",
                    "POS",
                    "ATM WITHDRAWAL",
                    "BILL PAYMENT",
                ],
            ),
            ("TRANSFER_IN", &["TRANSFER_IN", "TRANSFER IN"]),
            ("TRANSFER_OUT", &["TRANSFER_OUT", "TRANSFER OUT"]),
            ("INTEREST", &["INTEREST", "INTEREST EARNED"]),
            ("FEE", &["FEE", "FEES", "SERVICE FEE"]),
            ("TAX", &["TAX", "TAXES"]),
            ("CREDIT", &["CREDIT", "REFUND", "REVERSAL"]),
        ]
    };

    entries
        .iter()
        .map(|(k, vs)| (k.to_string(), vs.iter().map(|v| v.to_string()).collect()))
        .collect()
}

/// Merge LLM-provided activity mappings on top of the defaults. LLM entries
/// win on conflict, but defaults fill in anything the LLM omitted.
fn merge_activity_mappings(
    llm: Option<HashMap<String, Vec<String>>>,
    account_type: Option<&str>,
) -> HashMap<String, Vec<String>> {
    let is_transaction = is_transaction_account_type(account_type);
    let mut merged = if is_transaction {
        default_transaction_activity_mappings(account_type)
    } else {
        default_activity_mappings()
    };
    let allowed: Option<HashSet<String>> = if is_transaction {
        Some(merged.keys().cloned().collect())
    } else {
        None
    };
    if let Some(llm) = llm {
        for (canonical, csv_values) in llm {
            if allowed
                .as_ref()
                .is_some_and(|allowed| !allowed.contains(&canonical))
            {
                continue;
            }
            let entry = merged.entry(canonical).or_default();
            for v in csv_values {
                let trimmed = v.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let upper = trimmed.to_uppercase();
                if !entry
                    .iter()
                    .any(|existing| existing.to_uppercase() == upper)
                {
                    entry.push(trimmed.to_string());
                }
            }
        }
    }
    merged
}

/// Whether the CSV has a column a field mapping names (any of a fallback list).
fn mapping_header_exists(headers: &[String], value: &FieldMappingValue) -> bool {
    let exists = |name: &String| headers.iter().any(|header| header == name.trim());
    match value {
        FieldMappingValue::Single(name) => exists(name),
        FieldMappingValue::Fallback(names) => names.iter().any(exists),
    }
}

fn mapped_header_hits(
    headers: &[String],
    field_mappings: &HashMap<String, FieldMappingValue>,
) -> usize {
    field_mappings
        .values()
        .filter(|value| mapping_header_exists(headers, value))
        .count()
}

/// Estimate mapping confidence from how many of the "core" fields were mapped
/// to a column the CSV has.
/// Core = date + activityType + symbol + (quantity OR amount) + (unitPrice OR amount).
fn estimate_confidence(
    mapping: &ImportMappingData,
    headers: &[String],
    is_transaction_account: bool,
) -> MappingConfidence {
    let has = |field: &str| {
        mapping
            .field_mappings
            .get(field)
            .is_some_and(|value| mapping_header_exists(headers, value))
    };
    let has_date = has(FIELD_DATE);
    let has_type = has(FIELD_ACTIVITY_TYPE);
    let has_amount = has(FIELD_AMOUNT);

    let critical = if is_transaction_account {
        vec![has_date, has_type, has_amount]
    } else {
        let has_symbol = has(FIELD_SYMBOL);
        let has_numeric = has(FIELD_QUANTITY) || has(FIELD_AMOUNT) || has(FIELD_UNIT_PRICE);
        vec![has_date, has_type, has_symbol, has_numeric]
    };
    let ok = critical.iter().filter(|b| **b).count();

    if ok == critical.len() {
        MappingConfidence::High
    } else if ok >= 2 {
        MappingConfidence::Medium
    } else {
        MappingConfidence::Low
    }
}

fn valid_account_id(value: &str, accounts: &[Account]) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    accounts
        .iter()
        .find(|account| account.id == trimmed)
        .map(|account| account.id.clone())
}

fn clean_account_mappings(
    map: Option<HashMap<String, String>>,
    accounts: &[Account],
) -> HashMap<String, String> {
    clean_string_map(map)
        .into_iter()
        .filter_map(|(key, value)| {
            valid_account_id(&value, accounts).map(|account_id| (key, account_id))
        })
        .collect()
}

fn sanitize_field_mappings_for_account(
    field_mappings: HashMap<String, FieldMappingValue>,
    is_transaction_account: bool,
) -> HashMap<String, FieldMappingValue> {
    if !is_transaction_account {
        return field_mappings;
    }

    let allowed: HashSet<&str> = [
        FIELD_DATE,
        FIELD_ACTIVITY_TYPE,
        FIELD_AMOUNT,
        FIELD_CURRENCY,
        FIELD_FEE,
        FIELD_ACCOUNT,
        FIELD_COMMENT,
        FIELD_FX_RATE,
        FIELD_SUBTYPE,
    ]
    .into_iter()
    .collect();

    field_mappings
        .into_iter()
        .filter(|(field, _)| allowed.contains(field.as_str()))
        .collect()
}

fn sanitize_mapping_for_account(
    mut mapping: ImportMappingData,
    account_type: Option<&str>,
) -> ImportMappingData {
    let is_transaction = is_transaction_account_type(account_type);
    mapping.field_mappings =
        sanitize_field_mappings_for_account(mapping.field_mappings, is_transaction);
    if is_transaction {
        let mut merged_activity_mappings = default_transaction_activity_mappings(account_type);
        let allowed: HashSet<String> = merged_activity_mappings.keys().cloned().collect();
        for (activity_type, values) in mapping.activity_mappings {
            if !allowed.contains(&activity_type) {
                continue;
            }
            let entry = merged_activity_mappings.entry(activity_type).or_default();
            for value in values {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let upper = trimmed.to_uppercase();
                if !entry
                    .iter()
                    .any(|existing| existing.to_uppercase() == upper)
                {
                    entry.push(trimmed.to_string());
                }
            }
        }
        mapping.activity_mappings = merged_activity_mappings;
        mapping.symbol_mappings.clear();
        mapping.symbol_mapping_meta.clear();
    }
    mapping
}

fn sanitize_mapping_accounts(
    mut mapping: ImportMappingData,
    accounts: &[Account],
) -> ImportMappingData {
    mapping.account_id = valid_account_id(&mapping.account_id, accounts).unwrap_or_default();
    mapping.account_mappings = clean_account_mappings(Some(mapping.account_mappings), accounts);
    mapping
}

// ============================================================================
// Tool Implementation
// ============================================================================

/// Candidate `skipTopRows` values tried when the model's value misses the
/// headers its field mappings name.
const MAX_HEADER_SEARCH_ROWS: usize = 30;

/// Lines read while searching for the header row: enough for
/// `MAX_HEADER_SEARCH_ROWS` rows plus blank lines, without reparsing the
/// whole file for every candidate.
const HEADER_SEARCH_LINES: usize = 128;

/// Finds the attached CSV file the model named. A file attached again under
/// the same name replaces the earlier one, so the newest match wins.
pub(crate) fn find_csv_attachment<'a>(
    attachments: &'a [MessageAttachment],
    name: &str,
) -> Result<&'a MessageAttachment, AiError> {
    let name = name.trim();
    if let Some(attachment) = attachments
        .iter()
        .rev()
        .find(|attachment| attachment.is_csv() && attachment.name == name)
    {
        return Ok(attachment);
    }

    let available: Vec<&str> = attachments
        .iter()
        .filter(|attachment| attachment.is_csv())
        .map(|attachment| attachment.name.as_str())
        .collect();
    if available.is_empty() {
        return Err(AiError::ToolExecutionFailed(
            "No CSV file is attached in this chat. Ask the user to attach the CSV file."
                .to_string(),
        ));
    }
    Err(AiError::ToolExecutionFailed(format!(
        "No attached CSV file is named '{}'. Attached CSV files: {}.",
        name,
        available.join(", ")
    )))
}

fn leading_lines(content: &[u8], lines: usize) -> &[u8] {
    content
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .nth(lines.saturating_sub(1))
        .map_or(content, |(index, _)| &content[..=index])
}

/// Tool to infer a CSV import mapping. Does NOT build drafts or validate —
/// the frontend runs the backend pipeline with the returned mapping.
pub struct ImportCsvTool<E: AiEnvironment> {
    env: Arc<E>,
    base_currency: String,
    /// CSV files attached in this thread during the app session.
    attachments: Arc<Vec<MessageAttachment>>,
}

impl<E: AiEnvironment> ImportCsvTool<E> {
    pub fn new(env: Arc<E>, base_currency: String, attachments: Vec<MessageAttachment>) -> Self {
        Self {
            env,
            base_currency,
            attachments: Arc::new(attachments),
        }
    }

    /// `skipTopRows` counts the parser's rows, which leave out blank lines, so
    /// a model that counts lines can skip past the header. When the row the
    /// model chose lacks some of the headers the mapping names, returns the
    /// first row that has the most of them, if that is more.
    fn locate_header_row(
        &self,
        content: &[u8],
        config: &ParseConfig,
        field_mappings: &HashMap<String, FieldMappingValue>,
    ) -> Option<usize> {
        if field_mappings.is_empty() {
            return None;
        }
        let hits_at = |content: &[u8], skip: usize| {
            let config = ParseConfig {
                skip_top_rows: Some(skip),
                skip_bottom_rows: None,
                ..config.clone()
            };
            self.env
                .activity_service()
                .parse_csv(content, &config)
                .ok()
                .map(|parsed| mapped_header_hits(&parsed.headers, field_mappings))
        };

        // The requested row may lie beyond the search window, so score it on
        // the whole file.
        let chosen_hits = hits_at(content, config.top_skip()).unwrap_or(0);
        if chosen_hits == field_mappings.len() {
            return None;
        }
        let search_content = leading_lines(content, HEADER_SEARCH_LINES);
        let mut best: Option<(usize, usize)> = None;
        for skip in 0..=MAX_HEADER_SEARCH_ROWS {
            let Some(hits) = hits_at(search_content, skip) else {
                break;
            };
            if hits > best.map_or(chosen_hits, |(_, best_hits)| best_hits) {
                best = Some((skip, hits));
            }
            if hits == field_mappings.len() {
                break;
            }
        }
        best.map(|(skip, _)| skip)
    }
}

impl<E: AiEnvironment> Clone for ImportCsvTool<E> {
    fn clone(&self) -> Self {
        Self {
            env: self.env.clone(),
            base_currency: self.base_currency.clone(),
            attachments: self.attachments.clone(),
        }
    }
}

impl<E: AiEnvironment + 'static> Tool for ImportCsvTool<E> {
    const NAME: &'static str = "import_csv";

    type Error = AiError;
    type Args = ImportCsvArgs;
    type Output = ImportCsvMappingOutput;

    fn description(&self) -> String {
        "REQUIRED for CSV file imports. When a user attaches a CSV file, you MUST call this tool \
                with the file's name in attachmentName. The app reads the attached file itself: never copy \
                CSV rows into the call. \
                The tool returns a mapping (column→field, value normalization, symbol translations, parse config); \
                the app then parses/validates the whole file and shows the user an inline review grid in the chat. \
                You do NOT need to parse or validate the data yourself. \
                \n\nA large CSV appears in the message as a preview: its first and last lines plus each \
                column's distinct values. That is enough to build the mapping. Attached CSV files stay available \
                for the rest of the app session, so to change the mapping or the account, call this tool again \
                with the same attachmentName, passing the current import's mapping from the app context with \
                your change. CSV text typed into the message cannot be imported: ask the user to \
                attach it as a file. \
                \n\nFor investment/brokerage activity CSVs: when CSV symbol values look like company NAMES rather than tickers, populate `symbolMappings` with \
                name→ticker pairs using your knowledge of public companies. Examples: {\"Cloudflare\": \"NET\", \
                \"Apple Inc\": \"AAPL\", \"Tesla Inc.\": \"TSLA\"}. For values you are unsure about, leave them \
                out — the user will resolve them in the chat review step. \
                For CASH and CREDIT_CARD account statement CSVs, do NOT map merchant/payee/description values to \
                symbols or tickers. Map merchant/payee/description columns to `comment`; the app treats those rows \
                as cash/card transactions, not investment asset activity. \
                \n\nFor `parseConfig` fields (delimiter, skipTopRows, skipBottomRows, dateFormat, decimalSeparator, \
                thousandsSeparator, defaultCurrency): detect non-defaults from the sample rows. European brokers \
                often use `;` delimiter, `,` decimal, `.` thousands, and DD/MM/YYYY dates. Many broker exports have \
                a multi-line preamble before the real header row — pass skipTopRows to skip it. Totals/disclaimer \
                lines at the end need skipBottomRows.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "attachmentName": {
                    "type": "string",
                    "description": "File name of the attached CSV to import, exactly as shown with the attachment (e.g. \"trades.csv\")."
                },
                "accountId": {
                    "type": ["string", "null"],
                    "description": "Account UUID to assign to all imported activities. If the user mentions an account by name (e.g. 'Joint', 'RRSP'), call get_accounts first to resolve the name to an ID. Pass null only if the user didn't specify an account."
                },
                "fieldMappings": {
                    "type": ["object", "null"],
                    "description": "Maps field names to CSV header names. Investment keys: date, activityType, symbol, quantity, unitPrice, amount, fee, fxRate, subtype, currency, account, comment. For CASH/CREDIT_CARD statements, prefer only date, activityType, amount, fee, fxRate, subtype, currency, account, comment. A value may be a list of fallback headers, first non-empty per row wins (e.g. amount: [\"Debit\", \"Credit\"]).",
                    "additionalProperties": { "type": ["string", "array"], "items": { "type": "string" } }
                },
                "activityMappings": {
                    "type": ["object", "null"],
                    "description": "Maps canonical activity types (BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, SPLIT, FEE, TAX) to CSV values. Common English verbs (Buy/Bought/Purchase, Sell/Sold, Dividend/Div, etc.) are already covered by defaults — you only need to add non-English or broker-specific terms. E.g., {\"BUY\": [\"Achat\", \"Kopen\"], \"DIVIDEND\": [\"Dividende\"]}. Pass null if all CSV values are covered by defaults.",
                    "additionalProperties": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                },
                "symbolMappings": {
                    "type": ["object", "null"],
                    "description": "Maps CSV symbol values (tickers OR public-company names) to canonical tickers for investment activity imports only. For CASH/CREDIT_CARD statements, pass null and map merchant/payee text to comment instead.",
                    "additionalProperties": { "type": "string" }
                },
                "accountMappings": {
                    "type": ["object", "null"],
                    "description": "Maps CSV account values to app account IDs. Pass null if using accountId or no mapping needed.",
                    "additionalProperties": { "type": "string" }
                },
                "delimiter": {
                    "type": ["string", "null"],
                    "description": "CSV delimiter: \",\", \";\", \"\\t\". Pass null for auto-detection."
                },
                "skipTopRows": {
                    "type": ["integer", "null"],
                    "description": "Number of NON-HEADER rows to skip at the top (preamble/disclaimer lines BEFORE the column header row). Do NOT count the header row itself or blank lines — only count text like account names, date ranges, disclaimers that appear before the row with column headers. Example: if rows 1-3 are preamble and row 4 is 'Date,Symbol,Qty,...', pass 3 (not 4). Pass null or 0 if the header is the first row. The app moves this to the row holding the headers named in fieldMappings."
                },
                "skipBottomRows": {
                    "type": ["integer", "null"],
                    "description": "Number of rows to skip at the bottom (totals/disclaimer footer rows). Pass null or 0 if no rows to skip."
                },
                "dateFormat": {
                    "type": ["string", "null"],
                    "description": "Date format hint using strftime: \"%Y-%m-%d\", \"%d/%m/%Y\", \"%m/%d/%Y\". Pass null for auto-detection."
                },
                "decimalSeparator": {
                    "type": ["string", "null"],
                    "description": "Decimal separator: \".\", \",\". Pass null for auto-detection."
                },
                "thousandsSeparator": {
                    "type": ["string", "null"],
                    "description": "Thousands separator: \",\", \".\", \" \", \"none\". Pass null for auto-detection."
                },
                "defaultCurrency": {
                    "type": ["string", "null"],
                    "description": "Default currency when rows don't specify one (e.g., \"EUR\" for European broker statements)."
                }
            },
            "required": ["attachmentName"],
            "additionalProperties": false
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let attachment = find_csv_attachment(&self.attachments, &args.attachment_name)?;
        let csv_content = attachment.data.as_bytes();
        debug!(
            "import_csv called: content_len={}, account_id={:?}, delimiter={:?}",
            csv_content.len(),
            args.account_id,
            args.delimiter
        );

        // Get available accounts
        let accounts = self
            .env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AiError::ToolExecutionFailed(e.to_string()))?;

        let available_accounts: Vec<AccountOption> = accounts
            .iter()
            .map(|a| AccountOption {
                id: a.id.clone(),
                name: a.name.clone(),
                currency: a.currency.clone(),
                account_type: Some(a.account_type.clone()),
            })
            .collect();
        let account_id = args
            .account_id
            .as_deref()
            .and_then(|id| valid_account_id(id, &accounts));
        let account_type = account_id
            .as_deref()
            .and_then(|id| accounts.iter().find(|account| account.id == id))
            .map(|account| account.account_type.as_str());
        let is_transaction_account = is_transaction_account_type(account_type);

        // Build the parse config from LLM input (unset fields fall back to auto-detect).
        let llm_parse_config = ParseConfig {
            delimiter: args.delimiter.clone(),
            skip_top_rows: args.skip_top_rows,
            skip_bottom_rows: args.skip_bottom_rows,
            date_format: args.date_format.clone(),
            decimal_separator: args.decimal_separator.clone(),
            thousands_separator: args.thousands_separator.clone(),
            default_currency: args
                .default_currency
                .clone()
                .or_else(|| Some(self.base_currency.clone())),
            ..Default::default()
        };

        // Fast path: saved template exists for this account.
        let mut used_saved_profile = false;
        let mut mapping: Option<ImportMappingData> = None;
        if let Some(ref account_id) = account_id {
            if !has_usable_llm_mappings(&args) {
                if let Ok(saved) = self
                    .env
                    .activity_service()
                    .get_import_mapping(account_id.clone(), import_type::ACTIVITY.to_string())
                {
                    debug!("Loaded saved import mapping for account {}", account_id);
                    used_saved_profile = true;
                    mapping = Some(saved);
                }
            }
        }

        // Parse CSV to get headers + sample rows for the UI preview.
        let mut effective_parse_config = match &mapping {
            Some(m) => merge_parse_config(
                m.parse_config
                    .clone()
                    .unwrap_or_else(|| llm_parse_config.clone()),
                &llm_parse_config,
                args.default_currency.is_some(),
            ),
            None => llm_parse_config.clone(),
        };
        let requested_field_mappings = match &mapping {
            Some(m) => m.field_mappings.clone(),
            None => clean_field_mappings(args.field_mappings.clone()),
        };
        if let Some(skip_top_rows) = self.locate_header_row(
            csv_content,
            &effective_parse_config,
            &requested_field_mappings,
        ) {
            debug!(
                "import_csv: header row found at skipTopRows={} (requested {:?})",
                skip_top_rows, effective_parse_config.skip_top_rows
            );
            effective_parse_config.skip_top_rows = Some(skip_top_rows);
        }
        let parsed_csv = self
            .env
            .activity_service()
            .parse_csv(csv_content, &effective_parse_config)
            .map_err(|e| AiError::ToolExecutionFailed(format!("CSV parse error: {}", e)))?;

        let headers = parsed_csv.headers.clone();
        let total_rows = parsed_csv.rows.len();
        if total_rows == 0 {
            debug!("import_csv: parse_csv returned 0 data rows");
        }
        let sample_rows = Vec::new();

        // If we have no saved template, build the mapping from LLM + auto-detect.
        let applied_mapping = if let Some(m) = mapping {
            m
        } else {
            let llm_field_mappings = clean_field_mappings(args.field_mappings.clone());
            let field_mappings = if llm_field_mappings.is_empty() {
                auto_detect_field_mapping_values(&headers, is_transaction_account)
            } else {
                sanitize_field_mappings_for_account(llm_field_mappings, is_transaction_account)
            };

            ImportMappingData {
                account_id: account_id.clone().unwrap_or_default(),
                context_kind: import_type::ACTIVITY.to_string(),
                field_mappings,
                activity_mappings: merge_activity_mappings(
                    args.activity_mappings.clone(),
                    account_type,
                ),
                symbol_mappings: if is_transaction_account {
                    HashMap::new()
                } else {
                    clean_string_map(args.symbol_mappings.clone())
                },
                account_mappings: clean_account_mappings(args.account_mappings.clone(), &accounts),
                parse_config: Some(effective_parse_config.clone()),
                ..Default::default()
            }
        };
        let applied_mapping = sanitize_mapping_accounts(applied_mapping, &accounts);
        let applied_mapping = sanitize_mapping_for_account(applied_mapping, account_type);

        let mapping_confidence = if used_saved_profile {
            MappingConfidence::High
        } else {
            estimate_confidence(&applied_mapping, &headers, is_transaction_account)
        };

        Ok(ImportCsvMappingOutput {
            attachment_name: attachment.name.clone(),
            applied_mapping,
            parse_config: effective_parse_config,
            account_id,
            detected_headers: headers,
            sample_rows,
            total_rows,
            mapping_confidence,
            available_accounts,
            used_saved_profile,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::{MockAccountService, MockEnvironment};
    use chrono::Utc;
    use wealthfolio_core::activities::into_field_mapping_values;

    const ATTACHMENT_NAME: &str = "trades.csv";

    fn csv_attachment(data: &str) -> MessageAttachment {
        MessageAttachment {
            name: ATTACHMENT_NAME.to_string(),
            content_type: "text/csv".to_string(),
            data: data.to_string(),
        }
    }

    fn headers(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn account(id: &str, name: &str, currency: &str) -> Account {
        Account {
            id: id.to_string(),
            name: name.to_string(),
            account_type: account_types::SECURITIES.to_string(),
            currency: currency.to_string(),
            is_active: true,
            created_at: Utc::now().naive_utc(),
            updated_at: Utc::now().naive_utc(),
            ..Account::default()
        }
    }

    fn account_with_type(id: &str, name: &str, currency: &str, account_type: &str) -> Account {
        Account {
            account_type: account_type.to_string(),
            ..account(id, name, currency)
        }
    }

    #[test]
    fn test_parse_config_overrides_saved_profile_without_clobbering_currency() {
        let saved = ParseConfig {
            delimiter: Some(",".to_string()),
            date_format: Some("%m/%d/%Y".to_string()),
            default_currency: Some("CAD".to_string()),
            ..Default::default()
        };
        let overrides = ParseConfig {
            delimiter: Some(";".to_string()),
            date_format: None,
            default_currency: Some("USD".to_string()),
            ..Default::default()
        };

        let merged = merge_parse_config(saved.clone(), &overrides, false);
        assert_eq!(merged.delimiter.as_deref(), Some(";"));
        assert_eq!(merged.date_format.as_deref(), Some("%m/%d/%Y"));
        assert_eq!(merged.default_currency.as_deref(), Some("CAD"));

        let merged = merge_parse_config(saved, &overrides, true);
        assert_eq!(merged.default_currency.as_deref(), Some("USD"));
    }

    #[test]
    fn test_auto_detect_field_mappings() {
        let headers = vec![
            "Date".to_string(),
            "Symbol".to_string(),
            "Quantity".to_string(),
            "Price".to_string(),
            "Total".to_string(),
            "Type".to_string(),
        ];
        let mappings = auto_detect_field_mappings(&headers);
        assert_eq!(mappings.get(FIELD_DATE), Some(&"Date".to_string()));
        assert_eq!(mappings.get(FIELD_SYMBOL), Some(&"Symbol".to_string()));
        assert_eq!(mappings.get(FIELD_QUANTITY), Some(&"Quantity".to_string()));
        assert_eq!(mappings.get(FIELD_UNIT_PRICE), Some(&"Price".to_string()));
        assert_eq!(mappings.get(FIELD_AMOUNT), Some(&"Total".to_string()));
        assert_eq!(mappings.get(FIELD_ACTIVITY_TYPE), Some(&"Type".to_string()));
    }

    #[test]
    fn test_estimate_confidence_high() {
        let mapping = ImportMappingData {
            field_mappings: into_field_mapping_values(
                [
                    (FIELD_DATE.to_string(), "Date".to_string()),
                    (FIELD_ACTIVITY_TYPE.to_string(), "Type".to_string()),
                    (FIELD_SYMBOL.to_string(), "Symbol".to_string()),
                    (FIELD_QUANTITY.to_string(), "Quantity".to_string()),
                ]
                .into_iter()
                .collect(),
            ),
            ..Default::default()
        };
        assert_eq!(
            estimate_confidence(
                &mapping,
                &headers(&["Date", "Type", "Symbol", "Quantity"]),
                false
            ),
            MappingConfidence::High
        );
    }

    #[test]
    fn test_estimate_confidence_low() {
        let mapping = ImportMappingData {
            field_mappings: into_field_mapping_values(
                [(FIELD_DATE.to_string(), "Date".to_string())]
                    .into_iter()
                    .collect(),
            ),
            ..Default::default()
        };
        assert_eq!(
            estimate_confidence(&mapping, &headers(&["Date"]), false),
            MappingConfidence::Low
        );
    }

    #[test]
    fn test_transaction_auto_detect_hides_asset_fields() {
        let headers = vec![
            "Transaction Date".to_string(),
            "Merchant".to_string(),
            "Debit".to_string(),
            "Credit".to_string(),
            "Type".to_string(),
        ];

        let mappings = auto_detect_field_mapping_values(&headers, true);

        assert_eq!(
            mappings.get(FIELD_DATE),
            Some(&FieldMappingValue::Single("Transaction Date".to_string()))
        );
        assert_eq!(
            mappings.get(FIELD_COMMENT),
            Some(&FieldMappingValue::Single("Merchant".to_string()))
        );
        assert_eq!(
            mappings.get(FIELD_AMOUNT),
            Some(&FieldMappingValue::Fallback(vec![
                "Debit".to_string(),
                "Credit".to_string()
            ]))
        );
        assert!(!mappings.contains_key(FIELD_SYMBOL));
        assert!(!mappings.contains_key(FIELD_QUANTITY));
        assert!(!mappings.contains_key(FIELD_UNIT_PRICE));
    }

    #[tokio::test]
    async fn test_import_csv_basic_returns_mapping() {
        let env = Arc::new(MockEnvironment::new());
        let csv = "Date,Symbol,Quantity,Price,Type\n2024-01-15,AAPL,10,150.00,Buy";
        let tool = ImportCsvTool::new(env, "USD".to_string(), vec![csv_attachment(csv)]);
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: None,
            field_mappings: None,
            activity_mappings: None,
            symbol_mappings: None,
            account_mappings: None,
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        assert_eq!(result.total_rows, 1);
        assert_eq!(result.detected_headers.len(), 5);
        assert!(!result.used_saved_profile);
        // Auto-detect picks the obvious columns.
        let f = &result.applied_mapping.field_mappings;
        assert!(f.contains_key(FIELD_DATE));
        assert!(f.contains_key(FIELD_SYMBOL));
        assert!(f.contains_key(FIELD_ACTIVITY_TYPE));
        // Even with no LLM-provided activity_mappings, defaults cover the
        // common English verbs so the frontend can map CSV values to canonical
        // types.
        let am = &result.applied_mapping.activity_mappings;
        assert!(am.contains_key("BUY"));
        assert!(am
            .get("BUY")
            .unwrap()
            .iter()
            .any(|v| v.to_uppercase() == "PURCHASE"));
        assert!(am.contains_key("DIVIDEND"));
    }

    #[tokio::test]
    async fn test_import_csv_credit_card_returns_transaction_mapping() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account_with_type(
                "card-1",
                "Visa",
                "USD",
                account_types::CREDIT_CARD,
            )],
        });
        let tool = ImportCsvTool::new(
            Arc::new(env),
            "USD".to_string(),
            vec![csv_attachment(
                "Date,Merchant,Debit,Credit,Type\n2024-01-15,Starbucks,12.50,,Purchase",
            )],
        );
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: Some("card-1".to_string()),
            field_mappings: None,
            activity_mappings: None,
            symbol_mappings: Some(
                [("Starbucks".to_string(), "SBUX".to_string())]
                    .into_iter()
                    .collect(),
            ),
            account_mappings: None,
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        let fields = &result.applied_mapping.field_mappings;
        assert!(fields.contains_key(FIELD_DATE));
        assert!(fields.contains_key(FIELD_COMMENT));
        assert!(fields.contains_key(FIELD_AMOUNT));
        assert!(!fields.contains_key(FIELD_SYMBOL));
        assert!(result.applied_mapping.symbol_mappings.is_empty());
        assert!(result
            .applied_mapping
            .activity_mappings
            .get("WITHDRAWAL")
            .unwrap()
            .iter()
            .any(|value| value == "PURCHASE"));
        assert!(!result.applied_mapping.activity_mappings.contains_key("BUY"));
        assert_eq!(result.mapping_confidence, MappingConfidence::High);
        assert_eq!(
            result.available_accounts[0].account_type.as_deref(),
            Some(account_types::CREDIT_CARD)
        );
    }

    #[test]
    fn test_merge_activity_mappings_llm_additions() {
        let mut llm = HashMap::new();
        llm.insert("BUY".to_string(), vec!["Kopen".to_string()]);
        llm.insert("DIVIDEND".to_string(), vec!["Dividende".to_string()]);
        let merged = merge_activity_mappings(Some(llm), None);
        // Defaults preserved.
        assert!(merged
            .get("BUY")
            .unwrap()
            .iter()
            .any(|v| v.to_uppercase() == "PURCHASE"));
        // LLM additions merged in.
        assert!(merged.get("BUY").unwrap().iter().any(|v| v == "Kopen"));
        assert!(merged
            .get("DIVIDEND")
            .unwrap()
            .iter()
            .any(|v| v == "Dividende"));
    }

    #[test]
    fn test_empty_nullable_maps_are_not_usable_llm_mappings() {
        let args: ImportCsvArgs = serde_json::from_value(serde_json::json!({
            "attachmentName": "trades.csv",
            "fieldMappings": { "date": null },
            "symbolMappings": { "Apple": "   " },
            "accountMappings": {}
        }))
        .unwrap();

        assert!(clean_field_mappings(args.field_mappings.clone()).is_empty());
        assert!(!has_usable_string_map(&args.symbol_mappings));
        assert!(!has_usable_string_map(&args.account_mappings));
        assert!(!has_usable_llm_mappings(&args));
        assert!(clean_string_map(args.symbol_mappings).is_empty());
    }

    #[test]
    fn test_non_empty_mappings_are_usable() {
        let mut field_mappings = HashMap::new();
        field_mappings.insert("date".to_string(), "Datum".to_string());
        assert!(has_usable_string_map(&Some(field_mappings)));

        let mut activity_mappings = HashMap::new();
        activity_mappings.insert("BUY".to_string(), vec!["  ".to_string()]);
        assert!(!has_usable_activity_mappings(&Some(
            activity_mappings.clone()
        )));

        activity_mappings.insert("BUY".to_string(), vec!["Kopen".to_string()]);
        assert!(has_usable_activity_mappings(&Some(activity_mappings)));
    }

    #[tokio::test]
    async fn test_import_csv_with_llm_mapping() {
        let env = Arc::new(MockEnvironment::new());
        let csv = "Datum,Ticker,Aantal,Prijs,Actie\n2024-01-15,AAPL,10,150.00,Kopen";

        let mut field_mappings = HashMap::new();
        field_mappings.insert("date".to_string(), "Datum".to_string());
        field_mappings.insert("symbol".to_string(), "Ticker".to_string());
        field_mappings.insert("quantity".to_string(), "Aantal".to_string());
        field_mappings.insert("unitPrice".to_string(), "Prijs".to_string());
        field_mappings.insert("activityType".to_string(), "Actie".to_string());

        let mut activity_mappings = HashMap::new();
        activity_mappings.insert("BUY".to_string(), vec!["Kopen".to_string()]);

        let tool = ImportCsvTool::new(env, "USD".to_string(), vec![csv_attachment(csv)]);
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: None,
            field_mappings: Some(into_field_mapping_values(field_mappings)),
            activity_mappings: Some(activity_mappings),
            symbol_mappings: None,
            account_mappings: None,
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        assert_eq!(result.total_rows, 1);
        let buy = result.applied_mapping.activity_mappings.get("BUY").unwrap();
        assert!(buy.iter().any(|v| v == "Kopen"));
        // Defaults are merged in alongside the LLM-provided CSV value.
        assert!(buy.iter().any(|v| v.to_uppercase() == "PURCHASE"));
    }

    #[tokio::test]
    async fn test_import_csv_drops_unknown_account_id() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acct-1", "Default", "USD")],
        });
        let tool = ImportCsvTool::new(
            Arc::new(env),
            "USD".to_string(),
            vec![csv_attachment(
                "Date,Symbol,Quantity,Price,Type\n2024-01-15,AAPL,10,150.00,Buy",
            )],
        );
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: Some("stale-account".to_string()),
            field_mappings: None,
            activity_mappings: None,
            symbol_mappings: None,
            account_mappings: None,
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        assert_eq!(result.account_id, None);
        assert_eq!(result.applied_mapping.account_id, "");
    }

    #[tokio::test]
    async fn test_import_csv_keeps_valid_account_ids_and_drops_invalid_mappings() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account("acct-1", "Default", "USD")],
        });
        let mut account_mappings = HashMap::new();
        account_mappings.insert("Broker Account".to_string(), "acct-1".to_string());
        account_mappings.insert("Old Account".to_string(), "stale-account".to_string());

        let tool = ImportCsvTool::new(
            Arc::new(env),
            "USD".to_string(),
            vec![csv_attachment(
                "Date,Symbol,Quantity,Price,Type\n2024-01-15,AAPL,10,150.00,Buy",
            )],
        );
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: Some("acct-1".to_string()),
            field_mappings: None,
            activity_mappings: None,
            symbol_mappings: None,
            account_mappings: Some(account_mappings),
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        assert_eq!(result.account_id, Some("acct-1".to_string()));
        assert_eq!(result.applied_mapping.account_id, "acct-1");
        assert_eq!(
            result
                .applied_mapping
                .account_mappings
                .get("Broker Account"),
            Some(&"acct-1".to_string())
        );
        assert!(!result
            .applied_mapping
            .account_mappings
            .contains_key("Old Account"));
    }

    #[tokio::test]
    async fn test_import_csv_with_symbol_name_mapping() {
        // AI translates company names to tickers via symbol_mappings.
        let env = Arc::new(MockEnvironment::new());
        let csv = "Date,Company,Qty\n2024-01-15,Cloudflare,50";

        let mut symbol_mappings = HashMap::new();
        symbol_mappings.insert("Cloudflare".to_string(), "NET".to_string());

        let tool = ImportCsvTool::new(env, "USD".to_string(), vec![csv_attachment(csv)]);
        let args = ImportCsvArgs {
            attachment_name: ATTACHMENT_NAME.to_string(),
            account_id: None,
            field_mappings: None,
            activity_mappings: None,
            symbol_mappings: Some(symbol_mappings),
            account_mappings: None,
            delimiter: None,
            skip_top_rows: None,
            skip_bottom_rows: None,
            date_format: None,
            decimal_separator: None,
            thousands_separator: None,
            default_currency: None,
        };

        let result = tool.call(args).await.unwrap();
        assert_eq!(
            result.applied_mapping.symbol_mappings.get("Cloudflare"),
            Some(&"NET".to_string())
        );
    }

    const PREAMBLE_STATEMENT: &str = "Account Statement\n\
        Account: 12345678\n\
        Period: 01/01/2024 - 31/03/2024\n\
        \n\
        Trade Date,Security,Type,Quantity,Price,Amount\n\
        15/01/2024,\"Apple Inc, Common\",Buy,10,\"1,234.56\",\"12,345.60\"\n\
        16/01/2024,Microsoft Corp,Sell,5,400.00,2000.00\n";

    fn statement_field_mappings() -> HashMap<String, FieldMappingValue> {
        [
            ("date", "Trade Date"),
            ("symbol", "Security"),
            ("activityType", "Type"),
            ("quantity", "Quantity"),
            ("unitPrice", "Price"),
            ("amount", "Amount"),
        ]
        .into_iter()
        .map(|(field, header)| {
            (
                field.to_string(),
                FieldMappingValue::Single(header.to_string()),
            )
        })
        .collect()
    }

    fn statement_tool() -> ImportCsvTool<MockEnvironment> {
        ImportCsvTool::new(
            Arc::new(MockEnvironment::new()),
            "USD".to_string(),
            vec![csv_attachment(PREAMBLE_STATEMENT)],
        )
    }

    #[tokio::test]
    async fn test_import_csv_moves_skip_top_rows_to_the_mapped_header_row() {
        // The blank line is not a parser row, so a model counting lines asks
        // for 4 and would skip the header.
        let result = statement_tool()
            .call(ImportCsvArgs {
                attachment_name: ATTACHMENT_NAME.to_string(),
                field_mappings: Some(statement_field_mappings()),
                skip_top_rows: Some(4),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(result.parse_config.skip_top_rows, Some(3));
        assert_eq!(
            result.applied_mapping.parse_config.unwrap().skip_top_rows,
            Some(3)
        );
        assert_eq!(result.detected_headers[0], "Trade Date");
        assert_eq!(result.total_rows, 2);
        assert_eq!(result.mapping_confidence, MappingConfidence::High);
    }

    #[tokio::test]
    async fn test_import_csv_keeps_skip_top_rows_that_lands_on_the_header() {
        let result = statement_tool()
            .call(ImportCsvArgs {
                attachment_name: ATTACHMENT_NAME.to_string(),
                field_mappings: Some(statement_field_mappings()),
                skip_top_rows: Some(3),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(result.parse_config.skip_top_rows, Some(3));
        assert_eq!(result.total_rows, 2);
    }

    /// A requested header row far down the file is checked against the whole
    /// file, not only the lines the search reads, so an earlier section with
    /// the same headers does not replace it.
    #[tokio::test]
    async fn test_import_csv_keeps_a_requested_header_row_beyond_the_search_window() {
        let header = "Date,Symbol,Quantity,Price,Type\n";
        let mut csv = String::from(header);
        for row in 0..129 {
            csv.push_str(&format!("2023-01-01,OLD{row},1,10.00,Buy\n"));
        }
        csv.push_str(header);
        for row in 0..3 {
            csv.push_str(&format!("2024-01-01,NEW{row},1,10.00,Buy\n"));
        }
        let tool = ImportCsvTool::new(
            Arc::new(MockEnvironment::new()),
            "USD".to_string(),
            vec![csv_attachment(&csv)],
        );

        let result = tool
            .call(ImportCsvArgs {
                attachment_name: ATTACHMENT_NAME.to_string(),
                field_mappings: Some(into_field_mapping_values(
                    [
                        ("date", "Date"),
                        ("symbol", "Symbol"),
                        ("quantity", "Quantity"),
                        ("unitPrice", "Price"),
                        ("activityType", "Type"),
                    ]
                    .into_iter()
                    .map(|(field, header)| (field.to_string(), header.to_string()))
                    .collect(),
                )),
                skip_top_rows: Some(130),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(result.parse_config.skip_top_rows, Some(130));
        assert_eq!(result.total_rows, 3);
    }

    #[tokio::test]
    async fn test_import_csv_confidence_ignores_mapped_headers_the_file_lacks() {
        let field_mappings = [
            ("date", "Date"),
            ("symbol", "Symbol"),
            ("activityType", "Action"),
            ("quantity", "Qty"),
        ]
        .into_iter()
        .map(|(field, header)| {
            (
                field.to_string(),
                FieldMappingValue::Single(header.to_string()),
            )
        })
        .collect();

        let result = statement_tool()
            .call(ImportCsvArgs {
                attachment_name: ATTACHMENT_NAME.to_string(),
                field_mappings: Some(field_mappings),
                skip_top_rows: Some(3),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(result.parse_config.skip_top_rows, Some(3));
        assert_eq!(result.mapping_confidence, MappingConfidence::Low);
    }

    #[tokio::test]
    async fn test_import_csv_parses_every_row_of_the_attached_file() {
        let mut csv = String::from("Date,Symbol,Quantity,Price,Type\n");
        for day in 0..500 {
            csv.push_str(&format!("2024-01-01,SYM{day},{},10.00,Buy\n", day + 1));
        }
        let tool = ImportCsvTool::new(
            Arc::new(MockEnvironment::new()),
            "USD".to_string(),
            vec![csv_attachment(&csv)],
        );

        let result = tool
            .call(ImportCsvArgs {
                attachment_name: ATTACHMENT_NAME.to_string(),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(result.attachment_name, ATTACHMENT_NAME);
        assert_eq!(result.total_rows, 500);
    }

    /// The fictional files of the CSV import evals reach the grid whole:
    /// parsing each with the tool's parseConfig gives the file's header and
    /// every row, also when the model counts the blank line in skipTopRows.
    #[tokio::test]
    async fn test_import_csv_eval_files_reach_the_grid_whole() {
        let trades = [
            ("date", "Date"),
            ("activityType", "Action"),
            ("symbol", "Symbol"),
            ("quantity", "Quantity"),
            ("unitPrice", "Price"),
            ("fee", "Commission"),
            ("amount", "Net Amount"),
            ("currency", "Currency"),
        ];
        let statement = [
            ("date", "Trade Date"),
            ("activityType", "Transaction"),
            ("symbol", "Ticker"),
            ("quantity", "Shares"),
            ("unitPrice", "Unit Price"),
            ("fee", "Fees"),
            ("amount", "Total"),
            ("currency", "Ccy"),
        ];
        let files = [
            (
                include_str!("../../evals/data/csv/trades_500.csv"),
                trades,
                None,
                0,
                500,
            ),
            (
                include_str!("../../evals/data/csv/statement_messy_080.csv"),
                statement,
                Some(4),
                3,
                80,
            ),
        ];

        for (data, mappings, requested_skip, header_row, rows) in files {
            let tool = ImportCsvTool::new(
                Arc::new(MockEnvironment::new()),
                "USD".to_string(),
                vec![csv_attachment(data)],
            );
            let result = tool
                .call(ImportCsvArgs {
                    attachment_name: ATTACHMENT_NAME.to_string(),
                    field_mappings: Some(
                        mappings
                            .into_iter()
                            .map(|(field, header)| {
                                (
                                    field.to_string(),
                                    FieldMappingValue::Single(header.to_string()),
                                )
                            })
                            .collect(),
                    ),
                    skip_top_rows: requested_skip,
                    ..Default::default()
                })
                .await
                .unwrap();

            let grid =
                wealthfolio_core::activities::parse_csv(data.as_bytes(), &result.parse_config)
                    .unwrap();
            let source = wealthfolio_core::activities::parse_csv(
                data.as_bytes(),
                &ParseConfig {
                    skip_top_rows: Some(header_row),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(source.rows.len(), rows);
            assert_eq!(result.total_rows, rows);
            assert_eq!(grid.headers, source.headers);
            assert!(
                grid.rows == source.rows,
                "every row reaches the grid unchanged"
            );
        }
    }

    /// The working context shows the applied mapping, fallback lists
    /// included, for the model to pass back on a re-import.
    #[tokio::test]
    async fn test_import_csv_accepts_fallback_field_mappings() {
        let mut env = MockEnvironment::new();
        env.account_service = Arc::new(MockAccountService {
            accounts: vec![account_with_type(
                "card-1",
                "Visa",
                "USD",
                account_types::CREDIT_CARD,
            )],
        });
        let tool = ImportCsvTool::new(
            Arc::new(env),
            "USD".to_string(),
            vec![csv_attachment(
                "Date,Merchant,Debit,Credit,Type\n2024-01-15,Starbucks,12.50,,Purchase",
            )],
        );
        let args: ImportCsvArgs = serde_json::from_value(serde_json::json!({
            "attachmentName": ATTACHMENT_NAME,
            "accountId": "card-1",
            "fieldMappings": {
                "date": "Date",
                "comment": "Merchant",
                "activityType": "Type",
                "amount": ["Debit", "Credit"],
                "fee": null
            }
        }))
        .unwrap();

        let result = tool.call(args).await.unwrap();

        let fields = &result.applied_mapping.field_mappings;
        assert_eq!(
            fields.get(FIELD_AMOUNT),
            Some(&FieldMappingValue::Fallback(vec![
                "Debit".to_string(),
                "Credit".to_string()
            ]))
        );
        assert!(!fields.contains_key(FIELD_FEE));
        assert_eq!(result.mapping_confidence, MappingConfidence::High);
    }

    #[test]
    fn test_find_csv_attachment_prefers_the_newest_file_with_that_name() {
        let attachments = vec![
            csv_attachment("Date\n2024-01-01"),
            MessageAttachment {
                name: "receipt.png".to_string(),
                content_type: "image/png".to_string(),
                data: "aGk=".to_string(),
            },
            csv_attachment("Date\n2024-02-02"),
        ];

        let found = find_csv_attachment(&attachments, " trades.csv ").unwrap();
        assert_eq!(found.data, "Date\n2024-02-02");
    }

    #[test]
    fn test_find_csv_attachment_names_the_available_files() {
        let attachments = vec![
            csv_attachment("Date\n2024-01-01"),
            MessageAttachment {
                name: "receipt.png".to_string(),
                content_type: "image/png".to_string(),
                data: "aGk=".to_string(),
            },
        ];

        let error = find_csv_attachment(&attachments, "other.csv")
            .unwrap_err()
            .to_string();
        assert!(error.contains("'other.csv'"));
        assert!(error.contains("trades.csv"));
        assert!(!error.contains("receipt.png"));

        let error = find_csv_attachment(&attachments[1..], "trades.csv")
            .unwrap_err()
            .to_string();
        assert!(error.contains("No CSV file is attached"));
    }
}
