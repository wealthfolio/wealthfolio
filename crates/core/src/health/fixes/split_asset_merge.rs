//! Split asset merge fix.
//!
//! Merges the asset pairs reported by the split asset identity check. The fix
//! is reachable over HTTP in server mode, so every requested pair is checked
//! against a fresh detection run first: only a legacy-MIC duplicate and its
//! canonical twin, quoting in the same currency, can ever be merged.

use std::collections::{HashMap, HashSet};

use log::warn;
use serde::Deserialize;
use serde_json::Value;

use crate::activities::{Activity, ActivityServiceTrait};
use crate::assets::{Asset, AssetMergeReport, AssetServiceTrait};
use crate::errors::{Error, Result, ValidationError};
use crate::health::checks::find_split_asset_pairs;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeRequest {
    pairs: Vec<RequestedPair>,
}

#[derive(Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
struct RequestedPair {
    survivor_asset_id: String,
    duplicate_asset_id: String,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(ValidationError::InvalidInput(message.into()))
}

/// Merges each requested `{ survivorAssetId, duplicateAssetId }` pair after
/// re-validating all of them. Returns one report per merged pair.
pub async fn merge_split_assets(
    asset_service: &dyn AssetServiceTrait,
    activity_service: &dyn ActivityServiceTrait,
    payload: &Value,
) -> Result<Vec<AssetMergeReport>> {
    let assets = asset_service.get_assets()?;
    let activities = activity_service.get_activities()?;
    let requested = validate_merge_request(payload, &assets, &activities)?;

    let mut reports = Vec::with_capacity(requested.len());
    for pair in requested {
        let report = asset_service
            .merge_split_asset(&pair.survivor_asset_id, &pair.duplicate_asset_id)
            .await?;
        // The survivor may carry a wrong provider name or profile; refreshing
        // it is best-effort and never undoes the merge.
        if let Err(e) = asset_service
            .enrich_asset_profile(&pair.survivor_asset_id)
            .await
        {
            warn!(
                "Merged {} into {}, but refreshing its profile failed: {}",
                pair.duplicate_asset_id, pair.survivor_asset_id, e
            );
        }
        reports.push(report);
    }
    Ok(reports)
}

/// Parses the payload and accepts only pairs that a fresh detection run
/// reports as mergeable (same quote currency).
fn validate_merge_request(
    payload: &Value,
    assets: &[Asset],
    activities: &[Activity],
) -> Result<Vec<RequestedPair>> {
    let request: MergeRequest = serde_json::from_value(payload.clone())
        .map_err(|e| invalid(format!("Invalid merge request: {e}")))?;
    let mut seen = HashSet::new();
    let requested: Vec<RequestedPair> = request
        .pairs
        .into_iter()
        .filter(|pair| {
            seen.insert((
                pair.survivor_asset_id.clone(),
                pair.duplicate_asset_id.clone(),
            ))
        })
        .collect();
    if requested.is_empty() {
        return Err(invalid("No asset pairs to merge"));
    }

    let detected = find_split_asset_pairs(assets, activities, &HashMap::new(), None);
    for pair in &requested {
        let found = detected.iter().find(|candidate| {
            candidate.survivor.asset_id == pair.survivor_asset_id
                && candidate.duplicate.asset_id == pair.duplicate_asset_id
        });
        match found {
            None => {
                return Err(invalid(format!(
                    "Asset {} is not a legacy-exchange duplicate of asset {}",
                    pair.duplicate_asset_id, pair.survivor_asset_id
                )))
            }
            Some(found) if found.currency_mismatch => {
                return Err(invalid(format!(
                    "{} quotes in {} on {} and {} on {}, so the two records cannot be merged automatically",
                    found.survivor.symbol,
                    found.survivor.quote_ccy,
                    found.survivor.exchange_mic,
                    found.duplicate.quote_ccy,
                    found.duplicate.exchange_mic
                )))
            }
            Some(_) => {}
        }
    }
    Ok(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{AssetKind, InstrumentType};
    use serde_json::json;

    fn asset(id: &str, symbol: &str, mic: &str, ccy: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Investment,
            quote_ccy: ccy.to_string(),
            instrument_type: Some(InstrumentType::Equity),
            instrument_symbol: Some(symbol.to_string()),
            instrument_exchange_mic: Some(mic.to_string()),
            is_active: true,
            ..Asset::default()
        }
    }

    fn request(survivor: &str, duplicate: &str) -> Value {
        json!({ "pairs": [{ "survivorAssetId": survivor, "duplicateAssetId": duplicate }] })
    }

    fn is_validation(result: Result<Vec<RequestedPair>>) -> bool {
        matches!(result, Err(Error::Validation(_)))
    }

    #[test]
    fn accepts_only_detected_pairs() {
        let assets = vec![
            asset("xneo", "VBG", "XNEO", "CAD"),
            asset("neoe", "VBG", "NEOE", "CAD"),
            asset("aapl", "AAPL", "XNAS", "USD"),
        ];
        let accepted = validate_merge_request(&request("neoe", "xneo"), &assets, &[]).unwrap();
        assert_eq!(accepted.len(), 1);

        // Reversed direction, unrelated assets, unknown ids and empty or
        // malformed payloads are all rejected.
        for payload in [
            request("xneo", "neoe"),
            request("neoe", "aapl"),
            request("aapl", "xneo"),
            request("neoe", "missing"),
            json!({ "pairs": [] }),
            json!(["neoe", "xneo"]),
        ] {
            assert!(
                is_validation(validate_merge_request(&payload, &assets, &[])),
                "{payload}"
            );
        }
    }

    #[test]
    fn rejects_pairs_quoted_in_different_currencies() {
        let assets = vec![
            asset("xneo", "VBG", "XNEO", "USD"),
            asset("neoe", "VBG", "NEOE", "CAD"),
        ];
        assert!(is_validation(validate_merge_request(
            &request("neoe", "xneo"),
            &assets,
            &[]
        )));
    }

    #[test]
    fn rejects_an_already_merged_pair() {
        let mut retired = asset("xneo", "VBG", "XNEO", "CAD");
        retired.is_active = false;
        let assets = vec![retired, asset("neoe", "VBG", "NEOE", "CAD")];
        assert!(is_validation(validate_merge_request(
            &request("neoe", "xneo"),
            &assets,
            &[]
        )));
    }
}
