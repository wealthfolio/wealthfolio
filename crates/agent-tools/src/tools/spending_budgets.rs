//! Reviewed budget operations. Domain validation and mutations stay in Spending.
use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use wealthfolio_spending::budget::{BudgetOperation, BudgetReview};

fn operation_schema() -> Value {
    let target = json!({"type":"object","additionalProperties":false,"properties":{
        "id":{"type":["string","null"]},"periodKey":{"type":"string","description":"default or YYYY-MM. Defaults affect every inheriting month, including historical months."},
        "targetType":{"type":"string","enum":["category","group_buffer"]},"taxonomyId":{"type":["string","null"],"enum":["spending_categories","income_sources",null]},
        "categoryId":{"type":["string","null"]},"groupId":{"type":["string","null"]},"amount":{"type":"string","description":"Exact nonnegative decimal in the profile base currency. Category targets require a top-level category; group_buffer requires groupId."}
    },"required":["periodKey","targetType","amount"]});
    let rollover = json!({"type":"object","additionalProperties":false,"properties":{
        "id":{"type":["string","null"]},"targetType":{"type":"string","enum":["category","group"]},"taxonomyId":{"type":["string","null"],"enum":["spending_categories",null]},"categoryId":{"type":["string","null"]},"groupId":{"type":["string","null"]},"enabled":{"type":"boolean"},"startMonth":{"type":"string"},"startingBalance":{"type":"string"}
    },"required":["targetType","startMonth","startingBalance"]});
    let group = json!({"type":"object","additionalProperties":false,"properties":{
        "id":{"type":["string","null"]},"key":{"type":["string","null"]},"name":{"type":"string"},"color":{"type":["string","null"]},"icon":{"type":["string","null"]},"sortOrder":{"type":["integer","null"]},"isSystem":{"type":"boolean","const":false}
    },"required":["name"]});
    let patch = json!({"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"color":{"type":["string","null"]},"icon":{"type":["string","null"]},"sortOrder":{"type":"integer"}}});
    let variant = |name: &str, properties: Value, required: Vec<&str>| {
        let mut properties = properties.as_object().expect("schema properties").clone();
        properties.insert("operation".into(), json!({"type":"string","const":name}));
        let mut required = required;
        required.push("operation");
        json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
    };
    json!({"oneOf":[
        variant("set_target",json!({"target":target}),vec!["target"]),
        variant("remove_target",json!({"id":{"type":"string"}}),vec!["id"]),
        variant("copy_targets",json!({"sourcePeriodKey":{"type":"string"},"targetPeriodKey":{"type":"string"},"overwrite":{"type":"boolean","description":"True explicitly replaces all destination targets; false preserves existing destination rows."}}),vec!["sourcePeriodKey","targetPeriodKey","overwrite"]),
        variant("create_group",json!({"group":group}),vec!["group"]),
        variant("update_group",json!({"id":{"type":"string"},"changes":patch}),vec!["id","changes"]),
        variant("delete_group",json!({"id":{"type":"string"},"reassignToGroupId":{"type":"string"}}),vec!["id","reassignToGroupId"]),
        variant("assign_category",json!({"categoryId":{"type":"string"},"groupId":{"type":"string"}}),vec!["categoryId","groupId"]),
        variant("set_rollover",json!({"setting":rollover}),vec!["setting"]),
        variant("remove_rollover",json!({"id":{"type":"string"}}),vec!["id"]),
        variant("reset_groups",json!({}),vec![])
    ]})
}
fn invalid() -> AgentToolError {
    AgentToolError::InvalidInput("Invalid budget change; see the input schema".into())
}
fn failure() -> AgentToolError {
    AgentToolError::ExecutionFailed(
        "Budget change rejected; refresh configuration and review again".into(),
    )
}
fn timezone(env: &dyn AgentEnvironment) -> Result<String, AgentToolError> {
    let settings = env
        .settings_service()
        .get_settings()
        .map_err(|_| failure())?;
    Ok(
        wealthfolio_core::utils::time_utils::parse_user_timezone_or_default(&settings.timezone)
            .to_string(),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareArgs {
    change: BudgetOperation,
    period_key: Option<String>,
}
fn effects(review: &BudgetReview) -> Value {
    use BudgetOperation::*;
    let policy="Changing default targets or buffers affects every past/future month without an explicit override and can change historical rollover results. Monthly overrides remain authoritative. Removing a month override falls back to the current default, not zero unless no default exists.";
    let mut effects = json!({"currency":review.currency,"viewPeriod":review.period_key,"inheritancePolicy":policy});
    effects["details"] = match &review.operation {
        SetTarget { target } => {
            json!({"before":review.expected.targets.iter().find(|t| t.period_key==target.period_key && t.target_type.as_str()==target.target_type.as_str() && t.taxonomy_id==target.taxonomy_id && t.category_id==target.category_id && t.group_id==target.group_id),"after":target,"scope":if target.period_key=="default"{"all_inheriting_months"}else{"selected_month_only"}})
        }
        RemoveTarget { id } => {
            json!({"removed":review.expected.targets.iter().find(|t|t.id==*id),"effect":"Removing a monthly override restores the current default; removing a default leaves explicit monthly overrides unchanged."})
        }
        CopyTargets {
            source_period_key,
            target_period_key,
            overwrite,
        } => {
            json!({"source":review.expected.targets.iter().filter(|t|t.period_key==*source_period_key).collect::<Vec<_>>(),"destinationBefore":review.expected.targets.iter().filter(|t|t.period_key==*target_period_key).collect::<Vec<_>>(),"overwrite":overwrite,"effect":"Only the destination month's stored targets change; effective inherited defaults are not copied unless sourcePeriodKey is default."})
        }
        DeleteGroup {
            id,
            reassign_to_group_id,
        } => {
            json!({"removedGroup":review.expected.groups.iter().find(|g|g.id==*id),"reassignToGroupId":reassign_to_group_id,"assignments":review.expected.group_assignments.iter().filter(|a|a.group_id==*id).collect::<Vec<_>>(),"buffers":review.expected.targets.iter().filter(|t|t.group_id.as_deref()==Some(id.as_str())).collect::<Vec<_>>(),"effect":"Assignments move to the destination; buffers merge by period using the native decimal writer. Group rollover must be removed first."})
        }
        SetRollover { setting } => {
            json!({"after":setting,"rolloverSettingsBefore":review.expected.rollover_settings,"effect":"Enabling group rollover disables its category rollovers atomically. Category rollover requires its group rollover to be disabled. This changes remaining/carry calculations from startMonth."})
        }
        RemoveRollover { id } => {
            json!({"removed":review.expected.rollover_settings.iter().find(|r|r.id==*id),"effect":"Remaining and carry results are recalculated without this rollover setting."})
        }
        ResetGroups => {
            json!({"effect":"Explicit destructive reset: restore native system group labels/order and default category links. Custom groups remain; missing/deleted categories are not recreated. Targets and rollover settings remain stored."})
        }
        _ => {
            json!({"change":review.operation,"effect":"Only the displayed group configuration or category-group mapping changes; financial transactions and category assignments are preserved."})
        }
    };
    effects
}
pub struct PrepareBudgetChange;
#[async_trait::async_trait]
impl AgentTool for PrepareBudgetChange {
    fn name(&self) -> &'static str {
        "prepare_budget_change"
    }
    fn description(&self) -> &'static str {
        "Preview one native budget operation: set/remove category target or group buffer, copy month targets with explicit overwrite, create/edit/reorder/delete custom groups with reassignment, assign a category to a group, set/remove rollover, or explicitly reset groups. Read-only; returns before state, exact proposed configuration and scope/effects for review. Defaults apply to ANY inheriting month, including past months. Savings targets await core domain support; no new accounting semantics are introduced."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"change":operation_schema(),"periodKey":{"type":"string","description":"default or YYYY-MM for the resulting budget view. Each target carries its own explicit periodKey."}},"required":["change"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"budgetChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let review = env
            .budget_service()
            .prepare_change(
                args.change,
                args.period_key,
                &env.base_currency(),
                &timezone(env.as_ref())?,
            )
            .await
            .map_err(|_| failure())?;
        Ok(AgentToolResult {
            content: json!({"change":review,"effects":effects(&review),"reviewRequired":true,"atomicity":"One operation per commit. Independent operations require separate reviews and are not a whole-budget atomic batch."}),
        })
    }
}
pub struct CommitBudgetChange;
#[async_trait::async_trait]
impl AgentTool for CommitBudgetChange {
    fn name(&self) -> &'static str {
        "commit_budget_change"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply exactly one reviewed budget change returned by prepare_budget_change. Requires Manage budgets plus View spending; Organize spending is independent and insufficient. Revalidates native rules and compares full prior configuration inside the existing writer transaction. Concurrent changes reject the whole operation. Both default and monthly budgets are supported. Review reset/copy/delete/rollover consequences explicitly; do not retry after an unknown mutation outcome."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"expected":{"type":"object","description":"Copy full expected state from prepare unchanged."},"operation":operation_schema(),"periodKey":{"type":"string"},"currency":{"type":"string"}},"required":["expected","operation","periodKey","currency"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::BudgetWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"budgetChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let review: BudgetReview = serde_json::from_value(args).map_err(|_| invalid())?;
        let budget = env
            .budget_service()
            .commit_change(review, &env.base_currency(), &timezone(env.as_ref())?)
            .await
            .map_err(|_| failure())?;
        Ok(AgentToolResult {
            content: json!({"budget":budget,"draftStatus":"applied"}),
        })
    }
}
