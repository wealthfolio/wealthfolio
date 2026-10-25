//! Native rule editing and preset lifecycle, with explicit save/apply separation.
use super::commit_categorization_rule::validate_target;
use crate::{
    AgentEnvironment, AgentScope, AgentTool, AgentToolAccess, AgentToolError, AgentToolResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS;
use wealthfolio_spending::categorization_rules::{CategorizationRule, NewCategorizationRule};

fn invalid() -> AgentToolError {
    AgentToolError::InvalidInput("Invalid rule change; see the input schema".into())
}
fn failure() -> AgentToolError {
    AgentToolError::ExecutionFailed("Rule change rejected; refresh and review again".into())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareArgs {
    rule_id: String,
    #[serde(deserialize_with = "super::required_nullable")]
    changes: Option<serde_json::Map<String, Value>>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    expected: CategorizationRule,
    #[serde(deserialize_with = "super::required_nullable")]
    proposed: Option<NewCategorizationRule>,
}

fn proposal_schema() -> Value {
    super::commit_categorization_rule::CommitCategorizationRule.input_schema()["properties"]["rule"]
        .clone()
}
async fn validate(env: &dyn AgentEnvironment, change: &Change) -> Result<(), AgentToolError> {
    if !change
        .expected
        .taxonomy_id
        .as_deref()
        .is_some_and(|id| TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id))
    {
        return Err(invalid());
    }
    if let Some(rule) = &change.proposed {
        if rule.id.as_deref() != Some(change.expected.id.as_str())
            || rule.name.trim().is_empty()
            || rule.preset_id != change.expected.preset_id
            || rule.preset_rule_key != change.expected.preset_rule_key
            || rule.preset_version != change.expected.preset_version
        {
            return Err(invalid());
        }
        validate_target(env, rule).await?;
        wealthfolio_spending::categorization_rules::service::validate_rule_input(rule)
            .map_err(|_| invalid())?;
    }
    Ok(())
}

pub struct PrepareCategorizationRuleChange;
#[async_trait::async_trait]
impl AgentTool for PrepareCategorizationRuleChange {
    fn name(&self) -> &'static str {
        "prepare_categorization_rule_change"
    }
    fn description(&self) -> &'static str {
        "Preview an existing transaction categorization rule edit or deletion by ruleId. changes is an editable-field patch, or null to delete. Identity and provenance are preserved. Returns a fresh full expected snapshot for commit. Saving a rule never reruns history; use rerun_categorization_rules separately after review. No writes."
    }
    fn input_schema(&self) -> Value {
        let mut patch = proposal_schema();
        for key in ["id", "presetId", "presetRuleKey", "presetVersion"] {
            patch["properties"]
                .as_object_mut()
                .expect("schema properties")
                .remove(key);
        }
        patch["required"] = json!([]);
        patch["additionalProperties"] = json!(false);
        json!({"type":"object","additionalProperties":false,"properties":{"ruleId":{"type":"string"},"changes":{"anyOf":[patch,{"type":"null"}]}},"required":["ruleId","changes"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"ruleChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PrepareArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let expected = env
            .categorization_rules_service()
            .list()
            .await
            .map_err(|_| failure())?
            .into_iter()
            .find(|r| r.id == args.rule_id)
            .ok_or_else(invalid)?;
        let proposed = if let Some(changes) = args.changes {
            let schema = Self.input_schema();
            let allowed = &schema["properties"]["changes"]["anyOf"][0]["properties"];
            if changes.keys().any(|key| allowed.get(key).is_none()) {
                return Err(invalid());
            }
            let mut value = serde_json::to_value(&expected)?;
            for (key, val) in changes {
                value[&key] = val;
            }
            Some(serde_json::from_value::<NewCategorizationRule>(value).map_err(|_| invalid())?)
        } else {
            None
        };
        let change = Change { expected, proposed };
        validate(env.as_ref(), &change).await?;
        Ok(AgentToolResult {
            content: json!({"change":change,"historicalApplication":"none","effect":"Only the saved rule changes. Existing categorized transactions remain unchanged until an explicit rerun. Deleting a preset rule uses native deletion tracking so an upgrade does not restore it."}),
        })
    }
}
pub struct CommitCategorizationRuleChange;
#[async_trait::async_trait]
impl AgentTool for CommitCategorizationRuleChange {
    fn name(&self) -> &'static str {
        "commit_categorization_rule_change"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Save the reviewed change from prepare_categorization_rule_change. Full expected rule state is compared inside the native SQLite writer; concurrent edits reject. Keeps rule/addon IDs, marks edited preset rules modified, and uses native deletion tracking. Does not rerun historical categorization."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false,"properties":{"expected":{"type":"object","description":"Copy full expected snapshot from prepare unchanged."},"proposed":{"anyOf":[{"type":"object","description":"Copy the full proposed rule returned by prepare; preserve identity and provenance."},{"type":"null"}]}},"required":["expected","proposed"]})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"ruleChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let change: Change = serde_json::from_value(args).map_err(|_| invalid())?;
        validate(env.as_ref(), &change).await?;
        let service = env.categorization_rules_service();
        let result = if let Some(proposed) = change.proposed {
            json!({"updated":service.update_reviewed(change.expected,proposed).await.map_err(|_|failure())?})
        } else {
            service
                .delete_reviewed(change.expected)
                .await
                .map_err(|_| failure())?;
            json!({"deleted":true})
        };
        Ok(AgentToolResult { content: result })
    }
}

pub struct ListCategorizationPresets;
#[async_trait::async_trait]
impl AgentTool for ListCategorizationPresets {
    fn name(&self) -> &'static str {
        "list_categorization_presets"
    }
    fn description(&self) -> &'static str {
        "List bundled country rule presets, versions, installed status and rule counts. Independent of transaction availability. Import upgrades only unmodified preset rules, respects native deletion tracking and preserves user-edited rules. Removing a preset keeps edited rules as standalone rules. Neither action reruns history."
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{},"additionalProperties":false})
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        _: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        Ok(AgentToolResult {
            content: json!({"presets":env.categorization_rules_service().list_presets().await.map_err(|_|failure())?}),
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresetArgs {
    preset_id: String,
    action: PresetAction,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PresetAction {
    Import,
    Remove,
}
fn preset_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"presetId":{"type":"string"},"action":{"type":"string","enum":["import","remove"]}},"required":["presetId","action"]})
}
pub struct PrepareCategorizationPreset;
#[async_trait::async_trait]
impl AgentTool for PrepareCategorizationPreset {
    fn name(&self) -> &'static str {
        "prepare_categorization_preset"
    }
    fn description(&self) -> &'static str {
        "Preview importing/upgrading or removing a bundled categorization preset. Shows current preset rules and native preservation policy. Commit re-evaluates current state; this is not a frozen historical rerun. No writes."
    }
    fn input_schema(&self) -> Value {
        preset_schema()
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"presetChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PresetArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        let preset =
            wealthfolio_spending::categorization_rules::presets::load_preset(&args.preset_id)
                .ok_or_else(invalid)?;
        let rules = env
            .categorization_rules_service()
            .list()
            .await
            .map_err(|_| failure())?
            .into_iter()
            .filter(|r| r.preset_id.as_deref() == Some(args.preset_id.as_str()))
            .collect::<Vec<_>>();
        Ok(AgentToolResult {
            content: json!({"change":args,"presetVersion":preset.preset_version,"bundledRuleCount":preset.rules.len(),"currentRules":rules,"policy":"Import upgrades unmodified rules and preserves modified/deleted rules; remove deletes unmodified rules and detaches modified rules. Current state is re-evaluated at commit. No historical rerun."}),
        })
    }
}
pub struct CommitCategorizationPreset;
#[async_trait::async_trait]
impl AgentTool for CommitCategorizationPreset {
    fn name(&self) -> &'static str {
        "commit_categorization_preset"
    }
    fn description(&self) -> &'static str {
        "MUTATES data. Apply the reviewed import/upgrade/remove operation from prepare_categorization_preset using the existing atomic preset writer. Preserves native user edits/deletions and stable provenance. Does not rerun historical activities; request an explicit rerun separately."
    }
    fn input_schema(&self) -> Value {
        preset_schema()
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }
    fn sanitize_args_for_audit(&self, _: &Value) -> Value {
        json!({"presetChange":"[redacted]"})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: PresetArgs = serde_json::from_value(args).map_err(|_| invalid())?;
        if wealthfolio_spending::categorization_rules::presets::load_preset(&args.preset_id)
            .is_none()
        {
            return Err(invalid());
        }
        let service = env.categorization_rules_service();
        let result = match args.action {
            PresetAction::Remove => serde_json::to_value(
                service
                    .remove_preset(&args.preset_id)
                    .await
                    .map_err(|_| failure())?,
            )?,
            PresetAction::Import => {
                let mut resolver = std::collections::HashMap::new();
                let mut ambiguous = std::collections::HashSet::new();
                for entry in env
                    .taxonomy_service()
                    .get_taxonomies_with_categories()
                    .map_err(|_| failure())?
                {
                    if entry.taxonomy.scope != "activity"
                        || !TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&entry.taxonomy.id.as_str())
                    {
                        continue;
                    }
                    for cat in entry.categories {
                        if resolver
                            .insert(cat.key.clone(), (cat.taxonomy_id, cat.id))
                            .is_some()
                        {
                            ambiguous.insert(cat.key);
                        }
                    }
                }
                resolver.retain(|key, _| !ambiguous.contains(key));
                serde_json::to_value(
                    service
                        .import_preset(&args.preset_id, &resolver)
                        .await
                        .map_err(|_| failure())?,
                )?
            }
        };
        Ok(AgentToolResult {
            content: json!({"result":result,"historicalApplication":"none"}),
        })
    }
}
