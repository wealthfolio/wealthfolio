//! Reviewed split allocations over the existing Spending service/writer.
use std::sync::Arc;

use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{json, Value};
use wealthfolio_spending::activity_splits::{NewActivitySplit, SplitReviewState};

use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};

fn invalid() -> AgentToolError {
    AgentToolError::InvalidInput("Invalid split change; see the input schema".into())
}
fn lines_schema() -> Value {
    json!({"type":"array","minItems":1,"maxItems":100,"items":{"type":"object","additionalProperties":false,
        "properties":{"taxonomyId":{"type":"string","enum":["spending_categories","income_sources","savings_categories"]},
            "categoryId":{"type":"string"},"amount":{"type":"string","description":"Exact positive decimal in transaction currency; all lines must sum to its absolute amount."},
            "note":{"type":["string","null"]},"sortOrder":{"type":["integer","null"]}},
        "required":["taxonomyId","categoryId","amount"]}})
}
fn exact_lines(lines: &[NewActivitySplit]) -> Result<Value, AgentToolError> {
    let mut value = serde_json::to_value(lines)?;
    for (row, line) in value.as_array_mut().into_iter().flatten().zip(lines) {
        row["amount"] = Value::String(line.amount.to_string());
    }
    Ok(value)
}

fn validate_lines(lines: &[NewActivitySplit]) -> Result<(), AgentToolError> {
    if lines.is_empty()
        || lines.len() > 100
        || lines
            .iter()
            .any(|l| l.amount <= Decimal::ZERO || l.category_id.trim().is_empty())
    {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareArgs {
    activity_id: String,
    splits: Vec<NewActivitySplit>,
    review_notes: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitArgs {
    expected: SplitReviewState,
    splits: Vec<NewActivitySplit>,
}

pub struct PrepareSpendingSplits;
#[async_trait::async_trait]
impl AgentTool for PrepareSpendingSplits {
    fn name(&self) -> &'static str {
        "prepare_spending_splits"
    }
    fn description(&self) -> &'static str {
        "Preview exact category allocations for one opted-in Spending transaction, including a receipt interpreted by the caller. Show all existing assignments/splits being replaced, line amounts/notes, native currency, total and remaining. Include tax, discounts, tips and rounding as explicit lines; put uncertain interpretation in reviewNotes and resolve it with the user. No upload/OCR or writes. Uses native split validation; commit requires a valid, freshly reviewed proposal."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{
        "activityId":{"type":"string"},"splits":lines_schema(),"reviewNotes":{"type":"string","description":"Explain uncertainty or receipt interpretation for user review; never persisted."}
    },"required":["activityId","splits"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"splitProposal":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        validate_lines(&args.splits)?;
        let service = env.cash_activity_service();
        let mut rows = service
            .get_by_activity_ids(std::slice::from_ref(&args.activity_id))
            .await
            .map_err(|_| {
                AgentToolError::InvalidInput("Transaction is unavailable in Spending scope".into())
            })?;
        let row = rows.pop().ok_or_else(|| {
            AgentToolError::InvalidInput("Transaction is unavailable in Spending scope".into())
        })?;
        let valid = service
            .validate_splits(&args.activity_id, &args.splits)
            .await
            .is_ok();
        let total: Decimal = args.splits.iter().map(|l| l.amount).sum();
        let amount = row.activity.amount.unwrap_or_default().abs();
        let expected = SplitReviewState {
            activity: row.activity,
            assignments: row.assignments,
            splits: row.splits,
        };
        Ok(AgentToolResult {
            content: json!({"change":{"expected":expected,"splits":exact_lines(&args.splits)?},"valid":valid,
            "currency":expected.activity.currency,"transactionTotal":amount,"proposedTotal":total,"remaining":amount-total,
            "reviewNotes":args.review_notes,"validationMessage":if valid {"Native split validation passed"} else {"Resolve the total, category taxonomy or transaction eligibility before committing"},
            "effect":"Replace the displayed assignments and split lines atomically. Financial transaction fields and event tags are preserved."}),
        })
    }
}

pub struct CommitSpendingSplits;
#[async_trait::async_trait]
impl AgentTool for CommitSpendingSplits {
    fn name(&self) -> &'static str {
        "commit_spending_splits"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply the reviewed change from prepare_spending_splits. Requires Organize spending. Uses native exact-decimal validation and atomically replaces allocations only if the full financial transaction, assignments and split state still match the review. On conflict, prepare and review again; do not retry a mutation after an unknown outcome."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{
        "expected":{"type":"object","description":"Copy expected from prepare_spending_splits unchanged, including full activity, assignments and splits.","properties":{"activity":{"type":"object"},"assignments":{"type":"array","items":{"type":"object"}},"splits":{"type":"array","items":{"type":"object"}}},"required":["activity","assignments","splits"]},
        "splits":lines_schema()
    },"required":["expected","splits"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"splitChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: CommitArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        validate_lines(&args.splits)?;
        let splits=env.cash_activity_service().replace_splits_reviewed(args.expected,args.splits).await
            .map_err(|_|AgentToolError::ExecutionFailed("Split change rejected: transaction, allocations or validation changed; prepare and review again".into()))?;
        Ok(AgentToolResult {
            content: json!({"splits":splits,"draftStatus":"applied"}),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearArgs {
    activity_id: String,
    taxonomy_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClearReview {
    expected: SplitReviewState,
    taxonomy_id: String,
}
fn clear_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"activityId":{"type":"string"},"taxonomyId":{"type":"string","enum":wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS}},"required":["activityId","taxonomyId"]})
}
fn validate_clear_taxonomy(id: &str) -> Result<(), AgentToolError> {
    if wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id) {
        Ok(())
    } else {
        Err(invalid())
    }
}
pub struct PrepareSpendingAllocationClear;
#[async_trait::async_trait]
impl AgentTool for PrepareSpendingAllocationClear {
    fn name(&self) -> &'static str {
        "prepare_spending_allocation_clear"
    }
    fn description(&self) -> &'static str {
        "Review removing all split lines and the selected transaction-taxonomy assignment from one Spending transaction. Shows every allocation being removed and other stored assignments retained. This is explicit clearing, separate from categorizing or replacing splits. Financial fields and event tags are preserved. No writes."
    }
    fn input_schema(&self) -> Value {
        clear_schema()
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"allocationClear":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ClearArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        validate_clear_taxonomy(&args.taxonomy_id)?;
        let mut rows = env
            .cash_activity_service()
            .get_by_activity_ids(&[args.activity_id])
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to resolve Spending transaction".into())
            })?;
        let row = rows.pop().ok_or_else(invalid)?;
        let removed = row
            .assignments
            .iter()
            .filter(|a| a.taxonomy_id == args.taxonomy_id)
            .cloned()
            .collect::<Vec<_>>();
        let retained = row
            .assignments
            .iter()
            .filter(|a| a.taxonomy_id != args.taxonomy_id)
            .cloned()
            .collect::<Vec<_>>();
        let expected = SplitReviewState {
            activity: row.activity,
            assignments: row.assignments,
            splits: row.splits,
        };
        Ok(AgentToolResult {
            content: json!({"change":{"expected":expected,"taxonomyId":args.taxonomy_id},"removedSplits":expected.splits,"removedAssignments":removed,"retainedAssignments":retained,"effect":"Remove the displayed split lines and selected-taxonomy assignments atomically. Review retained legacy assignments, which may become effective after splits are removed."}),
        })
    }
}
pub struct CommitSpendingAllocationClear;
#[async_trait::async_trait]
impl AgentTool for CommitSpendingAllocationClear {
    fn name(&self) -> &'static str {
        "commit_spending_allocation_clear"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply explicit clearing from prepare_spending_allocation_clear. Full transaction/assignment/split state must still match inside the shared writer. Removes the reviewed split lines and selected-taxonomy assignment atomically; other assignments and financial fields remain unchanged. A stale clear requires fresh review."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"expected":CommitSpendingSplits.input_schema()["properties"]["expected"],"taxonomyId":clear_schema()["properties"]["taxonomyId"]},"required":["expected","taxonomyId"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"allocationClear":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ClearReview = serde_json::from_value(args).map_err(|_| invalid())?;
        validate_clear_taxonomy(&args.taxonomy_id)?;
        env.cash_activity_service()
            .clear_allocations_reviewed(args.expected, &args.taxonomy_id)
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed(
                    "Allocation clear rejected; refresh and review again".into(),
                )
            })?;
        Ok(AgentToolResult {
            content: json!({"draftStatus":"applied"}),
        })
    }
}
