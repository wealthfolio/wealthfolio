//! MCP tools for reviewing and committing an in-place activity update.
//!
//! `prepare_activity_update` loads the current activity and merges an allowed
//! partial patch into the core [`ActivityUpdate`] payload. The result is a
//! reviewable, complete update that preserves every field not explicitly
//! patched, including the original RFC3339 timestamp. `commit_activity_update`
//! persists that reviewed payload through the same activity service used by the
//! application.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wealthfolio_core::activities::{Activity, ActivityUpdate, AssetResolutionInput};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::commit_activity::CommittedActivity;

const PATCH_FIELDS: &[&str] = &[
    "accountId",
    "asset",
    "activityType",
    "subtype",
    "activityDate",
    "quantity",
    "unitPrice",
    "currency",
    "fee",
    "tax",
    "amount",
    "status",
    "notes",
    "fxRate",
    "metadata",
];

fn redact_update(args: &serde_json::Value) -> serde_json::Value {
    let mut redacted = serde_json::Map::new();
    if let Some(obj) = args.as_object() {
        if let Some(id) = obj.get("activityId").and_then(|value| value.as_str()) {
            redacted.insert("activityId".to_string(), serde_json::json!(id));
        }
        if obj.contains_key("patch") {
            redacted.insert("patch".to_string(), serde_json::json!("[redacted]"));
        }
        if obj.contains_key("update") {
            redacted.insert("update".to_string(), serde_json::json!("[redacted]"));
        }
    }
    serde_json::Value::Object(redacted)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivityUpdateArgs {
    pub activity_id: String,
    pub patch: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivityUpdateOutput {
    pub original: ActivityUpdate,
    pub update: ActivityUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityUpdateArgs {
    pub update: ActivityUpdate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityUpdateOutput {
    pub updated: CommittedActivity,
}

fn activity_to_update(activity: Activity) -> ActivityUpdate {
    ActivityUpdate {
        id: activity.id,
        account_id: activity.account_id,
        asset: activity.asset_id.map(|id| AssetResolutionInput {
            id: Some(id),
            ..Default::default()
        }),
        activity_type: activity.activity_type,
        subtype: activity.subtype,
        activity_date: activity.activity_date.to_rfc3339(),
        quantity: Some(activity.quantity),
        unit_price: Some(activity.unit_price),
        currency: activity.currency,
        fee: Some(activity.fee),
        tax: Some(activity.tax),
        amount: Some(activity.amount),
        status: Some(activity.status),
        notes: activity.notes,
        fx_rate: Some(activity.fx_rate),
        metadata: activity.metadata.map(|metadata| metadata.to_string()),
    }
}

fn merge_patch(
    original: &ActivityUpdate,
    activity_id: &str,
    patch: serde_json::Value,
) -> Result<ActivityUpdate, AgentToolError> {
    let patch = patch
        .as_object()
        .ok_or_else(|| AgentToolError::InvalidInput("patch must be a JSON object".to_string()))?;
    let mut update = serde_json::to_value(original)?;
    let update_object = update
        .as_object_mut()
        .expect("ActivityUpdate serializes as an object");

    for (field, value) in patch {
        if !PATCH_FIELDS.contains(&field.as_str()) {
            return Err(AgentToolError::InvalidInput(format!(
                "patch contains unsupported field: {field}"
            )));
        }
        update_object.insert(field.clone(), value.clone());
    }

    let update: ActivityUpdate = serde_json::from_value(update)?;
    if update.id != activity_id {
        return Err(AgentToolError::InvalidInput(
            "patch must not change activityId".to_string(),
        ));
    }
    Ok(update)
}

fn committed_summary(activity: Activity) -> CommittedActivity {
    CommittedActivity {
        id: activity.id,
        account_id: activity.account_id,
        asset_id: activity.asset_id,
        activity_type: activity.activity_type,
        activity_date: activity.activity_date.to_rfc3339(),
        currency: activity.currency,
    }
}

pub struct PrepareActivityUpdate;

#[async_trait::async_trait]
impl AgentTool for PrepareActivityUpdate {
    fn name(&self) -> &'static str {
        "prepare_activity_update"
    }

    fn description(&self) -> &'static str {
        "Load one existing activity and prepare a complete in-place update for review. \
         This does not mutate data. The partial patch may change only documented \
         editable fields; every unspecified field, including the full timestamp, is preserved."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "activityId": { "type": "string" },
                "patch": {
                    "type": "object",
                    "description": "Partial editable fields to apply before review.",
                    "properties": {
                        "accountId": { "type": "string" },
                        "asset": { "type": ["object", "null"] },
                        "activityType": { "type": "string" },
                        "subtype": { "type": ["string", "null"] },
                        "activityDate": { "type": "string", "description": "RFC3339 timestamp; preserves time and offset." },
                        "quantity": { "type": ["number", "string", "null"] },
                        "unitPrice": { "type": ["number", "string", "null"] },
                        "currency": { "type": "string" },
                        "fee": { "type": ["number", "string", "null"] },
                        "tax": { "type": ["number", "string", "null"] },
                        "amount": { "type": ["number", "string", "null"] },
                        "status": { "type": "string" },
                        "notes": { "type": ["string", "null"] },
                        "fxRate": { "type": ["number", "string", "null"] },
                        "metadata": { "type": ["string", "null"] }
                    },
                    "additionalProperties": false
                }
            },
            "required": ["activityId", "patch"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_update(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareActivityUpdateArgs = serde_json::from_value(args)?;
        let activity_id = args.activity_id.trim();
        if activity_id.is_empty() {
            return Err(AgentToolError::InvalidInput(
                "activityId must not be empty".to_string(),
            ));
        }
        let original = activity_to_update(
            env.activity_service()
                .get_activity(activity_id)
                .map_err(|error| AgentToolError::ExecutionFailed(error.to_string()))?,
        );
        let update = merge_patch(&original, activity_id, args.patch)?;
        Ok(AgentToolResult {
            content: serde_json::to_value(PrepareActivityUpdateOutput { original, update })?,
        })
    }
}

pub struct CommitActivityUpdate;

#[async_trait::async_trait]
impl AgentTool for CommitActivityUpdate {
    fn name(&self) -> &'static str {
        "commit_activity_update"
    }

    fn description(&self) -> &'static str {
        "Persist one reviewed activity update from prepare_activity_update. This MUTATES \
         data - call only after the prepared update has been reviewed and confirmed."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "update": { "type": "object", "description": "Complete reviewed update returned by prepare_activity_update." }
            },
            "required": ["update"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesDraft, AgentScope::ActivitiesWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        redact_update(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: CommitActivityUpdateArgs = serde_json::from_value(args)?;
        let updated = env
            .activity_service()
            .update_activity(args.update)
            .await
            .map_err(|error| AgentToolError::ExecutionFailed(error.to_string()))?;
        env.health_service().clear_cache().await;
        Ok(AgentToolResult {
            content: serde_json::to_value(CommitActivityUpdateOutput {
                updated: committed_summary(updated),
            })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use rust_decimal::Decimal;
    use wealthfolio_core::activities::ActivityStatus;

    use super::*;

    fn activity() -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: "DEPOSIT".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc.with_ymd_and_hms(2026, 8, 2, 13, 28, 53).unwrap(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(500000, 2)),
            fee: None,
            tax: None,
            currency: "SAR".to_string(),
            fx_rate: None,
            notes: Some("original note".to_string()),
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn prepare_preserves_full_timestamp_and_unpatched_fields() {
        let original = activity_to_update(activity());
        let update = merge_patch(
            &original,
            "activity-1",
            serde_json::json!({ "notes": "corrected note" }),
        )
        .unwrap();

        assert_eq!(update.activity_date, "2026-08-02T13:28:53+00:00");
        assert_eq!(update.amount, Some(Some(Decimal::new(500000, 2))));
        assert_eq!(update.notes.as_deref(), Some("corrected note"));
    }

    #[test]
    fn prepare_rejects_unsupported_patch_field() {
        let original = activity_to_update(activity());
        assert!(matches!(
            merge_patch(
                &original,
                "activity-1",
                serde_json::json!({ "id": "other" })
            ),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn audit_redacts_financial_payloads() {
        assert_eq!(
            redact_update(&serde_json::json!({
                "activityId": "activity-1",
                "patch": { "amount": 5000, "notes": "private" }
            })),
            serde_json::json!({ "activityId": "activity-1", "patch": "[redacted]" })
        );
    }
}
