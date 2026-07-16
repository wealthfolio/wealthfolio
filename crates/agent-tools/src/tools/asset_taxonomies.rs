//! Asset taxonomy read tools.
//!
//! `list_asset_taxonomies` and `get_asset_taxonomy_assignments` migrated
//! here from `wealthfolio-ai` (see `crates/ai/tests/tool_outputs_parity.rs`).
//! The asset-resolution helpers are shared with the assistant-only
//! `prepare_asset_classification` tool, which stays in `wealthfolio-ai` and
//! imports them from this module.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wealthfolio_core::{
    assets::{parse_symbol_with_exchange_suffix, Asset},
    taxonomies::{AssetTaxonomyAssignment, Category, TaxonomyWithCategories},
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

const ASSET_SCOPE: &str = "asset";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAssetTaxonomiesArgs {
    pub taxonomy_id: Option<String>,
    pub taxonomy_name: Option<String>,
    pub include_categories: Option<bool>,
    pub category_depth: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetTaxonomyAssignmentsArgs {
    pub asset_query: String,
    pub taxonomy_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAssetDto {
    pub asset_id: String,
    pub label: String,
    pub display_code: Option<String>,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub exchange_mic: Option<String>,
    pub currency: String,
    pub matched_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTaxonomyCategoryDto {
    pub category_id: String,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTaxonomyDto {
    pub taxonomy_id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub is_single_select: bool,
    pub sort_order: i32,
    pub category_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<AssetTaxonomyCategoryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAssetTaxonomiesOutput {
    pub taxonomies: Vec<AssetTaxonomyDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetTaxonomyAssignmentDto {
    pub assignment_id: String,
    pub taxonomy_id: String,
    pub taxonomy_name: String,
    pub category_id: String,
    pub category_name: String,
    pub category_key: String,
    pub weight_basis_points: i32,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAssetTaxonomyAssignmentsOutput {
    pub asset_query: String,
    pub resolved_asset: ResolvedAssetDto,
    pub assignments: Vec<AssetTaxonomyAssignmentDto>,
}

/// Tool to list asset-scoped taxonomies and their categories.
pub struct ListAssetTaxonomies;

#[async_trait::async_trait]
impl AgentTool for ListAssetTaxonomies {
    fn name(&self) -> &'static str {
        "list_asset_taxonomies"
    }

    fn description(&self) -> &'static str {
        "List asset-scoped taxonomy summaries, or categories for one selected \
         asset taxonomy. First call without arguments to choose the taxonomy. Then call \
         with taxonomyId or taxonomyName and includeCategories=true to get category IDs. \
         For sector/top-level allocation requests, use categoryDepth=\"root\" so only \
         root categories are returned. For region screenshots that list countries, use \
         categoryDepth=\"all\" to get child country categories and parent IDs; use \
         matching leaf country category IDs when available, and aggregate to root region \
         categories only for top-level/root region requests. Use categoryDepth=\"all\" \
         for detailed industry/subindustry requests."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "taxonomyId": {
                    "type": "string",
                    "description": "Optional asset-scoped taxonomy ID. Use this when you already selected the taxonomy from a prior summary call."
                },
                "taxonomyName": {
                    "type": "string",
                    "description": "Optional exact taxonomy name to fetch. Prefer taxonomyId when available."
                },
                "includeCategories": {
                    "type": "boolean",
                    "description": "Whether to include category IDs. Defaults to false for summary calls and true when taxonomyId or taxonomyName is provided."
                },
                "categoryDepth": {
                    "type": "string",
                    "enum": ["root", "all"],
                    "description": "Category set to return when includeCategories is true. Defaults to root. Use root for sector/top-level allocation; use all only for detailed categories."
                }
            }
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ClassificationRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ListAssetTaxonomiesArgs = serde_json::from_value(args)?;
        let taxonomies = asset_taxonomies(env.as_ref())?;
        let taxonomy_id = args
            .taxonomy_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let taxonomy_name = args
            .taxonomy_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let filters_taxonomy = taxonomy_id.is_some() || taxonomy_name.is_some();
        let include_categories = args.include_categories.unwrap_or(filters_taxonomy);
        let category_depth = parse_category_depth(args.category_depth.as_deref())?;
        let taxonomies = filter_asset_taxonomies(&taxonomies, taxonomy_id, taxonomy_name)?;

        let output = ListAssetTaxonomiesOutput {
            taxonomies: taxonomies
                .iter()
                .map(|entry| to_asset_taxonomy_dto(entry, include_categories, category_depth))
                .collect(),
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// Tool to read the current taxonomy assignments for one active local asset.
pub struct GetAssetTaxonomyAssignments;

#[async_trait::async_trait]
impl AgentTool for GetAssetTaxonomyAssignments {
    fn name(&self) -> &'static str {
        "get_asset_taxonomy_assignments"
    }

    fn description(&self) -> &'static str {
        "Read current asset taxonomy assignments for one active local asset. \
         assetQuery may be an asset ID, exact ticker/display code, provider-suffixed \
         ticker like SHOP.TO, or an asset name such as Apple Inc. Use this for \
         read-only current-classification questions. For classification update/draft \
         requests, use prepare_asset_classification instead because it returns current \
         assignments and handles ambiguous asset matches in the widget."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "assetQuery": {
                    "type": "string",
                    "description": "Active local asset ID, ticker/display code, provider-suffixed ticker, or asset name."
                },
                "taxonomyId": {
                    "type": "string",
                    "description": "Optional taxonomy ID filter. Omit to return all asset-scoped taxonomy assignments for the asset."
                }
            },
            "required": ["assetQuery"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ClassificationRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: GetAssetTaxonomyAssignmentsArgs = serde_json::from_value(args)?;
        let taxonomies = asset_taxonomies(env.as_ref())?;
        let taxonomy_lookup = taxonomy_lookup(&taxonomies);
        if let Some(taxonomy_id) = args.taxonomy_id.as_deref() {
            validate_asset_taxonomy(&taxonomies, taxonomy_id)?;
        }

        let asset = resolve_active_asset(env.as_ref(), &args.asset_query)?;
        let assignments = env
            .taxonomy_service()
            .get_asset_assignments(&asset.asset.id)
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            .into_iter()
            .filter(|assignment| {
                args.taxonomy_id
                    .as_ref()
                    .is_none_or(|taxonomy_id| &assignment.taxonomy_id == taxonomy_id)
            })
            .filter_map(|assignment| assignment_dto(&assignment, &taxonomy_lookup))
            .collect();

        let output = GetAssetTaxonomyAssignmentsOutput {
            asset_query: args.asset_query,
            resolved_asset: asset.to_dto(),
            assignments,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CategoryDepth {
    Root,
    All,
}

fn resolve_active_asset(
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
        currency: asset.quote_ccy.clone(),
        matched_by: matched_by.to_string(),
    }
}

fn asset_candidate_label(asset: &Asset) -> String {
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

/// Fetch all asset-scoped taxonomies (with categories).
pub fn asset_taxonomies(
    env: &dyn AgentEnvironment,
) -> Result<Vec<TaxonomyWithCategories>, AgentToolError> {
    Ok(env
        .taxonomy_service()
        .get_taxonomies_with_categories()
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .into_iter()
        .filter(|entry| entry.taxonomy.scope == ASSET_SCOPE)
        .collect())
}

/// Find `taxonomy_id` among asset-scoped taxonomies or fail with the
/// model-facing invalid-input message.
pub fn validate_asset_taxonomy<'a>(
    taxonomies: &'a [TaxonomyWithCategories],
    taxonomy_id: &str,
) -> Result<&'a TaxonomyWithCategories, AgentToolError> {
    taxonomies
        .iter()
        .find(|entry| entry.taxonomy.id == taxonomy_id)
        .ok_or_else(|| {
            AgentToolError::InvalidInput(format!(
                "Taxonomy '{taxonomy_id}' was not found or is not asset-scoped"
            ))
        })
}

fn parse_category_depth(value: Option<&str>) -> Result<CategoryDepth, AgentToolError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(CategoryDepth::Root),
        Some(value) if value.eq_ignore_ascii_case("root") => Ok(CategoryDepth::Root),
        Some(value) if value.eq_ignore_ascii_case("all") => Ok(CategoryDepth::All),
        Some(value) => Err(AgentToolError::InvalidInput(format!(
            "categoryDepth must be 'root' or 'all', got '{value}'"
        ))),
    }
}

fn filter_asset_taxonomies<'a>(
    taxonomies: &'a [TaxonomyWithCategories],
    taxonomy_id: Option<&str>,
    taxonomy_name: Option<&str>,
) -> Result<Vec<&'a TaxonomyWithCategories>, AgentToolError> {
    let filtered = taxonomies
        .iter()
        .filter(|entry| {
            taxonomy_id.is_none_or(|id| entry.taxonomy.id == id)
                && taxonomy_name.is_none_or(|name| entry.taxonomy.name.eq_ignore_ascii_case(name))
        })
        .collect::<Vec<_>>();

    if (taxonomy_id.is_some() || taxonomy_name.is_some()) && filtered.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "No asset-scoped taxonomy matched the requested taxonomy filter".to_string(),
        ));
    }

    if taxonomy_id.is_none() && taxonomy_name.is_some() && filtered.len() > 1 {
        return Err(AgentToolError::InvalidInput(
            "Taxonomy name matched multiple asset-scoped taxonomies; use taxonomyId".to_string(),
        ));
    }

    Ok(filtered)
}

