use std::collections::{BTreeMap, HashSet};

use chrono::NaiveDate;
use rust_decimal::Decimal;

use crate::{
    assets::{
        AssetResolutionInput, AssetResolutionOutput, AssetServiceTrait, InstrumentType, QuoteMode,
    },
    errors::{Error, Result, ValidationError},
    quotes::constants::DATA_SOURCE_MANUAL,
};

use super::{validate_snapshot_write_date, SnapshotServiceTrait, SnapshotSource};

#[derive(Debug, Clone)]
pub struct HoldingsImportPositionValidationInput {
    pub symbol: String,
    pub quantity: String,
    pub avg_cost: Option<String>,
    pub currency: String,
    pub exchange_mic: Option<String>,
    pub quote_ccy: Option<String>,
    pub instrument_type: Option<String>,
    pub quote_mode: Option<String>,
    pub provider_id: Option<String>,
    pub provider_symbol: Option<String>,
    pub asset_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HoldingsImportSnapshotValidationInput {
    pub date: String,
    pub positions: Vec<HoldingsImportPositionValidationInput>,
    pub cash_balances: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct HoldingsImportSymbolCheck {
    pub symbol: String,
    pub found: bool,
    pub asset_name: Option<String>,
    pub asset_id: Option<String>,
    pub currency: Option<String>,
    pub exchange_mic: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HoldingsImportCheckResult {
    pub existing_dates: Vec<String>,
    pub symbols: Vec<HoldingsImportSymbolCheck>,
    pub validation_errors: Vec<String>,
    pub valid_snapshot_dates: Vec<String>,
    pub invalid_snapshot_dates: Vec<String>,
}

pub fn validate_holdings_import_snapshot(
    account_id: &str,
    today: NaiveDate,
    snapshot: &HoldingsImportSnapshotValidationInput,
) -> std::result::Result<NaiveDate, Vec<String>> {
    let date = match validate_holdings_import_snapshot_date(account_id, today, snapshot) {
        Ok(date) => date,
        Err(error) => return Err(vec![error]),
    };
    let errors = holdings_position_validation_errors(snapshot);
    if errors.is_empty() {
        Ok(date)
    } else {
        Err(errors)
    }
}

fn validate_holdings_import_snapshot_date(
    account_id: &str,
    today: NaiveDate,
    snapshot: &HoldingsImportSnapshotValidationInput,
) -> std::result::Result<NaiveDate, String> {
    let date = NaiveDate::parse_from_str(&snapshot.date, "%Y-%m-%d")
        .map_err(|_| format!("Date '{}' isn't valid. Use YYYY-MM-DD.", snapshot.date))?;
    validate_snapshot_write_date(account_id, date, SnapshotSource::CsvImport.as_str(), today)
        .map_err(import_date_error)?;
    Ok(date)
}

fn holdings_position_validation_errors(
    snapshot: &HoldingsImportSnapshotValidationInput,
) -> Vec<String> {
    let mut errors = Vec::new();
    for position in &snapshot.positions {
        let holding = position.symbol.trim();
        let holding = if holding.is_empty() {
            "this holding"
        } else {
            holding
        };
        if position.symbol.trim().is_empty() {
            errors.push(format!(
                "On {}, add a symbol for each holding.",
                snapshot.date
            ));
        }
        if position.quantity.parse::<Decimal>().is_err() {
            errors.push(format!(
                "On {}, enter a valid quantity for {}.",
                snapshot.date, holding
            ));
        }
        if let Some(avg_cost) = &position.avg_cost {
            if !avg_cost.is_empty() && avg_cost.parse::<Decimal>().is_err() {
                errors.push(format!(
                    "On {}, enter a valid average cost for {}.",
                    snapshot.date, holding
                ));
            }
        }
    }
    for (currency, amount) in &snapshot.cash_balances {
        let currency = currency.trim();
        if currency.is_empty() {
            errors.push(format!(
                "On {}, add a currency for each cash balance.",
                snapshot.date
            ));
        }
        if amount.parse::<Decimal>().is_err() {
            let label = if currency.is_empty() {
                "this cash balance"
            } else {
                currency
            };
            errors.push(format!(
                "On {}, enter a valid cash amount for {}.",
                snapshot.date, label
            ));
        }
    }
    errors
}

pub async fn check_holdings_import(
    asset_service: &dyn AssetServiceTrait,
    snapshot_service: &dyn SnapshotServiceTrait,
    account_id: &str,
    account_currency: &str,
    today: NaiveDate,
    snapshots: &[HoldingsImportSnapshotValidationInput],
) -> Result<HoldingsImportCheckResult> {
    let mut validation_errors = Vec::new();
    let mut valid_dates = Vec::new();
    let mut invalid_snapshot_dates = Vec::new();
    let mut candidates = BTreeMap::<String, AssetResolutionInput>::new();

    for snapshot in snapshots {
        match validate_holdings_import_snapshot(account_id, today, snapshot) {
            Ok(date) => valid_dates.push(date),
            Err(errors) => {
                validation_errors.extend(errors);
                invalid_snapshot_dates.push(snapshot.date.clone());
                continue;
            }
        }

        for position in &snapshot.positions {
            let symbol = position.symbol.trim().to_uppercase();
            if symbol.is_empty() {
                continue;
            }
            let candidate = asset_resolution_input(position, account_currency, symbol.clone());
            candidates
                .entry(symbol)
                .and_modify(|existing| {
                    if !existing.reviewed_metadata_is_sufficient()
                        && candidate.reviewed_metadata_is_sufficient()
                    {
                        *existing = candidate.clone();
                    }
                })
                .or_insert(candidate);
        }
    }

    let existing_dates = existing_snapshot_dates(snapshot_service, account_id, &valid_dates)?;

    let unresolved: Vec<_> = candidates
        .values()
        .filter(|candidate| !candidate.reviewed_metadata_is_sufficient())
        .cloned()
        .collect();
    let resolved = if unresolved.is_empty() {
        Vec::new()
    } else {
        asset_service
            .resolve_import_asset_inputs(unresolved)
            .await?
    };
    let resolved_by_key: BTreeMap<_, _> = resolved
        .into_iter()
        .map(|output| (output.key.clone(), output))
        .collect();

    let symbols = candidates
        .into_values()
        .map(|candidate| {
            if candidate.reviewed_metadata_is_sufficient() {
                symbol_check_from_reviewed(candidate)
            } else {
                let output = resolved_by_key.get(&candidate.key);
                symbol_check_from_resolution(candidate, output)
            }
        })
        .collect();

    Ok(HoldingsImportCheckResult {
        existing_dates,
        symbols,
        validation_errors,
        valid_snapshot_dates: valid_dates.iter().map(ToString::to_string).collect(),
        invalid_snapshot_dates,
    })
}

fn import_date_error(error: Error) -> String {
    match error {
        Error::Validation(ValidationError::InvalidSnapshotDate {
            date,
            min_date,
            max_date,
            ..
        }) => format!(
            "Date {} can't be imported. Use a date from {} to {}.",
            date, min_date, max_date
        ),
        error => error.to_string(),
    }
}

fn asset_resolution_input(
    position: &HoldingsImportPositionValidationInput,
    account_currency: &str,
    key: String,
) -> AssetResolutionInput {
    AssetResolutionInput {
        key,
        source_symbol: position.symbol.clone(),
        account_currency: account_currency.to_string(),
        activity_currency: non_empty(&position.currency),
        exchange_mic: position.exchange_mic.clone(),
        quote_ccy: position.quote_ccy.clone(),
        instrument_type: position
            .instrument_type
            .as_deref()
            .and_then(InstrumentType::from_external_str),
        quote_mode: parse_quote_mode(position.quote_mode.as_deref()),
        isin: None,
        asset_id: position.asset_id.clone(),
        provider_id: position.provider_id.clone(),
        provider_symbol: position.provider_symbol.clone(),
        name: None,
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn parse_quote_mode(value: Option<&str>) -> Option<QuoteMode> {
    match value?.trim().to_uppercase().as_str() {
        "MARKET" => Some(QuoteMode::Market),
        "MANUAL" => Some(QuoteMode::Manual),
        _ => None,
    }
}

pub fn holdings_import_data_source(quote_mode: Option<&str>) -> Option<String> {
    (parse_quote_mode(quote_mode) == Some(QuoteMode::Manual))
        .then(|| DATA_SOURCE_MANUAL.to_string())
}

fn existing_snapshot_dates(
    snapshot_service: &dyn SnapshotServiceTrait,
    account_id: &str,
    valid_dates: &[NaiveDate],
) -> Result<Vec<String>> {
    let (Some(min_date), Some(max_date)) = (valid_dates.iter().min(), valid_dates.iter().max())
    else {
        return Ok(Vec::new());
    };

    let import_dates: HashSet<_> = valid_dates.iter().copied().collect();
    let mut existing_dates: Vec<_> = snapshot_service
        .get_holdings_keyframes(account_id, Some(*min_date), Some(*max_date))?
        .into_iter()
        .filter(|snapshot| import_dates.contains(&snapshot.snapshot_date))
        .map(|snapshot| snapshot.snapshot_date.format("%Y-%m-%d").to_string())
        .collect();
    existing_dates.sort();
    existing_dates.dedup();
    Ok(existing_dates)
}

fn symbol_check_from_reviewed(candidate: AssetResolutionInput) -> HoldingsImportSymbolCheck {
    HoldingsImportSymbolCheck {
        symbol: candidate.key,
        found: true,
        asset_name: None,
        asset_id: candidate.asset_id,
        currency: candidate.quote_ccy,
        exchange_mic: candidate.exchange_mic,
    }
}

fn symbol_check_from_resolution(
    candidate: AssetResolutionInput,
    output: Option<&AssetResolutionOutput>,
) -> HoldingsImportSymbolCheck {
    let found = output.is_some_and(|output| {
        output.existing_asset_id.is_some()
            || output.draft.is_some()
            || output.canonical_symbol.is_some()
    });
    HoldingsImportSymbolCheck {
        symbol: candidate.key,
        found,
        asset_name: output.and_then(|output| {
            output
                .name
                .clone()
                .or_else(|| output.draft.as_ref().and_then(|draft| draft.name.clone()))
        }),
        asset_id: output.and_then(|output| output.existing_asset_id.clone()),
        currency: output
            .and_then(|output| output.quote_ccy.clone())
            .or(candidate.quote_ccy),
        exchange_mic: output
            .and_then(|output| output.exchange_mic.clone())
            .or(candidate.exchange_mic),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(symbol: &str) -> HoldingsImportPositionValidationInput {
        HoldingsImportPositionValidationInput {
            symbol: symbol.to_string(),
            quantity: "1".to_string(),
            avg_cost: None,
            currency: "USD".to_string(),
            exchange_mic: Some("XNAS".to_string()),
            quote_ccy: Some("USD".to_string()),
            instrument_type: Some("EQUITY".to_string()),
            quote_mode: Some("MARKET".to_string()),
            provider_id: Some("YAHOO".to_string()),
            provider_symbol: Some(symbol.to_string()),
            asset_id: None,
        }
    }

    #[test]
    fn manual_quote_mode_uses_manual_data_source() {
        assert_eq!(
            holdings_import_data_source(Some("manual")).as_deref(),
            Some(DATA_SOURCE_MANUAL)
        );
        assert_eq!(holdings_import_data_source(Some("MARKET")), None);
        assert_eq!(holdings_import_data_source(None), None);
    }

    #[test]
    fn reviewed_holdings_do_not_require_resolution() {
        let candidates: Vec<_> = (0..51)
            .map(|index| {
                let position = position(&format!("ASSET{index}"));
                asset_resolution_input(&position, "USD", position.symbol.clone())
            })
            .collect();

        assert!(candidates
            .iter()
            .all(AssetResolutionInput::reviewed_metadata_is_sufficient));
    }

    #[test]
    fn incomplete_equity_still_requires_resolution() {
        let mut position = position("AAPL");
        position.exchange_mic = None;
        position.asset_id = None;

        let candidate = asset_resolution_input(&position, "USD", "AAPL".to_string());

        assert!(!candidate.reviewed_metadata_is_sufficient());
    }

    #[test]
    fn manual_equity_does_not_require_an_exchange() {
        let mut position = position("PRIVATE FUND");
        position.exchange_mic = None;
        position.quote_mode = Some("MANUAL".to_string());

        let candidate = asset_resolution_input(&position, "USD", "PRIVATE FUND".to_string());

        assert!(candidate.reviewed_metadata_is_sufficient());
    }

    #[test]
    fn apply_validation_rejects_the_same_invalid_position_fields_as_preview() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 5).unwrap();
        let mut invalid = position("");
        invalid.avg_cost = Some("not-a-number".to_string());
        let snapshot = HoldingsImportSnapshotValidationInput {
            date: today.to_string(),
            positions: vec![invalid],
            cash_balances: Vec::new(),
        };

        let errors = validate_holdings_import_snapshot("account", today, &snapshot)
            .expect_err("invalid fields must block apply");
        assert!(errors.iter().any(|error| error.contains("add a symbol")));
        assert!(errors
            .iter()
            .any(|error| error.contains("valid average cost")));
    }

    #[test]
    fn apply_validation_accepts_reviewed_snapshot() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 5).unwrap();
        let snapshot = HoldingsImportSnapshotValidationInput {
            date: today.to_string(),
            positions: vec![position("AAPL")],
            cash_balances: vec![("USD".to_string(), "100".to_string())],
        };

        assert_eq!(
            validate_holdings_import_snapshot("account", today, &snapshot),
            Ok(today)
        );
    }

    #[test]
    fn apply_validation_rejects_invalid_cash_before_import() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 5).unwrap();
        let snapshot = HoldingsImportSnapshotValidationInput {
            date: today.to_string(),
            positions: vec![position("AAPL")],
            cash_balances: vec![("USD".to_string(), "not-a-number".to_string())],
        };

        let errors = validate_holdings_import_snapshot("account", today, &snapshot)
            .expect_err("invalid cash must block preview and apply");
        assert!(errors
            .iter()
            .any(|error| error.contains("valid cash amount for USD")));
    }
}
