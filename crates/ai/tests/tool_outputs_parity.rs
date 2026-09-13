//! Output parity snapshots for the read-tool catalog.
//!
//! These snapshots pin the exact JSON each read tool returns for fixed
//! fixture inputs. They exist to prove the agent-tools extraction
//! (`crates/agent-tools`) is behavior-preserving: captured BEFORE the
//! migration against the rig `Tool` impls, they must pass UNCHANGED
//! afterwards when the same tools run through the `AgentTool` adapter.
//!
//! Companion to `tool_schemas.rs` (which pins the input schemas). If one
//! of these fails during the migration, the migration changed observable
//! tool behavior — fix the migration, do not accept the snapshot.

#![cfg(feature = "test-utils")]

use chrono::{DateTime, NaiveDate, Utc};

use rust_decimal::Decimal;
use std::sync::Arc;
use wealthfolio_agent_tools::AgentTool;
use wealthfolio_ai::env::test_env::{
    MockAccountService, MockAssetService, MockCashActivityService, MockEnvironment,
    MockTaxonomyService,
};
use wealthfolio_ai::tools::{
    GetAccounts, GetAssetAllocation, GetAssetTaxonomyAssignments, GetCashBalances, GetGoals,
    GetHealthStatus, GetHoldings, GetIncome, GetPerformance, GetValuationHistory,
    ListAssetTaxonomies, ListCategorizationContext, PrepareAssetClassification, RecordActivities,
    RecordActivity, RigAgentTool, SearchActivities,
};
use wealthfolio_core::accounts::{Account, TrackingMode};
use wealthfolio_core::activities::{Activity, ActivityStatus};
use wealthfolio_core::assets::{Asset, AssetKind, InstrumentType, QuoteMode};
use wealthfolio_core::taxonomies::{
    AssetTaxonomyAssignment, Category, Taxonomy, TaxonomyWithCategories,
};
use wealthfolio_spending::cash_activities::model::CashFlowBucket;
use wealthfolio_spending::cash_activities::CashActivity;

