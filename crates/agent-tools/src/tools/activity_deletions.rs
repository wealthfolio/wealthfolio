//! Activity deletion tools (MCP-only).
//!
//! `prepare_activity_deletions` previews which activities a deletion removes
//! and `commit_activity_deletions` deletes them through core's checked delete:
//! deleting one leg of a linked transfer deletes the other leg too, and the
//! portfolio recalculates from the earliest date. Other grouped deletions are
//! refused. The preview lists each activity as stored, so the user sees what goes before
//! anything is written. Both legs of a linked transfer must be named, so a
//! transfer linked after the preview cannot take an unreviewed leg with it.
//!
//! A deleted activity is gone. To keep one but leave it out of every
//! calculation, void it with `prepare_activity_updates` instead. A broker sync
//! may add a deleted synced activity back, but it keeps a voided one void.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Map, Value};
use wealthfolio_core::activities::{Activity, ActivityServiceTrait};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};
use crate::tools::activity_updates::{read_error, stored_fields};

/// Max activities per call, so one call cannot force unbounded deletes.
const MAX_DELETIONS: usize = 100;

/// The activity as stored, with the fields the update tools report.
fn activity_value(activity: &Activity) -> Value {
    let mut fields: Map<String, Value> = stored_fields(activity)
        .into_iter()
        .map(|(field, value)| (field.to_string(), value))
        .collect();
    if let Some(source_system) = &activity.source_system {
        fields.insert("sourceSystem".to_string(), json!(source_system));
    }
    Value::Object(fields)
}

/// A row that passed validation: the activity and the linked leg its delete
/// also removes.
struct PlannedDeletion {
    activity: Activity,
    linked: Option<Activity>,
}

impl PlannedDeletion {
    fn warning(&self) -> Option<String> {
        let synced: Vec<&str> = std::iter::once(&self.activity)
            .chain(self.linked.as_ref())
            .filter(|activity| activity.is_broker_synced())
            .map(|activity| activity.id.as_str())
            .collect();
        (!synced.is_empty()).then(|| {
            format!(
                "Activity {} came from a broker sync, which may add it back. To keep it out of \
                 the portfolio for good, void it with prepare_activity_updates and void: true.",
                synced.join(" and ")
            )
        })
    }
}

/// An id an earlier row deletes: that row's index, and whether the id is the
/// other leg of the transfer that row deletes.
struct Covered {
    index: usize,
    linked_leg: bool,
}

/// Validates one activity id as core would delete it, without writing.
/// `named` holds every id in the call; a linked leg must be among them.
fn plan_deletion(
    activity_service: &dyn ActivityServiceTrait,
    activity_id: &str,
    covered: &HashMap<String, Covered>,
    named: &HashSet<String>,
) -> Result<PlannedDeletion, String> {
    if let Some(Covered { index, .. }) = covered.get(activity_id) {
        return Err(format!(
            "Activity {activity_id} is already deleted by row {index}"
        ));
    }
    let activity = activity_service
        .get_activity(activity_id)
        .map_err(|error| read_error(activity_id, error))?;
    let linked = activity_service
        .get_transfer_pair_for_activity(activity_id.to_string())
        .map_err(|error| error.to_string())?
        .map(|pair| {
            if pair.transfer_out.id == activity_id {
                pair.transfer_in
            } else {
                pair.transfer_out
            }
        });
    if let Some(linked) = linked.as_ref().filter(|linked| !named.contains(&linked.id)) {
        return Err(format!(
            "Activity {activity_id} is a linked transfer leg; deleting it also deletes {}. \
             Preview and delete both ids together, or unlink them first",
            linked.id
        ));
    }
    let additional_ids: Vec<String> = activity_service
        .get_activity_deletion_ids(activity_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|id| id != activity_id && linked.as_ref().is_none_or(|leg| &leg.id != id))
        .collect();
    if !additional_ids.is_empty() {
        return Err(format!(
            "Activity {activity_id} shares a deletion group with {}. Grouped deletions other \
             than linked pairs are unsupported; void it with prepare_activity_updates instead",
            additional_ids.join(", ")
        ));
    }
    Ok(PlannedDeletion { activity, linked })
}

