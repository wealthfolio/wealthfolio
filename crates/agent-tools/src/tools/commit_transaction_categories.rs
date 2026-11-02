//! Persist reviewed transaction categories through the native spending Apply path.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use wealthfolio_spending::activity_assignments::{
    ActivityTaxonomyAssignment, BulkCategoryAssignment, CategoryAssignmentConflicts,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::categorization_context::MAX_LIMIT;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitTransactionCategoriesArgs {
    pub assignments: Vec<BulkCategoryAssignment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitTransactionCategoriesOutput {
    pub draft_status: String,
    pub assignment_count: usize,
    pub assignments: Vec<ActivityTaxonomyAssignment>,
    pub applied_at: String,
}

fn parse_args(args: serde_json::Value) -> Result<CommitTransactionCategoriesArgs, AgentToolError> {
    // Serde errors can contain caller-supplied values. The MCP handler stores
    // error text in its audit log, so keep malformed-input errors data-free.
    let args: CommitTransactionCategoriesArgs = serde_json::from_value(args).map_err(|_| {
        AgentToolError::InvalidInput(
            "assignments must be an array of activityId, taxonomyId and categoryId strings"
                .to_string(),
        )
    })?;
    if args.assignments.is_empty() || args.assignments.len() > MAX_LIMIT {
        return Err(AgentToolError::InvalidInput(format!(
            "assignments must contain 1 to {MAX_LIMIT} entries"
        )));
    }
    let mut pairs = HashSet::new();
    for item in &args.assignments {
        if item.activity_id.trim().is_empty()
            || item.taxonomy_id.trim().is_empty()
            || item.category_id.trim().is_empty()
        {
            return Err(AgentToolError::InvalidInput(
                "activityId, taxonomyId and categoryId cannot be blank".to_string(),
            ));
        }
        if let Some(splits) = &item.expected_splits {
            let mut ids = HashSet::new();
            if splits.len() > MAX_LIMIT
                || splits.iter().any(|split| {
                    split.activity_id != item.activity_id
                        || split.id.trim().is_empty()
                        || !ids.insert(&split.id)
                })
            {
                return Err(AgentToolError::InvalidInput("expectedSplits must contain at most 100 distinct current split rows for the same activity".to_string()));
            }
        }
        if !pairs.insert((&item.activity_id, &item.taxonomy_id)) {
            return Err(AgentToolError::InvalidInput(
                "assignments cannot repeat an activityId/taxonomyId pair".to_string(),
            ));
        }
    }
    Ok(args)
}

/// MCP-only save operation for selected, user-confirmed category proposals.
pub struct CommitTransactionCategories;

#[async_trait::async_trait]
impl AgentTool for CommitTransactionCategories {
    fn name(&self) -> &'static str {
        "commit_transaction_categories"
    }

    fn description(&self) -> &'static str {
        "Persist selected, reviewed proposals from propose_transaction_categories. This \
         MUTATES data — call only after the user confirms the categories. Pass 1–100 \
         assignments with activityId, taxonomyId and categoryId from the reviewed proposals. \
         The whole batch is atomic. Each assignment replaces the current category for its \
         activity/taxonomy pair. Split transactions are protected: without explicit reviewed \
         replacement intent the ENTIRE batch is rejected. To intentionally replace splits, \
         include expectedSplits with the full current split rows from Spending search. \
         The writer compares IDs, amounts, categories, notes, order and timestamps atomically. \
         Financial activity fields are unchanged. Repeating a payload keeps one assignment \
         per pair, but a delayed commit or retry can overwrite intervening category edits \
         on non-split rows. Splits created or changed since review cause a conflict."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "assignments": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_LIMIT,
                    "description": "Selected category assignments after user review and confirmation.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "activityId": { "type": "string", "minLength": 1 },
                            "taxonomyId": { "type": "string", "minLength": 1 },
                            "categoryId": { "type": "string", "minLength": 1 },
                            "expectedSplits": {
                                "type": "array", "maxItems": 100,
                                "description": "Only for explicitly reviewed replacement of existing splits. Copy the full current split rows; changed state rejects the entire batch.",
                                "items": { "type": "object", "properties": {
                                    "id": { "type": "string" }, "activityId": { "type": "string" },
                                    "taxonomyId": { "type": "string" }, "categoryId": { "type": "string" },
                                    "amount": { "type": "string" }, "note": { "type": ["string", "null"] },
                                    "sortOrder": { "type": "integer" },
                                    "createdAt": { "type": "string" }, "updatedAt": { "type": "string" }
                                }, "required": ["id", "activityId", "taxonomyId", "categoryId", "amount", "note", "sortOrder", "createdAt", "updatedAt"] }
                            }
                        },
                        "required": ["activityId", "taxonomyId", "categoryId"]
                    }
                }
            },
            "required": ["assignments"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        match args
            .get("assignments")
            .and_then(serde_json::Value::as_array)
        {
            Some(items) => serde_json::json!({
                "assignments": format!("[{} assignments]", items.len())
            }),
            None => serde_json::json!({}),
        }
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args = parse_args(args)?;
        let assignments = match env
            .cash_activity_service()
            .bulk_assign_categories(&args.assignments)
            .await
        {
            Ok(assignments) => assignments,
            Err(error) => {
                if let Some(conflicts) = error.downcast_ref::<CategoryAssignmentConflicts>() {
                    return Ok(AgentToolResult {
                        content: serde_json::json!({
                            "draftStatus": "conflict", "assignmentCount": 0, "conflicts": conflicts.conflicts,
                            "message": "No categories or splits were changed. Review the affected transactions and explicitly confirm a corrected batch."
                        }),
                    });
                }
                return Err(AgentToolError::ExecutionFailed(error.to_string()));
            }
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(CommitTransactionCategoriesOutput {
                draft_status: "applied".to_string(),
                assignment_count: assignments.len(),
                assignments,
                applied_at: Utc::now().to_rfc3339(),
            })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assignment() -> serde_json::Value {
        json!({"activityId": "activity-1", "taxonomyId": "spending_categories", "categoryId": "category-1"})
    }

    #[test]
    fn batch_limits_match_proposal_cap_and_schema() {
        for count in [0, MAX_LIMIT + 1] {
            let items: Vec<_> = (0..count)
                .map(|index| {
                    let mut item = assignment();
                    item["activityId"] = json!(format!("activity-{index}"));
                    item
                })
                .collect();
            assert!(matches!(
                parse_args(json!({"assignments": items})),
                Err(AgentToolError::InvalidInput(_))
            ));
        }
        for count in [1, MAX_LIMIT] {
            let items: Vec<_> = (0..count)
                .map(|index| {
                    let mut item = assignment();
                    item["activityId"] = json!(format!("activity-{index}"));
                    item
                })
                .collect();
            assert_eq!(
                parse_args(json!({"assignments": items}))
                    .unwrap()
                    .assignments
                    .len(),
                count
            );
        }
        let schema = CommitTransactionCategories.input_schema();
        assert_eq!(schema["properties"]["assignments"]["minItems"], 1);
        assert_eq!(schema["properties"]["assignments"]["maxItems"], MAX_LIMIT);
    }

    #[test]
    fn blank_ids_are_rejected_for_every_field() {
        for field in ["activityId", "taxonomyId", "categoryId"] {
            for blank in ["", " \t\n", "\u{2003}"] {
                let mut item = assignment();
                item[field] = json!(blank);
                assert!(matches!(
                    parse_args(json!({"assignments": [item]})),
                    Err(AgentToolError::InvalidInput(_))
                ));
            }
        }
    }

    #[test]
    fn rejects_same_pair_with_different_categories() {
        let first = assignment();
        let mut second = first.clone();
        second["categoryId"] = json!("category-2");
        let error = parse_args(json!({"assignments": [first, second]})).unwrap_err();
        assert!(matches!(error, AgentToolError::InvalidInput(_)));
        assert!(error.to_string().contains("pair"));
    }

    #[test]
    fn distinct_pairs_do_not_collide_at_delimiters() {
        let args = parse_args(json!({"assignments": [
            {"activityId": "a:b", "taxonomyId": "c", "categoryId": "one"},
            {"activityId": "a", "taxonomyId": "b:c", "categoryId": "two"}
        ]}))
        .unwrap();
        assert_eq!(args.assignments[0].activity_id, "a:b");
        assert_eq!(args.assignments[1].taxonomy_id, "b:c");
    }

    #[test]
    fn exact_ids_survive_deserialization_without_trimming() {
        let mut seed = 0xbb67_ae85_84ca_a73b_u64;
        for _ in 0..256 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let ch = char::from_u32((seed % 0x110000) as u32).unwrap_or('\0');
            let activity = format!(" {ch}:{seed}\0 ");
            let taxonomy = format!("{ch}:taxonomy:{seed}");
            let category = format!("category:{ch}:{seed}");
            let args = parse_args(json!({"assignments": [{
                "activityId": activity, "taxonomyId": taxonomy, "categoryId": category,
                "amount": 999, "source": "ai", "weight": 1
            }]}))
            .unwrap();
            let item = &args.assignments[0];
            assert_eq!(item.activity_id, activity);
            assert_eq!(item.taxonomy_id, taxonomy);
            assert_eq!(item.category_id, category);
        }
    }

    #[test]
    fn malformed_args_do_not_echo_values_or_unknown_field_names() {
        for args in [
            json!({}),
            json!({"assignments": null}),
            json!({"assignments": "sensitive-sentinel"}),
            json!({"assignments": [null]}),
            json!({"assignments": [{"activityId": ["sensitive-sentinel"]}]}),
            json!({"assignments": [{"taxonomyId": "sensitive-sentinel", "categoryId": "secret"}], "private-field": true}),
        ] {
            let error = parse_args(args).unwrap_err().to_string();
            assert_eq!(
                error,
                "assignments must be an array of activityId, taxonomyId and categoryId strings"
            );
        }
    }

    #[test]
    fn audit_summary_keeps_only_assignment_count() {
        let args = json!({
            "assignments": [assignment(), {"notes": "sensitive-sentinel"}],
            "private-field": "secret"
        });
        assert_eq!(
            CommitTransactionCategories.sanitize_args_for_audit(&args),
            json!({"assignments": "[2 assignments]"})
        );
        assert_eq!(
            CommitTransactionCategories.sanitize_args_for_audit(&json!({
                "assignments": "sensitive-sentinel", "private-field": "secret"
            })),
            json!({})
        );
    }
}