fn fixture_account(id: &str, name: &str, account_type: &str, currency: &str) -> Account {
    let ts = NaiveDate::from_ymd_opt(2024, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    Account {
        id: id.to_string(),
        name: name.to_string(),
        account_type: account_type.to_string(),
        group: None,
        currency: currency.to_string(),
        is_default: false,
        is_active: true,
        created_at: ts,
        updated_at: ts,
        platform_id: None,
        account_number: None,
        meta: None,
        provider: None,
        provider_account_id: None,
        is_archived: false,
        tracking_mode: TrackingMode::Transactions,
    }
}

/// Mock environment with two seeded accounts; everything else default.
fn env() -> Arc<MockEnvironment> {
    let mut env = MockEnvironment::new();
    env.account_service = Arc::new(MockAccountService {
        accounts: vec![
            fixture_account("acc-1", "Brokerage", "SECURITIES", "USD"),
            fixture_account("acc-2", "Savings", "CASH", "EUR"),
        ],
    });
    Arc::new(env)
}

/// Call a migrated tool exactly as a rig agent would — through the
/// `RigAgentTool` adapter, with parsed JSON arguments —
/// normalized to the same `{"ok"|"err"}` shape as `call_json`.
async fn call_json_dyn(
    tool: impl AgentTool + 'static,
    env: Arc<MockEnvironment>,
    args: serde_json::Value,
) -> serde_json::Value {
    let direct = tool
        .call(env.clone(), args.clone())
        .await
        .map(|result| result.content)
        .map_err(|error| error.to_string());
    let adapter = RigAgentTool::new(Arc::new(tool), env);
    let adapted = adapter.call(args).await;
    assert_eq!(
        adapted.as_ref().map_err(ToString::to_string),
        direct.as_ref().map_err(Clone::clone),
        "Rig adapter must preserve the catalog result"
    );
    match adapted {
        Ok(output) => serde_json::json!({
            "ok": output
        }),
        Err(e) => {
            let msg = e.to_string();
            serde_json::json!({ "err": msg })
        }
    }
}

macro_rules! output_test_dyn {
    ($test_name:ident, $tool:expr, $args:tt) => {
        #[tokio::test]
        async fn $test_name() {
            let result = call_json_dyn($tool, env(), serde_json::json!($args)).await;
            insta::assert_json_snapshot!(result);
        }
    };
}

/// Like `output_test_dyn!` but with an explicit (seeded) environment.
macro_rules! output_test_dyn_env {
    ($test_name:ident, $tool:expr, $env:expr, $args:tt) => {
        #[tokio::test]
        async fn $test_name() {
            let result = call_json_dyn($tool, $env, serde_json::json!($args)).await;
            insta::assert_json_snapshot!(result);
        }
    };
}

output_test_dyn!(output_get_accounts, GetAccounts, {});
output_test_dyn!(
    output_get_accounts_compact,
    GetAccounts,
    { "displayMode": "compact" }
);
output_test_dyn!(output_get_cash_balances, GetCashBalances, {});
output_test_dyn!(output_get_holdings, GetHoldings, {});
output_test_dyn!(
    output_get_holdings_scoped,
    GetHoldings,
    { "accountId": "acc-1", "viewMode": "table" }
);
output_test_dyn!(output_get_asset_allocation, GetAssetAllocation, {});
output_test_dyn!(
    output_get_asset_allocation_by_sector,
    GetAssetAllocation,
    { "groupBy": "sector" }
);
output_test_dyn!(
    output_get_asset_allocation_by_region,
    GetAssetAllocation,
    { "groupBy": "region" }
);
output_test_dyn!(
    output_get_asset_allocation_by_risk,
    GetAssetAllocation,
    { "groupBy": "risk" }
);
output_test_dyn!(
    output_get_asset_allocation_invalid_group_by,
    GetAssetAllocation,
    { "groupBy": "invalid" }
);
output_test_dyn!(
    output_get_asset_allocation_drill_down,
    GetAssetAllocation,
    { "groupBy": "sector", "taxonomyId": "industries_gics", "categoryId": "TECHNOLOGY" }
);
output_test_dyn!(
    output_get_performance,
    GetPerformance,
    { "period": "1Y" }
);
output_test_dyn!(
    output_get_performance_scoped,
    GetPerformance,
    { "accountId": "acc-1", "period": "1M" }
);
output_test_dyn!(
    output_get_valuation_history,
    GetValuationHistory,
    { "startDate": "2024-01-01", "endDate": "2024-03-01" }
);
output_test_dyn!(
    output_get_valuation_history_scoped,
    GetValuationHistory,
    { "accountId": "acc-1", "startDate": "2024-01-01", "endDate": "2024-12-31" }
);
output_test_dyn!(
    output_search_activities,
    SearchActivities,
    { "dateFrom": "2024-01-01", "dateTo": "2024-12-31" }
);
output_test_dyn!(
    output_search_activities_filtered,
    SearchActivities,
    { "activityType": "DIVIDEND", "dateFrom": "2024-01-01", "pageSize": 25 }
);
output_test_dyn!(
    output_search_activities_invalid_date,
    SearchActivities,
    { "dateFrom": "2024-13-01" }
);
output_test_dyn!(output_get_income, GetIncome, { "period": "ALL" });
output_test_dyn!(output_get_income_default, GetIncome, {});
output_test_dyn!(output_get_goals, GetGoals, {});
output_test_dyn!(output_get_health_status, GetHealthStatus, {});
output_test_dyn!(output_list_asset_taxonomies, ListAssetTaxonomies, {});
output_test_dyn!(
    output_get_asset_taxonomy_assignments,
    GetAssetTaxonomyAssignments,
    { "assetQuery": "AAPL" }
);
output_test_dyn!(
    output_list_categorization_context,
    ListCategorizationContext,
    {}
);

// ---------------------------------------------------------------------------
// Classification fixtures (seeded envs) — pin the asset-resolution and
// taxonomy-filtering behaviors that used to be covered by inline unit tests
// in `crates/ai/src/tools/asset_classification.rs`.
// ---------------------------------------------------------------------------

fn fixture_ts() -> chrono::NaiveDateTime {
    NaiveDate::from_ymd_opt(2024, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
}

fn fixture_asset(
    id: &str,
    display_code: &str,
    symbol: &str,
    exchange_mic: Option<&str>,
    name: &str,
    is_active: bool,
) -> Asset {
    Asset {
        id: id.to_string(),
        kind: AssetKind::Investment,
        name: Some(name.to_string()),
        display_code: Some(display_code.to_string()),
        is_active,
        quote_mode: QuoteMode::Market,
        quote_ccy: "USD".to_string(),
        instrument_type: Some(InstrumentType::Equity),
        instrument_symbol: Some(symbol.to_string()),
        instrument_exchange_mic: exchange_mic.map(str::to_string),
        created_at: fixture_ts(),
        updated_at: fixture_ts(),
        ..Default::default()
    }
}

fn fixture_taxonomy(
    id: &str,
    name: &str,
    scope: &str,
    categories: Vec<Category>,
) -> TaxonomyWithCategories {
    TaxonomyWithCategories {
        taxonomy: Taxonomy {
            id: id.to_string(),
            name: name.to_string(),
            color: "#2563eb".to_string(),
            description: None,
            is_system: false,
            is_single_select: false,
            sort_order: 1,
            created_at: fixture_ts(),
            updated_at: fixture_ts(),
            scope: scope.to_string(),
        },
        categories,
    }
}

fn fixture_category(taxonomy_id: &str, id: &str, name: &str) -> Category {
    Category {
        id: id.to_string(),
        taxonomy_id: taxonomy_id.to_string(),
        parent_id: None,
        name: name.to_string(),
        key: name.to_lowercase().replace(' ', "_"),
        color: "#64748b".to_string(),
        description: None,
        sort_order: 1,
        created_at: fixture_ts(),
        updated_at: fixture_ts(),
        icon: None,
    }
}

fn fixture_child_category(taxonomy_id: &str, id: &str, parent_id: &str, name: &str) -> Category {
    Category {
        parent_id: Some(parent_id.to_string()),
        ..fixture_category(taxonomy_id, id, name)
    }
}

fn fixture_assignment(
    id: &str,
    asset_id: &str,
    taxonomy_id: &str,
    category_id: &str,
    weight: i32,
    source: &str,
) -> AssetTaxonomyAssignment {
    AssetTaxonomyAssignment {
        id: id.to_string(),
        asset_id: asset_id.to_string(),
        taxonomy_id: taxonomy_id.to_string(),
        category_id: category_id.to_string(),
        weight,
        source: source.to_string(),
        created_at: fixture_ts(),
        updated_at: fixture_ts(),
    }
}

/// Env seeded with active/inactive assets (including ambiguous tickers and
/// names), two asset-scoped taxonomies that share a category ID, one
/// activity-scoped taxonomy, and assignments for AAPL in both asset
/// taxonomies.
fn classification_env() -> Arc<MockEnvironment> {
    let mut env = MockEnvironment::new();
    env.asset_service = Arc::new(MockAssetService {
        assets: vec![
            fixture_asset(
                "asset-aapl",
                "AAPL",
                "AAPL",
                Some("XNAS"),
                "Apple Inc.",
                true,
            ),
            fixture_asset(
                "asset-aple",
                "APLE",
                "APLE",
                Some("XNYS"),
                "Apple Hospitality REIT",
                true,
            ),
            fixture_asset(
                "asset-shop",
                "SHOP",
                "SHOP",
                Some("XTSE"),
                "Shopify Inc.",
                true,
            ),
            fixture_asset(
                "asset-vt-xnas",
                "VT",
                "VT",
                Some("XNAS"),
                "Vanguard Total World Stock Index Fund ETF Shares",
                true,
            ),
            fixture_asset(
                "asset-vt-arcx",
                "VT",
                "VT",
                Some("ARCX"),
                "Vanguard Total World Stock Index Fund ETF Shares",
                true,
            ),
            fixture_asset(
                "asset-msft",
                "MSFT",
                "MSFT",
                Some("XNAS"),
                "Microsoft Corp.",
                false,
            ),
        ],
    });
    env.taxonomy_service = Arc::new(MockTaxonomyService {
        taxonomies: vec![
            fixture_taxonomy(
                "asset-tax",
                "Asset Class",
                "asset",
                vec![
                    fixture_category("asset-tax", "equity", "Equity"),
                    fixture_child_category("asset-tax", "equity-us", "equity", "US Equity"),
                    fixture_category("asset-tax", "cash", "Cash"),
                ],
            ),
            fixture_taxonomy(
                "factor-tax",
                "Factors",
                "asset",
                // Same category ID as asset-tax's "equity" on purpose:
                // assignment enrichment must resolve by (taxonomy, category).
                vec![fixture_category("factor-tax", "equity", "Value")],
            ),
            fixture_taxonomy(
                "activity-tax",
                "Spending",
                "activity",
                vec![fixture_category("activity-tax", "food", "Food")],
            ),
        ],
        assignments: vec![
            fixture_assignment(
                "assignment-1",
                "asset-aapl",
                "asset-tax",
                "equity",
                10000,
                "manual",
            ),
            fixture_assignment(
                "assignment-2",
                "asset-aapl",
                "factor-tax",
                "equity",
                10000,
                "ai",
            ),
        ],
    });
    Arc::new(env)
}

output_test_dyn_env!(
    output_list_asset_taxonomies_seeded_summaries,
    ListAssetTaxonomies,
    classification_env(),
    {}
);
output_test_dyn_env!(
    output_list_asset_taxonomies_seeded_root_categories,
    ListAssetTaxonomies,
    classification_env(),
    { "taxonomyId": "asset-tax", "includeCategories": true }
);
output_test_dyn_env!(
    output_list_asset_taxonomies_seeded_all_categories,
    ListAssetTaxonomies,
    classification_env(),
    { "taxonomyName": "Asset Class", "includeCategories": true, "categoryDepth": "all" }
);
output_test_dyn_env!(
    output_list_asset_taxonomies_invalid_depth,
    ListAssetTaxonomies,
    classification_env(),
    { "taxonomyId": "asset-tax", "includeCategories": true, "categoryDepth": "bogus" }
);
output_test_dyn_env!(
    output_list_asset_taxonomies_unknown_taxonomy,
    ListAssetTaxonomies,
    classification_env(),
    { "taxonomyId": "missing-tax" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_filtered,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "AAPL", "taxonomyId": "asset-tax" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_all_taxonomies,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "asset-aapl" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_name_match,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "Apple Inc." }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_fuzzy_name,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "Hospitality" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_provider_suffix,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "SHOP.TO" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_symbol_mic,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "VT XNAS" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_candidate_label,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "VT - Vanguard Total World Stock Index Fund ETF Shares (mic: ARCX, currency: USD, id: asset-vt-arcx)" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_ambiguous_symbol,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "VT" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_ambiguous_name,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "Apple" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_inactive_asset,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "MSFT" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_unknown_taxonomy,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "AAPL", "taxonomyId": "missing-tax" }
);
output_test_dyn_env!(
    output_get_asset_taxonomy_assignments_empty_query,
    GetAssetTaxonomyAssignments,
    classification_env(),
    { "assetQuery": "  " }
);

// ---------------------------------------------------------------------------
// Categorization-context fixtures (seeded env) — pin the deterministic
// rules/history pass through `list_categorization_context`.
// ---------------------------------------------------------------------------

fn fixture_cash_activity(
    id: &str,
    account_id: &str,
    activity_date: &str,
    notes: &str,
    assigned_category: Option<(&str, &str)>,
) -> CashActivity {
    let now = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let activity_date = DateTime::parse_from_rfc3339(activity_date)
        .unwrap()
        .with_timezone(&Utc);
    let assignments = assigned_category
        .map(|(taxonomy_id, category_id)| {
            vec![
                wealthfolio_spending::activity_assignments::ActivityTaxonomyAssignment {
                    id: format!("{id}-asg"),
                    activity_id: id.to_string(),
                    taxonomy_id: taxonomy_id.to_string(),
                    category_id: category_id.to_string(),
                    weight: 10_000,
                    source: "manual".to_string(),
                    created_at: now.naive_utc(),
                    updated_at: now.naive_utc(),
                },
            ]
        })
        .unwrap_or_default();
    CashActivity {
        activity: Activity {
            id: id.to_string(),
            account_id: account_id.to_string(),
            asset_id: None,
            activity_type: "WITHDRAWAL".to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date,
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(-1250, 2)),
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: Some(notes.to_string()),
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: now,
            updated_at: now,
        },
        cash_flow_bucket: CashFlowBucket::Spending,
        assignments,
        splits: Vec::new(),
        event_id: None,
        transfer_link_status: None,
        // Matches the -12.50 posted withdrawal above. Unused by the parity
        // assertions, but the fixture should not claim a movement the activity
        // does not describe.
        net_amount: -12.5,
        net_amount_base: None,
    }
}

