//! Snapshot tests for tool JSON schemas.
//!
//! Every tool's `Tool::definition().parameters` is the contract the LLM
//! sees. If a field rename, type change, or required-field shift happens
//! by accident, every saved chat thread that targets that tool starts
//! producing wrong calls. These snapshots make any such drift impossible
//! to ship silently — `cargo test` fails until the maintainer runs
//! `cargo insta review` and explicitly accepts the new schema.
//!
//! When this test fails:
//! - Run `cargo insta review` (or `cargo insta accept` for batch).
//! - For every accepted change, double-check it's the schema you meant.
//! - Drift in `required` or enum values is the most dangerous — agents'
//!   tool calls hard-fail when the schema changes underneath them.

#![cfg(feature = "test-utils")]

use rig::tool::{Tool, ToolDyn};
use std::sync::Arc;
use wealthfolio_agent_tools::AgentTool;
use wealthfolio_ai::env::test_env::MockEnvironment;
use wealthfolio_ai::tools::{
    CreateCategorizationRule, GetAccounts, GetAssetAllocation, GetAssetTaxonomyAssignments,
    GetCashBalances, GetGoals, GetHealthStatus, GetHoldings, GetIncome, GetPerformance,
    GetValuationHistory, ImportCsvTool, ListAssetTaxonomies, ListCategorizationContext,
    PrepareAssetClassification, ProposeCategories, RecordActivities, RecordActivity, RigAgentTool,
    SearchActivities,
};

fn env() -> Arc<MockEnvironment> {
    Arc::new(MockEnvironment::new())
}

/// Wrap a migrated agent tool the way the assistant sees it (via the rig
/// adapter), so its schema snapshot is captured at the same boundary as
/// before the migration.
fn adapted(tool: impl AgentTool + 'static) -> RigAgentTool {
    RigAgentTool::new(Arc::new(tool), env())
}

/// Capture name + parameters JSON, with `description` fields stripped at
/// every depth.
///
/// We snapshot the *structure* (field names, types, enums, required) not
/// the prose. Descriptions are intentionally allowed to change — phrasing
/// tweaks, typo fixes, and the date-dependent text some tool descriptions
/// embed (e.g. record_activity's `activityDate` includes today's date) all
/// drift legitimately and shouldn't fail CI.
async fn schema_snapshot<T: Tool>(tool: T) -> serde_json::Value {
    let def = tool.definition(String::new()).await;
    let mut params = def.parameters;
    strip_descriptions(&mut params);
    serde_json::json!({
        "name": def.name,
        "parameters": params,
    })
}

/// Same capture for migrated tools, which reach rig as `dyn ToolDyn`
/// through the adapter instead of implementing `Tool` directly.
async fn schema_snapshot_dyn(tool: &dyn ToolDyn) -> serde_json::Value {
    let def = tool.definition(String::new()).await;
    let mut params = def.parameters;
    strip_descriptions(&mut params);
    serde_json::json!({
        "name": def.name,
        "parameters": params,
    })
}

fn strip_descriptions(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("description");
            for v in map.values_mut() {
                strip_descriptions(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                strip_descriptions(v);
            }
        }
        _ => {}
    }
}

macro_rules! schema_test {
    ($test_name:ident, $tool_ctor:expr) => {
        #[tokio::test]
        async fn $test_name() {
            let tool = $tool_ctor;
            let snapshot = schema_snapshot(tool).await;
            insta::assert_json_snapshot!(snapshot);
        }
    };
}

#[tokio::test]
async fn snapshot_propose_transaction_categories() {
    let snapshot = schema_snapshot_dyn(&adapted(ProposeCategories)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_list_categorization_context() {
    let snapshot = schema_snapshot_dyn(&adapted(ListCategorizationContext)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_create_categorization_rule() {
    let snapshot = schema_snapshot_dyn(&adapted(CreateCategorizationRule)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_list_asset_taxonomies() {
    let snapshot = schema_snapshot_dyn(&adapted(ListAssetTaxonomies)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_get_asset_taxonomy_assignments() {
    let snapshot = schema_snapshot_dyn(&adapted(GetAssetTaxonomyAssignments)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_prepare_asset_classification() {
    let snapshot = schema_snapshot_dyn(&adapted(PrepareAssetClassification)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_get_accounts() {
    let snapshot = schema_snapshot_dyn(&adapted(GetAccounts)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_holdings() {
    let snapshot = schema_snapshot_dyn(&adapted(GetHoldings)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_get_asset_allocation() {
    let snapshot = schema_snapshot_dyn(&adapted(GetAssetAllocation)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_cash_balances() {
    let snapshot = schema_snapshot_dyn(&adapted(GetCashBalances)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_search_activities() {
    let snapshot = schema_snapshot_dyn(&adapted(SearchActivities)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_income() {
    let snapshot = schema_snapshot_dyn(&adapted(GetIncome)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_valuation_history() {
    let snapshot = schema_snapshot_dyn(&adapted(GetValuationHistory)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_goals() {
    let snapshot = schema_snapshot_dyn(&adapted(GetGoals)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn snapshot_get_performance() {
    let snapshot = schema_snapshot_dyn(&adapted(GetPerformance)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_record_activity() {
    let snapshot = schema_snapshot_dyn(&adapted(RecordActivity)).await;
    insta::assert_json_snapshot!(snapshot);
}
#[tokio::test]
async fn snapshot_record_activities() {
    let snapshot = schema_snapshot_dyn(&adapted(RecordActivities)).await;
    insta::assert_json_snapshot!(snapshot);
}
schema_test!(snapshot_import_csv, ImportCsvTool::new(env(), "USD".into()));

#[tokio::test]
async fn snapshot_get_health_status() {
    let snapshot = schema_snapshot_dyn(&adapted(GetHealthStatus)).await;
    insta::assert_json_snapshot!(snapshot);
}

#[tokio::test]
async fn categorization_tool_descriptions_require_widget_for_deterministic_matches() {
    let list_tool = adapted(ListCategorizationContext);
    let list_def = list_tool.definition(String::new()).await;
    let propose_tool = adapted(ProposeCategories);
    let propose_def = propose_tool.definition(String::new()).await;

    assert!(list_def.description.contains("summary.total > 0"));
    assert!(list_def.description.contains("aiProposals: []"));
    assert!(list_def.description.contains("NOT applied"));
    assert!(propose_def.description.contains("needsAiJudgement"));
    assert!(propose_def.description.contains("aiProposals: []"));
    assert!(propose_def.description.contains("review widget"));
}
