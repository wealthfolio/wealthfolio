//! Shared asset lookup for agent tools.
//!
//! Resolves a user-supplied asset query (id, symbol, symbol + MIC, name) to
//! one active asset or a short candidate list. Used by the classification
//! tools and by `get_asset`, so finding an asset id needs only the scope of
//! the tool that asks.

use serde::{Deserialize, Serialize};
use wealthfolio_core::assets::{parse_symbol_with_exchange_suffix, Asset};

use crate::env::AgentEnvironment;
use crate::tool::AgentToolError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAssetDto {
    pub asset_id: String,
    pub label: String,
    pub display_code: Option<String>,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub exchange_mic: Option<String>,
    pub instrument_type: Option<wealthfolio_core::assets::InstrumentType>,
    pub currency: String,
    pub matched_by: String,
}

/// An active asset matched by [`resolve_active_asset_match`], with the
/// matching strategy that found it.
pub struct ResolvedAsset {
    pub asset: Asset,
    pub matched_by: &'static str,
}

impl ResolvedAsset {
    pub fn to_dto(&self) -> ResolvedAssetDto {
        asset_to_dto(&self.asset, self.matched_by)
    }
}

/// Outcome of resolving a user-supplied asset query against active assets.
pub enum ActiveAssetResolution {
    Resolved(Box<ResolvedAsset>),
    Ambiguous(Vec<Asset>),
    NotFound(String),
}

enum UniqueAssetMatch {
    None,
    One(Box<Asset>),
    Ambiguous(Vec<Asset>),
}

/// Resolve `asset_query` to one active asset, or an error that lists the
/// candidates when it is ambiguous.
pub fn resolve_active_asset(
    env: &dyn AgentEnvironment,
    asset_query: &str,
) -> Result<ResolvedAsset, AgentToolError> {
    match resolve_active_asset_match(env, asset_query)? {
        ActiveAssetResolution::Resolved(asset) => Ok(*asset),
        ActiveAssetResolution::Ambiguous(candidates) => Err(ambiguous_asset_error(&candidates)),
        ActiveAssetResolution::NotFound(query) => Err(AgentToolError::InvalidInput(format!(
            "Asset '{query}' was not found among active assets"
        ))),
    }
}

/// Resolve `asset_query` against active assets, trying (in order): asset ID,
/// exact symbol/display code, provider-suffixed ticker, symbol + exchange
/// MIC, exact name, exact label, then fuzzy name.
pub fn resolve_active_asset_match(
    env: &dyn AgentEnvironment,
    asset_query: &str,
) -> Result<ActiveAssetResolution, AgentToolError> {
    let query = asset_query.trim();
    if query.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "assetQuery is required".to_string(),
        ));
    }

    let active_assets = env
        .asset_service()
        .get_assets()
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .into_iter()
        .filter(|asset| asset.is_active)
        .collect::<Vec<_>>();
    if active_assets.is_empty() {
        return Ok(ActiveAssetResolution::NotFound(query.to_string()));
    }

    match unique_by_result(&active_assets, |asset| asset.id.eq_ignore_ascii_case(query)) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "asset_id",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    match unique_by_result(&active_assets, |asset| {
        option_eq_ignore_ascii_case(asset.display_code.as_deref(), query)
            || option_eq_ignore_ascii_case(asset.instrument_symbol.as_deref(), query)
    }) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "symbol",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    let (base_symbol, exchange_mic) = parse_symbol_with_exchange_suffix(query);
    if let Some(exchange_mic) = exchange_mic {
        match unique_by_result(&active_assets, |asset| {
            (option_eq_ignore_ascii_case(asset.display_code.as_deref(), base_symbol)
                || option_eq_ignore_ascii_case(asset.instrument_symbol.as_deref(), base_symbol))
                && option_eq_ignore_ascii_case(
                    asset.instrument_exchange_mic.as_deref(),
                    exchange_mic,
                )
        }) {
            UniqueAssetMatch::One(asset) => {
                return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                    asset: *asset,
                    matched_by: "provider_suffix",
                })));
            }
            UniqueAssetMatch::Ambiguous(candidates) => {
                return Ok(ActiveAssetResolution::Ambiguous(candidates));
            }
            UniqueAssetMatch::None => {}
        }
    }

    match resolve_symbol_with_exchange_mic(&active_assets, query) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "symbol_exchange_mic",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    let normalized_query = normalize_lookup(query);
    match unique_by_result(&active_assets, |asset| {
        asset.name.as_deref().is_some_and(|name| {
            let normalized_name = normalize_lookup(name);
            normalized_name == normalized_query
        })
    }) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "name",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    match unique_by_result(&active_assets, |asset| {
        normalize_lookup(&asset_label(asset)) == normalized_query
            || normalize_lookup(&asset_candidate_label(asset)) == normalized_query
    }) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "label",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    match unique_by_result(&active_assets, |asset| {
        asset.name.as_deref().is_some_and(|name| {
            let normalized_name = normalize_lookup(name);
            normalized_name.starts_with(&normalized_query)
                || normalized_name.contains(&normalized_query)
        })
    }) {
        UniqueAssetMatch::One(asset) => {
            return Ok(ActiveAssetResolution::Resolved(Box::new(ResolvedAsset {
                asset: *asset,
                matched_by: "name_fuzzy",
            })));
        }
        UniqueAssetMatch::Ambiguous(candidates) => {
            return Ok(ActiveAssetResolution::Ambiguous(candidates));
        }
        UniqueAssetMatch::None => {}
    }

    Ok(ActiveAssetResolution::NotFound(query.to_string()))
}

