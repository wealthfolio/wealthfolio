//! Activity review flag logic and metadata building for broker sync.
//!
//! This module handles:
//! - Determining whether activities need user review
//! - Building metadata JSON for activity records
//! - Resolving asset symbols with fallback logic
//!
//! Note: Subtype mapping is now done by the API - this module uses the subtype
//! field directly from the API response.

use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;

use super::models::AccountUniversalActivity;
use wealthfolio_core::activities::{self, AssetResolutionInput, NewActivity};
use wealthfolio_core::assets::parse_symbol_with_exchange_suffix;
use wealthfolio_core::fx::currency::{get_normalization_rule, normalize_amount, resolve_currency};

/// Minimum confidence score to consider a mapping reliable
const CONFIDENCE_THRESHOLD: f64 = 0.7;

fn normalize_activity_token(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '-' || c == '_')
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_uppercase)
        .collect::<Vec<_>>()
        .join("_")
}

fn fold_position_intent_activity_type(activity_type: String) -> (String, Option<String>) {
    match normalize_activity_token(&activity_type).as_str() {
        "SELL_SHORT" | "SHORT_SELL" | "SELL_SHORT_TO_OPEN" => (
            activities::ACTIVITY_TYPE_SELL.to_string(),
            Some(activities::ACTIVITY_SUBTYPE_POSITION_OPEN.to_string()),
        ),
        "BUY_TO_COVER" | "BUY_COVER" | "COVER_SHORT" => (
            activities::ACTIVITY_TYPE_BUY.to_string(),
            Some(activities::ACTIVITY_SUBTYPE_POSITION_CLOSE.to_string()),
        ),
        _ => (activity_type, None),
    }
}

/// Determine if an activity needs user review based on various signals.
///
/// Returns `true` if the activity should be flagged for review.
pub fn needs_review(activity: &AccountUniversalActivity) -> bool {
    // 1. API explicitly flagged for review
    if activity.needs_review {
        return true;
    }

    // 2. Activity type is UNKNOWN
    if let Some(ref activity_type) = activity.activity_type {
        if activity_type.to_uppercase() == "UNKNOWN" {
            return true;
        }
    } else {
        // No activity type at all - needs review
        return true;
    }

    // 3. Check mapping metadata
    if let Some(ref metadata) = activity.mapping_metadata {
        // Low confidence mapping
        if let Some(confidence) = metadata.confidence {
            if confidence < CONFIDENCE_THRESHOLD {
                return true;
            }
        }

        // Has warning reasons
        if has_warning_reasons(&metadata.reasons) {
            return true;
        }
    }

    false
}

/// Check if the reasons list contains any warning-level reasons.
fn has_warning_reasons(reasons: &[String]) -> bool {
    // Common warning patterns from the API
    let warning_patterns = [
        "unknown",
        "unrecognized",
        "ambiguous",
        "multiple",
        "conflict",
        "manual",
        "review",
        "unsupported",
    ];

    for reason in reasons {
        let reason_lower = reason.to_lowercase();
        for pattern in &warning_patterns {
            if reason_lower.contains(pattern) {
                return true;
            }
        }
    }

    false
}

fn normalize_source_system(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_uppercase())
}

