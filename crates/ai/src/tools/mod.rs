//! AI assistant tools for portfolio data access.
//!
//! This module provides tools that implement rig-core's Tool trait:
//! - GetAccountsTool: Fetch active investment accounts
//! - GetHoldingsTool: Fetch portfolio holdings
//! - GetAssetAllocationTool: Calculate portfolio allocation by category
//! - GetPerformanceTool: Fetch portfolio performance metrics
//! - GetValuationHistoryTool: Fetch portfolio valuation history
//! - SearchActivitiesTool: Search transactions
//! - GetIncomeTool: Fetch income summaries (dividends, interest, other income)
//! - GetGoalsTool: Fetch investment goals with progress
//! - RecordActivityTool: Create activity drafts from natural language
//! - RecordActivitiesTool: Create multiple activity drafts from natural language
//!
//! All tools are designed to work with the AiEnvironment trait for dependency injection.

pub mod accounts;
pub mod activities;
pub mod allocation;
pub mod cash_balances;
pub mod constants;
pub mod create_categorization_rule;
pub mod goals;
pub mod health;
pub mod holdings;
pub mod import_csv;
pub mod income;
pub mod list_categorization_context;
pub mod performance;
pub mod propose_categories;
pub mod record_activities;
pub mod record_activity;
pub mod valuation;

// Re-export constants
pub use constants::*;

// Re-export tools
pub use accounts::GetAccountsTool;
pub use activities::SearchActivitiesTool;
pub use allocation::GetAssetAllocationTool;
pub use cash_balances::GetCashBalancesTool;
pub use create_categorization_rule::CreateCategorizationRuleTool;
pub use goals::GetGoalsTool;
pub use health::GetHealthStatusTool;
pub use holdings::GetHoldingsTool;
pub use import_csv::ImportCsvTool;
pub use income::GetIncomeTool;
pub use list_categorization_context::ListCategorizationContextTool;
pub use performance::GetPerformanceTool;
pub use propose_categories::{
    AiProposal, CategoryExample, CategoryOption, Proposal, ProposeCategoriesTool, TaxonomySummary,
    UnproposedActivity,
};
pub use record_activities::RecordActivitiesTool;
pub use record_activity::RecordActivityTool;
pub use valuation::GetValuationHistoryTool;

use std::sync::Arc;

use crate::env::AiEnvironment;

/// Container for all AI tools, simplifying tool registration across providers.
pub struct ToolSet<E: AiEnvironment> {
    pub holdings: GetHoldingsTool<E>,
    pub allocation: GetAssetAllocationTool<E>,
    pub accounts: GetAccountsTool<E>,
    pub cash_balances: GetCashBalancesTool<E>,
    pub activities: SearchActivitiesTool<E>,
    pub income: GetIncomeTool<E>,
    pub valuation: GetValuationHistoryTool<E>,
    pub goals: GetGoalsTool<E>,
    pub performance: GetPerformanceTool<E>,
    pub record_activity: RecordActivityTool<E>,
    pub record_activities: RecordActivitiesTool<E>,
    pub import_csv: ImportCsvTool<E>,
    pub health_status: GetHealthStatusTool<E>,
    pub propose_categories: ProposeCategoriesTool<E>,
    pub list_categorization_context: ListCategorizationContextTool<E>,
    pub create_categorization_rule: CreateCategorizationRuleTool<E>,
}

impl<E: AiEnvironment> ToolSet<E> {
    /// Create a new tool set with all portfolio tools.
    pub fn new(env: Arc<E>, base_currency: String) -> Self {
        Self {
            holdings: GetHoldingsTool::new(env.clone(), base_currency.clone()),
            allocation: GetAssetAllocationTool::new(env.clone(), base_currency.clone()),
            accounts: GetAccountsTool::new(env.clone()),
            cash_balances: GetCashBalancesTool::new(env.clone(), base_currency.clone()),
            activities: SearchActivitiesTool::new(env.clone()),
            income: GetIncomeTool::new(env.clone()),
            valuation: GetValuationHistoryTool::new(env.clone(), base_currency.clone()),
            goals: GetGoalsTool::new(env.clone()),
            performance: GetPerformanceTool::new(env.clone(), base_currency.clone()),
            record_activity: RecordActivityTool::new(env.clone()),
            record_activities: RecordActivitiesTool::new(env.clone()),
            import_csv: ImportCsvTool::new(env.clone(), base_currency),
            health_status: GetHealthStatusTool::new(env.clone()),
            propose_categories: ProposeCategoriesTool::new(env.clone()),
            list_categorization_context: ListCategorizationContextTool::new(env.clone()),
            create_categorization_rule: CreateCategorizationRuleTool::new(env),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::test_env::MockEnvironment;
    use rig::tool::Tool;

    #[test]
    fn test_tool_set_creation() {
        let env = Arc::new(MockEnvironment::new());
        let _tools = ToolSet::new(env, "USD".to_string());
    }

    /// Each tool's NAME constant must match what the system prompt + frontend
    /// allowlist + chat.rs allowlist branch use. Drift here means the tool is
    /// registered but never enabled. Catches typos at compile/test time.
    #[test]
    fn tool_names_are_exactly_the_strings_used_by_allowlist() {
        use crate::types::DEFAULT_TOOLS_ALLOWLIST;
        let env = Arc::new(MockEnvironment::new());
        let tools = ToolSet::new(env, "USD".to_string());

        // Every tool's NAME must be in DEFAULT_TOOLS_ALLOWLIST. The reverse is
        // checked separately (some allowlist entries are read-only data tools
        // that aren't in ToolSet's ergonomic field list, which is fine).
        let registered_names = vec![
            <GetHoldingsTool<MockEnvironment> as Tool>::NAME,
            <GetAssetAllocationTool<MockEnvironment> as Tool>::NAME,
            <GetAccountsTool<MockEnvironment> as Tool>::NAME,
            <GetCashBalancesTool<MockEnvironment> as Tool>::NAME,
            <SearchActivitiesTool<MockEnvironment> as Tool>::NAME,
            <GetIncomeTool<MockEnvironment> as Tool>::NAME,
            <GetValuationHistoryTool<MockEnvironment> as Tool>::NAME,
            <GetGoalsTool<MockEnvironment> as Tool>::NAME,
            <GetPerformanceTool<MockEnvironment> as Tool>::NAME,
            <RecordActivityTool<MockEnvironment> as Tool>::NAME,
            <RecordActivitiesTool<MockEnvironment> as Tool>::NAME,
            <ImportCsvTool<MockEnvironment> as Tool>::NAME,
            <GetHealthStatusTool<MockEnvironment> as Tool>::NAME,
            <ProposeCategoriesTool<MockEnvironment> as Tool>::NAME,
            <ListCategorizationContextTool<MockEnvironment> as Tool>::NAME,
            <CreateCategorizationRuleTool<MockEnvironment> as Tool>::NAME,
        ];
        for name in &registered_names {
            assert!(
                DEFAULT_TOOLS_ALLOWLIST.contains(name),
                "Tool {name} is registered in ToolSet but missing from DEFAULT_TOOLS_ALLOWLIST — \
                 add it or it'll never be enabled by default. Drift between tool NAME and \
                 allowlist is the most common cause of 'I added a tool and the agent ignores it'.",
            );
        }
        let _ = tools;
    }
}
