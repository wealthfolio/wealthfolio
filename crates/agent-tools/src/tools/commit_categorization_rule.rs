//! Commit Categorization Rule tool (MCP-only).
//!
//! `create_categorization_rule` returns a rule draft; the in-app assistant saves
//! it through its confirmation widget. External MCP clients use this tool after
//! the user reviews that draft.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wealthfolio_spending::categorization_rules::{
    compile_regex_pattern, CategorizationRule, NewCategorizationRule, RuleMatchType,
    MAX_REGEX_PATTERN_LEN,
};

use crate::env::AgentEnvironment;
use crate::scope::AgentScope;
use crate::tool::{AgentTool, AgentToolAccess, AgentToolError, AgentToolResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCategorizationRuleArgs {
    pub rule: NewCategorizationRule,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCategorizationRuleOutput {
    pub created: CategorizationRule,
}

fn validate_draft(rule: &NewCategorizationRule) -> Result<(), AgentToolError> {
    // The draft tool always assigns an ID. Requiring it here makes a retry
    // fail with a duplicate-ID error instead of silently creating two rules.
    if rule.id.as_deref().is_none_or(|id| id.trim().is_empty()) {
        return Err(AgentToolError::InvalidInput(
            "rule.id from create_categorization_rule is required".to_string(),
        ));
    }
    if rule.pattern.trim().is_empty() {
        return Err(AgentToolError::InvalidInput(
            "rule.pattern cannot be empty".to_string(),
        ));
    }
    if rule.pattern.len() > MAX_REGEX_PATTERN_LEN {
        return Err(AgentToolError::InvalidInput(format!(
            "rule.pattern must be {MAX_REGEX_PATTERN_LEN} characters or fewer"
        )));
    }
    if matches!(rule.match_type, RuleMatchType::Regex) {
        compile_regex_pattern(&rule.pattern).map_err(|_| {
            AgentToolError::InvalidInput("rule.pattern is not a valid regex".to_string())
        })?;
    }
    if rule
        .taxonomy_id
        .as_deref()
        .is_none_or(|id| id.trim().is_empty())
        || rule
            .category_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
    {
        return Err(AgentToolError::InvalidInput(
            "rule.taxonomyId and rule.categoryId are required".to_string(),
        ));
    }
    // Drafts are user-created rules, never preset imports. Do not let an MCP
    // caller mark a new rule as owned by a bundled preset.
    if rule.preset_id.is_some() || rule.preset_rule_key.is_some() || rule.preset_version.is_some() {
        return Err(AgentToolError::InvalidInput(
            "preset provenance is not allowed on a rule draft".to_string(),
        ));
    }
    Ok(())
}

/// Commit one reviewed categorization rule draft.
pub struct CommitCategorizationRule;

#[async_trait::async_trait]
impl AgentTool for CommitCategorizationRule {
    fn name(&self) -> &'static str {
        "commit_categorization_rule"
    }

    fn description(&self) -> &'static str {
        "Persist a reviewed rule draft from create_categorization_rule. Pass the \
         returned rule object as `rule`. This MUTATES data — call it only after \
         the user has reviewed and confirmed the draft. A successful call \
         returns the saved rule."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "rule": {
                    "type": "object",
                    "description": "The rule object returned by create_categorization_rule, after user review. Copy its fields unchanged unless the user requests an edit.",
                    "properties": {
                        "id": { "type": "string" },
                        "name": { "type": "string" },
                        "pattern": { "type": "string", "minLength": 1, "maxLength": MAX_REGEX_PATTERN_LEN },
                        "matchType": { "type": "string", "enum": ["contains", "starts_with", "exact", "regex"] },
                        "taxonomyId": { "type": ["string", "null"] },
                        "categoryId": { "type": ["string", "null"] },
                        "activityType": { "type": ["string", "null"] },
                        "amountOp": { "type": ["string", "null"], "enum": ["eq", "gt", "gte", "lt", "lte", "between", null] },
                        "amountValue": { "type": ["string", "number", "null"] },
                        "amountValue2": { "type": ["string", "number", "null"] },
                        "priority": { "type": "integer" },
                        "isGlobal": { "type": "boolean" },
                        "accountId": { "type": ["string", "null"] },
                        "presetId": { "type": "null" },
                        "presetRuleKey": { "type": "null" },
                        "presetVersion": { "type": "null" }
                    },
                    "required": ["id", "name", "pattern", "taxonomyId", "categoryId", "activityType", "amountOp", "amountValue", "amountValue2", "accountId", "presetId", "presetRuleKey", "presetVersion"]
                }
            },
            "required": ["rule"]
        })
    }

    fn required_scopes(&self) -> &'static [AgentScope] {
        &[
            AgentScope::ClassificationSuggest,
            AgentScope::ClassificationWrite,
        ]
    }

    fn access_level(&self) -> AgentToolAccess {
        AgentToolAccess::Write
    }

    fn sanitize_args_for_audit(&self, args: &serde_json::Value) -> serde_json::Value {
        if args.get("rule").is_some() {
            serde_json::json!({ "rule": "[redacted]" })
        } else {
            serde_json::json!({})
        }
    }

    async fn call(
        &self,
        env: Arc<dyn AgentEnvironment>,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let args: CommitCategorizationRuleArgs = serde_json::from_value(args)?;
        validate_draft(&args.rule)?;

        let created = env
            .categorization_rules_service()
            .create(args.rule)
            .await
            .map_err(|e| AgentToolError::ExecutionFailed(e.to_string()))?;
        Ok(AgentToolResult {
            content: serde_json::to_value(CommitCategorizationRuleOutput { created })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_payload_matches_commit_schema() {
        let draft = NewCategorizationRule {
            id: Some("rule-1".to_string()),
            name: "Coffee".to_string(),
            pattern: "CAFE".to_string(),
            match_type: wealthfolio_spending::categorization_rules::RuleMatchType::Contains,
            taxonomy_id: Some("spending_categories".to_string()),
            category_id: Some("food".to_string()),
            activity_type: None,
            amount_op: None,
            amount_value: None,
            amount_value2: None,
            priority: 0,
            is_global: true,
            account_id: None,
            preset_id: None,
            preset_rule_key: None,
            preset_version: None,
        };
        let draft_json = serde_json::to_value(&draft).unwrap();
        let schema = CommitCategorizationRule.input_schema();
        for key in draft_json.as_object().unwrap().keys() {
            assert!(
                schema["properties"]["rule"]["properties"]
                    .get(key)
                    .is_some(),
                "commit schema is missing draft field {key}"
            );
        }
        let args: CommitCategorizationRuleArgs =
            serde_json::from_value(serde_json::json!({ "rule": draft_json })).unwrap();
        validate_draft(&args.rule).unwrap();
        assert_eq!(args.rule.id.as_deref(), Some("rule-1"));
        assert_eq!(args.rule.pattern, "CAFE");
    }

    #[test]
    fn rejects_missing_id_and_preset_provenance() {
        let mut rule: NewCategorizationRule = serde_json::from_value(serde_json::json!({
            "id": null, "name": "Coffee", "pattern": "CAFE", "matchType": "contains",
            "taxonomyId": "spending_categories", "categoryId": "food", "activityType": null,
            "amountOp": null, "amountValue": null, "amountValue2": null,
            "priority": 0, "isGlobal": true, "accountId": null,
            "presetId": null, "presetRuleKey": null, "presetVersion": null
        }))
        .unwrap();
        assert!(matches!(
            validate_draft(&rule),
            Err(AgentToolError::InvalidInput(_))
        ));
        rule.id = Some("rule-1".to_string());
        rule.preset_id = Some("preset".to_string());
        assert!(matches!(
            validate_draft(&rule),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_empty_and_oversized_patterns() {
        let mut rule: NewCategorizationRule = serde_json::from_value(serde_json::json!({
            "id": "rule-1", "name": "Coffee", "pattern": "CAFE", "matchType": "contains",
            "taxonomyId": "spending_categories", "categoryId": "food", "activityType": null,
            "amountOp": null, "amountValue": null, "amountValue2": null,
            "priority": 0, "isGlobal": true, "accountId": null,
            "presetId": null, "presetRuleKey": null, "presetVersion": null
        }))
        .unwrap();

        rule.pattern = "  ".to_string();
        assert!(matches!(
            validate_draft(&rule),
            Err(AgentToolError::InvalidInput(_))
        ));
        rule.pattern = "x".repeat(MAX_REGEX_PATTERN_LEN + 1);
        assert!(matches!(
            validate_draft(&rule),
            Err(AgentToolError::InvalidInput(_))
        ));
    }

    #[test]
    fn invalid_regex_error_does_not_echo_pattern() {
        let mut rule: NewCategorizationRule = serde_json::from_value(serde_json::json!({
            "id": "rule-1", "name": "Coffee", "pattern": "CAFE", "matchType": "regex",
            "taxonomyId": "spending_categories", "categoryId": "food", "activityType": null,
            "amountOp": null, "amountValue": null, "amountValue2": null,
            "priority": 0, "isGlobal": true, "accountId": null,
            "presetId": null, "presetRuleKey": null, "presetVersion": null
        }))
        .unwrap();
        rule.pattern = "PRIVATE-MERCHANT-(".to_string();
        let error = validate_draft(&rule).unwrap_err().to_string();
        assert!(!error.contains("PRIVATE-MERCHANT"));
    }

    #[test]
    fn audit_payload_redacts_merchant_and_account() {
        let sanitized = CommitCategorizationRule.sanitize_args_for_audit(&serde_json::json!({
            "rule": { "name": "Coffee", "pattern": "CAFE", "accountId": "account-1" },
            "extra": "sensitive"
        }));
        assert_eq!(sanitized, serde_json::json!({ "rule": "[redacted]" }));
    }
}
