//! Reviewed event definitions and opted-in transaction tags.
use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use wealthfolio_spending::events::{Event, NewEvent, UpdateEvent};
fn invalid() -> AgentToolError {
    AgentToolError::InvalidInput("Invalid event change; see the input schema".into())
}
fn failed() -> AgentToolError {
    AgentToolError::ExecutionFailed("Event change rejected; refresh and review again".into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareArgs {
    event_id: Option<String>,
    #[serde(deserialize_with = "super::required_nullable")]
    event: Option<NewEvent>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    #[serde(deserialize_with = "super::required_nullable")]
    expected: Option<Event>,
    #[serde(deserialize_with = "super::required_nullable")]
    proposed: Option<NewEvent>,
    expected_tag_count: usize,
}
fn event_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{
    "id":{"type":["string","null"]},"name":{"type":"string","minLength":1},"description":{"type":["string","null"]},"eventTypeId":{"type":"string"},"startDate":{"type":"string","description":"YYYY-MM-DD or RFC3339 inclusive bound."},"endDate":{"type":"string","description":"YYYY-MM-DD or RFC3339 inclusive bound."}
},"required":["name","eventTypeId","startDate","endDate"]})
}
async fn validate(env: &dyn AgentEnvironment, event: &NewEvent) -> Result<(), AgentToolError> {
    if event.name.trim().is_empty() || event.id.as_deref().is_none_or(|id| id.trim().is_empty()) {
        return Err(invalid());
    }
    wealthfolio_spending::events::service::validate_event_range_strict(
        &event.start_date,
        &event.end_date,
    )
    .map_err(|_| invalid())?;
    if !env
        .spending_events_service()
        .list_types()
        .await
        .map_err(|_| failed())?
        .iter()
        .any(|t| t.id == event.event_type_id)
    {
        return Err(invalid());
    }
    Ok(())
}
pub struct PrepareSpendingEvent;
#[async_trait::async_trait]
impl AgentTool for PrepareSpendingEvent {
    fn name(&self) -> &'static str {
        "prepare_spending_event"
    }
    fn description(&self) -> &'static str {
        "Preview creating, editing or deleting a Spending event definition. Omit eventId to create; provide eventId plus a complete edited event to update, or event:null explicitly to delete. Returns fresh expected state and total tag count removed on deletion. Date edits preserve all existing tags, including purchases outside the range. No writes."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"eventId":{"type":"string"},"event":{"anyOf":[event_schema(),{"type":"null"}]}},"required":["event"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"eventChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let service = env.spending_events_service();
        let expected = if let Some(id) = args.event_id {
            Some(
                service
                    .list_events()
                    .await
                    .map_err(|_| failed())?
                    .into_iter()
                    .find(|e| e.id == id)
                    .ok_or_else(invalid)?,
            )
        } else {
            None
        };
        let mut proposed = args.event;
        if let Some(event) = &mut proposed {
            event.id = Some(
                expected
                    .as_ref()
                    .map(|e| e.id.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            );
            validate(env.as_ref(), event).await?;
        }
        if expected.is_none() && proposed.is_none() {
            return Err(invalid());
        }
        let count = if let Some(event) = &expected {
            service
                .event_tag_count(&event.id)
                .await
                .map_err(|_| failed())?
        } else {
            0
        };
        let deleting = proposed.is_none();
        let review = Review {
            expected,
            proposed,
            expected_tag_count: count,
        };
        Ok(AgentToolResult {
            content: json!({"change":review,"removedTagCount":if deleting{count}else{0},"effect":if deleting{"Deletes only the event definition and its tags. Financial activities, categories and splits are preserved."}else{"Creates/updates the event definition; dates do not restrict tagging and existing tags remain unchanged."}}),
        })
    }
}
pub struct CommitSpendingEvent;
#[async_trait::async_trait]
impl AgentTool for CommitSpendingEvent {
    fn name(&self) -> &'static str {
        "commit_spending_event"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply the reviewed change from prepare_spending_event. Uses native validation and writer/outbox behavior. Updates compare full event state atomically; deletions also compare reviewed tag count. A stale review rejects. Creation keeps its draft UUID so a replay cannot create duplicates. No transaction financial fields change."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"expected":{"type":["object","null"],"description":"Copy full expected from prepare unchanged."},"proposed":{"anyOf":[event_schema(),{"type":"null"}]},"expectedTagCount":{"type":"integer","minimum":0}},"required":["expected","proposed","expectedTagCount"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"eventChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let review: Review = serde_json::from_value(args).map_err(|_| invalid())?;
        let service = env.spending_events_service();
        if let Some(proposed) = &review.proposed {
            validate(env.as_ref(), proposed).await?;
        }
        let result = match (review.expected, review.proposed) {
            (None, Some(new)) => {
                if new
                    .id
                    .as_deref()
                    .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
                {
                    return Err(invalid());
                }
                json!({"created":service.create_event(new).await.map_err(|_|failed())?})
            }
            (Some(expected), Some(new)) => {
                if new.id.as_deref() != Some(expected.id.as_str()) {
                    return Err(invalid());
                }
                let patch = UpdateEvent {
                    name: Some(new.name),
                    description: Some(new.description),
                    event_type_id: Some(new.event_type_id),
                    start_date: Some(new.start_date),
                    end_date: Some(new.end_date),
                };
                json!({"updated":service.update_event_reviewed(expected,patch).await.map_err(|_|failed())?})
            }
            (Some(expected), None) => {
                service
                    .delete_event_reviewed(expected, review.expected_tag_count)
                    .await
                    .map_err(|_| failed())?;
                json!({"deleted":true,"removedTagCount":review.expected_tag_count})
            }
            _ => return Err(invalid()),
        };
        Ok(AgentToolResult { content: result })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TagArgs {
    activity_id: String,
    #[serde(deserialize_with = "super::required_nullable")]
    event_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TagReview {
    activity_id: String,
    #[serde(deserialize_with = "super::required_nullable")]
    event_id: Option<String>,
    #[serde(deserialize_with = "super::required_nullable")]
    expected_event_id: Option<String>,
}
fn tag_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"activityId":{"type":"string"},"eventId":{"type":["string","null"],"description":"Event to attach, or null explicitly to untag."}},"required":["activityId","eventId"]})
}
pub struct PrepareSpendingEventTag;
#[async_trait::async_trait]
impl AgentTool for PrepareSpendingEventTag {
    fn name(&self) -> &'static str {
        "prepare_spending_event_tag"
    }
    fn description(&self) -> &'static str {
        "Review attaching, moving or clearing one opted-in Spending transaction's event tag. Returns the scoped transaction and previous/new event IDs. Event date ranges do not restrict tagging. No writes; commit each reviewed transaction separately."
    }
    fn input_schema(&self) -> Value {
        tag_schema()
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"eventTag":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: TagArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let mut rows = env
            .cash_activity_service()
            .get_by_activity_ids(std::slice::from_ref(&args.activity_id))
            .await
            .map_err(|_| failed())?;
        let row = rows.pop().ok_or_else(invalid)?;
        if let Some(id) = &args.event_id {
            if !env
                .spending_events_service()
                .list_events()
                .await
                .map_err(|_| failed())?
                .iter()
                .any(|e| e.id == *id)
            {
                return Err(invalid());
            }
        }
        let review = TagReview {
            activity_id: args.activity_id,
            event_id: args.event_id,
            expected_event_id: row.event_id.clone(),
        };
        Ok(AgentToolResult {
            content: json!({"change":review,"transaction":row,"effect":"Only this transaction's event tag changes. Financial fields, category assignments and splits are preserved."}),
        })
    }
}
pub struct CommitSpendingEventTag;
#[async_trait::async_trait]
impl AgentTool for CommitSpendingEventTag {
    fn name(&self) -> &'static str {
        "commit_spending_event_tag"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply one reviewed event tag change from prepare_spending_event_tag. Rechecks Spending scope and event existence; the existing writer atomically rejects a changed prior tag. Does not constrain transaction date to the event period or edit financial fields."
    }
    fn input_schema(&self) -> Value {
        let mut schema = tag_schema();
        schema["properties"]["expectedEventId"] = json!({"type":["string","null"]});
        schema["required"]
            .as_array_mut()
            .expect("required array")
            .push(json!("expectedEventId"));
        schema
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"eventTag":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: TagReview = serde_json::from_value(args).map_err(|_| invalid())?;
        env.cash_activity_service()
            .set_event_reviewed(
                &args.activity_id,
                args.expected_event_id,
                args.event_id.clone(),
            )
            .await
            .map_err(|_| failed())?;
        Ok(AgentToolResult {
            content: json!({"activityId":args.activity_id,"eventId":args.event_id,"draftStatus":"applied"}),
        })
    }
}
