//! Record Activity tool - create activity drafts from natural language input.
//!
//! This tool enables users to record transactions conversationally (e.g., "Buy 20 AAPL at 240 yesterday").
//! Returns an editable draft preview; user confirms via UI button.

use log::debug;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wealthfolio_core::activities::{
    ACTIVITY_SUBTYPE_BONUS, ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND, ACTIVITY_SUBTYPE_DRIP,
    ACTIVITY_SUBTYPE_STAKING_REWARD, ACTIVITY_TYPE_ADJUSTMENT, ACTIVITY_TYPE_BUY,
    ACTIVITY_TYPE_CREDIT, ACTIVITY_TYPE_DEPOSIT, ACTIVITY_TYPE_DIVIDEND, ACTIVITY_TYPE_FEE,
    ACTIVITY_TYPE_INTEREST, ACTIVITY_TYPE_SELL, ACTIVITY_TYPE_SPLIT, ACTIVITY_TYPE_TAX,
    ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT, ACTIVITY_TYPE_UNKNOWN,
    ACTIVITY_TYPE_WITHDRAWAL,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

// ============================================================================
// Tool Arguments (LLM Input)
// ============================================================================

/// Arguments for the record_activity tool.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivityArgs {
    /// Activity type: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TRANSFER_IN,
    /// TRANSFER_OUT, INTEREST, FEE, SPLIT, TAX, CREDIT, ADJUSTMENT, UNKNOWN.
    pub activity_type: String,

    /// Symbol (e.g., "AAPL", "BTC"). Required for trading activities.
    pub symbol: Option<String>,

    /// ISO 8601 date (e.g., "2026-01-17"). LLM converts "yesterday" to ISO.
    pub activity_date: String,

    /// Number of shares/units. Required for BUY/SELL.
    pub quantity: Option<f64>,

    /// Price per unit. If omitted, tool may attempt to fetch historical price.
    pub unit_price: Option<f64>,

    /// Total amount. For DEPOSIT/WITHDRAWAL/DIVIDEND/etc.
    pub amount: Option<f64>,

    /// Transaction fee.
    pub fee: Option<f64>,
    /// Trade-level tax.
    pub tax: Option<f64>,

    /// Account name or ID. If ambiguous/missing, tool returns available accounts.
    pub account: Option<String>,

    /// Activity subtype: DRIP, DIVIDEND_IN_KIND, STAKING_REWARD, BONUS.
    pub subtype: Option<String>,

    /// Optional notes.
    pub notes: Option<String>,
}

// ============================================================================
// Output Types
// ============================================================================

/// Output envelope for record_activity tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActivityOutput {
    /// Draft preview data.
    pub draft: ActivityDraft,

    /// Validation status.
    pub validation: ValidationResult,

    /// Available accounts (for dropdown).
    pub available_accounts: Vec<AccountOption>,

    /// Resolved asset info (if symbol provided and resolved).
    pub resolved_asset: Option<ResolvedAsset>,

    /// Available subtypes for this activity type (for dropdown).
    pub available_subtypes: Vec<SubtypeOption>,
}

/// Activity draft data for preview/editing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDraft {
    pub activity_type: String,
    /// ISO 8601 date.
    pub activity_date: String,
    pub symbol: Option<String>,
    /// Resolved canonical ID (e.g., "SEC:AAPL:XNAS").
    pub asset_id: Option<String>,
    /// Display name for the asset.
    pub asset_name: Option<String>,
    pub quantity: Option<f64>,
    pub unit_price: Option<f64>,
    /// Computed or provided amount.
    pub amount: Option<f64>,
    pub fee: Option<f64>,
    pub tax: Option<f64>,
    /// From asset or account.
    pub currency: String,
    /// Resolved account ID.
    pub account_id: Option<String>,
    /// Display name for the account.
    pub account_name: Option<String>,
    /// Activity subtype.
    pub subtype: Option<String>,
    pub notes: Option<String>,

    /// Price source: "user", "historical", "none".
    pub price_source: String,

    /// Pricing mode: "MARKET" or "MANUAL".
    pub pricing_mode: String,

    /// True if asset not found and needs custom creation.
    pub is_custom_asset: bool,

    /// Asset kind for custom assets: "SECURITY", "CRYPTO", "OTHER".
    pub asset_kind: Option<String>,
}

