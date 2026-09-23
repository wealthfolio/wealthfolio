//! Tool registry with scope-gated execution.

use std::sync::Arc;

use crate::env::AgentEnvironment;
use crate::scope::AgentScopeSet;
use crate::tool::{AgentTool, AgentToolError, AgentToolResult};

/// An ordered collection of agent tools.
///
/// `execute` enforces scopes BEFORE the tool runs — this is the
/// authorization boundary for MCP callers. The in-app assistant filters by
/// its per-thread name allowlist instead and calls tools through the rig
/// adapter, which does not scope-check (the user is the operator there).
pub struct AgentToolCatalog {
    tools: Vec<Arc<dyn AgentTool>>,
}

impl AgentToolCatalog {
    pub fn new(tools: Vec<Arc<dyn AgentTool>>) -> Self {
        Self { tools }
    }

    /// The v1 read-only catalog.
    pub fn v1_read_tools() -> Self {
        Self::new(crate::tools::v1_read_tools())
    }

    /// The in-app assistant catalog: read tools plus the draft/suggest tools.
    /// Commit tools are NOT included — the assistant persists drafts through
    /// its confirmation widget, never directly.
    pub fn assistant_catalog() -> Self {
        let mut tools = crate::tools::v1_read_tools();
        tools.extend(crate::tools::draft_suggest_tools());
        Self::new(tools)
    }

