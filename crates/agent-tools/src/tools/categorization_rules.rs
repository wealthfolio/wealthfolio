//! Categorization rule tools (MCP-only).
//!
//! `list_categorization_rules` shows the saved rules — the user's own, those
//! installed from a bundled preset, and those an add-on saved — so an external
//! agent can see what the rule pass in `list_categorization_context` applies.
//! `rerun_categorization_rules` runs the rules over the spending accounts, as
//! re-running rules on the rules page does.

use std::collections::HashMap;
use std::sync::Arc;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use wealthfolio_spending::categorization_rules::{CategorizationRule, RuleAmountOp, RuleMatchType};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

/// Prefix of the ids add-ons give the rules they save
/// (`addon:<addonId>:<hash>`, see `apps/frontend/src/addons/spending-rule-key.ts`).
const ADDON_RULE_ID_PREFIX: &str = "addon:";

const ORIGIN_USER: &str = "user";
const ORIGIN_PRESET: &str = "preset";
const ORIGIN_ADDON: &str = "addon";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCategorizationRulesArgs {
    #[serde(default)]
    pub taxonomy_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorizationRuleDto {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub match_type: RuleMatchType,
    pub taxonomy_id: Option<String>,
    pub category_id: Option<String>,
    pub category_key: Option<String>,
    pub category_name: Option<String>,
    pub activity_type: Option<String>,
    pub amount_op: Option<RuleAmountOp>,
    pub amount_value: Option<Decimal>,
    pub amount_value2: Option<Decimal>,
    pub priority: i32,
    pub is_global: bool,
    pub account_id: Option<String>,
    /// "user" | "preset" | "addon"
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_version: Option<String>,
    /// True when the user edited a preset rule.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset_modified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addon_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCategorizationRulesOutput {
    pub rules: Vec<CategorizationRuleDto>,
    pub count: usize,
}

/// The add-on id from an `addon:<addonId>:<hash>` rule id.
fn addon_id(rule_id: &str) -> Option<&str> {
    let rest = rule_id.strip_prefix(ADDON_RULE_ID_PREFIX)?;
    let (addon_id, _) = rest.split_once(':')?;
    (!addon_id.is_empty()).then_some(addon_id)
}

fn to_dto(
    rule: CategorizationRule,
    categories: &HashMap<(String, String), (String, String)>,
) -> CategorizationRuleDto {
    let category = rule
        .taxonomy_id
        .clone()
        .zip(rule.category_id.clone())
        .and_then(|key| categories.get(&key));
    let addon_id = addon_id(&rule.id).map(str::to_string);
    let origin = if addon_id.is_some() {
        ORIGIN_ADDON
    } else if rule.preset_id.is_some() {
        ORIGIN_PRESET
    } else {
        ORIGIN_USER
    };
    let from_preset = origin == ORIGIN_PRESET;
    CategorizationRuleDto {
        category_key: category.map(|(key, _)| key.clone()),
        category_name: category.map(|(_, name)| name.clone()),
        origin: origin.to_string(),
        preset_id: rule.preset_id.filter(|_| from_preset),
        preset_version: rule.preset_version.filter(|_| from_preset),
        preset_modified: from_preset.then_some(rule.preset_modified),
        addon_id,
        id: rule.id,
        name: rule.name,
        pattern: rule.pattern,
        match_type: rule.match_type,
        taxonomy_id: rule.taxonomy_id,
        category_id: rule.category_id,
        activity_type: rule.activity_type,
        amount_op: rule.amount_op,
        amount_value: rule.amount_value,
        amount_value2: rule.amount_value2,
        priority: rule.priority,
        is_global: rule.is_global,
        account_id: rule.account_id,
    }
}

/// Apply the filters and order rules by priority, highest (the one that wins) first.
fn select_rules(
    mut rules: Vec<CategorizationRule>,
    categories: &HashMap<(String, String), (String, String)>,
    args: &ListCategorizationRulesArgs,
) -> Vec<CategorizationRuleDto> {
    if let Some(taxonomy_id) = args.taxonomy_id.as_deref() {
        rules.retain(|rule| rule.taxonomy_id.as_deref() == Some(taxonomy_id));
    }
    // Stable sort keeps the service order for equal priorities.
    rules.sort_by_key(|rule| std::cmp::Reverse(rule.priority));
    rules
        .into_iter()
        .map(|rule| to_dto(rule, categories))
        .filter(|rule| args.origin.as_deref().is_none_or(|o| rule.origin == o))
        .collect()
}

/// List the saved categorization rules.
pub struct ListCategorizationRules;

#[async_trait::async_trait]
impl AgentTool for ListCategorizationRules {
    fn name(&self) -> &'static str {
        "list_categorization_rules"
    }

    fn description(&self) -> &'static str {
        "List the saved transaction categorization rules: the user's own, rules \
         installed from a bundled country preset, and rules an add-on saved \
         (origin user/preset/addon). Each rule matches an activity's notes by \
         `pattern` and `matchType`, optionally only for one `activityType`, an \
         amount condition or one account, and assigns `categoryId` in \
         `taxonomyId`. When several rules match, the highest `priority` wins; \
         rules are returned in that order. list_categorization_context already \
         applies these rules, so rows they match do not appear in its \
         `unproposed` list. To apply a rule's category yourself, use \
         propose_transaction_categories and commit_transaction_categories; to \
         re-apply all rules, use rerun_categorization_rules."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "taxonomyId": {
                    "type": "string",
                    "description": "Only rules that assign a category in this taxonomy (e.g. spending_categories or income_sources)."
                },
                "origin": {
                    "type": "string",
                    "enum": [ORIGIN_USER, ORIGIN_PRESET, ORIGIN_ADDON],
                    "description": "Only rules with this origin."
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }

    fn sanitize_args_for_audit(&self, _: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({"categorizationArguments":"[redacted]"})
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: ListCategorizationRulesArgs = serde_json::from_value(args).map_err(|_| {
            AgentToolError::InvalidInput(
                "Invalid categorization arguments; see the input schema".into(),
            )
        })?;
        if let Some(origin) = args.origin.as_deref() {
            if ![ORIGIN_USER, ORIGIN_PRESET, ORIGIN_ADDON].contains(&origin) {
                return Err(AgentToolError::InvalidInput(format!(
                    "origin must be one of {ORIGIN_USER}, {ORIGIN_PRESET}, {ORIGIN_ADDON}"
                )));
            }
        }

        let mut rules = env
            .categorization_rules_service()
            .list()
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        rules.retain(|rule| {
            rule.taxonomy_id.as_deref().is_none_or(|id| {
                wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS.contains(&id)
            })
        });
        let categories: HashMap<(String, String), (String, String)> = env
            .taxonomy_service()
            .get_taxonomies_with_categories()
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?
            .into_iter()
            .filter(|entry| {
                entry.taxonomy.scope == "activity"
                    && wealthfolio_core::taxonomies::TRANSACTION_CATEGORY_TAXONOMY_IDS
                        .contains(&entry.taxonomy.id.as_str())
            })
            .flat_map(|entry| entry.categories)
            .map(|cat| ((cat.taxonomy_id, cat.id), (cat.key, cat.name)))
            .collect();

        let rules = select_rules(rules, &categories, &args);
        let output = ListCategorizationRulesOutput {
            count: rules.len(),
            rules,
        };
        Ok(AgentToolResult {
            content: serde_json::to_value(output)?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RerunCategorizationRulesArgs {
    #[serde(default = "default_only_uncategorized")]
    pub only_uncategorized: bool,
}

fn default_only_uncategorized() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunCategorizationRulesOutput {
    #[serde(flatten)]
    pub decisions: wealthfolio_spending::activity_assignments::RuleAssignmentResult,
    pub only_uncategorized: bool,
    /// Spending accounts the rules ran over; 0 when spending tracking is off
    /// or no account is opted in.
    pub accounts: usize,
    /// Activities a rule matched, including those whose existing category was kept.
    pub matched: usize,
}

/// Re-apply the categorization rules to the spending accounts.
pub struct RerunCategorizationRules;

#[async_trait::async_trait]
impl AgentTool for RerunCategorizationRules {
    fn name(&self) -> &'static str {
        "rerun_categorization_rules"
    }

    fn description(&self) -> &'static str {
        "Re-apply the saved categorization rules to every activity in the \
         accounts opted in to spending tracking, as re-running rules on the \
         rules page does. By default (`onlyUncategorized: true`) only activities without a \
         category in the rule's taxonomy get one. With `onlyUncategorized: \
         false`, rule matches also replace categories set by rules, imports or \
         AI. Split allocations and manual choices are always protected. Preview with preview_categorization_rules first; the run re-evaluates current state. This \
         MUTATES data — call it only after the user asked for it. Returns how \
         many spending accounts the rules ran over and how many activities a \
         rule matched, actual changes and separate split/manual/existing/unchanged counts. Matching is distinct from changing an assignment."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "onlyUncategorized": {
                    "type": "boolean",
                    "default": true,
                    "description": "True: only fill activities without a category. False: also replace categories that rules, imports or AI set."
                }
            },
            "required": []
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead, AgentScope::SpendingWrite]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, _: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({"categorizationArguments":"[redacted]"})
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: RerunCategorizationRulesArgs = serde_json::from_value(args).map_err(|_| {
            AgentToolError::InvalidInput(
                "Invalid categorization arguments; see the input schema".into(),
            )
        })?;
        let account_ids = env
            .cash_activity_service()
            .spending_account_ids()
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        // `rerun_all` returns 0 without reading anything for no accounts.
        let summary = env
            .categorization_rules_service()
            .rerun_detailed(&account_ids, args.only_uncategorized)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        Ok(AgentToolResult {
            content: serde_json::to_value(RerunCategorizationRulesOutput {
                only_uncategorized: args.only_uncategorized,
                accounts: account_ids.len(),
                matched: summary.matched,
                decisions: summary.decisions,
            })?,
        })
    }
}