/// Validation result for the draft.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub is_valid: bool,
    /// Fields that are required but missing (e.g., ["account_id", "quantity"]).
    pub missing_fields: Vec<String>,
    /// Semantic validation errors.
    pub errors: Vec<ValidationError>,
}

/// A validation error for a specific field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub field: String,
    pub message: String,
}

/// An account option for the dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountOption {
    pub id: String,
    pub name: String,
    pub currency: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_type: Option<String>,
}

/// Resolved asset information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAsset {
    /// Canonical asset ID (e.g., "SEC:AAPL:XNAS").
    pub asset_id: String,
    pub symbol: String,
    pub name: String,
    pub currency: String,
    /// Exchange name (e.g., "NASDAQ").
    pub exchange: Option<String>,
    /// Exchange MIC code (e.g., "XNAS").
    pub exchange_mic: Option<String>,
    /// Instrument type from the search provider (e.g., "EQUITY", "ETF", "BOND").
    pub instrument_type: Option<String>,
}

/// A subtype option for the dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtypeOption {
    /// Value (e.g., "DRIP").
    pub value: String,
    /// Display label (e.g., "Dividend Reinvested").
    pub label: String,
}

// ============================================================================
// Constants
// ============================================================================

/// Canonical activity types.
const ACTIVITY_TYPES: &[&str] = &[
    ACTIVITY_TYPE_BUY,
    ACTIVITY_TYPE_SELL,
    ACTIVITY_TYPE_SPLIT,
    ACTIVITY_TYPE_DIVIDEND,
    ACTIVITY_TYPE_INTEREST,
    ACTIVITY_TYPE_DEPOSIT,
    ACTIVITY_TYPE_WITHDRAWAL,
    ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT,
    ACTIVITY_TYPE_FEE,
    ACTIVITY_TYPE_TAX,
    ACTIVITY_TYPE_CREDIT,
    ACTIVITY_TYPE_ADJUSTMENT,
    ACTIVITY_TYPE_UNKNOWN,
];

// ============================================================================
// Subtype Mappings
// ============================================================================

/// Get available subtypes for an activity type.
/// Only includes subtypes that affect calculations (compiler expansion or flow classification).
pub(crate) fn get_subtypes_for_activity_type(activity_type: &str) -> Vec<SubtypeOption> {
    match activity_type.to_uppercase().as_str() {
        // DIVIDEND subtypes
        s if s == ACTIVITY_TYPE_DIVIDEND => vec![
            SubtypeOption {
                value: ACTIVITY_SUBTYPE_DRIP.to_string(),
                label: "Dividend Reinvested (DRIP)".to_string(),
            },
            SubtypeOption {
                value: ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND.to_string(),
                label: "Dividend in Kind".to_string(),
            },
        ],
        // STAKING_REWARD expands to INTEREST + BUY
        s if s == ACTIVITY_TYPE_INTEREST => vec![SubtypeOption {
            value: ACTIVITY_SUBTYPE_STAKING_REWARD.to_string(),
            label: "Staking Reward".to_string(),
        }],
        // BONUS is external flow (affects TWR)
        s if s == ACTIVITY_TYPE_CREDIT => vec![SubtypeOption {
            value: ACTIVITY_SUBTYPE_BONUS.to_string(),
            label: "Bonus".to_string(),
        }],
        _ => vec![],
    }
}

