//! Tool implementations.
//!
//! Tools migrate here from `wealthfolio-ai` one at a time; each keeps its
//! existing name, schema, and output shape (guarded by the parity
//! snapshots in `crates/ai/tests/`).

pub mod accounts;
pub mod activities;
pub mod activity_import;
pub mod allocation;
pub mod asset_classification;
pub mod asset_taxonomies;
pub mod cash_balances;
pub mod categorization_context;
pub mod commit_activity;
pub mod commit_asset_classification;
pub mod contribution_limits;
pub mod create_categorization_rule;
pub mod goals;
pub mod health;
pub mod holdings;
pub mod income;
pub mod net_worth;
pub mod performance;
pub mod portfolios;
pub mod propose_categories;
pub mod record_activities;
pub mod record_activity;
pub mod valuation;

pub use accounts::{AccountDto, GetAccounts, GetAccountsArgs, GetAccountsOutput};
pub use activities::{ActivityDto, SearchActivities, SearchActivitiesArgs, SearchActivitiesOutput};
// `allocation::HoldingDto` is intentionally not re-exported here: it would
// collide with `holdings::HoldingDto`. Reach it as `allocation::HoldingDto`.
pub use allocation::{
    AllocationDto, GetAssetAllocation, GetAssetAllocationArgs, GetAssetAllocationOutput,
};
pub use asset_taxonomies::{
    AssetTaxonomyAssignmentDto, AssetTaxonomyCategoryDto, AssetTaxonomyDto,
    GetAssetTaxonomyAssignments, GetAssetTaxonomyAssignmentsArgs,
    GetAssetTaxonomyAssignmentsOutput, ListAssetTaxonomies, ListAssetTaxonomiesArgs,
    ListAssetTaxonomiesOutput, ResolvedAssetDto,
};
pub use cash_balances::{
    AccountCashSummary, CashBalanceEntry, GetCashBalances, GetCashBalancesArgs,
    GetCashBalancesOutput,
};
pub use categorization_context::{
    CategoryExample, CategoryOption, ContextSummary, ListCategorizationContext,
    ListCategorizationContextArgs, ListCategorizationContextOutput, Proposal, TaxonomySummary,
    UnproposedActivity,
};
pub use contribution_limits::{
    ContributionLimitDto, GetContributionLimits, GetContributionLimitsArgs,
    GetContributionLimitsOutput,
};
pub use goals::{GetGoals, GetGoalsArgs, GetGoalsOutput, GoalDto};
pub use health::{GetHealthStatus, GetHealthStatusArgs, GetHealthStatusOutput, HealthIssueDto};
pub use holdings::{GetHoldings, GetHoldingsArgs, GetHoldingsOutput, HoldingDto};
pub use income::{GetIncome, GetIncomeArgs, GetIncomeOutput, TopAssetDto};
pub use net_worth::{
    GetNetWorth, GetNetWorthArgs, GetNetWorthOutput, NetWorthHistoryPointDto, NetWorthLineDto,
};
pub use performance::{
    GetPerformance, GetPerformanceArgs, GetPerformanceOutput, PerformanceAttributionOutput,
    PerformanceDataQualityOutput, PerformanceReturnsOutput, PerformanceRiskOutput,
};
pub use portfolios::{GetPortfolios, GetPortfoliosArgs, GetPortfoliosOutput, PortfolioDto};
pub use valuation::{
    GetValuationHistory, GetValuationHistoryArgs, GetValuationHistoryOutput, ValuationPointDto,
};

// Draft/suggest tools migrated from `wealthfolio-ai`.
pub use asset_classification::{
    AssignmentPreviewDto, CandidateAssignmentPreviewDto, ClassificationChangesDto,
    PrepareAssetClassification, PrepareAssetClassificationArgs, PrepareAssetClassificationOutput,
    PreparedAssignmentInput, PreparedTaxonomyDto,
};
pub use create_categorization_rule::{
    CreateCategorizationRule, CreateCategorizationRuleArgs, CreateCategorizationRuleOutput,
};
pub use propose_categories::{
    AiProposal, ProposalSummary, ProposeCategories, ProposeCategoriesArgs, ProposeCategoriesOutput,
};
pub use record_activities::{
    ActivityDraftRow, BatchValidationSummary, RecordActivities, RecordActivitiesArgs,
    RecordActivitiesOutput,
};
pub use record_activity::{
    AccountOption, ActivityDraft, RecordActivity, RecordActivityArgs, RecordActivityOutput,
    ResolvedAsset, SubtypeOption, ValidationError, ValidationResult,
};