/// Build metadata JSON for storing in the activity record.
///
/// Extracts relevant fields from the API metadata and formats them for storage.
pub fn build_activity_metadata(activity: &AccountUniversalActivity) -> Option<String> {
    let mut metadata = serde_json::Map::new();

    // Add flow.is_external for transfers
    if let Some(ref mapping_meta) = activity.mapping_metadata {
        if let Some(ref flow) = mapping_meta.flow {
            metadata.insert(
                "flow".to_string(),
                serde_json::json!({
                    "is_external": flow.is_external
                }),
            );
        }

        // Add confidence score
        if let Some(confidence) = mapping_meta.confidence {
            metadata.insert("confidence".to_string(), serde_json::json!(confidence));
        }

        // Add mapping reasons (for debugging/review)
        if !mapping_meta.reasons.is_empty() {
            metadata.insert(
                "mapping_reasons".to_string(),
                serde_json::json!(mapping_meta.reasons),
            );
        }
    }

    // Add raw_type from provider
    if let Some(ref raw_type) = activity.raw_type {
        metadata.insert("raw_type".to_string(), serde_json::json!(raw_type));
    }

    // Add source system info
    if let Some(ref source_system) = activity.source_system {
        metadata.insert(
            "source_system".to_string(),
            serde_json::json!(source_system),
        );
    }

    if let Some(ref provider_type) = activity.provider_type {
        metadata.insert(
            "provider_type".to_string(),
            serde_json::json!(provider_type),
        );
    }

    if let Some(ref source_record_id) = activity.source_record_id {
        metadata.insert(
            "source_record_id".to_string(),
            serde_json::json!(source_record_id),
        );
    }

    if let Some(ref source_group_id) = activity.source_group_id {
        metadata.insert(
            "source_group_id".to_string(),
            serde_json::json!(source_group_id),
        );
    }

    if let Some(ref external_reference_id) = activity.external_reference_id {
        metadata.insert(
            "external_reference_id".to_string(),
            serde_json::json!(external_reference_id),
        );
    }

    if let Some(ref institution) = activity.institution {
        metadata.insert("institution".to_string(), serde_json::json!(institution));
    }

    // Add symbol identity fields for broker sync learning
    if let Some(ref symbol) = activity.symbol {
        let mut sym_meta = serde_json::Map::new();

        if let Some(ref id) = symbol.id {
            sym_meta.insert("id".to_string(), serde_json::json!(id));
        }
        if let Some(ref sym) = symbol.symbol {
            sym_meta.insert("symbol".to_string(), serde_json::json!(sym));
        }
        if let Some(ref raw) = symbol.raw_symbol {
            sym_meta.insert("raw_symbol".to_string(), serde_json::json!(raw));
        }
        if let Some(ref figi) = symbol.figi_code {
            sym_meta.insert("figi_code".to_string(), serde_json::json!(figi));
        }
        if let Some(ref exchange) = symbol.exchange {
            if let Some(ref mic) = exchange.mic_code {
                sym_meta.insert("exchange_mic".to_string(), serde_json::json!(mic));
            }
        }
        if let Some(ref sym_type) = symbol.symbol_type {
            if let Some(ref code) = sym_type.code {
                sym_meta.insert("symbol_type_code".to_string(), serde_json::json!(code));
            }
        }
        if let Some(ref currency) = symbol.currency {
            if let Some(ref code) = currency.code {
                sym_meta.insert("currency_code".to_string(), serde_json::json!(code));
            }
        }

        if !sym_meta.is_empty() {
            metadata.insert("symbol".to_string(), serde_json::Value::Object(sym_meta));
        }
    }

    if let Some(option_leg_type) = activity
        .option_type
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        metadata.insert(
            "option_leg_type".to_string(),
            serde_json::json!(option_leg_type),
        );
    }

    if let Some(ref option_symbol) = activity.option_symbol {
        if let Some(contract_type) = option_symbol
            .option_type
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            metadata.insert(
                "option_contract_type".to_string(),
                serde_json::json!(contract_type),
            );
        }
        if let Some(ref ticker) = option_symbol.ticker {
            metadata.insert("option_ticker".to_string(), serde_json::json!(ticker));
        }
        if let Some(ref underlying) = option_symbol.underlying_symbol {
            if let Some(ref underlying_symbol) = underlying.symbol {
                metadata.insert(
                    "option_underlying_symbol".to_string(),
                    serde_json::json!(underlying_symbol),
                );
            }
        }
    }

    if metadata.is_empty() {
        None
    } else {
        serde_json::to_string(&serde_json::Value::Object(metadata)).ok()
    }
}

/// Check if a broker symbol type code represents a crypto asset.
pub fn is_broker_crypto(code: Option<&str>) -> bool {
    matches!(
        code.map(|c| c.to_uppercase()).as_deref(),
        Some("CRYPTOCURRENCY" | "CRYPTO")
    )
}

fn is_broker_bond(code: Option<&str>) -> bool {
    matches!(
        code.map(|c| c.to_uppercase()).as_deref(),
        Some("BOND" | "FIXEDINCOME" | "FIXED_INCOME" | "FIXED INCOME" | "DEBT")
    )
}