pub struct PreviewCategorizationRules;
#[async_trait::async_trait]
impl AgentTool for PreviewCategorizationRules {
    fn name(&self) -> &'static str {
        "preview_categorization_rules"
    }
    fn description(&self) -> &'static str {
        "Preview reapplying native categorization rules over effective Spending accounts. Reports matched activities, eligible changes, protected split/manual rows, skipped existing assignments and already-unchanged targets. No writes or outbox. Defaults to onlyUncategorized:true. Execution re-evaluates current state; this preview is not a frozen snapshot."
    }
    fn input_schema(&self) -> serde_json::Value {
        RerunCategorizationRules.input_schema()
    }
    fn required_scopes(&self) -> &'static [AgentScope] {
        &[AgentScope::SpendingRead]
    }
    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Read
    }
    fn sanitize_args_for_audit(&self, _: &serde_json::Value) -> serde_json::Value {
        serde_json::json!({})
    }
    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: RerunCategorizationRulesArgs = serde_json::from_value(args)
            .map_err(|_| AgentToolError::InvalidInput("Invalid rule preview arguments".into()))?;
        let ids = env
            .cash_activity_service()
            .spending_account_ids()
            .await
            .map_err(|_| {
                AgentToolError::ExecutionFailed("Unable to resolve Spending scope".into())
            })?;
        let summary = env
            .categorization_rules_service()
            .preview_rerun(&ids, args.only_uncategorized)
            .await
            .map_err(|_| AgentToolError::ExecutionFailed("Unable to preview rules".into()))?;
        Ok(AgentToolResult {
            content: serde_json::json!({"onlyUncategorized":args.only_uncategorized,"accounts":ids.len(),"summary":summary,"writesPerformed":false,"policy":"A later rerun re-evaluates current state and preserves split/manual choices."}),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addon_id_reads_the_rule_id_prefix() {
        assert_eq!(
            addon_id("addon:gocardless-sync:0123abcd"),
            Some("gocardless-sync")
        );
        assert_eq!(addon_id("addon::0123abcd"), None);
        assert_eq!(addon_id("addon:no-key"), None);
        assert_eq!(addon_id("9f1c2d3e-uuid"), None);
    }

    fn rule(id: &str, category_id: &str, priority: i32) -> CategorizationRule {
        let now = chrono::Utc::now().naive_utc();
        CategorizationRule {
            id: id.to_string(),
            name: id.to_string(),
            pattern: "(?i)conad".to_string(),
            match_type: RuleMatchType::Regex,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some(category_id.to_string()),
            activity_type: Some("WITHDRAWAL".to_string()),
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            priority,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
            preset_modified: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn rules() -> Vec<CategorizationRule> {
        let mut preset = rule("preset-rule", "cat_groceries", 80);
        preset.preset_id = Some("it".to_string());
        preset.preset_rule_key = Some("it.food_groceries".to_string());
        preset.preset_version = Some("2026-10.1".to_string());
        let mut income = rule("user-salary", "cat_salary", 10);
        income.taxonomy_id = Some("income_sources".to_string());
        income.activity_type = Some("DEPOSIT".to_string());
        vec![
            rule("addon:gocardless-sync:0123abcd", "cat_groceries", -20),
            income,
            preset,
            rule("user-coffee", "missing", 0),
        ]
    }

    fn categories() -> HashMap<(String, String), (String, String)> {
        HashMap::from([(
            (
                "spending_categories".to_string(),
                "cat_groceries".to_string(),
            ),
            ("groceries".to_string(), "Groceries".to_string()),
        )])
    }

    #[test]
    fn rules_come_highest_priority_first_with_origin_and_category() {
        let listed = select_rules(rules(), &categories(), &Default::default());
        let ids: Vec<_> = listed.iter().map(|rule| rule.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "preset-rule",
                "user-salary",
                "user-coffee",
                "addon:gocardless-sync:0123abcd"
            ]
        );

        let preset = &listed[0];
        assert_eq!(preset.origin, "preset");
        assert_eq!(preset.preset_id.as_deref(), Some("it"));
        assert_eq!(preset.preset_version.as_deref(), Some("2026-10.1"));
        assert_eq!(preset.preset_modified, Some(false));
        assert_eq!(preset.category_key.as_deref(), Some("groceries"));
        assert_eq!(preset.category_name.as_deref(), Some("Groceries"));
        assert_eq!(preset.activity_type.as_deref(), Some("WITHDRAWAL"));

        let user = &listed[2];
        assert_eq!(user.origin, "user");
        assert_eq!(user.category_key, None);
        let json = serde_json::to_value(user).unwrap();
        assert!(json.get("presetId").is_none(), "{json}");
        assert!(json.get("addonId").is_none(), "{json}");

        let addon = &listed[3];
        assert_eq!(addon.origin, "addon");
        assert_eq!(addon.addon_id.as_deref(), Some("gocardless-sync"));
        assert_eq!(addon.preset_id, None);
    }

    #[test]
    fn rules_filter_by_taxonomy_and_origin() {
        let by_taxonomy = select_rules(
            rules(),
            &categories(),
            &ListCategorizationRulesArgs {
                taxonomy_id: Some("income_sources".to_string()),
                origin: None,
            },
        );
        assert_eq!(by_taxonomy.len(), 1);
        assert_eq!(by_taxonomy[0].id, "user-salary");

        let addons = select_rules(
            rules(),
            &categories(),
            &ListCategorizationRulesArgs {
                taxonomy_id: Some("spending_categories".to_string()),
                origin: Some("addon".to_string()),
            },
        );
        assert_eq!(addons.len(), 1);
        assert_eq!(addons[0].id, "addon:gocardless-sync:0123abcd");
    }

    #[test]
    fn rerun_defaults_to_only_uncategorized() {
        let args: RerunCategorizationRulesArgs =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(args.only_uncategorized);
    }
}