// MCP-only commit tools.
pub use commit_activity::{
    CommitActivityDraft, CommitActivityDraftOutput, CommitActivityDrafts, CommitActivityDraftsArgs,
    CommitActivityDraftsOutput, CommitError, CommittedActivity,
};
pub use commit_asset_classification::{
    CommitAssetClassificationAssignmentInput, CommitAssetClassificationDraft,
    CommitAssetClassificationDraftArgs, CommitAssetClassificationDraftOutput,
    CommittedAssetClassificationAssignment,
};

// MCP-only CSV import tools (validate + dedup-safe import pipeline).
pub use activity_import::{
    ActivityImportArgs, ActivityImportRow, CommitActivityImport, CommitActivityImportOutput,
    GetImportMapping, GetImportMappingArgs, ImportPreviewSummary, ImportRowResult,
    PrepareActivityImport, PrepareActivityImportOutput,
};

use std::sync::Arc;

use crate::tool::AgentTool;

/// The v1 read-only tool set, in catalog (and LLM-visible) order — the
/// read tools keep their historical relative order, but all of them are
/// now registered before the assistant's write tools (previously the two
/// kinds were interleaved).
pub fn v1_read_tools() -> Vec<Arc<dyn AgentTool>> {
    vec![
        Arc::new(GetHoldings),
        Arc::new(GetAccounts),
        Arc::new(GetCashBalances),
        Arc::new(SearchActivities),
        Arc::new(GetGoals),
        Arc::new(GetValuationHistory),
        Arc::new(GetIncome),
        Arc::new(GetAssetAllocation),
        Arc::new(GetPerformance),
        Arc::new(GetHealthStatus),
        Arc::new(ListCategorizationContext),
        Arc::new(ListAssetTaxonomies),
        Arc::new(GetAssetTaxonomyAssignments),
        Arc::new(GetPortfolios),
        Arc::new(GetNetWorth),
        Arc::new(GetContributionLimits),
    ]
}

/// The draft/suggest tools, in catalog (and LLM-visible) order. These prepare
/// drafts or proposals for user review — they never mutate data themselves.
pub fn draft_suggest_tools() -> Vec<Arc<dyn AgentTool>> {
    vec![
        Arc::new(RecordActivity),
        Arc::new(RecordActivities),
        Arc::new(ProposeCategories),
        Arc::new(CreateCategorizationRule),
        Arc::new(PrepareAssetClassification),
    ]
}

/// The MCP-only commit tools that persist reviewed drafts. Never exposed to the
/// in-app assistant (which writes through its confirmation widget instead).
pub fn commit_tools() -> Vec<Arc<dyn AgentTool>> {
    vec![
        Arc::new(CommitActivityDraft),
        Arc::new(CommitActivityDrafts),
        Arc::new(CommitAssetClassificationDraft),
    ]
}

/// The MCP-only CSV import tools: fetch an account's mapping, preview rows
/// (validate + duplicate detection), and import through the real pipeline.
/// Not exposed to the in-app assistant (which has its own `import_csv` flow).
pub fn import_tools() -> Vec<Arc<dyn AgentTool>> {
    vec![
        Arc::new(GetImportMapping),
        Arc::new(PrepareActivityImport),
        Arc::new(CommitActivityImport),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalog order is LLM-visible (tool listing) and mirrors the
    /// read tools' historical relative order — append-only.
    #[test]
    fn v1_read_tools_names_and_order_are_stable() {
        let names: Vec<&str> = v1_read_tools().iter().map(|tool| tool.name()).collect();
        assert_eq!(
            names,
            vec![
                "get_holdings",
                "get_accounts",
                "get_cash_balances",
                "search_activities",
                "get_goals",
                "get_valuation_history",
                "get_income",
                "get_asset_allocation",
                "get_performance",
                "get_health_status",
                "list_categorization_context",
                "list_asset_taxonomies",
                "get_asset_taxonomy_assignments",
                "get_portfolios",
                "get_net_worth",
                "get_contribution_limits",
            ]
        );
    }
}
