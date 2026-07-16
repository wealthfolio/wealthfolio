//! AI assistant tools for portfolio data access.
//!
//! Read, draft, and suggest tools live in `wealthfolio-agent-tools` (shared
//! with MCP) and are exposed to rig agents through `rig_adapter::RigAgentTool`.
//! The only tool remaining here implements rig-core's Tool trait directly:
//! - ImportCsvTool: Infer CSV column mappings and validate for import
//!
//! It is designed to work with the AiEnvironment trait for dependency injection.

pub mod constants;
pub mod import_csv;
pub mod rig_adapter;

// Re-export constants
pub use constants::*;

// Re-export migrated agent tools (DTOs, arg/output types, and unit structs) for
// compatibility so existing import paths via `crate::tools::` keep resolving.
// `allocation::HoldingDto` is skipped: it collides with `holdings::HoldingDto`
// (reach it as `wealthfolio_agent_tools::tools::allocation::HoldingDto`).
pub use wealthfolio_agent_tools::tools::{
    AccountCashSummary, AccountDto, AccountOption, ActivityDraft, ActivityDraftRow, ActivityDto,
    AiProposal, AllocationDto, AssetTaxonomyAssignmentDto, AssetTaxonomyCategoryDto,
    AssetTaxonomyDto, AssignmentPreviewDto, BatchValidationSummary, CandidateAssignmentPreviewDto,
    CashBalanceEntry, CategoryExample, CategoryOption, ClassificationChangesDto, ContextSummary,
    CreateCategorizationRule, CreateCategorizationRuleArgs, CreateCategorizationRuleOutput,
    GetAccounts, GetAccountsArgs, GetAccountsOutput, GetAssetAllocation, GetAssetAllocationArgs,
    GetAssetAllocationOutput, GetAssetTaxonomyAssignments, GetAssetTaxonomyAssignmentsArgs,
    GetAssetTaxonomyAssignmentsOutput, GetCashBalances, GetCashBalancesArgs, GetCashBalancesOutput,
    GetGoals, GetGoalsArgs, GetGoalsOutput, GetHealthStatus, GetHealthStatusArgs,
    GetHealthStatusOutput, GetHoldings, GetHoldingsArgs, GetHoldingsOutput, GetIncome,
    GetIncomeArgs, GetIncomeOutput, GetPerformance, GetPerformanceArgs, GetPerformanceOutput,
    GetValuationHistory, GetValuationHistoryArgs, GetValuationHistoryOutput, GoalDto,
    HealthIssueDto, HoldingDto, ListAssetTaxonomies, ListAssetTaxonomiesArgs,
    ListAssetTaxonomiesOutput, ListCategorizationContext, ListCategorizationContextArgs,
    ListCategorizationContextOutput, PerformanceAttributionOutput, PerformanceDataQualityOutput,
    PerformanceReturnsOutput, PerformanceRiskOutput, PrepareAssetClassification,
    PrepareAssetClassificationArgs, PrepareAssetClassificationOutput, PreparedAssignmentInput,
    PreparedTaxonomyDto, Proposal, ProposalSummary, ProposeCategories, ProposeCategoriesArgs,
    ProposeCategoriesOutput, RecordActivities, RecordActivitiesArgs, RecordActivitiesOutput,
    RecordActivity, RecordActivityArgs, RecordActivityOutput, ResolvedAsset, ResolvedAssetDto,
    SearchActivities, SearchActivitiesArgs, SearchActivitiesOutput, SubtypeOption, TaxonomySummary,
    TopAssetDto, UnproposedActivity, ValidationError, ValidationResult, ValuationPointDto,
};

// Re-export the assistant-local tool and the rig adapter.
pub use import_csv::ImportCsvTool;
pub use rig_adapter::RigAgentTool;

use once_cell::sync::Lazy;
use std::sync::Arc;
use wealthfolio_agent_tools::AgentToolCatalog;

use crate::env::AiEnvironment;

/// Process-wide catalog of agent tools available to the in-app assistant
/// (read + draft/suggest), shared by every chat session (tools are stateless;
/// the environment arrives per call). Commit tools are MCP-only and excluded.
static AGENT_CATALOG: Lazy<AgentToolCatalog> = Lazy::new(AgentToolCatalog::assistant_catalog);

/// The shared agent-tool catalog exposed to rig via [`RigAgentTool`].
pub fn agent_catalog() -> &'static AgentToolCatalog {
    &AGENT_CATALOG
}

/// Container for the assistant-only rig tools. The migrated read/draft/suggest
/// tools are not listed here; they come from [`agent_catalog`]. Only `import_csv`
/// still implements rig's `Tool` trait directly.
pub struct ToolSet<E: AiEnvironment> {
    pub import_csv: ImportCsvTool<E>,
}

impl<E: AiEnvironment> ToolSet<E> {
    /// Create a new tool set with the assistant-only rig tools.
    pub fn new(env: Arc<E>, base_currency: String) -> Self {
        Self {
            import_csv: ImportCsvTool::new(env, base_currency),
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

        // The assistant-local rig tool (`import_csv`) plus every agent-catalog
        // tool name must be present in DEFAULT_TOOLS_ALLOWLIST.
        assert!(
            DEFAULT_TOOLS_ALLOWLIST.contains(&<ImportCsvTool<MockEnvironment> as Tool>::NAME),
            "import_csv is registered but missing from DEFAULT_TOOLS_ALLOWLIST",
        );
    }

    /// Every catalog tool (read + draft/suggest) must stay in
    /// DEFAULT_TOOLS_ALLOWLIST under its original name — names are the contract
    /// chat threads snapshot.
    #[test]
    fn agent_catalog_names_are_in_default_allowlist() {
        use crate::types::DEFAULT_TOOLS_ALLOWLIST;
        for tool in agent_catalog().iter() {
            assert!(
                DEFAULT_TOOLS_ALLOWLIST.contains(&tool.name()),
                "Catalog tool {} missing from DEFAULT_TOOLS_ALLOWLIST",
                tool.name()
            );
        }
    }
}