/// Env seeded with one activity-scope taxonomy, one uncategorized cash row,
/// and one categorized row with the same normalized payee (history signal).
fn categorization_env() -> Arc<MockEnvironment> {
    let mut env = MockEnvironment::new();
    env.account_service = Arc::new(MockAccountService {
        accounts: vec![fixture_account("acc-1", "Brokerage", "SECURITIES", "USD")],
    });
    env.taxonomy_service = Arc::new(MockTaxonomyService {
        taxonomies: vec![fixture_taxonomy(
            "spending",
            "Spending",
            "activity",
            vec![
                fixture_category("spending", "cat-food", "Food"),
                fixture_child_category("spending", "cat-coffee", "cat-food", "Coffee"),
            ],
        )],
        assignments: vec![],
    });
    env.cash_activity_service = Arc::new(MockCashActivityService {
        items: vec![
            fixture_cash_activity(
                "cash-a",
                "acc-1",
                "2024-06-15T00:00:00Z",
                "SQ *COFFEE SHOP TORONTO",
                None,
            ),
            fixture_cash_activity(
                "cash-b",
                "acc-1",
                "2024-05-10T00:00:00Z",
                "SQ *COFFEE SHOP OTTAWA",
                Some(("spending", "cat-coffee")),
            ),
        ],
    });
    Arc::new(env)
}