/// The JSON schema for record_activity / per-row of record_activities.
pub(crate) fn record_activity_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "activityType": {
                "type": "string",
                "description": "Activity type: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, INTEREST, FEE, SPLIT, TAX, CREDIT, ADJUSTMENT",
                "enum": ["BUY", "SELL", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "INTEREST", "FEE", "SPLIT", "TAX", "CREDIT", "ADJUSTMENT", "UNKNOWN"]
            },
            "symbol": {
                "type": "string",
                "description": "Symbol or ticker (e.g., 'AAPL', 'BTC', 'VTI'). Required for BUY/SELL/DIVIDEND/SPLIT and asset-backed income subtypes like DRIP, DIVIDEND_IN_KIND, and STAKING_REWARD"
            },
            "activityDate": {
                "type": "string",
                "description": "Concrete ISO 8601 date only, e.g. '2026-01-17'. Do not pass relative phrases like 'yesterday', 'today', 'last Friday', or 'next Monday'. Resolve them relative to the current local date before calling this tool."
            },
            "quantity": {
                "type": "number",
                "description": "Number of shares or units. Required for BUY/SELL/SPLIT and asset-backed income subtypes like DRIP, DIVIDEND_IN_KIND, and STAKING_REWARD"
            },
            "unitPrice": {
                "type": "number",
                "description": "Price or fair market value per unit. Required for BUY/SELL unless amount is provided; for DRIP, DIVIDEND_IN_KIND, and STAKING_REWARD, provide either unitPrice or amount"
            },
            "amount": {
                "type": "number",
                "description": "Total cash amount or taxable income amount. For DRIP, DIVIDEND_IN_KIND, and STAKING_REWARD, provide either amount or unitPrice"
            },
            "fee": {
                "type": "number",
                "description": "Transaction fee (optional)"
            },
            "tax": {
                "type": "number",
                "description": "Trade-level tax amount (optional)"
            },
            "account": {
                "type": "string",
                "description": "Account name or ID. Required before calling this tool when the user has multiple accounts. If the user did not specify an account, ask which account first instead of calling this tool with an empty account."
            },
            "subtype": {
                "type": "string",
                "description": "Activity subtype for semantic variations: DRIP (dividend reinvested), DIVIDEND_IN_KIND (dividend paid as additional units of the same asset), STAKING_REWARD (staking income received as more units of the same asset), BONUS (promotional credit)"
            },
            "notes": {
                "type": "string",
                "description": "Optional notes for the transaction"
            }
        },
        "required": ["activityType", "activityDate"]
    })
}

const RECORD_ACTIVITY_DESCRIPTION: &str = "Record investment transactions from natural language. \
    Creates an editable draft preview for user confirmation — every field can be adjusted before \
    save. Supports all activity types: BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, TRANSFER_IN, \
    TRANSFER_OUT, INTEREST, FEE, SPLIT, TAX, CREDIT, ADJUSTMENT. \
    \n\nResolve all relative date phrases (\"yesterday\", \"last Monday\", \"2 days ago\") to ISO \
    8601 yourself before calling. \
    \n\nACCOUNT HANDLING: \
    \n- If only ONE account exists, pass that account name. \
    \n- If accounts are listed in Known App Context, use those names. \
    \n- If accounts aren't listed and `get_accounts` is available, call it with \
    `displayMode=\"compact\"` first; otherwise ASK which account before calling. \
    \n- If MULTIPLE accounts exist and the user didn't specify, ASK first — do NOT \
    call this tool with an empty account just to show the picker. \
    \n\nSYMBOL HANDLING: pass whatever the user wrote (ticker, company name, or \
    freeform like \"my rental property\") VERBATIM. The backend resolves names to \
    tickers and marks unresolvable symbols as custom assets. Do NOT hand-convert \
    names to tickers — models routinely hallucinate or use stale tickers (e.g. \
    \"Facebook\" is now META, not FB). \
    \n\nSUBTYPES: \"reinvested dividend\" → DRIP, \"dividend in kind\"/\"spinoff\" → \
    DIVIDEND_IN_KIND, \"staking reward\" → STAKING_REWARD, \"bonus\"/\"promo credit\" \
    → BONUS. \
    \n\nUse `record_activities` (the batch tool) instead of this one when recording 2+ \
    transactions in a single user request.";