fn unique_by_result(assets: &[Asset], matches: impl Fn(&Asset) -> bool) -> UniqueAssetMatch {
    let matched = assets
        .iter()
        .filter(|asset| matches(asset))
        .collect::<Vec<_>>();
    match matched.len() {
        0 => UniqueAssetMatch::None,
        1 => UniqueAssetMatch::One(Box::new((*matched[0]).clone())),
        _ => UniqueAssetMatch::Ambiguous(
            matched
                .iter()
                .take(8)
                .map(|asset| (*asset).clone())
                .collect(),
        ),
    }
}

fn ambiguous_asset_error(candidates: &[Asset]) -> AgentToolError {
    AgentToolError::InvalidInput(format!(
        "Asset query is ambiguous. Candidates: {}",
        candidates
            .iter()
            .take(8)
            .map(asset_candidate_label)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn option_eq_ignore_ascii_case(value: Option<&str>, query: &str) -> bool {
    value.is_some_and(|value| value.trim().eq_ignore_ascii_case(query.trim()))
}

fn normalize_lookup(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn asset_label(asset: &Asset) -> String {
    let code = asset
        .display_code
        .as_deref()
        .or(asset.instrument_symbol.as_deref())
        .unwrap_or(asset.id.as_str());
    match asset.name.as_deref() {
        Some(name) if !name.trim().is_empty() => format!("{code} - {name}"),
        _ => code.to_string(),
    }
}

fn resolve_symbol_with_exchange_mic(assets: &[Asset], query: &str) -> UniqueAssetMatch {
    let normalized_query = normalize_lookup(query);
    unique_by_result(assets, |asset| {
        let Some(code) = asset
            .display_code
            .as_deref()
            .or(asset.instrument_symbol.as_deref())
        else {
            return false;
        };

        let mut candidates = Vec::new();
        if let Some(mic) = asset.instrument_exchange_mic.as_deref() {
            candidates.push(format!("{code} {mic}"));
            candidates.push(format!("{code} {mic} {}", asset.quote_ccy));
        }

        candidates
            .iter()
            .any(|candidate| normalize_lookup(candidate) == normalized_query)
    })
}

/// Build the DTO for a resolved asset, recording the matching strategy.
pub fn asset_to_dto(asset: &Asset, matched_by: &str) -> ResolvedAssetDto {
    ResolvedAssetDto {
        asset_id: asset.id.clone(),
        label: asset_label(asset),
        display_code: asset.display_code.clone(),
        symbol: asset.instrument_symbol.clone(),
        name: asset.name.clone(),
        exchange_mic: asset.instrument_exchange_mic.clone(),
        instrument_type: asset.instrument_type.clone(),
        currency: asset.quote_ccy.clone(),
        matched_by: matched_by.to_string(),
    }
}

pub fn asset_candidate_label(asset: &Asset) -> String {
    let mut qualifiers = Vec::new();
    if let Some(exchange_mic) = asset
        .instrument_exchange_mic
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        qualifiers.push(format!("mic: {exchange_mic}"));
    }
    if !asset.quote_ccy.trim().is_empty() {
        qualifiers.push(format!("currency: {}", asset.quote_ccy));
    }
    qualifiers.push(format!("id: {}", asset.id));

    format!("{} ({})", asset_label(asset), qualifiers.join(", "))
}
