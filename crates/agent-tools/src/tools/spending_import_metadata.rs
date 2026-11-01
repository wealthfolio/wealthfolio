//! Resolve imported category/subcategory/event columns against saved IDs.
//! Financial import and metadata application are explicitly separate stages.
use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetadataRow {
    activity_id: String,
    taxonomy_id: Option<String>,
    category_key: Option<String>,
    subcategory_key: Option<String>,
    event_id: Option<String>,
    event_name: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    rows: Vec<MetadataRow>,
}
fn invalid() -> AgentToolError {
    AgentToolError::InvalidInput("Provide 1 to 100 unique saved activity IDs and explicit taxonomy-qualified metadata columns".into())
}
pub struct PrepareSpendingImportMetadata;
#[async_trait::async_trait]
impl AgentTool for PrepareSpendingImportMetadata {
    fn name(&self) -> &'static str {
        "prepare_spending_import_metadata"
    }
    fn description(&self) -> &'static str {
        "Resolve mapped CSV category/subcategory/event columns for ALREADY SAVED Spending transaction IDs from commit_activity_import.financialRows or transaction search. Categories require taxonomyId plus stable categoryKey; optional subcategoryKey must descend from that category. Event ID is preferred; an event name must match uniquely. Unknown/ambiguous values need review; nothing is implicitly created. Returns explicit eligible category assignments and independent event-tag changes for review, with protected/conflicting rows listed. No writes. Financial import is a separate Activities-permission stage; after it succeeds, retry only metadata against saved IDs, never reimport financial successes. Category and event commits are separate operations, not a claimed atomic combined import."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"rows":{"type":"array","minItems":1,"maxItems":100,"items":{"type":"object","additionalProperties":false,"properties":{
        "activityId":{"type":"string"},"taxonomyId":{"type":"string","enum":["spending_categories","income_sources","savings_categories"]},"categoryKey":{"type":"string"},"subcategoryKey":{"type":"string"},"eventId":{"type":"string"},"eventName":{"type":"string"}
    },"required":["activityId"]}}},"required":["rows"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        json!({"rowCount":args["rows"].as_array().map(Vec::len).unwrap_or(0)})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: Args = serde_json::from_value(args).map_err(|_| invalid())?;
        let ids = args
            .rows
            .iter()
            .map(|r| r.activity_id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty()
            || ids.len() > 100
            || ids.iter().any(|id| id.trim().is_empty())
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err(invalid());
        }
        let activities = env
            .cash_activity_service()
            .get_by_activity_ids(&ids)
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed(
                    "Unable to resolve saved Spending transactions".into(),
                )
            })?
            .into_iter()
            .map(|row| (row.activity.id.clone(), row))
            .collect::<HashMap<_, _>>();
        let taxonomies = env
            .taxonomy_service()
            .get_taxonomies_with_categories()
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to read transaction categories".into())
            })?
            .into_iter()
            .filter(|t| {
                t.taxonomy.scope == "activity"
                    && wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS
                        .contains(&t.taxonomy.id.as_str())
            })
            .map(|t| (t.taxonomy.id.clone(), t))
            .collect::<HashMap<_, _>>();
        let events = env
            .spending_events_service()
            .list_events()
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to read Spending events".into())
            })?;
        let mut rows = Vec::new();
        let mut assignments = Vec::new();
        let mut event_changes = Vec::new();
        for input in args.rows {
            let Some(activity) = activities.get(&input.activity_id) else {
                rows.push(json!({"activityId":input.activity_id,"status":"needs_review","errors":["Saved transaction is unavailable in effective Spending scope"]}));
                continue;
            };
            let mut errors = Vec::new();
            let mut category = None;
            let mut event = None;
            if input.category_key.is_some()
                || input.subcategory_key.is_some()
                || input.taxonomy_id.is_some()
            {
                let taxonomy = input.taxonomy_id.as_deref().unwrap_or("");
                if activity.cash_flow_bucket.taxonomy_id() != Some(taxonomy) {
                    errors.push("Category taxonomy must match the transaction cash-flow bucket");
                } else if !activity.splits.is_empty() {
                    errors.push("Existing split allocations are protected; use the explicit split review workflow");
                } else if let Some(tree) = taxonomies.get(taxonomy) {
                    let roots = tree
                        .categories
                        .iter()
                        .filter(|c| Some(c.key.as_str()) == input.category_key.as_deref())
                        .collect::<Vec<_>>();
                    if roots.len() != 1 {
                        errors.push("Category key is missing, unknown or ambiguous within the selected taxonomy");
                    } else if let Some(key) = input.subcategory_key.as_deref() {
                        let children = tree
                            .categories
                            .iter()
                            .filter(|c| c.key == key)
                            .collect::<Vec<_>>();
                        if children.len() != 1 {
                            errors.push("Subcategory key is unknown or ambiguous");
                        } else {
                            let mut seen = std::collections::HashSet::new();
                            let mut parent = children[0].parent_id.as_deref();
                            let mut descendant = false;
                            while let Some(id) = parent {
                                if !seen.insert(id) {
                                    break;
                                }
                                if id == roots[0].id {
                                    descendant = true;
                                    break;
                                }
                                parent = tree
                                    .categories
                                    .iter()
                                    .find(|c| c.id == id)
                                    .and_then(|c| c.parent_id.as_deref());
                            }
                            if descendant {
                                category = Some(children[0].id.clone());
                            } else {
                                errors.push(
                                    "Subcategory does not descend from the selected category",
                                );
                            }
                        }
                    } else {
                        category = Some(roots[0].id.clone());
                    }
                } else {
                    errors.push("Transaction taxonomy is unavailable");
                }
            }
            if input.event_id.is_some() && input.event_name.is_some() {
                errors.push("Choose eventId or eventName, not both");
            } else if let Some(id) = input.event_id.as_deref() {
                if events.iter().any(|e| e.id == id) {
                    event = Some(id.to_string());
                } else {
                    errors.push("Event ID is unknown");
                }
            } else if let Some(name) = input.event_name.as_deref() {
                let matches = events
                    .iter()
                    .filter(|e| e.name.trim().eq_ignore_ascii_case(name.trim()))
                    .collect::<Vec<_>>();
                if matches.len() == 1 {
                    event = Some(matches[0].id.clone());
                } else {
                    errors.push("Event name is unknown or ambiguous; select an explicit event ID");
                }
            }
            if input.category_key.is_none()
                && input.subcategory_key.is_none()
                && input.taxonomy_id.is_none()
                && input.event_id.is_none()
                && input.event_name.is_none()
            {
                errors.push("No metadata columns were supplied");
            }
            // Do not silently apply only the successful half of an unresolved row.
            if errors.is_empty() {
                if let Some(category_id) = category {
                    assignments.push(json!({"activityId":input.activity_id,"taxonomyId":input.taxonomy_id,"categoryId":category_id}));
                }
                if let Some(event_id) = event {
                    event_changes.push(json!({"activityId":input.activity_id,"eventId":event_id,"expectedEventId":activity.event_id}));
                }
            }
            rows.push(json!({"activityId":input.activity_id,"status":if errors.is_empty(){"ready"}else{"needs_review"},"errors":errors,"currentAssignments":activity.assignments,"currentSplits":activity.splits,"currentEventId":activity.event_id}));
        }
        Ok(AgentToolResult {
            content: json!({"rows":rows,"categoryAssignments":assignments,"eventChanges":event_changes,
            "nextActions":"Review the explicit eligible subset. Submit categoryAssignments to commit_transaction_categories (atomic across that submitted batch); submit each eventChanges entry to commit_spending_event_tag. Resolve needs_review rows separately. A metadata failure requires metadata-only retry against these saved IDs, never reimporting financial rows.",
            "writesPerformed":false}),
        })
    }
}