/// The row of the pair an earlier row deletes as its linked leg; any other
/// repeat stays a duplicate.
fn linked_leg_row(covered: &mut HashMap<String, Covered>, activity_id: &str) -> Option<usize> {
    let entry = covered
        .get_mut(activity_id)
        .filter(|entry| entry.linked_leg)?;
    entry.linked_leg = false;
    Some(entry.index)
}

/// Rejects an oversized or empty batch, then reads each id on its own so one
/// bad id only fails its row.
fn parse_ids(args: &Value) -> Result<Vec<Result<String, String>>, AgentToolError> {
    let ids = args
        .get("activityIds")
        .and_then(Value::as_array)
        .ok_or_else(|| AgentToolError::InvalidInput("activityIds must be an array".to_string()))?;
    if ids.len() > MAX_DELETIONS {
        return Err(AgentToolError::InvalidInput(format!(
            "Batch limited to {MAX_DELETIONS} activities, got {}",
            ids.len()
        )));
    }
    if ids.is_empty() {
        return Err(AgentToolError::InvalidInput(
            "activityIds must contain at least one id".to_string(),
        ));
    }
    Ok(ids
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "Each activity id must be a non-empty string".to_string())
        })
        .collect())
}

/// Records the ids `planned` deletes, so a later row naming one is refused,
/// except once for the linked leg.
fn cover(covered: &mut HashMap<String, Covered>, index: usize, planned: &PlannedDeletion) {
    covered.insert(
        planned.activity.id.clone(),
        Covered {
            index,
            linked_leg: false,
        },
    );
    if let Some(linked) = &planned.linked {
        covered.insert(
            linked.id.clone(),
            Covered {
                index,
                linked_leg: true,
            },
        );
    }
}

fn named_ids(ids: &[Result<String, String>]) -> HashSet<String> {
    ids.iter().filter_map(|id| id.clone().ok()).collect()
}

/// Keeps only the ids, never the stored values.
fn ids_for_audit(args: &Value) -> Value {
    let ids = args.get("activityIds").and_then(Value::as_array);
    let kept: Vec<Value> = ids
        .map(|ids| {
            ids.iter()
                .take(MAX_DELETIONS)
                .filter(|id| id.is_string())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    json!({ "activityIds": kept, "activityCount": ids.map_or(0, Vec::len) })
}

fn ids_schema(action: &str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "activityIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_DELETIONS,
                "items": { "type": "string" },
                "description": format!("Ids of the activities to {action} (find them with search_activities). Deleting one leg of a linked transfer also deletes the other leg, so name both legs.")
            }
        },
        "required": ["activityIds"],
        "additionalProperties": false
    })
}

/// One previewed row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeletionPreviewRow {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    /// "ready" or "invalid".
    pub status: &'static str,
    /// The activity as stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Value>,
    /// The other leg of a linked transfer, which the delete also removes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_activity: Option<Value>,
    /// For the other leg of a linked transfer, the row whose delete removes
    /// it too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_with: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeletionPreviewSummary {
    pub total: usize,
    pub ready: usize,
    pub invalid: usize,
    /// Activities the ready rows delete, linked legs included.
    pub activities_deleted: usize,
}

/// Output for `prepare_activity_deletions`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareActivityDeletionsOutput {
    pub rows: Vec<ActivityDeletionPreviewRow>,
    pub summary: ActivityDeletionPreviewSummary,
}

/// Preview the deletion of existing activities.
pub struct PrepareActivityDeletions;

