//! Asset classification tool.
//!
//! `prepare_asset_classification` prepares asset taxonomy assignment
//! previews for the chat widget. It never writes to the database; the
//! frontend applies accepted drafts with existing taxonomy assignment
//! mutations after user confirmation.
//!
//! The read-only companions (`list_asset_taxonomies`,
//! `get_asset_taxonomy_assignments`) and the shared asset-resolution
//! helpers live in [`crate::tools::asset_taxonomies`].

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wealthfolio_core::taxonomies::Category;

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::asset_taxonomies::{
    asset_taxonomies, asset_to_dto, resolve_active_asset_match, validate_asset_taxonomy,
    ActiveAssetResolution, ResolvedAssetDto,
};

const AI_ASSIGNMENT_SOURCE: &str = "ai";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAssetClassificationArgs {
    pub asset_query: String,
    pub taxonomy_id: String,
    pub assignments: Vec<PreparedAssignmentInput>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAssignmentInput {
    pub category_id: String,
    pub weight_basis_points: i32,
    pub source_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTaxonomyDto {
    pub taxonomy_id: String,
    pub name: String,
    pub is_single_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentPreviewDto {
    pub assignment_id: Option<String>,
    pub category_id: String,
    pub category_name: String,
    pub category_key: String,
    pub category_color: String,
    pub weight_basis_points: i32,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationChangesDto {
    pub add_count: usize,
    pub update_count: usize,
    pub remove_count: usize,
    pub unchanged_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateAssignmentPreviewDto {
    pub asset_id: String,
    pub current_assignments: Vec<AssignmentPreviewDto>,
    pub changes: ClassificationChangesDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAssetClassificationOutput {
    pub asset_query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_asset: Option<ResolvedAssetDto>,
    pub taxonomy: PreparedTaxonomyDto,
    pub current_assignments: Vec<AssignmentPreviewDto>,
    pub proposed_assignments: Vec<AssignmentPreviewDto>,
    pub changes: ClassificationChangesDto,
    pub unallocated_basis_points: i32,
    pub draft_status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_candidates: Vec<ResolvedAssetDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_current_assignments: Vec<CandidateAssignmentPreviewDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_at: Option<String>,
}

const PREPARE_ASSET_CLASSIFICATION_DESCRIPTION: &str =
    "Prepare a non-mutating asset classification draft for the review widget. \
     Use category IDs from list_asset_taxonomies for the selected taxonomy only. \
     For sector allocation requests, use root/top-level categories from \
     list_asset_taxonomies instead of detailed industry or subindustry categories. \
     For region allocation requests based on country rows, use leaf country categories \
     when that is the requested granularity; aggregate to root regions only for \
     top-level/root region requests. \
     Omit screenshot buckets such as Unknown, Other, Unclassified, or N/A when they \
     do not exactly match an available category. Never map Other/Unknown/residual \
     bucket weights to a plausible country, region, sector, or industry. Never invent \
     placeholder category IDs. \
     This tool does not apply changes; the user must confirm the widget.";

pub struct PrepareAssetClassification;

impl PrepareAssetClassification {
    pub(crate) fn build_output(
        env: &dyn AgentEnvironment,
        args: PrepareAssetClassificationArgs,
    ) -> Result<PrepareAssetClassificationOutput, AgentToolError> {
        let taxonomies = asset_taxonomies(env)?;
        let taxonomy = validate_asset_taxonomy(&taxonomies, &args.taxonomy_id)?;
        let category_lookup: HashMap<&str, &Category> = taxonomy
            .categories
            .iter()
            .map(|category| (category.id.as_str(), category))
            .collect();

        validate_proposed_assignments(
            taxonomy.taxonomy.is_single_select,
            &category_lookup,
            &args.assignments,
        )?;

        let proposed_assignments = args
            .assignments
            .iter()
            .filter(|assignment| assignment.weight_basis_points > 0)
            .map(|assignment| proposed_preview_dto(assignment, &category_lookup))
            .collect::<Result<Vec<_>, _>>()?;

        let total_weight: i32 = proposed_assignments
            .iter()
            .map(|assignment| assignment.weight_basis_points)
            .sum();

        let asset = match resolve_active_asset_match(env, &args.asset_query)? {
            ActiveAssetResolution::Resolved(asset) => asset,
            ActiveAssetResolution::Ambiguous(candidates) => {
                let candidate_current_assignments = candidates
                    .iter()
                    .map(|asset| {
                        let current_assignments = current_assignments_for_asset(
                            env,
                            asset.id.as_str(),
                            &args.taxonomy_id,
                            &category_lookup,
                        )?;
                        Ok(CandidateAssignmentPreviewDto {
                            asset_id: asset.id.clone(),
                            changes: compute_changes(&current_assignments, &proposed_assignments),
                            current_assignments,
                        })
                    })
                    .collect::<Result<Vec<_>, AgentToolError>>()?;

                return Ok(PrepareAssetClassificationOutput {
                    asset_query: args.asset_query,
                    resolved_asset: None,
                    taxonomy: PreparedTaxonomyDto {
                        taxonomy_id: taxonomy.taxonomy.id.clone(),
                        name: taxonomy.taxonomy.name.clone(),
                        is_single_select: taxonomy.taxonomy.is_single_select,
                    },
                    changes: ClassificationChangesDto::default(),
                    current_assignments: Vec::new(),
                    proposed_assignments,
                    unallocated_basis_points: 10000 - total_weight,
                    draft_status: "needsAssetSelection".to_string(),
                    asset_candidates: candidates
                        .iter()
                        .map(|asset| asset_to_dto(asset, "candidate"))
                        .collect(),
                    candidate_current_assignments,
                    applied_at: None,
                });
            }
            ActiveAssetResolution::NotFound(query) => {
                return Err(AgentToolError::InvalidInput(format!(
                    "Asset '{query}' was not found among active assets"
                )));
            }
        };

        let current_assignments = current_assignments_for_asset(
            env,
            &asset.asset.id,
            &args.taxonomy_id,
            &category_lookup,
        )?;

        Ok(PrepareAssetClassificationOutput {
            asset_query: args.asset_query,
            resolved_asset: Some(asset.to_dto()),
            taxonomy: PreparedTaxonomyDto {
                taxonomy_id: taxonomy.taxonomy.id.clone(),
                name: taxonomy.taxonomy.name.clone(),
                is_single_select: taxonomy.taxonomy.is_single_select,
            },
            changes: compute_changes(&current_assignments, &proposed_assignments),
            current_assignments,
            proposed_assignments,
            unallocated_basis_points: 10000 - total_weight,
            draft_status: "draft".to_string(),
            asset_candidates: Vec::new(),
            candidate_current_assignments: Vec::new(),
            applied_at: None,
        })
    }
}

#[async_trait::async_trait]
impl AgentTool for PrepareAssetClassification {
    fn name(&self) -> &'static str {
        "prepare_asset_classification"
    }

    fn description(&self) -> &'static str {
        PREPARE_ASSET_CLASSIFICATION_DESCRIPTION
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
                    "description": "Asset-scoped taxonomy ID from list_asset_taxonomies."
                },
                "assignments": {
                    "type": "array",
                    "description": "Proposed categories for this asset and taxonomy. Empty array clears current assignments for the taxonomy.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "categoryId": { "type": "string" },
                            "weightBasisPoints": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 10000
                            },
                            "sourceLabel": {
                                "type": "string",
                                "description": "Original label exactly as shown by the user or screenshot before mapping to categoryId, for example 'United States'. Do not rewrite residual labels such as 'Other' or 'Unknown' as a country/category; omit those residual buckets unless they exactly match an available category."
                            }
                        },
                        "required": ["categoryId", "weightBasisPoints", "sourceLabel"]
                    }
                }
            },
            "required": ["assetQuery", "taxonomyId", "assignments"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Returns existing asset classifications (current + candidate
        // assignments), so it requires classification:read in addition to
        // classification:suggest — a suggest-only token must not read them.
        &[
            AgentScope::ClassificationRead,
            AgentScope::ClassificationSuggest,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Suggest
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareAssetClassificationArgs = serde_json::from_value(args)?;
        let output = PrepareAssetClassification::build_output(env.as_ref(), args)?;
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

fn validate_proposed_assignments(
    is_single_select: bool,
    category_lookup: &HashMap<&str, &Category>,
    assignments: &[PreparedAssignmentInput],
) -> Result<(), AgentToolError> {
    let mut seen = HashSet::new();
    for assignment in assignments {
        if !(0..=10000).contains(&assignment.weight_basis_points) {
            return Err(AgentToolError::InvalidInput(format!(
                "Weight for category '{}' must be between 0 and 10000 basis points",
                assignment.category_id
            )));
        }
        if assignment.weight_basis_points == 0 {
            continue;
        }
        if assignment.source_label.trim().is_empty() {
            return Err(AgentToolError::InvalidInput(format!(
                "sourceLabel is required for category '{}'",
                assignment.category_id
            )));
        }
        let Some(category) = category_lookup.get(assignment.category_id.as_str()) else {
            return Err(AgentToolError::InvalidInput(format!(
                "Category '{}' does not belong to the selected taxonomy",
                assignment.category_id
            )));
        };
        validate_source_label_mapping(assignment, category)?;
        if !seen.insert(assignment.category_id.as_str()) {
            return Err(AgentToolError::InvalidInput(format!(
                "Duplicate category ID '{}'",
                assignment.category_id
            )));
        }
    }

    if is_single_select {
        let non_zero_assignments = assignments
            .iter()
            .filter(|assignment| assignment.weight_basis_points > 0)
            .collect::<Vec<_>>();
        if non_zero_assignments.len() > 1 {
            return Err(AgentToolError::InvalidInput(
                "Single-select taxonomies allow only one category".to_string(),
            ));
        }
        if let Some(assignment) = non_zero_assignments.first() {
            if assignment.weight_basis_points != 10000 {
                return Err(AgentToolError::InvalidInput(
                    "Single-select taxonomies require 10000 basis points".to_string(),
                ));
            }
        }
    }

    Ok(())
}

fn validate_source_label_mapping(
    assignment: &PreparedAssignmentInput,
    category: &Category,
) -> Result<(), AgentToolError> {
    let source_label = assignment.source_label.trim();
    if !is_residual_bucket_label(source_label)
        || category_matches_source_label(category, source_label)
    {
        return Ok(());
    }

    Err(AgentToolError::InvalidInput(format!(
        "Residual bucket '{}' cannot be mapped to category '{}'. Omit that bucket so it remains unallocated.",
        source_label, category.name
    )))
}

fn category_matches_source_label(category: &Category, source_label: &str) -> bool {
    let normalized_source = normalize_category_label(source_label);
    [
        category.name.as_str(),
        category.key.as_str(),
        category.id.as_str(),
    ]
    .iter()
    .any(|value| normalize_category_label(value) == normalized_source)
}

fn is_residual_bucket_label(label: &str) -> bool {
    matches!(
        normalize_category_label(label).as_str(),
        "unknown"
            | "other"
            | "unclassified"
            | "uncategorized"
            | "unallocated"
            | "not classified"
            | "not applicable"
            | "n a"
            | "na"
            | "misc"
            | "miscellaneous"
            | "remainder"
            | "remaining"
            | "residual"
            | "rest"
    )
}

fn normalize_category_label(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn current_assignments_for_asset(
    env: &dyn AgentEnvironment,
    asset_id: &str,
    taxonomy_id: &str,
    category_lookup: &HashMap<&str, &Category>,
) -> Result<Vec<AssignmentPreviewDto>, AgentToolError> {
    Ok(env
        .taxonomy_service()
        .get_asset_assignments(asset_id)
        .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
        .into_iter()
        .filter(|assignment| assignment.taxonomy_id == taxonomy_id)
        .filter_map(|assignment| current_preview_dto(&assignment, category_lookup))
        .collect())
}

fn current_preview_dto(
    assignment: &wealthfolio_core::taxonomies::AssetTaxonomyAssignment,
    category_lookup: &HashMap<&str, &Category>,
) -> Option<AssignmentPreviewDto> {
    let category = category_lookup.get(assignment.category_id.as_str())?;
    Some(AssignmentPreviewDto {
        assignment_id: Some(assignment.id.clone()),
        category_id: assignment.category_id.clone(),
        category_name: category.name.clone(),
        category_key: category.key.clone(),
        category_color: category.color.clone(),
        weight_basis_points: assignment.weight,
        source: assignment.source.clone(),
        source_label: None,
    })
}

fn proposed_preview_dto(
    assignment: &PreparedAssignmentInput,
    category_lookup: &HashMap<&str, &Category>,
) -> Result<AssignmentPreviewDto, AgentToolError> {
    let category = category_lookup
        .get(assignment.category_id.as_str())
        .ok_or_else(|| {
            AgentToolError::InvalidInput(format!(
                "Category '{}' does not belong to the selected taxonomy",
                assignment.category_id
            ))
        })?;
    Ok(AssignmentPreviewDto {
        assignment_id: None,
        category_id: assignment.category_id.clone(),
        category_name: category.name.clone(),
        category_key: category.key.clone(),
        category_color: category.color.clone(),
        weight_basis_points: assignment.weight_basis_points,
        source: AI_ASSIGNMENT_SOURCE.to_string(),
        source_label: Some(assignment.source_label.clone()),
    })
}

fn compute_changes(
    current: &[AssignmentPreviewDto],
    proposed: &[AssignmentPreviewDto],
) -> ClassificationChangesDto {
    let current_by_category = current
        .iter()
        .map(|assignment| (assignment.category_id.as_str(), assignment))
        .collect::<HashMap<_, _>>();
    let proposed_by_category = proposed
        .iter()
        .map(|assignment| (assignment.category_id.as_str(), assignment))
        .collect::<HashMap<_, _>>();

    let mut changes = ClassificationChangesDto::default();
    for proposed_assignment in proposed {
        match current_by_category.get(proposed_assignment.category_id.as_str()) {
            None => changes.add_count += 1,
            Some(current_assignment)
                if current_assignment.weight_basis_points
                    != proposed_assignment.weight_basis_points
                    || current_assignment.source != AI_ASSIGNMENT_SOURCE =>
            {
                changes.update_count += 1;
            }
            Some(_) => changes.unchanged_count += 1,
        }
    }
    for current_assignment in current {
        if !proposed_by_category.contains_key(current_assignment.category_id.as_str()) {
            changes.remove_count += 1;
        }
    }
    changes
}