// ============================================================================
// Tool Implementation
// ============================================================================

/// Tool to record investment activities from natural language.
pub struct RecordActivity;

impl RecordActivity {
    /// Build normalized tool output without side effects.
    ///
    /// Used by `record_activity` and the batch `record_activities` tool.
    pub(crate) async fn build_output(
        env: &dyn AgentEnvironment,
        args: RecordActivityArgs,
    ) -> Result<RecordActivityOutput, AgentToolError> {
        // Fetch accounts, then delegate to the shared implementation.
        let accounts = env
            .account_service()
            .get_active_non_archived_accounts()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;

        Self::build_output_with_accounts(env, args, &accounts).await
    }

    /// Build normalized tool output using pre-fetched accounts.
    ///
    /// Avoids redundant DB calls when processing a batch.
    pub(crate) async fn build_output_with_accounts(
        env: &dyn AgentEnvironment,
        args: RecordActivityArgs,
        accounts: &[wealthfolio_core::accounts::Account],
    ) -> Result<RecordActivityOutput, AgentToolError> {
        debug!(
            "record_activity called: type={}, symbol={:?}, account={:?}, date={}",
            args.activity_type, args.symbol, args.account, args.activity_date
        );

        // 1. Validate activity type
        let activity_type =
            validate_activity_type(&args.activity_type).unwrap_or_else(|| "UNKNOWN".to_string());

        // 2. Build account options from pre-fetched accounts
        debug!("Found {} active accounts", accounts.len());

        let available_accounts: Vec<AccountOption> = accounts
            .iter()
            .map(|a| AccountOption {
                id: a.id.clone(),
                name: a.name.clone(),
                currency: a.currency.clone(),
                account_type: Some(a.account_type.clone()),
            })
            .collect();

        // 3. Resolve account
        // Treat empty string as None for auto-selection
        let account_hint = args.account.as_deref().filter(|s| !s.is_empty());
        debug!(
            "Account resolution: hint={:?}, num_accounts={}",
            account_hint,
            accounts.len()
        );
        let (account_id, account_name) = resolve_account(account_hint, accounts);
        debug!(
            "Account resolved: id={:?}, name={:?}",
            account_id, account_name
        );

        // Get currency from resolved account, or use base currency as fallback
        let currency = account_id
            .as_ref()
            .and_then(|id| accounts.iter().find(|a| &a.id == id))
            .map(|a| a.currency.clone())
            .unwrap_or_else(|| env.base_currency());

        // 4. Handle symbol/asset resolution using quote_service
        let (resolved_asset, asset_id, asset_name, is_custom_asset) =
            if let Some(symbol) = &args.symbol {
                // Search for the symbol using quote_service
                let search_results = env
                    .quote_service()
                    .search_symbol_with_currency(symbol, Some(&currency))
                    .await
                    .unwrap_or_default();

                if let Some(top_result) = search_results.first() {
                    // Found a match - use the top result
                    let asset = ResolvedAsset {
                        asset_id: top_result.existing_asset_id.clone().unwrap_or_else(|| {
                            // Construct asset ID from symbol and exchange
                            format!(
                                "{}:{}",
                                top_result.symbol,
                                top_result.exchange_mic.as_deref().unwrap_or("UNKNOWN")
                            )
                        }),
                        symbol: top_result.symbol.clone(),
                        name: top_result.long_name.clone(),
                        currency: top_result
                            .currency
                            .clone()
                            .unwrap_or_else(|| currency.clone()),
                        exchange: top_result.exchange_name.clone(),
                        exchange_mic: top_result.exchange_mic.clone(),
                        instrument_type: (!top_result.quote_type.trim().is_empty())
                            .then(|| top_result.quote_type.clone()),
                    };
                    (
                        Some(asset.clone()),
                        Some(asset.asset_id.clone()),
                        Some(asset.name.clone()),
                        false,
                    )
                } else {
                    // No match found - treat as custom asset
                    (
                        None,
                        None,
                        Some(symbol.clone()),
                        true, // Mark as custom asset so user can create it
                    )
                }
            } else {
                (None, None, None, false)
            };

        // 5. Determine price source
        let price_source = if args.unit_price.is_some() {
            "user"
        } else {
            "none"
        };

        // 6. Compute amount if not provided
        let amount = compute_amount(
            args.quantity,
            args.unit_price,
            args.fee,
            args.tax,
            args.amount,
        );

        // 7. Build draft
        // Use asset's currency for trading activities, otherwise use account currency
        let draft_currency = resolved_asset
            .as_ref()
            .map(|a| a.currency.clone())
            .unwrap_or(currency);

        let draft = ActivityDraft {
            activity_type: activity_type.clone(),
            activity_date: args.activity_date,
            symbol: args.symbol.clone(),
            asset_id,
            asset_name,
            quantity: args.quantity,
            unit_price: args.unit_price,
            amount,
            fee: args.fee,
            tax: args.tax,
            currency: draft_currency,
            account_id,
            account_name,
            subtype: args.subtype,
            notes: args.notes,
            price_source: price_source.to_string(),
            pricing_mode: "MARKET".to_string(),
            is_custom_asset,
            asset_kind: None,
        };

        // 8. Validate the draft
        let validation = validate_draft(&draft);

        // 9. Get available subtypes
        let available_subtypes = get_subtypes_for_activity_type(&activity_type);

        Ok(RecordActivityOutput {
            draft,
            validation,
            available_accounts,
            resolved_asset,
            available_subtypes,
        })
    }
}