#[async_trait::async_trait]
impl AgentTool for PrepareActivityDeletions {
    fn name(&self) -> &'static str {
        "prepare_activity_deletions"
    }

    fn description(&self) -> &'static str {
        "Preview deleting existing activities without writing anything. Pass activityIds (find them with search_activities). Each ready row shows the activity as stored and, for one leg of a linked transfer, linkedActivity: the other leg, which the delete also removes. Name both legs of a linked transfer; the row for the second leg gives deletedWith, the row that removes it. A warning marks an activity from a broker sync, which may add it back; to keep such an activity out of the portfolio for good, void it with prepare_activity_updates (void: true) instead. Voiding also keeps the record, so prefer it when the user wants an activity to stop counting rather than to disappear. An invalid row gives its error: a missing activity, one an earlier row already deletes, a linked transfer leg whose other leg is not named, or an unsupported group other than a linked pair. Void unsupported grouped activities instead. Up to 100 ids. Show the preview to the user, then delete the confirmed ids with commit_activity_deletions."
    }

    fn input_schema(&self) -> Value {
        ids_schema("preview for deletion")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::ActivitiesRead, AgentScope::ActivitiesDraft]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Draft
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        ids_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let ids = parse_ids(&args)?;
        let named = named_ids(&ids);
        let activity_service = env.activity_service();
        let mut covered = HashMap::new();
        let mut rows = Vec::with_capacity(ids.len());
        for (index, id) in ids.into_iter().enumerate() {
            if let Some(row) = id
                .as_ref()
                .ok()
                .and_then(|id| linked_leg_row(&mut covered, id))
            {
                rows.push(ActivityDeletionPreviewRow {
                    index,
                    activity_id: id.ok(),
                    status: "ready",
                    activity: None,
                    linked_activity: None,
                    deleted_with: Some(row),
                    warning: None,
                    error: None,
                });
                continue;
            }
            let planned = id
                .clone()
                .and_then(|id| plan_deletion(activity_service.as_ref(), &id, &covered, &named));
            rows.push(match planned {
                Ok(planned) => {
                    cover(&mut covered, index, &planned);
                    ActivityDeletionPreviewRow {
                        index,
                        activity_id: Some(planned.activity.id.clone()),
                        status: "ready",
                        activity: Some(activity_value(&planned.activity)),
                        linked_activity: planned.linked.as_ref().map(activity_value),
                        deleted_with: None,
                        warning: planned.warning(),
                        error: None,
                    }
                }
                Err(message) => ActivityDeletionPreviewRow {
                    index,
                    activity_id: id.ok(),
                    status: "invalid",
                    activity: None,
                    linked_activity: None,
                    deleted_with: None,
                    warning: None,
                    error: Some(message),
                },
            });
        }
        let ready = rows.iter().filter(|row| row.status == "ready").count();
        let output = PrepareActivityDeletionsOutput {
            summary: ActivityDeletionPreviewSummary {
                total: rows.len(),
                ready,
                invalid: rows.len() - ready,
                activities_deleted: covered.len(),
            },
            rows,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

/// One deleted row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedActivity {
    pub index: usize,
    pub activity_id: String,
    /// The activity as it was stored before the delete.
    pub activity: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_activity: Option<Value>,
}

/// A row naming the other leg of a transfer an earlier row deleted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedLinkedLeg {
    pub index: usize,
    pub activity_id: String,
    /// The row whose delete removed this leg.
    pub deleted_with: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDeletionError {
    pub index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<String>,
    pub message: String,
}

/// Output for `commit_activity_deletions`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitActivityDeletionsOutput {
    pub deleted: Vec<DeletedActivity>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deleted_with_pair: Vec<DeletedLinkedLeg>,
    pub errors: Vec<ActivityDeletionError>,
}

/// Delete reviewed activities.
pub struct CommitActivityDeletions;