fn to_asset_taxonomy_dto(
    entry: &TaxonomyWithCategories,
    include_categories: bool,
    category_depth: CategoryDepth,
) -> AssetTaxonomyDto {
    let categories = if include_categories {
        entry
            .categories
            .iter()
            .filter(|category| {
                category_depth == CategoryDepth::All || category.parent_id.as_deref().is_none()
            })
            .map(to_category_dto)
            .collect()
    } else {
        Vec::new()
    };

    AssetTaxonomyDto {
        taxonomy_id: entry.taxonomy.id.clone(),
        name: entry.taxonomy.name.clone(),
        description: entry.taxonomy.description.clone(),
        color: entry.taxonomy.color.clone(),
        is_single_select: entry.taxonomy.is_single_select,
        sort_order: entry.taxonomy.sort_order,
        category_count: entry.categories.len(),
        categories,
    }
}

fn to_category_dto(category: &Category) -> AssetTaxonomyCategoryDto {
    AssetTaxonomyCategoryDto {
        category_id: category.id.clone(),
        taxonomy_id: category.taxonomy_id.clone(),
        parent_id: category.parent_id.clone(),
        name: category.name.clone(),
        key: category.key.clone(),
        color: category.color.clone(),
        sort_order: category.sort_order,
    }
}

fn taxonomy_lookup(
    taxonomies: &[TaxonomyWithCategories],
) -> HashMap<(String, String), (&TaxonomyWithCategories, &Category)> {
    let mut lookup = HashMap::new();
    for taxonomy in taxonomies {
        for category in &taxonomy.categories {
            lookup.insert(
                (taxonomy.taxonomy.id.clone(), category.id.clone()),
                (taxonomy, category),
            );
        }
    }
    lookup
}

fn assignment_dto(
    assignment: &AssetTaxonomyAssignment,
    lookup: &HashMap<(String, String), (&TaxonomyWithCategories, &Category)>,
) -> Option<AssetTaxonomyAssignmentDto> {
    let lookup_key = (
        assignment.taxonomy_id.clone(),
        assignment.category_id.clone(),
    );
    let (taxonomy, category) = lookup.get(&lookup_key)?;
    Some(AssetTaxonomyAssignmentDto {
        assignment_id: assignment.id.clone(),
        taxonomy_id: assignment.taxonomy_id.clone(),
        taxonomy_name: taxonomy.taxonomy.name.clone(),
        category_id: assignment.category_id.clone(),
        category_name: category.name.clone(),
        category_key: category.key.clone(),
        weight_basis_points: assignment.weight,
        source: assignment.source.clone(),
    })
}
