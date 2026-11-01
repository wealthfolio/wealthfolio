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

    /// The MCP catalog: read + draft/suggest + commit, categorization rule,
    /// import, transfer linking, quote import and activity update tools. Scope filtering at the
    /// boundary (`execute`, `list_tools`) hides whatever a token can't reach.
    pub fn mcp_catalog() -> Self {
        let mut tools = crate::tools::v1_read_tools();
        tools.extend(crate::tools::draft_suggest_tools());
        tools.extend(crate::tools::commit_tools());
        tools.extend(crate::tools::categorization_rule_tools());
        tools.extend(crate::tools::spending_access_tools());
        tools.extend(crate::tools::import_tools());
        tools.extend(crate::tools::transfer_link_tools());
        tools.extend(crate::tools::quote_import_tools());
        tools.extend(crate::tools::activity_update_tools());
        tools.extend(crate::tools::transaction_category_tools());
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
    use wealthfolio_core::taxonomies::{
        AssetTaxonomyAssignment, Category, NewAssetTaxonomyAssignment, NewCategory, NewTaxonomy,
        Taxonomy, TaxonomyServiceTrait, TaxonomyWithCategories,
    };
    struct TestTaxonomyService;
    #[async_trait::async_trait]
    impl TaxonomyServiceTrait for TestTaxonomyService {
        async fn update_category_reviewed(
            &self,
            _: wealthfolio_core::taxonomies::Category,
            _: wealthfolio_core::taxonomies::Category,
        ) -> wealthfolio_core::Result<wealthfolio_core::taxonomies::Category> {
            unimplemented!("reviewed categories are not used by this fixture")
        }
        async fn delete_category_reviewed(
            &self,
            _: wealthfolio_core::taxonomies::Category,
        ) -> wealthfolio_core::Result<usize> {
            unimplemented!("reviewed categories are not used by this fixture")
        }

        fn get_category_references(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<wealthfolio_core::taxonomies::CategoryReferences> {
            unimplemented!("category references are not used by this fixture")
        }

        fn get_taxonomies(&self) -> wealthfolio_core::Result<Vec<Taxonomy>> {
            unimplemented!()
        }
        fn get_taxonomy(
            &self,
            id: &str,
        ) -> wealthfolio_core::Result<Option<TaxonomyWithCategories>> {
            let time = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
            Ok(Some(TaxonomyWithCategories {
                taxonomy: Taxonomy {
                    id: id.into(),
                    name: "Transaction categories".into(),
                    color: "#808080".into(),
                    description: None,
                    is_system: true,
                    is_single_select: true,
                    sort_order: 0,
                    created_at: time,
                    updated_at: time,
                    scope: "activity".into(),
                },
                categories: vec![Category {
                    id: "food".into(),
                    taxonomy_id: id.into(),
                    parent_id: None,
                    name: "Food".into(),
                    key: "food".into(),
                    color: "#808080".into(),
                    description: None,
                    sort_order: 0,
                    created_at: time,
                    updated_at: time,
                    icon: None,
                }],
            }))
        }
        fn get_taxonomies_with_categories(
            &self,
        ) -> wealthfolio_core::Result<Vec<TaxonomyWithCategories>> {
            unimplemented!()
        }
        async fn create_taxonomy(&self, _: NewTaxonomy) -> wealthfolio_core::Result<Taxonomy> {
            unimplemented!()
        }
        async fn update_taxonomy(&self, _: Taxonomy) -> wealthfolio_core::Result<Taxonomy> {
            unimplemented!()
        }
        async fn delete_taxonomy(&self, _: &str) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
        async fn create_category(&self, _: NewCategory) -> wealthfolio_core::Result<Category> {
            unimplemented!()
        }
        async fn update_category(&self, _: Category) -> wealthfolio_core::Result<Category> {
            unimplemented!()
        }
        async fn delete_category(&self, _: &str, _: &str) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
        async fn move_category(
            &self,
            _: &str,
            _: &str,
            _: Option<String>,
            _: i32,
        ) -> wealthfolio_core::Result<Category> {
            unimplemented!()
        }
        async fn import_taxonomy_json(&self, _: &str) -> wealthfolio_core::Result<Taxonomy> {
            unimplemented!()
        }
        fn export_taxonomy_json(&self, _: &str) -> wealthfolio_core::Result<String> {
            unimplemented!()
        }
        fn get_asset_assignments(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        fn get_category_assignments(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn assign_asset_to_category(
            &self,
            _: NewAssetTaxonomyAssignment,
        ) -> wealthfolio_core::Result<AssetTaxonomyAssignment> {
            unimplemented!()
        }
        async fn replace_asset_taxonomy_assignments(
            &self,
            _: &str,
            _: &str,
            _: Vec<NewAssetTaxonomyAssignment>,
        ) -> wealthfolio_core::Result<Vec<AssetTaxonomyAssignment>> {
            unimplemented!()
        }
        async fn remove_asset_assignment(&self, _: &str) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }
    }
    use wealthfolio_spending::categorization_rules::{CategorizationRule, NewCategorizationRule};

    /// Stub environment for authorization tests: service access panics unless
    /// a test explicitly supplies the rule service.
    #[derive(Default)]
    struct PanicEnv {
        rules: Option<Arc<TestRuleService>>,
        cash: Option<Arc<TestCashService>>,
    }

    #[derive(Default)]
    struct TestRuleService {
        created: Mutex<Vec<NewCategorizationRule>>,
        reruns: Mutex<Vec<(Vec<String>, bool)>>,
    }

    /// Cash-activity service that only reports the opted-in spending accounts.
    struct TestCashService {
        spending_account_ids: Vec<String>,
    }

    #[async_trait::async_trait]
    impl wealthfolio_spending::cash_activities::CashActivityServiceTrait for TestCashService {
        async fn set_event_reviewed(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<String>,
        ) -> anyhow::Result<()> {
            unimplemented!("reviewed tags")
        }

        async fn validate_splits(
            &self,
            _: &str,
            _: &[wealthfolio_spending::activity_splits::NewActivitySplit],
        ) -> anyhow::Result<()> {
            unimplemented!("reviewed splits")
        }
        async fn replace_splits_reviewed(
            &self,
            _: wealthfolio_spending::activity_splits::SplitReviewState,
            _: Vec<wealthfolio_spending::activity_splits::NewActivitySplit>,
        ) -> anyhow::Result<Vec<wealthfolio_spending::activity_splits::ActivitySplit>> {
            unimplemented!("reviewed splits")
        }

        async fn context(
            &self,
        ) -> anyhow::Result<wealthfolio_spending::cash_activities::SpendingContext> {
            Ok(wealthfolio_spending::cash_activities::SpendingContext {
                enabled: true,
                account_ids: self.spending_account_ids.clone(),
                excluded_category_ids: Vec::new(),
            })
        }
        async fn search(
            &self,
            _: wealthfolio_spending::cash_activities::CashActivitySearchRequest,
        ) -> anyhow::Result<wealthfolio_spending::cash_activities::CashActivitySearchResponse>
        {
            unreachable!("not used by the rerun test")
        }

        async fn get_by_activity_ids(
            &self,
            _: &[String],
        ) -> anyhow::Result<Vec<wealthfolio_spending::cash_activities::CashActivity>> {
            unreachable!("not used by the rerun test")
        }

        async fn bulk_assign_categories(
            &self,
            _: &[wealthfolio_spending::activity_assignments::BulkCategoryAssignment],
        ) -> anyhow::Result<
            Vec<wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignment>,
        > {
            unreachable!("not used by the rerun test")
        }

        async fn spending_account_ids(&self) -> anyhow::Result<Vec<String>> {
            Ok(self.spending_account_ids.clone())
        }
    }

    #[async_trait::async_trait]
    impl wealthfolio_spending::categorization_rules::CategorizationRulesServiceTrait
        for TestRuleService
    {
        async fn update_reviewed(
            &self,
            _: wealthfolio_spending::categorization_rules::CategorizationRule,
            _: wealthfolio_spending::categorization_rules::NewCategorizationRule,
        ) -> anyhow::Result<wealthfolio_spending::categorization_rules::CategorizationRule>
        {
            unimplemented!("reviewed rules")
        }
        async fn delete_reviewed(
            &self,
            _: wealthfolio_spending::categorization_rules::CategorizationRule,
        ) -> anyhow::Result<()> {
            unimplemented!("reviewed rules")
        }
        async fn list_presets(
            &self,
        ) -> anyhow::Result<
            Vec<wealthfolio_spending::categorization_rules::presets::RulePresetSummary>,
        > {
            unimplemented!("presets")
        }
        async fn import_preset(
            &self,
            _: &str,
            _: &std::collections::HashMap<String, (String, String)>,
        ) -> anyhow::Result<wealthfolio_spending::categorization_rules::presets::ImportPresetResult>
        {
            unimplemented!("presets")
        }
        async fn remove_preset(
            &self,
            _: &str,
        ) -> anyhow::Result<wealthfolio_spending::categorization_rules::presets::RemovePresetResult>
        {
            unimplemented!("presets")
        }
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

        async fn rerun_all(
            &self,
            account_ids: &[String],
            only_uncategorized: bool,
        ) -> anyhow::Result<usize> {
            self.reruns
                .lock()
                .unwrap()
                .push((account_ids.to_vec(), only_uncategorized));
            Ok(account_ids.len() * 2)
        }
    }

    impl AgentEnvironment for PanicEnv {
        fn budget_service(&self) -> Arc<dyn wealthfolio_spending::budget::BudgetServiceTrait> {
            unimplemented!("MCP-only service")
        }
        fn spending_events_service(
            &self,
        ) -> Arc<dyn wealthfolio_spending::events::EventsServiceTrait> {
            unimplemented!("MCP-only service")
        }
        fn spending_analytics_service(
            &self,
        ) -> Arc<dyn wealthfolio_spending::analytics::AnalyticsServiceTrait> {
            unimplemented!("MCP-only service")
        }
        fn spending_insight_service(
            &self,
        ) -> Arc<dyn wealthfolio_spending::insight::InsightServiceTrait> {
            unimplemented!("MCP-only service")
        }
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
            self.rules.as_ref().expect("PanicEnv");
            Arc::new(TestTaxonomyService)
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
            self.cash.clone().expect("PanicEnv")
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
    fn mcp_catalog_includes_transaction_category_management() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let assistant = AgentToolCatalog::assistant_catalog();
        for (name, access, scopes) in [
            (
                "list_transaction_categories",
                crate::AgentToolAccess::Read,
                vec![crate::AgentScope::SpendingRead],
            ),
            (
                "prepare_transaction_category",
                crate::AgentToolAccess::Draft,
                vec![crate::AgentScope::SpendingRead],
            ),
            (
                "commit_transaction_category",
                crate::AgentToolAccess::Write,
                vec![
                    crate::AgentScope::SpendingRead,
                    crate::AgentScope::SpendingWrite,
                ],
            ),
        ] {
            let tool = catalog
                .get(name)
                .unwrap_or_else(|| panic!("missing {name}"));
            assert_eq!(tool.access_level(), access);
            assert_eq!(tool.required_scopes(), scopes);
            assert!(assistant.get(name).is_none());
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
        assert!(!names.contains(&"commit_transaction_categories"));
        assert!(!names.contains(&"list_categorization_rules"));
        assert!(!names.contains(&"rerun_categorization_rules"));
        assert!(!names.contains(&"prepare_activity_import"));
        assert!(!names.contains(&"commit_activity_import"));
        assert!(!names.contains(&"get_import_mapping"));
        assert!(!names.contains(&"find_transfer_matches"));
        assert!(!names.contains(&"link_transfer_activities"));
        assert!(!names.contains(&"unlink_transfer_activities"));
        assert!(!names.contains(&"prepare_quote_import"));
        assert!(!names.contains(&"commit_quote_import"));
        assert!(!names.contains(&"prepare_activity_updates"));
        assert!(!names.contains(&"commit_activity_updates"));
        assert!(!names.contains(&"prepare_activity_deletions"));
        assert!(!names.contains(&"commit_activity_deletions"));
    }

    #[tokio::test]
    async fn transaction_category_parse_errors_do_not_echo_private_input() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let granted = AgentScopeSet::from_strs(["spending:read", "spending:write"]);
        for name in [
            "list_transaction_categories",
            "prepare_transaction_category",
            "commit_transaction_category",
        ] {
            for args in [
                serde_json::json!("private-value"),
                serde_json::json!({"private-field": "private-value", "taxonomyId": ["private-value"]}),
            ] {
                let error = catalog
                    .execute(Arc::new(PanicEnv::default()), &granted, name, args)
                    .await
                    .unwrap_err()
                    .to_string();
                assert!(!error.contains("private-field"), "{name}: {error}");
                assert!(!error.contains("private-value"), "{name}: {error}");
            }
        }
    }

    #[tokio::test]
    async fn transaction_category_tools_deny_missing_scopes_before_service_access() {
        let catalog = AgentToolCatalog::mcp_catalog();
        for name in [
            "list_transaction_categories",
            "prepare_transaction_category",
            "commit_transaction_category",
        ] {
            let required = catalog.get(name).unwrap().required_scopes();
            for missing in required {
                let granted = AgentScopeSet::from_strs(
                    required
                        .iter()
                        .filter(|scope| scope != &missing)
                        .map(|scope| scope.as_str()),
                );
                let error = catalog
                    .execute(
                        Arc::new(PanicEnv::default()),
                        &granted,
                        name,
                        serde_json::json!({}),
                    )
                    .await
                    .unwrap_err();
                assert!(
                    matches!(error, AgentToolError::ScopeDenied { .. }),
                    "{name}: {error}"
                );
            }
        }
    }

    #[test]
    fn mcp_catalog_includes_commit_and_import_tools() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let names: Vec<&str> = catalog.iter().map(|tool| tool.name()).collect();
        assert!(names.contains(&"commit_activity_draft"));
        assert!(names.contains(&"commit_activity_drafts"));
        assert!(names.contains(&"commit_asset_classification_draft"));
        assert!(names.contains(&"commit_categorization_rule"));
        assert!(names.contains(&"commit_transaction_categories"));
        assert!(names.contains(&"list_categorization_rules"));
        assert!(names.contains(&"rerun_categorization_rules"));
        assert!(names.contains(&"get_import_mapping"));
        assert!(names.contains(&"prepare_activity_import"));
        assert!(names.contains(&"commit_activity_import"));
        assert!(names.contains(&"find_transfer_matches"));
        assert!(names.contains(&"link_transfer_activities"));
        assert!(names.contains(&"unlink_transfer_activities"));
        assert!(names.contains(&"prepare_quote_import"));
        assert!(names.contains(&"commit_quote_import"));
        assert!(names.contains(&"prepare_activity_updates"));
        assert!(names.contains(&"commit_activity_updates"));
        assert!(names.contains(&"prepare_activity_deletions"));
        assert!(names.contains(&"commit_activity_deletions"));
        // The shared v1 read catalog stays unchanged; category management is MCP-only.
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
            "commit_transaction_categories",
            "list_categorization_rules",
            "rerun_categorization_rules",
            "find_transfer_matches",
            "link_transfer_activities",
            "unlink_transfer_activities",
            "prepare_quote_import",
            "commit_quote_import",
            "prepare_activity_updates",
            "commit_activity_updates",
            "prepare_activity_deletions",
            "commit_activity_deletions",
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
    async fn category_commit_requires_spending_read_and_write() {
        let catalog = AgentToolCatalog::mcp_catalog();
        for scopes in [
            vec!["classification:read"],
            vec!["classification:suggest"],
            vec!["classification:write"],
            vec!["spending:read"],
            vec!["spending:write"],
            vec!["spending:read", "budget:write"],
        ] {
            let error = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &AgentScopeSet::from_strs(scopes),
                    "commit_transaction_categories",
                    serde_json::json!({"assignments": []}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::ScopeDenied { .. }),
                "{error}"
            );
        }
    }

    #[tokio::test]
    async fn rule_tools_reject_legacy_classification_scopes() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let cases = [
            ("list_categorization_rules", vec!["classification:suggest"]),
            ("list_categorization_rules", vec!["classification:write"]),
            ("rerun_categorization_rules", vec!["classification:read"]),
            ("rerun_categorization_rules", vec!["classification:suggest"]),
            ("rerun_categorization_rules", vec!["classification:write"]),
        ];
        for (name, scopes) in cases {
            let error = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &AgentScopeSet::from_strs(scopes.clone()),
                    name,
                    serde_json::json!({}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::ScopeDenied { .. }),
                "{name} with {scopes:?}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn spending_and_investment_permissions_are_isolated() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let spending =
            AgentScopeSet::from_strs(["spending:read", "spending:write", "budget:write"]);
        for name in [
            "search_activities",
            "get_holdings",
            "prepare_asset_classification",
            "commit_activity_draft",
        ] {
            let tool = catalog.get(name).expect("published tool");
            assert!(!spending.grants_all(tool.required_scopes()), "{name}");
            let error = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &spending,
                    name,
                    serde_json::json!({}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::ScopeDenied { .. }),
                "{name}: {error}"
            );
        }
        let legacy = AgentScopeSet::from_strs([
            "activities:read",
            "classification:read",
            "classification:suggest",
            "classification:write",
        ]);
        for name in [
            "get_spending_context",
            "get_budget",
            "list_spending_events",
            "search_spending_transactions",
            "list_transaction_categories",
            "list_categorization_context",
            "propose_transaction_categories",
            "create_categorization_rule",
            "commit_transaction_categories",
            "commit_categorization_rule",
            "list_categorization_rules",
            "rerun_categorization_rules",
        ] {
            let tool = catalog.get(name).expect("published spending tool");
            assert!(spending.grants_all(tool.required_scopes()), "{name}");
            let error = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &legacy,
                    name,
                    serde_json::json!({}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::ScopeDenied { .. }),
                "{name}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn rerun_runs_rules_over_the_spending_accounts() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let writable = AgentScopeSet::from_strs(["spending:read", "spending:write"]);
        let rules = Arc::new(TestRuleService::default());
        let env = Arc::new(PanicEnv {
            rules: Some(rules.clone()),
            cash: Some(Arc::new(TestCashService {
                spending_account_ids: vec!["acct-1".to_string(), "acct-2".to_string()],
            })),
        });

        let result = catalog
            .execute(
                env.clone(),
                &writable,
                "rerun_categorization_rules",
                serde_json::json!({}),
            )
            .await
            .unwrap();
        assert_eq!(
            result.content,
            serde_json::json!({ "onlyUncategorized": true, "accounts": 2, "matched": 4, "eligible":0,"changed":0,"protectedSplits":0,"protectedManual":0,"skippedExisting":0,"unchanged":0,"incompatible":0,"withoutTarget":0 })
        );
        catalog
            .execute(
                env,
                &writable,
                "rerun_categorization_rules",
                serde_json::json!({ "onlyUncategorized": false }),
            )
            .await
            .unwrap();
        let accounts = vec!["acct-1".to_string(), "acct-2".to_string()];
        assert_eq!(
            *rules.reruns.lock().unwrap(),
            [(accounts.clone(), true), (accounts, false)]
        );
    }

    /// Generated duplicate pairs must be rejected before any service access,
    /// regardless of category, batch position, Unicode or delimiter-containing IDs.
    #[tokio::test]
    async fn category_commit_rejects_generated_duplicate_pairs_before_service_access() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let scopes = AgentScopeSet::from_strs(["spending:read", "spending:write"]);
        let mut seed = 0x6a09_e667_f3bc_c909_u64;
        for _ in 0..256 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let count = 2 + (seed as usize % 99);
            let mut assignments: Vec<_> = (0..count)
                .map(|index| {
                    let ch = char::from_u32((seed.wrapping_add(index as u64) % 0x110000) as u32)
                        .unwrap_or('\0');
                    serde_json::json!({
                        "activityId": format!("{index}:{ch}:{seed}"),
                        "taxonomyId": format!("{ch}:taxonomy:{seed}"),
                        "categoryId": format!("category:{index}")
                    })
                })
                .collect();
            let original = seed as usize % count;
            let duplicate = (original + 1 + (seed >> 32) as usize % (count - 1)) % count;
            assignments[duplicate]["activityId"] = assignments[original]["activityId"].clone();
            assignments[duplicate]["taxonomyId"] = assignments[original]["taxonomyId"].clone();
            let error = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &scopes,
                    "commit_transaction_categories",
                    serde_json::json!({"assignments": assignments}),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::InvalidInput(_)),
                "seed {seed}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn categorization_rule_commit_requires_write_scope_and_saves_reviewed_rule() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let rules = Arc::new(TestRuleService::default());
        let env = Arc::new(PanicEnv {
            rules: Some(rules.clone()),
            ..Default::default()
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

        let suggest_only = AgentScopeSet::from_strs(["spending:read"]);
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

        let writable = AgentScopeSet::from_strs(["spending:read", "spending:write"]);
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
    async fn quote_import_needs_holdings_read_and_market_data_write() {
        // Each set lacks one of the two scopes; PanicEnv proves the denial
        // happens before any service is reached.
        let catalog = AgentToolCatalog::mcp_catalog();
        let args = serde_json::json!({ "quotes": [{
            "assetId": "a", "date": "2026-06-30", "price": 10, "currency": "EUR"
        }] });
        for granted in [
            AgentScopeSet::read_activity_write_classification_suggest(),
            AgentScopeSet::from_strs(["market-data:write"]),
        ] {
            for name in ["prepare_quote_import", "commit_quote_import"] {
                let err = catalog
                    .execute(Arc::new(PanicEnv::default()), &granted, name, args.clone())
                    .await
                    .unwrap_err();
                assert!(
                    matches!(err, AgentToolError::ScopeDenied { .. }),
                    "tool {name} should be scope-denied for {granted:?}, got: {err}"
                );
            }
        }
    }

    #[tokio::test]
    async fn quote_import_rejects_oversized_batch_before_touching_env() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let granted = AgentScopeSet::from_strs(["holdings:read", "market-data:write"]);
        let quotes: Vec<_> = (0..256)
            .map(|_| {
                serde_json::json!({
                    "assetId": "a", "date": "2026-06-30", "price": 10, "currency": "EUR"
                })
            })
            .collect();
        for name in ["prepare_quote_import", "commit_quote_import"] {
            let err = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &granted,
                    name,
                    serde_json::json!({ "quotes": quotes }),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, AgentToolError::InvalidInput(_)),
                "{name}: oversized batch should be rejected with InvalidInput, got: {err}"
            );
        }
    }

    #[tokio::test]
    async fn activity_update_tools_need_their_scopes() {
        let catalog = AgentToolCatalog::mcp_catalog();
        // Rejected while parsing, so no service is reached (PanicEnv).
        let args = serde_json::json!({ "updates": [{ "activityId": "a", "symbol": "BTC" }] });
        let cases = [
            ("prepare_activity_updates", vec!["activities:read"], false),
            ("prepare_activity_updates", vec!["activities:draft"], false),
            (
                "prepare_activity_updates",
                vec!["activities:read", "activities:draft"],
                true,
            ),
            (
                "commit_activity_updates",
                vec!["activities:read", "activities:draft"],
                false,
            ),
            (
                "commit_activity_updates",
                vec!["activities:draft", "activities:write"],
                false,
            ),
            (
                "commit_activity_updates",
                vec!["activities:read", "activities:draft", "activities:write"],
                true,
            ),
        ];
        // An empty id list is refused before any service is reached.
        let deletion_cases = [
            ("prepare_activity_deletions", vec!["activities:read"], false),
            (
                "prepare_activity_deletions",
                vec!["activities:draft"],
                false,
            ),
            (
                "prepare_activity_deletions",
                vec!["activities:read", "activities:draft"],
                true,
            ),
            (
                "commit_activity_deletions",
                vec!["activities:read", "activities:draft"],
                false,
            ),
            (
                "commit_activity_deletions",
                vec!["activities:read", "activities:draft", "activities:write"],
                true,
            ),
        ];
        let deletion_args = serde_json::json!({ "activityIds": [] });
        let all_cases = cases
            .into_iter()
            .map(|(name, scopes, allowed)| (name, scopes, allowed, &args))
            .chain(
                deletion_cases
                    .into_iter()
                    .map(|(name, scopes, allowed)| (name, scopes, allowed, &deletion_args)),
            );
        for (name, scopes, allowed, args) in all_cases {
            let result = catalog
                .execute(
                    Arc::new(PanicEnv::default()),
                    &AgentScopeSet::from_strs(scopes.clone()),
                    name,
                    args.clone(),
                )
                .await;
            assert_eq!(
                !matches!(result, Err(AgentToolError::ScopeDenied { .. })),
                allowed,
                "{name} with {scopes:?}"
            );
        }
    }

    #[tokio::test]
    async fn activity_updates_refuse_symbols_and_bad_batches_before_touching_env() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let granted =
            AgentScopeSet::from_strs(["activities:read", "activities:draft", "activities:write"]);
        let rows = serde_json::json!({ "updates": [
            { "activityId": "a", "symbol": "BTC" },
            { "activityId": "b", "assetId": "x", "ticker": "BTC" },
            { "activityId": "c", "unitprice": 1 }
        ]});
        let preview = catalog
            .execute(
                Arc::new(PanicEnv::default()),
                &granted,
                "prepare_activity_updates",
                rows.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            preview.content["summary"]["invalid"], 3,
            "{}",
            preview.content
        );
        let committed = catalog
            .execute(
                Arc::new(PanicEnv::default()),
                &granted,
                "commit_activity_updates",
                rows,
            )
            .await
            .unwrap();
        assert_eq!(committed.content["updated"], serde_json::json!([]));
        assert_eq!(committed.content["errors"].as_array().unwrap().len(), 3);

        let oversized: Vec<_> = (0..101)
            .map(|index| serde_json::json!({ "activityId": format!("a{index}"), "fee": 1 }))
            .collect();
        let err = catalog
            .execute(
                Arc::new(PanicEnv::default()),
                &granted,
                "commit_activity_updates",
                serde_json::json!({ "updates": oversized }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AgentToolError::InvalidInput(_)), "{err}");
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
    #[tokio::test]
    async fn every_spending_write_respects_the_independent_budget_boundary() {
        let catalog = AgentToolCatalog::mcp_catalog();
        for tool in catalog.iter() {
            let denied = if tool
                .required_scopes()
                .contains(&crate::AgentScope::SpendingWrite)
            {
                Some(AgentScopeSet::from_strs(["spending:read", "budget:write"]))
            } else if tool
                .required_scopes()
                .contains(&crate::AgentScope::BudgetWrite)
            {
                Some(AgentScopeSet::from_strs([
                    "spending:read",
                    "spending:write",
                ]))
            } else {
                None
            };
            if let Some(scopes) = denied {
                let error = catalog
                    .execute(
                        Arc::new(PanicEnv::default()),
                        &scopes,
                        tool.name(),
                        serde_json::json!({}),
                    )
                    .await
                    .unwrap_err();
                assert!(
                    matches!(error, AgentToolError::ScopeDenied { .. }),
                    "{}: {error}",
                    tool.name()
                );
            }
        }
    }

    #[tokio::test]
    async fn malformed_spending_changes_are_data_free_and_never_treat_omission_as_deletion() {
        let catalog = AgentToolCatalog::mcp_catalog();
        let scopes = AgentScopeSet::from_strs(["spending:read", "spending:write", "budget:write"]);
        for name in [
            "prepare_budget_change",
            "commit_budget_change",
            "prepare_spending_event",
            "commit_spending_event",
            "prepare_spending_event_tag",
            "commit_spending_event_tag",
            "prepare_spending_splits",
            "commit_spending_splits",
            "prepare_transaction_category_change",
            "commit_transaction_category_change",
            "prepare_categorization_rule_change",
            "commit_categorization_rule_change",
            "prepare_categorization_preset",
            "commit_categorization_preset",
            "prepare_spending_import_metadata",
        ] {
            let input = serde_json::json!({"confidential_unknown":"private amount and notes"});
            let tool = catalog.get(name).expect("registered workflow");
            assert!(
                !tool
                    .sanitize_args_for_audit(&input)
                    .to_string()
                    .contains("private"),
                "{name}"
            );
            let error = catalog
                .execute(Arc::new(PanicEnv::default()), &scopes, name, input)
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::InvalidInput(_)),
                "{name}: {error}"
            );
            assert!(
                !error.to_string().contains("confidential")
                    && !error.to_string().contains("private"),
                "{name}: {error}"
            );
        }
        for (name, input) in [
            (
                "prepare_categorization_rule_change",
                serde_json::json!({"ruleId":"r"}),
            ),
            ("prepare_spending_event", serde_json::json!({"eventId":"e"})),
            (
                "prepare_spending_event_tag",
                serde_json::json!({"activityId":"a"}),
            ),
            (
                "commit_spending_event_tag",
                serde_json::json!({"activityId":"a","eventId":null}),
            ),
        ] {
            let error = catalog
                .execute(Arc::new(PanicEnv::default()), &scopes, name, input)
                .await
                .unwrap_err();
            assert!(
                matches!(error, AgentToolError::InvalidInput(_)),
                "{name}: {error}"
            );
        }
    }
}