fn normalized_trade_amount(
    activity_type: &str,
    quantity: Option<Decimal>,
    unit_price: Option<Decimal>,
    amount: Option<Decimal>,
    is_option_activity: bool,
    is_crypto: bool,
    is_bond: bool,
) -> Option<Decimal> {
    if matches!(
        activity_type,
        activities::ACTIVITY_TYPE_BUY | activities::ACTIVITY_TYPE_SELL
    ) && !is_option_activity
        && !is_crypto
        && !is_bond
    {
        if let (Some(quantity), Some(unit_price)) = (quantity, unit_price) {
            if !quantity.is_zero() && !unit_price.is_zero() {
                return Some(quantity * unit_price);
            }
        }
    }

    amount
}

/// Maps a broker API activity into a `NewActivity` with unresolved `AssetResolutionInput`.
///
/// The returned `NewActivity` has `AssetResolutionInput { symbol, exchange_mic, kind }` set
/// so that `prepare_activities_for_sync()` can handle asset creation and dedup via `instrument_key`.
///
/// Returns `None` if the activity should be skipped (e.g. no id).
pub fn map_broker_activity(
    activity: &AccountUniversalActivity,
    account_id: &str,
    account_currency: Option<&str>,
    base_currency: Option<&str>,
) -> Option<NewActivity> {
    // Must have an id
    let activity_id = activity.id.clone().filter(|v| !v.trim().is_empty())?;

    let activity_currency = activity
        .currency
        .as_ref()
        .and_then(|c| c.code.clone())
        .filter(|c| !c.trim().is_empty());

    // Get activity type from API
    let raw_activity_type = activity
        .activity_type
        .clone()
        .map(|t| t.trim().to_uppercase())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "UNKNOWN".to_string());
    let (activity_type, activity_type_position_intent) =
        fold_position_intent_activity_type(raw_activity_type);

    let option_leg_type = activity
        .option_type
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let subtype = activity_type_position_intent
        .or(option_leg_type.clone())
        .or(activity.subtype.clone())
        .or(activity.raw_type.clone());
    let subtype =
        NewActivity::canonicalize_subtype_for_activity(&activity_type, subtype.as_deref());

    // Calculate needs_review flag
    let needs_review_flag = needs_review(activity);

    // Build metadata JSON
    let metadata = build_activity_metadata(activity);

    let is_never_asset_type = activities::NEVER_ASSET_TYPES.contains(&activity_type.as_str());

    let is_cash_like = matches!(
        activity_type.as_str(),
        activities::ACTIVITY_TYPE_DEPOSIT
            | activities::ACTIVITY_TYPE_WITHDRAWAL
            | activities::ACTIVITY_TYPE_INTEREST
            | activities::ACTIVITY_TYPE_FEE
            | activities::ACTIVITY_TYPE_TAX
            | activities::ACTIVITY_TYPE_TRANSFER_IN
            | activities::ACTIVITY_TYPE_TRANSFER_OUT
            | activities::ACTIVITY_TYPE_CREDIT
    );

    // Extract symbol reference for convenience
    let symbol_ref = activity.symbol.as_ref();
    let symbol_type_ref = symbol_ref.and_then(|s| s.symbol_type.as_ref());
    let symbol_type_code = symbol_type_ref.and_then(|t| t.code.as_deref());
    let is_crypto = is_broker_crypto(symbol_type_code);
    let is_bond = is_broker_bond(symbol_type_code);

    // Extract exchange MIC from broker data (prefer mic_code over code)
    let exchange_mic_from_symbol = symbol_ref.and_then(|s| s.exchange.as_ref()).and_then(|e| {
        e.mic_code
            .clone()
            .filter(|c| !c.trim().is_empty())
            .or_else(|| e.code.clone().filter(|c| !c.trim().is_empty()))
    });
    let exchange_mic_from_underlying = activity
        .option_symbol
        .as_ref()
        .and_then(|o| o.underlying_symbol.as_ref())
        .and_then(|u| u.exchange.as_ref())
        .and_then(|e| {
            e.mic_code
                .clone()
                .filter(|c| !c.trim().is_empty())
                .or_else(|| e.code.clone().filter(|c| !c.trim().is_empty()))
        });
    let exchange_mic = exchange_mic_from_symbol.or(exchange_mic_from_underlying);

    // Get the symbol's currency
    let symbol_currency = symbol_ref
        .and_then(|s| s.currency.as_ref())
        .and_then(|c| c.code.clone())
        .filter(|c| !c.trim().is_empty());

    let currency_code = resolve_currency(&[
        activity_currency.as_deref().unwrap_or(""),
        symbol_currency.as_deref().unwrap_or(""),
        account_currency.unwrap_or(""),
        base_currency.unwrap_or(""),
    ]);

    // Determine the display symbol based on asset type
    let display_symbol: Option<String> = if is_crypto {
        // For crypto: raw_symbol > extract base from symbol field
        symbol_ref
            .and_then(|s| s.raw_symbol.clone())
            .filter(|r| !r.trim().is_empty())
            .or_else(|| {
                symbol_ref
                    .and_then(|s| s.symbol.clone())
                    .filter(|sym| !sym.trim().is_empty())
                    .map(|sym| sym.split('-').next().unwrap_or(&sym).to_string())
            })
    } else {
        // For securities: raw_symbol > symbol normalized via Yahoo suffix parser.
        // This preserves valid share-class symbols like BRK.B while trimming real exchange suffixes.
        symbol_ref
            .and_then(|s| s.raw_symbol.clone())
            .filter(|r| !r.trim().is_empty())
            .or_else(|| {
                symbol_ref
                    .and_then(|s| s.symbol.clone())
                    .filter(|sym| !sym.trim().is_empty())
                    .map(|sym| parse_symbol_with_exchange_suffix(&sym).0.to_string())
            })
    };

    // Also get option symbol if present. SnapTrade/Connect sometimes returns
    // OCC tickers in space-padded form ("BA    260116C00200000"); normalize
    // to compact form so we don't fragment asset identity per-broker.
    let option_symbol = activity
        .option_symbol
        .as_ref()
        .and_then(|s| s.ticker.clone())
        .filter(|t| !t.trim().is_empty())
        .map(|t| wealthfolio_core::utils::occ_symbol::normalize_option_symbol(&t).unwrap_or(t));
    let is_option_activity = option_symbol.is_some() || option_leg_type.is_some();
    // Option contracts are uniquely identified by OCC ticker; adding underlying MIC can fragment identity.
    let exchange_mic = if is_option_activity {
        None
    } else {
        exchange_mic
    };

    // Never-asset types are always pure cash, even if brokers send a symbol.
    let asset_resolution_input = if is_never_asset_type {
        None
    } else if is_cash_like && display_symbol.is_none() && option_symbol.is_none() {
        // Cash activity without symbol - no asset needed
        None
    } else {
        let symbol = option_symbol.clone().or(display_symbol.clone());
        symbol.map(|sym| {
            let kind_hint = if is_option_activity {
                Some("OPTION".to_string())
            } else if is_crypto {
                Some("CRYPTO".to_string())
            } else if is_bond {
                Some("BOND".to_string())
            } else {
                None
            };
            let asset_name = symbol_ref
                .and_then(|s| s.description.clone())
                .filter(|d| !d.trim().is_empty())
                .or_else(|| {
                    activity
                        .option_symbol
                        .as_ref()
                        .and_then(|o| o.underlying_symbol.as_ref())
                        .and_then(|u| u.description.clone())
                        .filter(|d| !d.trim().is_empty())
                });
            AssetResolutionInput {
                id: None, // Let sync preparation resolve via instrument_key
                symbol: Some(sym),
                exchange_mic: exchange_mic.clone(),
                kind: kind_hint,
                name: asset_name,
                quote_mode: None,
                quote_ccy: symbol_currency.clone(),
                instrument_type: if is_option_activity {
                    Some("OPTION".to_string())
                } else if is_crypto {
                    Some("CRYPTO".to_string())
                } else if is_bond {
                    Some("BOND".to_string())
                } else {
                    None
                },
                ..Default::default()
            }
        })
    };

    let activity_date = activity
        .trade_date
        .clone()
        .or(activity.settlement_date.clone())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let quantity = activity.units.and_then(Decimal::from_f64).map(|d| d.abs());
    let unit_price = activity.price.and_then(Decimal::from_f64).map(|d| d.abs());
    let fee = activity.fee.and_then(Decimal::from_f64).map(|d| d.abs());
    let amount = activity.amount.and_then(Decimal::from_f64).map(|d| d.abs());
    let amount = normalized_trade_amount(
        &activity_type,
        quantity,
        unit_price,
        amount,
        is_option_activity,
        is_crypto,
        is_bond,
    );
    let fx_rate = activity.fx_rate.and_then(Decimal::from_f64);

    // Normalize minor currency units (e.g., GBp -> GBP) and convert amounts
    let (unit_price, quantity, fee, amount, currency_code) =
        if get_normalization_rule(&currency_code).is_some() {
            let norm_price = unit_price.map(|p| normalize_amount(p, &currency_code).0);
            let norm_fee = fee.map(|f| normalize_amount(f, &currency_code).0);
            let norm_amount = amount.map(|a| normalize_amount(a, &currency_code).0);
            let (_, norm_currency) = normalize_amount(Decimal::ZERO, &currency_code);
            (
                norm_price,
                quantity,
                norm_fee,
                norm_amount,
                norm_currency.to_string(),
            )
        } else {
            (unit_price, quantity, fee, amount, currency_code)
        };

    // Determine status
    let status = if needs_review_flag {
        wealthfolio_core::activities::ActivityStatus::Draft
    } else {
        wealthfolio_core::activities::ActivityStatus::Posted
    };

    Some(NewActivity {
        id: Some(activity_id),
        account_id: account_id.to_string(),
        asset: asset_resolution_input,
        activity_type,
        subtype,
        activity_date,
        quantity,
        unit_price,
        currency: currency_code,
        fee,
        tax: None,
        amount,
        status: Some(status),
        notes: activity
            .description
            .clone()
            .filter(|d| !d.trim().is_empty())
            .or(activity.external_reference_id.clone()),
        fx_rate,
        metadata,
        needs_review: Some(needs_review_flag),
        source_system: normalize_source_system(activity.source_system.as_deref())
            .or_else(|| normalize_source_system(activity.provider_type.as_deref()))
            .or_else(|| Some("SNAPTRADE".to_string())),
        source_record_id: activity
            .source_record_id
            .clone()
            .or(activity.external_reference_id.clone())
            .or(activity.id.clone()),
        source_group_id: activity.source_group_id.clone(),
        idempotency_key: None,
        import_run_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::models::{
        AccountUniversalActivityCurrency, AccountUniversalActivityExchange,
        AccountUniversalActivityOptionSymbol, AccountUniversalActivitySymbol,
        AccountUniversalActivitySymbolType, AccountUniversalActivityUnderlyingSymbol,
        MappingMetadata,
    };

    fn decimal(value: &str) -> Decimal {
        Decimal::from_str_exact(value).unwrap()
    }

    fn broker_symbol(symbol: &str, symbol_type_code: &str) -> AccountUniversalActivitySymbol {
        AccountUniversalActivitySymbol {
            symbol: Some(symbol.to_string()),
            raw_symbol: Some(symbol.to_string()),
            symbol_type: Some(AccountUniversalActivitySymbolType {
                code: Some(symbol_type_code.to_string()),
                ..Default::default()
            }),
            currency: Some(AccountUniversalActivityCurrency {
                code: Some("USD".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn test_needs_review_unknown_type() {
        let activity = AccountUniversalActivity {
            activity_type: Some("UNKNOWN".to_string()),
            ..Default::default()
        };
        assert!(needs_review(&activity));
    }

    #[test]
    fn test_needs_review_low_confidence() {
        let activity = AccountUniversalActivity {
            activity_type: Some("BUY".to_string()),
            mapping_metadata: Some(MappingMetadata {
                confidence: Some(0.5),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(needs_review(&activity));
    }

    #[test]
    fn test_needs_review_high_confidence() {
        let activity = AccountUniversalActivity {
            activity_type: Some("BUY".to_string()),
            mapping_metadata: Some(MappingMetadata {
                confidence: Some(0.9),
                reasons: vec![],
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(!needs_review(&activity));
    }

    #[test]
    fn test_warning_reasons() {
        assert!(has_warning_reasons(&[
            "Unknown transaction type".to_string()
        ]));
        assert!(has_warning_reasons(&["Ambiguous mapping".to_string()]));
        assert!(!has_warning_reasons(&["Matched by symbol".to_string()]));
        assert!(!has_warning_reasons(&[]));
    }

    #[test]
    fn test_map_broker_activity_uses_provider_and_external_reference_fallbacks() {
        let activity = AccountUniversalActivity {
            id: Some("act-1".to_string()),
            activity_type: Some("BUY".to_string()),
            provider_type: Some("snaptrade".to_string()),
            external_reference_id: Some("ext-123".to_string()),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.source_system.as_deref(), Some("SNAPTRADE"));
        assert_eq!(mapped.source_record_id.as_deref(), Some("ext-123"));

        let metadata_json = mapped.metadata.expect("metadata should be present");
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).unwrap();
        assert_eq!(metadata["provider_type"], "snaptrade");
        assert_eq!(metadata["external_reference_id"], "ext-123");
    }

    #[test]
    fn test_map_broker_activity_trade_amount_policy_recomputes_plain_trade_amount() {
        let activity = AccountUniversalActivity {
            id: Some("act-equity-buy".to_string()),
            activity_type: Some("BUY".to_string()),
            symbol: Some(broker_symbol("AMD", "cs")),
            units: Some(10.0),
            price: Some(99.76),
            amount: Some(9976.0),
            fee: Some(4.9),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.amount.unwrap().round_dp(4), decimal("997.6000"));
        assert_eq!(mapped.fee.unwrap().round_dp(4), decimal("4.9000"));
        assert_eq!(mapped.tax, None);
    }

    #[test]
    fn test_map_broker_activity_trade_amount_policy_preserves_bond_amount() {
        let activity = AccountUniversalActivity {
            id: Some("act-bond-buy".to_string()),
            activity_type: Some("BUY".to_string()),
            symbol: Some(broker_symbol("US912828ZT58", "bond")),
            units: Some(1000.0),
            price: Some(99.0),
            amount: Some(990.0),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.amount.unwrap().round_dp(2), decimal("990.00"));
        let asset = mapped.asset.expect("bond activity should produce an asset");
        assert_eq!(asset.kind.as_deref(), Some("BOND"));
        assert_eq!(asset.instrument_type.as_deref(), Some("BOND"));
    }

    #[test]
    fn test_map_broker_activity_trade_amount_policy_preserves_option_amount() {
        let activity = AccountUniversalActivity {
            id: Some("act-option-buy".to_string()),
            activity_type: Some("BUY".to_string()),
            option_symbol: Some(AccountUniversalActivityOptionSymbol {
                ticker: Some("AAPL  260116C00200000".to_string()),
                ..Default::default()
            }),
            units: Some(2.0),
            price: Some(3.0),
            amount: Some(600.0),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.amount.unwrap().round_dp(2), decimal("600.00"));
    }

    #[test]
    fn test_map_broker_activity_trade_amount_policy_preserves_cash_amount() {
        let activity = AccountUniversalActivity {
            id: Some("act-cash".to_string()),
            activity_type: Some("DEPOSIT".to_string()),
            amount: Some(12.34),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.amount.unwrap().round_dp(2), decimal("12.34"));
    }

    #[test]
    fn test_map_broker_activity_marks_option_with_option_kind() {
        let activity = AccountUniversalActivity {
            id: Some("act-opt".to_string()),
            activity_type: Some("BUY".to_string()),
            option_type: Some("BUY_TO_OPEN".to_string()),
            option_symbol: Some(AccountUniversalActivityOptionSymbol {
                ticker: Some("AAPL  261218C00240000".to_string()),
                underlying_symbol: Some(AccountUniversalActivityUnderlyingSymbol {
                    exchange: Some(AccountUniversalActivityExchange {
                        mic_code: Some("XNAS".to_string()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();
        let symbol = mapped
            .asset
            .expect("option activities should produce symbol");

        assert_eq!(symbol.kind.as_deref(), Some("OPTION"));
        assert_eq!(symbol.exchange_mic, None);
        assert_eq!(mapped.subtype.as_deref(), Some("POSITION_OPEN"));
    }

    #[test]
    fn test_map_broker_activity_folds_raw_stock_short_activity_type() {
        let activity = AccountUniversalActivity {
            id: Some("act-short".to_string()),
            activity_type: Some("SELL_SHORT".to_string()),
            symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                symbol: Some("AAPL".to_string()),
                raw_symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            units: Some(1.0),
            price: Some(200.0),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.activity_type, activities::ACTIVITY_TYPE_SELL);
        assert_eq!(mapped.subtype.as_deref(), Some("POSITION_OPEN"));
    }

    #[test]
    fn test_map_broker_activity_raw_short_intent_outranks_unrelated_subtype() {
        let activity = AccountUniversalActivity {
            id: Some("act-short-subtype".to_string()),
            activity_type: Some("sell  short".to_string()),
            subtype: Some("tax_lot_label".to_string()),
            symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                symbol: Some("AAPL".to_string()),
                raw_symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            units: Some(1.0),
            price: Some(200.0),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.activity_type, activities::ACTIVITY_TYPE_SELL);
        assert_eq!(mapped.subtype.as_deref(), Some("POSITION_OPEN"));
    }

    #[test]
    fn test_map_broker_activity_folds_raw_buy_to_cover_activity_type() {
        let activity = AccountUniversalActivity {
            id: Some("act-cover".to_string()),
            activity_type: Some("BUY_TO_COVER".to_string()),
            symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                symbol: Some("AAPL".to_string()),
                raw_symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            units: Some(1.0),
            price: Some(180.0),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();

        assert_eq!(mapped.activity_type, activities::ACTIVITY_TYPE_BUY);
        assert_eq!(mapped.subtype.as_deref(), Some("POSITION_CLOSE"));
    }

    #[test]
    fn test_map_broker_activity_does_not_mark_empty_option_type_as_option() {
        let activity = AccountUniversalActivity {
            id: Some("act-eq".to_string()),
            activity_type: Some("BUY".to_string()),
            option_type: Some(String::new()),
            symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                symbol: Some("AAPL".to_string()),
                raw_symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();
        let symbol = mapped.asset.expect("equity activity should produce symbol");

        assert_eq!(symbol.symbol.as_deref(), Some("AAPL"));
        assert_ne!(symbol.kind.as_deref(), Some("OPTION"));
    }

    #[test]
    fn test_map_broker_activity_clears_symbol_for_all_never_asset_types() {
        for activity_type in activities::NEVER_ASSET_TYPES {
            let activity = AccountUniversalActivity {
                id: Some(format!("act-{}", activity_type.to_lowercase())),
                activity_type: Some(activity_type.to_string()),
                symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                    symbol: Some("AAPL".to_string()),
                    raw_symbol: Some("AAPL".to_string()),
                    ..Default::default()
                }),
                ..Default::default()
            };

            let mapped =
                map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();
            assert!(
                mapped.asset.is_none(),
                "expected no asset for never-asset type {}",
                activity_type
            );
        }
    }

    #[test]
    fn test_map_broker_activity_keeps_symbol_for_transfer_with_symbol() {
        let activity = AccountUniversalActivity {
            id: Some("act-tr-in".to_string()),
            activity_type: Some("TRANSFER_IN".to_string()),
            symbol: Some(crate::broker::models::AccountUniversalActivitySymbol {
                symbol: Some("AAPL".to_string()),
                raw_symbol: Some("AAPL".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let mapped = map_broker_activity(&activity, "acct-1", Some("USD"), Some("USD")).unwrap();
        assert_eq!(
            mapped.asset.and_then(|s| s.symbol),
            Some("AAPL".to_string())
        );
    }
}