    /// The MCP catalog: read + draft/suggest + commit tools. Scope filtering at
    /// the boundary (`execute`, `list_tools`) hides whatever a token can't reach.
    pub fn mcp_catalog() -> Self {
        let mut tools = crate::tools::v1_read_tools();
        tools.extend(crate::tools::draft_suggest_tools());
        tools.extend(crate::tools::commit_tools());
        tools.extend(crate::tools::import_tools());
        Self::new(tools)
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn AgentTool>> {
        self.tools.iter().find(|tool| tool.name() == name)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn AgentTool>> {
        self.tools.iter()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Execute `name` with `args`, enforcing `granted` scopes first.
    /// Denials and unknown tools return errors without touching services.
    pub async fn execute(
        &self,
        env: Arc<dyn AgentEnvironment>,
        granted: &AgentScopeSet,
        name: &str,
        args: serde_json::Value,
    ) -> Result<AgentToolResult, AgentToolError> {
        let tool = self
            .get(name)
            .ok_or_else(|| AgentToolError::NotFound(name.to_string()))?;
        let required = tool.required_scopes();
        if !granted.grants_all(required) {
            let missing = required
                .iter()
                .filter(|scope| !granted.contains(**scope))
                .map(|scope| scope.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(AgentToolError::ScopeDenied {
                tool: name.to_string(),
                missing,
            });
        }
        tool.call(env, args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use wealthfolio_spending::categorization_rules::{CategorizationRule, NewCategorizationRule};

    /// Stub environment for authorization tests: service access panics unless
    /// a test explicitly supplies the rule service.
    #[derive(Default)]
    struct PanicEnv {
        rules: Option<Arc<TestRuleService>>,
    }

    #[derive(Default)]
    struct TestRuleService {
        created: Mutex<Vec<NewCategorizationRule>>,
    }

    #[async_trait::async_trait]
    impl wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait
        for TestRuleService
    {
        async fn list(&self) -> anyhow::Result<Vec<CategorizationRule>> {
            unreachable!("not used by the commit test")
        }

        async fn create(&self, rule: NewCategorizationRule) -> anyhow::Result<CategorizationRule> {
            let now = chrono::Utc::now().naive_utc();
            let created = CategorizationRule {
                id: rule.id.clone().unwrap(),
                name: rule.name.clone(),
                pattern: rule.pattern.clone(),
                match_type: rule.match_type,
                taxonomy_id: rule.taxonomy_id.clone(),
                category_id: rule.category_id.clone(),
                activity_type: rule.activity_type.clone(),
                amount_op: rule.amount_op,
                amount_value: rule.amount_value,
                amount_value2: rule.amount_value2,
                priority: rule.priority,
                is_global: rule.is_global,
                account_id: rule.account_id.clone(),
                preset_id: rule.preset_id.clone(),
                preset_rule_key: rule.preset_rule_key.clone(),
                preset_version: rule.preset_version.clone(),
                preset_modified: false,
                created_at: now,
                updated_at: now,
            };
            self.created.lock().unwrap().push(rule);
            Ok(created)
        }
    }

    impl AgentEnvironment for PanicEnv {
        fn base_currency(&self) -> String {
            "USD".to_string()
        }
        fn account_service(&self) -> Arc<dyn wealthfolio_core::accounts::AccountServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn activity_service(&self) -> Arc<dyn wealthfolio_core::activities::ActivityServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn holdings_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::holdings::HoldingsServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn valuation_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::valuation::ValuationServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn goal_service(&self) -> Arc<dyn wealthfolio_core::goals::GoalServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn settings_service(&self) -> Arc<dyn wealthfolio_core::settings::SettingsServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn quote_service(&self) -> Arc<dyn wealthfolio_core::quotes::QuoteServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn asset_service(&self) -> Arc<dyn wealthfolio_core::assets::AssetServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn allocation_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::allocation::AllocationServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn performance_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::performance::PerformanceServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn income_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::income::IncomeServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn health_service(&self) -> Arc<dyn wealthfolio_core::health::HealthServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn taxonomy_service(&self) -> Arc<dyn wealthfolio_core::taxonomies::TaxonomyServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn portfolio_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolios::PortfolioServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn net_worth_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::portfolio::net_worth::NetWorthServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn contribution_limit_service(
            &self,
        ) -> Arc<dyn wealthfolio_core::limits::ContributionLimitServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn cash_activity_service(
            &self,
        ) -> Arc<dyn wealthfolio_spending::cash_activities::CashActivityServiceTrait> {
            unimplemented!("PanicEnv")
        }
        fn categorization_rules_service(
            &self,
        ) -> Arc<dyn wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait>
        {
            self.rules.clone().expect("PanicEnv")
        }
    }

    #[tokio::test]
    async fn execute_denies_every_v1_tool_with_empty_scopes() {
        let catalog = AgentToolCatalog::v1_read_tools();
        let granted = AgentScopeSet::new();
        for name in catalog.iter().map(|tool| tool.name()).collect::<Vec<_>>() {
            let err = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &granted,
                    name,
                    serde_json::json!({}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, AgentToolError::ScopeDenied { .. }),
                "tool {name} should be scope-denied, got: {err}"
            );
        }
    }

    #[test]
    fn assistant_catalog_excludes_commit_tools() {
        let catalog = AgentToolCatalog::assistant_catalog();
        let names: Vec<&str> = catalog.iter().map(|tool| tool.name()).collect();
        // Draft/suggest tools are present.
        assert!(names.contains(&"record_activity"));
        assert!(names.contains(&"prepare_asset_classification"));
        // Commit and CSV-import tools are NOT exposed to the assistant.
        assert!(!names.contains(&"commit_activity_draft"));
        assert!(!names.contains(&"commit_activity_drafts"));
        assert!(!names.contains(&"commit_asset_classification_draft"));
        assert!(!names.contains(&"commit_categorization_rule"));
        assert!(!names.contains(&"prepare_activity_import"));
        assert!(!names.contains(&"commit_activity_import"));
        assert!(!names.contains(&"get_import_mapping"));
    }

    #[test]
    fn mcp_catalog_includes_commit_and_import_tools() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let names: Vec<&str> = catalog.iter().map(|tool| tool.name()).collect();
        assert!(names.contains(&"commit_activity_draft"));
        assert!(names.contains(&"commit_activity_drafts"));
        assert!(names.contains(&"commit_asset_classification_draft"));
        assert!(names.contains(&"commit_categorization_rule"));
        assert!(names.contains(&"get_import_mapping"));
        assert!(names.contains(&"prepare_activity_import"));
        assert!(names.contains(&"commit_activity_import"));
        // Read-only token still sees exactly 16 read tools.
        assert_eq!(crate::tools::v1_read_tools().len(), 16);
    }

    #[tokio::test]
    async fn execute_denies_commit_tools_with_empty_scopes() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let granted = AgentScopeSet::new();
        for name in [
            "commit_activity_draft",
            "commit_activity_drafts",
            "commit_asset_classification_draft",
            "commit_categorization_rule",
        ] {
            let err = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &granted,
                    name,
                    serde_json::json!({}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, AgentToolError::ScopeDenied { .. }),
                "tool {name} should be scope-denied, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn categorization_rule_commit_requires_write_scope_and_saves_reviewed_rule() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let rules = Arc::new(TestRuleService::default());
        let env = Arc::new(PanicEnv {
            rules: Some(rules.clone()),
        });
        let input = serde_json::json!({
            "rule": {
                "id": "draft-1", "name": "Coffee", "pattern": "CAFE",
                "matchType": "contains", "taxonomyId": "spending_categories",
                "categoryId": "food", "activityType": null, "amountOp": null,
                "amountValue": null, "amountValue2": null, "priority": 0,
                "isGlobal": true, "accountId": null, "presetId": null,
                "presetRuleKey": null, "presetVersion": null
            }
        });

        let suggest_only = AgentScopeSet::from_strs(["classification:suggest"]);
        let denied = catalog
            .execute(
                env.clone(),
                &suggest_only,
                "commit_categorization_rule",
                input.clone(),
            )
            .await
            .unwrap_err();
        assert!(matches!(denied, AgentToolError::ScopeDenied { .. }));
        assert!(rules.created.lock().unwrap().is_empty());

        let writable = AgentScopeSet::from_strs(["classification:suggest", "classification:write"]);
        let result = catalog
            .execute(env, &writable, "commit_categorization_rule", input)
            .await
            .unwrap();
        assert_eq!(result.content["created"]["id"], "draft-1");
        let saved = rules.created.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].pattern, "CAFE");
    }

    #[tokio::test]
    async fn commit_drafts_rejects_oversized_batch_before_touching_env() {
        // A write-scoped but oversized batch must be rejected by the tool's
        // size cap before any service is reached — PanicEnv proves no write
        // (or any service access) is attempted.
        let catalog = AgentToolCatalog::mcp_catalog();
        let granted = AgentScopeSet::from_strs(["activities:draft", "activities:write"]);
        // Comfortably over the cap (100) regardless of small future tweaks.
        let drafts: Vec<_> = (0..256)
            .map(|_| {
                serde_json::json!({
                    "activityType": "BUY",
                    "activityDate": "2024-01-15",
                    "currency": "USD",
                    "accountId": "a"
                })
            })
            .collect();
        let err = catalog
            .execute(
                Arc::new(PanicEnv::default()),
                &granted,
                "commit_activity_drafts",
                serde_json::json!({ "drafts": drafts }),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, AgentToolError::InvalidInput(_)),
            "oversized batch should be rejected with InvalidInput, got: {err}"
        );
    }

    #[tokio::test]
    async fn execute_returns_not_found_for_unknown_tool() {
        let catalog = AgentToolCatalog::v1_read_tools();
        let err = catalog
            .execute(
                Arc::new(PanicEnv::default()),
                &AgentScopeSet::read_only(),
                "no_such_tool",
                serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AgentToolError::NotFound(_)));
    }
}