/// Resolve account by name or ID with fuzzy matching.
/// Auto-selects if there's only one account and no hint provided.
fn resolve_account(
    account_hint: Option<&str>,
    accounts: &[wealthfolio_core::accounts::Account],
) -> (Option<String>, Option<String>) {
    // If no hint provided, auto-select if there's only one account
    let Some(hint) = account_hint else {
        if accounts.len() == 1 {
            return (Some(accounts[0].id.clone()), Some(accounts[0].name.clone()));
        }
        return (None, None);
    };

    let hint_lower = hint.to_lowercase();

    // First try exact ID match
    if let Some(account) = accounts.iter().find(|a| a.id == hint) {
        return (Some(account.id.clone()), Some(account.name.clone()));
    }

    // Try exact name match (case-insensitive)
    if let Some(account) = accounts
        .iter()
        .find(|a| a.name.to_lowercase() == hint_lower)
    {
        return (Some(account.id.clone()), Some(account.name.clone()));
    }

    // Try partial name match (contains)
    let matches: Vec<_> = accounts
        .iter()
        .filter(|a| a.name.to_lowercase().contains(&hint_lower))
        .collect();

    if matches.len() == 1 {
        return (Some(matches[0].id.clone()), Some(matches[0].name.clone()));
    }

    // Ambiguous or not found
    (None, None)
}

/// Validate activity type against canonical types.
pub(crate) fn validate_activity_type(activity_type: &str) -> Option<String> {
    let upper = activity_type.to_uppercase();
    if ACTIVITY_TYPES.contains(&upper.as_str()) {
        Some(upper)
    } else {
        None
    }
}