output_test_dyn_env!(
    output_list_categorization_context_seeded,
    ListCategorizationContext,
    categorization_env(),
    {}
);
output_test_dyn_env!(
    output_list_categorization_context_explicit_ids,
    ListCategorizationContext,
    categorization_env(),
    { "activityIds": ["cash-a"] }
);

// ---------------------------------------------------------------------------
// Draft/suggest tool outputs (migrated from `crates/ai/src/tools/*.rs` inline
// tests). These pin the editable-draft behavior the assistant relies on.
// ---------------------------------------------------------------------------

/// Env with a single account so account auto-selection applies (the common
/// record_activity flow). No quote results, so symbols fall back to custom.
fn single_account_env() -> Arc<MockEnvironment> {
    let mut env = MockEnvironment::new();
    env.account_service = Arc::new(MockAccountService {
        accounts: vec![fixture_account("acc-1", "Main Broker", "SECURITIES", "USD")],
    });
    Arc::new(env)
}

output_test_dyn_env!(
    output_record_activity_buy,
    RecordActivity,
    single_account_env(),
    {
        "activityType": "BUY",
        "symbol": "AAPL",
        "activityDate": "2026-01-17",
        "quantity": 20.0,
        "unitPrice": 240.0
    }
);
output_test_dyn_env!(
    output_record_activity_deposit,
    RecordActivity,
    single_account_env(),
    { "activityType": "DEPOSIT", "activityDate": "2026-01-17", "amount": 5000.0 }
);
output_test_dyn_env!(
    output_record_activity_dividend_drip,
    RecordActivity,
    single_account_env(),
    {
        "activityType": "DIVIDEND",
        "symbol": "VTI",
        "activityDate": "2026-01-17",
        "quantity": 2.0,
        "subtype": "DRIP"
    }
);
output_test_dyn_env!(
    output_record_activities_mixed,
    RecordActivities,
    single_account_env(),
    {
        "activities": [
            { "activityType": "DEPOSIT", "activityDate": "2026-01-17", "amount": 1000.0 },
            { "activityType": "DEPOSIT", "activityDate": "2026-01-17" }
        ]
    }
);

