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

use rig::tool::Tool;
use std::sync::Arc;
use wealthfolio_ai::env::test_env::MockEnvironment;
use wealthfolio_ai::tools::{
    CreateCategorizationRuleTool, GetAccountsTool, GetAssetAllocationTool, GetCashBalancesTool,
    GetGoalsTool, GetHealthStatusTool, GetHoldingsTool, GetIncomeTool, GetPerformanceTool,
    GetValuationHistoryTool, ImportCsvTool, ListCategorizationContextTool, ProposeCategoriesTool,
    RecordActivitiesTool, RecordActivityTool, SearchActivitiesTool,
};

fn env() -> Arc<MockEnvironment> {
    Arc::new(MockEnvironment::new())
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

schema_test!(
    snapshot_propose_transaction_categories,
    ProposeCategoriesTool::new(env())
);
schema_test!(
    snapshot_list_categorization_context,
    ListCategorizationContextTool::new(env())
);
schema_test!(
    snapshot_create_categorization_rule,
    CreateCategorizationRuleTool::new(env())
);
schema_test!(snapshot_get_accounts, GetAccountsTool::new(env()));
schema_test!(
    snapshot_get_holdings,
    GetHoldingsTool::new(env(), "USD".into())
);
schema_test!(
    snapshot_get_asset_allocation,
    GetAssetAllocationTool::new(env(), "USD".into())
);
schema_test!(
    snapshot_get_cash_balances,
    GetCashBalancesTool::new(env(), "USD".into())
);
schema_test!(snapshot_search_activities, SearchActivitiesTool::new(env()));
schema_test!(snapshot_get_income, GetIncomeTool::new(env()));
schema_test!(
    snapshot_get_valuation_history,
    GetValuationHistoryTool::new(env(), "USD".into())
);
schema_test!(snapshot_get_goals, GetGoalsTool::new(env()));
schema_test!(
    snapshot_get_performance,
    GetPerformanceTool::new(env(), "USD".into())
);
schema_test!(snapshot_record_activity, RecordActivityTool::new(env()));
schema_test!(snapshot_record_activities, RecordActivitiesTool::new(env()));
schema_test!(snapshot_import_csv, ImportCsvTool::new(env(), "USD".into()));
schema_test!(snapshot_get_health_status, GetHealthStatusTool::new(env()));