/// Validate required fields based on activity type.
fn validate_draft(draft: &ActivityDraft) -> ValidationResult {
    let mut missing_fields = Vec::new();
    let mut errors = Vec::new();

    let activity_type = draft.activity_type.to_uppercase();
    let subtype = draft.subtype.as_deref().map(str::to_uppercase);
    let is_dividend_asset_income = activity_type == ACTIVITY_TYPE_DIVIDEND
        && subtype.as_deref().is_some_and(|subtype| {
            subtype == ACTIVITY_SUBTYPE_DRIP || subtype == ACTIVITY_SUBTYPE_DIVIDEND_IN_KIND
        });
    let is_staking_reward = activity_type == ACTIVITY_TYPE_INTEREST
        && subtype.as_deref() == Some(ACTIVITY_SUBTYPE_STAKING_REWARD);

    // Account is always required
    if draft.account_id.is_none() {
        missing_fields.push("account_id".to_string());
    }

    // Validate based on activity type
    match activity_type.as_str() {
        s if s == ACTIVITY_TYPE_BUY || s == ACTIVITY_TYPE_SELL => {
            if draft.symbol.is_none() && draft.asset_id.is_none() {
                missing_fields.push("symbol".to_string());
            }
            if draft.quantity.is_none() {
                missing_fields.push("quantity".to_string());
            }
            // Either unit_price or amount is required
            if draft.unit_price.is_none() && draft.amount.is_none() {
                missing_fields.push("unit_price".to_string());
            }
        }
        s if (s == ACTIVITY_TYPE_DEPOSIT
            || s == ACTIVITY_TYPE_WITHDRAWAL
            || s == ACTIVITY_TYPE_TAX
            || s == ACTIVITY_TYPE_FEE
            || s == ACTIVITY_TYPE_CREDIT)
            && draft.amount.is_none() =>
        {
            missing_fields.push("amount".to_string());
        }
        s if s == ACTIVITY_TYPE_DIVIDEND => {
            if draft.symbol.is_none() && draft.asset_id.is_none() {
                missing_fields.push("symbol".to_string());
            }
            if is_dividend_asset_income && draft.quantity.is_none() {
                missing_fields.push("quantity".to_string());
            }
            if is_dividend_asset_income && draft.amount.is_none() && draft.unit_price.is_none() {
                missing_fields.push("unit_price".to_string());
            }
            if !is_dividend_asset_income && draft.amount.is_none() {
                missing_fields.push("amount".to_string());
            }
        }
        s if s == ACTIVITY_TYPE_INTEREST => {
            if is_staking_reward {
                if draft.symbol.is_none() && draft.asset_id.is_none() {
                    missing_fields.push("symbol".to_string());
                }
                if draft.quantity.is_none() {
                    missing_fields.push("quantity".to_string());
                }
                if draft.amount.is_none() && draft.unit_price.is_none() {
                    missing_fields.push("unit_price".to_string());
                }
            } else if draft.amount.is_none() {
                missing_fields.push("amount".to_string());
            }
        }
        s if s == ACTIVITY_TYPE_SPLIT => {
            if draft.symbol.is_none() && draft.asset_id.is_none() {
                missing_fields.push("symbol".to_string());
            }
            if draft.quantity.is_none() {
                missing_fields.push("quantity".to_string());
            }
        }
        // Either amount (for cash) or (symbol + quantity) for assets
        s if (s == ACTIVITY_TYPE_TRANSFER_IN || s == ACTIVITY_TYPE_TRANSFER_OUT)
            && draft.amount.is_none()
            && draft.symbol.is_none() =>
        {
            missing_fields.push("amount".to_string());
        }
        _ => {}
    }

    // Validate date format
    if chrono::NaiveDate::parse_from_str(&draft.activity_date, "%Y-%m-%d").is_err()
        && chrono::DateTime::parse_from_rfc3339(&draft.activity_date).is_err()
    {
        errors.push(ValidationError {
            field: "activity_date".to_string(),
            message: "Invalid date format. Expected YYYY-MM-DD or ISO 8601".to_string(),
        });
    }

    // Check for custom asset creation
    if draft.is_custom_asset && draft.asset_kind.is_none() {
        missing_fields.push("asset_kind".to_string());
    }

    ValidationResult {
        is_valid: missing_fields.is_empty() && errors.is_empty(),
        missing_fields,
        errors,
    }
}