// prepare_asset_classification — reuse the seeded classification env.
output_test_dyn_env!(
    output_prepare_asset_classification_draft,
    PrepareAssetClassification,
    classification_env(),
    {
        "assetQuery": "AAPL",
        "taxonomyId": "asset-tax",
        "assignments": [
            { "categoryId": "equity", "weightBasisPoints": 6000, "sourceLabel": "Equity" },
            { "categoryId": "cash", "weightBasisPoints": 3000, "sourceLabel": "Cash" }
        ]
    }
);
output_test_dyn_env!(
    output_prepare_asset_classification_ambiguous,
    PrepareAssetClassification,
    classification_env(),
    {
        "assetQuery": "VT",
        "taxonomyId": "asset-tax",
        "assignments": [
            { "categoryId": "equity", "weightBasisPoints": 9000, "sourceLabel": "Equity" }
        ]
    }
);
output_test_dyn_env!(
    output_prepare_asset_classification_duplicate_error,
    PrepareAssetClassification,
    classification_env(),
    {
        "assetQuery": "AAPL",
        "taxonomyId": "asset-tax",
        "assignments": [
            { "categoryId": "equity", "weightBasisPoints": 5000, "sourceLabel": "Equity" },
            { "categoryId": "equity", "weightBasisPoints": 5000, "sourceLabel": "Equity" }
        ]
    }
);