#[async_trait::async_trait]
impl AgentTool for CommitActivityDeletions {
    fn name(&self) -> &'static str {
        "commit_activity_deletions"
    }

    fn description(&self) -> &'static str {
        "Delete existing activities: the activityIds prepare_activity_deletions previewed. This DELETES data and cannot be undone: only call it after the user reviewed the preview and confirmed. Each id is checked again through core's checked delete: one leg of a linked transfer takes the other leg with it, and the portfolio is recalculated. A linked transfer leg is refused unless its other leg is also named. The write transaction refuses any additional grouped rows, including a link made after validation. Grouped deletions other than linked pairs are unsupported; use prepare_activity_updates to void those activities instead. Up to 100 ids; deleted lists each removed activity as it was stored (and linkedActivity for the other leg of a linked transfer), deletedWithPair lists the named second legs that went with them, and errors lists the ids that failed."
    }

    fn input_schema(&self) -> Value {
        ids_schema("delete")
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        // Deleting reads the stored activities and reports them, so it needs
        // read as well.
        &[
            AgentScope::ActivitiesRead,
            AgentScope::ActivitiesDraft,
            AgentScope::ActivitiesWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &Value) -> Value {
        ids_for_audit(args)
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let ids = parse_ids(&args)?;
        let named = named_ids(&ids);
        let activity_service = env.activity_service();
        let mut covered = HashMap::new();
        let mut deleted = Vec::new();
        let mut deleted_with_pair = Vec::new();
        let mut errors = Vec::new();
        for (index, id) in ids.into_iter().enumerate() {
            if let Some(row) = id
                .as_ref()
                .ok()
                .and_then(|id| linked_leg_row(&mut covered, id))
            {
                deleted_with_pair.push(DeletedLinkedLeg {
                    index,
                    activity_id: id.unwrap_or_default(),
                    deleted_with: row,
                });
                continue;
            }
            let planned = id
                .clone()
                .and_then(|id| plan_deletion(activity_service.as_ref(), &id, &covered, &named));
            let result = match planned {
                Ok(planned) => {
                    let activity_id = planned.activity.id.clone();
                    let ids = std::iter::once(&planned.activity)
                        .chain(planned.linked.as_ref())
                        .map(|activity| activity.id.clone())
                        .collect();
                    activity_service
                        .delete_activities_checked(ids)
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(|mut deleted| {
                            let index = deleted
                                .iter()
                                .position(|activity| activity.id == activity_id)
                                .ok_or_else(|| "Deleted activity was not returned".to_string())?;
                            let activity = deleted.remove(index);
                            Ok(PlannedDeletion {
                                activity,
                                linked: deleted.pop(),
                            })
                        })
                }
                Err(message) => Err(message),
            };
            match result {
                Ok(planned) => {
                    cover(&mut covered, index, &planned);
                    deleted.push(DeletedActivity {
                        index,
                        activity_id: planned.activity.id.clone(),
                        activity: activity_value(&planned.activity),
                        linked_activity: planned.linked.as_ref().map(activity_value),
                    });
                }
                Err(message) => errors.push(ActivityDeletionError {
                    index,
                    activity_id: id.ok(),
                    message,
                }),
            }
        }
        if !deleted.is_empty() {
            env.health_service().clear_cache().await;
        }
        Ok(AgentToolResult {
            content: serde_json::to_value(CommitActivityDeletionsOutput {
                deleted,
                deleted_with_pair,
                errors,
            })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(id: &str) -> Activity {
        Activity {
            id: id.to_string(),
            account_id: "acct".to_string(),
            asset_id: None,
            activity_type: "DEPOSIT".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: wealthfolio_core::activities::ActivityStatus::Posted,
            activity_date: chrono::DateTime::parse_from_rfc3339("2026-03-02T09:30:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: None,
            fee: None,
            tax: None,
            currency: "EUR".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn only_broker_records_are_synced() {
        let manual = activity("a");
        assert!(!manual.is_broker_synced());

        let mut csv = activity("b");
        csv.source_system = Some("csv".to_string());
        csv.source_record_id = Some("row-1".to_string());
        assert!(!csv.is_broker_synced());

        let mut synced = activity("c");
        synced.source_system = Some("SNAPTRADE".to_string());
        synced.source_record_id = Some("tx-1".to_string());
        assert!(synced.is_broker_synced());

        let planned = PlannedDeletion {
            activity: manual,
            linked: Some(synced),
        };
        let warning = planned.warning().expect("synced linked leg warns");
        assert!(warning.contains("Activity c "), "{warning}");
        assert!(warning.contains("void: true"), "{warning}");
    }

    #[test]
    fn ids_are_parsed_per_row_and_batches_are_bounded() {
        let ids = parse_ids(&json!({ "activityIds": ["a", " ", 3, " b "] })).unwrap();
        assert_eq!(ids[0], Ok("a".to_string()));
        assert!(ids[1].is_err());
        assert!(ids[2].is_err());
        assert_eq!(ids[3], Ok("b".to_string()));

        assert!(parse_ids(&json!({ "activityIds": [] })).is_err());
        let oversized: Vec<String> = (0..=MAX_DELETIONS).map(|i| format!("a{i}")).collect();
        assert!(parse_ids(&json!({ "activityIds": oversized })).is_err());
    }

    #[test]
    fn audit_keeps_only_ids() {
        let audited = ids_for_audit(&json!({ "activityIds": ["a", { "amount": 5 }, "b"] }));
        assert_eq!(
            audited,
            json!({ "activityIds": ["a", "b"], "activityCount": 3 })
        );
    }
}