/// Compute amount from quantity and unit_price if not provided.
fn compute_amount(
    quantity: Option<f64>,
    unit_price: Option<f64>,
    fee: Option<f64>,
    tax: Option<f64>,
    provided_amount: Option<f64>,
) -> Option<f64> {
    if let Some(amount) = provided_amount {
        return Some(amount);
    }

    match (quantity, unit_price) {
        (Some(qty), Some(price)) => {
            let base = qty * price;
            Some(base + fee.unwrap_or(0.0) + tax.unwrap_or(0.0))
        }
        _ => None,
    }
}

#[async_trait::async_trait]
impl AgentTool for RecordActivity {
    fn name(&self) -> &'static str {
        "record_activity"
    }

    fn description(&self) -> &'static str {
        RECORD_ACTIVITY_DESCRIPTION
    }

    fn input_schema(&self) -> serde_json::Value {
        record_activity_schema()
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Returns the account list (ids, names, currencies, types) for
        // resolution, so it needs accounts:read in addition to activities:draft.
        &[AgentScope::AccountsRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, _args: &serde_json::Value) -> serde_json::Value {
        // The args carry the draft's financial details (symbol, quantity,
        // amount, fee, account, notes); never persist them in the audit log.
        serde_json::json!("[redacted]")
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: RecordActivityArgs = serde_json::from_value(args)?;
        let output = RecordActivity::build_output(env.as_ref(), args).await?;
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_activity_type() {
        assert_eq!(validate_activity_type("buy"), Some("BUY".to_string()));
        assert_eq!(validate_activity_type("SELL"), Some("SELL".to_string()));
        assert_eq!(validate_activity_type("invalid"), None);
    }

    #[test]
    fn test_get_subtypes_for_activity_type() {
        let subtypes = get_subtypes_for_activity_type("DIVIDEND");
        assert!(subtypes.iter().any(|s| s.value == "DRIP"));
        assert!(subtypes.iter().any(|s| s.value == "DIVIDEND_IN_KIND"));
        assert_eq!(subtypes.len(), 2); // DRIP and DIVIDEND_IN_KIND

        let subtypes = get_subtypes_for_activity_type("INTEREST");
        assert!(subtypes.iter().any(|s| s.value == "STAKING_REWARD"));

        let subtypes = get_subtypes_for_activity_type("DEPOSIT");
        assert!(subtypes.is_empty());
    }

    #[test]
    fn test_compute_amount() {
        // With quantity and price
        assert_eq!(
            compute_amount(Some(10.0), Some(100.0), None, None, None),
            Some(1000.0)
        );

        // With fee
        assert_eq!(
            compute_amount(Some(10.0), Some(100.0), Some(5.0), None, None),
            Some(1005.0)
        );

        // With fee and tax
        assert_eq!(
            compute_amount(Some(10.0), Some(100.0), Some(5.0), Some(2.0), None),
            Some(1007.0)
        );

        // Provided amount takes precedence
        assert_eq!(
            compute_amount(Some(10.0), Some(100.0), None, None, Some(500.0)),
            Some(500.0)
        );

        // Missing quantity or price
        assert_eq!(compute_amount(Some(10.0), None, None, None, None), None);
        assert_eq!(compute_amount(None, Some(100.0), None, None, None), None);
    }

    #[test]
    fn audit_redaction_drops_draft_details() {
        let args = serde_json::json!({
            "activityType": "BUY", "symbol": "AAPL", "quantity": 10.0,
            "amount": 1502.5, "account": "Brokerage", "notes": "secret"
        });
        assert_eq!(
            RecordActivity.sanitize_args_for_audit(&args),
            serde_json::json!("[redacted]")
        );
    }
}