/// Live model regression using only in-memory fixture services. No user data.
#[tokio::test]
#[ignore = "requires Ollama and WF_TEST_OLLAMA_MODEL"]
async fn live_ollama_each_assistant_tool() {
    use futures::StreamExt;
    use rig::{
        agent::MultiTurnStreamItem,
        client::{AgentClientExt, Nothing},
        streaming::StreamedAssistantContent,
        tool::{DynamicTool, PortableTool, ToolOutput},
    };
    use std::sync::Mutex;
    use wealthfolio_ai::tools::{agent_catalog, ImportCsvTool};
    let thinking = std::env::var("WF_TEST_OLLAMA_THINKING").as_deref() == Ok("true");
    let model = std::env::var("WF_TEST_OLLAMA_MODEL").expect("set model");
    let mut names: Vec<_> = agent_catalog()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    names.push("import_csv".into());
    let mut report = Vec::new();
    for name in names {
        let test_env = match name.as_str() {
            "create_categorization_rule"
            | "propose_transaction_categories"
            | "list_categorization_context" => categorization_env(),
            "prepare_asset_classification"
            | "get_asset_taxonomy_assignments"
            | "list_asset_taxonomies" => classification_env(),
            _ => env(),
        };
        let args = match name.as_str() {
            "record_activity" => {
                serde_json::json!({"activityType":"DEPOSIT","activityDate":"2024-06-15","amount":100,"account":"acc-1"})
            }
            "record_activities" => {
                serde_json::json!({"activities":[{"activityType":"DEPOSIT","activityDate":"2024-06-15","amount":100,"account":"acc-1"}]})
            }
            "create_categorization_rule" => {
                serde_json::json!({"pattern":"COFFEE","matchType":"contains","categoryKey":"coffee","taxonomyId":"spending"})
            }
            "propose_transaction_categories" => {
                serde_json::json!({"activityIds":["cash-a"],"aiProposals":[{"activityId":"cash-a","taxonomyId":"spending","categoryKey":"coffee","confidence":0.95}]})
            }
            "get_asset_taxonomy_assignments" => serde_json::json!({"assetQuery":"AAPL"}),
            "prepare_asset_classification" => {
                serde_json::json!({"assetQuery":"AAPL","taxonomyId":"asset-tax","assignments":[{"categoryId":"equity","weightBasisPoints":10000,"sourceLabel":"test"}]})
            }
            "get_performance" => serde_json::json!({"period":"ALL"}),
            "import_csv" => {
                serde_json::json!({"csvContent":"Date,Type,Amount\n2024-06-15,DEPOSIT,100\n","accountId":"acc-1"})
            }
            _ => serde_json::json!({}),
        };
        let observations = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let mut tools = Vec::new();
        for tool in agent_catalog().iter() {
            let adapter = Arc::new(RigAgentTool::new(tool.clone(), test_env.clone()));
            let definition = adapter.definition();
            let tool_name = definition.name.clone();
            let observed = observations.clone();
            tools.push(DynamicTool::new(definition.name, definition.description, definition.parameters, move |_, args| {
                let adapter=adapter.clone(); let observed=observed.clone(); let tool_name=tool_name.clone();
                Box::pin(async move {
                    let result=adapter.call(args).await;
                    observed.lock().unwrap().push(serde_json::json!({"tool":tool_name,"ok":result.is_ok(),"result":result.as_ref().ok(),"error":result.as_ref().err().map(ToString::to_string)}));
                    result.map(ToolOutput::json)
                })
            }));
        }
        let csv = Arc::new(ImportCsvTool::new(test_env.clone(), "USD".into()));
        let def = rig::completion::ToolDefinition {
            name: "import_csv".into(),
            description: csv.description(),
            parameters: csv.parameters(),
        };
        let observed = observations.clone();
        tools.push(DynamicTool::new(def.name,def.description,def.parameters,move |_,args| {
            let csv=csv.clone();let observed=observed.clone();
            Box::pin(async move {
                let parsed=serde_json::from_value(args).map_err(rig::tool::ToolExecutionError::from_error)?;
                let result=csv.call(parsed).await.map_err(rig::tool::ToolExecutionError::from_error);
                observed.lock().unwrap().push(serde_json::json!({"tool":"import_csv","ok":result.is_ok(),"result":result.as_ref().ok(),"error":result.as_ref().err().map(ToString::to_string)}));
                result.map(|r| ToolOutput::json(serde_json::to_value(r).unwrap()))
            })
        }));
        let client = rig::providers::ollama::Client::builder()
            .api_key(Nothing)
            .http_client(wealthfolio_http::client())
            .build()
            .unwrap();
        let agent=client.agent(&model).temperature(0.0)
            .preamble("You are testing tool integration against synthetic fixtures. Call the specifically requested tool once with the supplied arguments. Do not call other tools. After its response, briefly report the result and stop.")
            .additional_params(serde_json::json!({"think":thinking,"options":{"num_ctx":32768,"num_predict":1024}}))
            .dynamic_tools(tools).build();
        let prompt =
            format!("Call {name} with these arguments: {args}. Then briefly report its result.");
        let mut stream = agent.runner(prompt).max_turns(2).stream().await;
        let mut text = String::new();
        let mut stream_error = None;
        let finished = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(MultiTurnStreamItem::StreamAssistantItem(
                        StreamedAssistantContent::Text(t),
                    )) => text.push_str(&t.text),
                    Err(e) => {
                        stream_error = Some(e.to_string());
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await
        .is_ok();
        let calls = observations.lock().unwrap().clone();
        let target = calls.iter().find(|c| c["tool"] == name);
        let valid_result = target.is_some_and(|c| {
            let r = &c["result"];
            match name.as_str() {
                "record_activity" => r["validation"]["isValid"] == true,
                "record_activities" => r["validation"]["validRows"] == 1,
                "propose_transaction_categories" => {
                    r["summary"]["proposed"].as_u64().unwrap_or(0) > 0
                }
                "create_categorization_rule" | "prepare_asset_classification" => {
                    r["draftStatus"] == "draft"
                }
                _ => true,
            }
        });
        let passed = valid_result
            && calls.len() == 1
            && finished
            && stream_error.is_none()
            && !text.trim().is_empty()
            && target.is_some_and(|c| c["ok"] == true);
        println!(
            "{name}: {} (calls={}, final_text={}, timeout={})",
            if passed { "PASS" } else { "FAIL" },
            calls.len(),
            !text.trim().is_empty(),
            !finished
        );
        report.push(serde_json::json!({"tool":name,"passed":passed,"calls":calls,"streamError":stream_error,"timedOut":!finished,"hasFinalText":!text.trim().is_empty()}));
        std::fs::write(
            format!("/tmp/wealthfolio-ollama-all-tools-thinking-{thinking}.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
    assert!(
        report.iter().all(|r| r["passed"] == true),
        "See /tmp/wealthfolio-ollama-all-tools.json for per-tool results"
    );
}
